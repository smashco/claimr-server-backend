// claimr_server/game_logic/solo_handler.js

const turf = require('@turf/turf');

// The global 'players' object will be available in the scope where this module is required and called.
// No need to explicitly require it here.

async function handleSoloClaim(io, socket, player, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
        const intersectionResult = await client.query(intersectionCheckQuery);

        if (intersectionResult.rowCount > 0) {
            console.log(`[SoloClaim] Rejected initial base claim for ${userId} because it's inside existing territory.`);
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory. Move to an unclaimed area.' });
            return null;
        }

        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; 
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (e) {
            console.error(`[SoloClaim] Error creating initial base circle for ${userId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[SoloClaim] Initial base claim attempt for ${userId}. Area: ${newAreaSqM} sqm.`);

        const existingBaseCheck = await client.query('SELECT original_base_point FROM territories WHERE owner_id = $1', [userId]);
        if (existingBaseCheck.rows.length > 0 && existingBaseCheck.rows[0].original_base_point) {
            socket.emit('claimRejected', { reason: 'You already have an initial base.' });
            return null;
        }

    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points to form a polygon.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try {
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        } catch (e) {
            console.error(`[SoloClaim] Error creating polygon from trail for ${userId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }

        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
        const existingAreaGeoJSON = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].geojson_area : null;
        const existingAreaTurf = existingAreaGeoJSON ? JSON.parse(existingAreaGeoJSON) : null;

        if (!existingAreaTurf || turf.area(existingAreaTurf) === 0) { 
            console.warn(`[SoloClaim] Player ${userId} attempting expansion claim but has no existing territory.`);
            socket.emit('claimRejected', { reason: 'You must claim an initial base first or connect to existing territory.' });
            return null;
        }

        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            console.log(`[SoloClaim] Expansion claim for ${userId} does not connect to existing territory.`);
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }

    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set(); 
    affectedOwnerIds.add(userId); 

    const intersectingTerritoriesQuery = `
        SELECT owner_id, username, area, has_shield, ST_AsGeoJSON(original_base_point) as geojson_base
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        const victimUsername = row.username;
        const victimHasShield = row.has_shield;
        
        if (victimHasShield) {
            console.log(`[SoloClaim] Attack on ${victimUsername} failed, shield is active.`);
            continue;
        }

        const diffGeomResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
        `, [victimCurrentArea]);
        
        const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;
        let finalRemainingAreaGeoJSON = remainingAreaGeoJSON;
        let finalRemainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
        
        const victimSocketId = Object.keys(io.sockets.sockets).find(id => players[id] && players[id].googleId === victimId);
        const victimPlayer = victimSocketId ? players[victimSocketId] : null;

        // --- CORRECTED "LAST STAND" SUPERPOWER LOGIC ---
        if (finalRemainingAreaSqM < 1 && victimPlayer && victimPlayer.isLastStandActive) {
            console.log(`[GAME] Victim ${victimPlayer.name} is being wiped out, but their LAST STAND is active.`);
            victimPlayer.isLastStandActive = false; // Consume the power
            io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: victimPlayer.lastStandCharges });
            
            const centerPoint = JSON.parse(row.geojson_base).coordinates;
            const baseCircle = turf.circle(centerPoint, 30.0, { units: 'meters' });
            finalRemainingAreaGeoJSON = JSON.stringify(baseCircle.geometry);
            finalRemainingAreaSqM = turf.area(baseCircle);
            console.log(`[GAME] Restored ${victimPlayer.name}'s base. New area: ${finalRemainingAreaSqM} sqm.`);
        }
        
        if (finalRemainingAreaSqM > 1) {
            await client.query(`
                UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                WHERE owner_id = $3;
            `, [finalRemainingAreaGeoJSON, finalRemainingAreaSqM, victimId]);
        } else {
            await client.query(`
                UPDATE territories 
                SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), 
                    area_sqm = 0
                WHERE owner_id = $1;
            `, [victimId]);
            console.log(`[SoloClaim] Entire territory stolen from ${victimId}.`);
        }
        affectedOwnerIds.add(victimId);
    }

    let finalAreaSqM;
    let finalAreaGeoJSON;

    const existingUserAreaResult = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
    const existingUserAreaGeoJSON = existingUserAreaResult.rows.length > 0 ? existingUserAreaResult.rows[0].geojson_area : null;
    const existingUserAreaTurf = existingUserAreaGeoJSON ? JSON.parse(existingUserAreaGeoJSON) : null;

    if (existingUserAreaTurf && turf.area(existingUserAreaTurf) > 0) { 
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(ST_GeomFromGeoJSON($1), ${newAreaWKT})) AS united_area;
        `, [existingUserAreaGeoJSON]); 
        finalAreaGeoJSON = unionResult.rows[0].united_area;
        finalAreaSqM = turf.area(JSON.parse(finalAreaGeoJSON));
        console.log(`[SoloClaim] Unioned new area for ${userId}. Total: ${finalAreaSqM}`);
    } else {
        finalAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        finalAreaSqM = newAreaSqM;
        console.log(`[SoloClaim] Initial/reclaim area for ${userId}. Total: ${finalAreaSqM}`);
    }

    let updateQuery;
    let queryParams;
    if (isInitialBaseClaim) {
        updateQuery = `
            UPDATE territories 
            SET area = ST_GeomFromGeoJSON($1), 
                area_sqm = $2, 
                original_base_point = ST_SetSRID(ST_Point($4, $5), 4326)
            WHERE owner_id = $3;
        `;
        queryParams = [finalAreaGeoJSON, finalAreaSqM, userId, baseClaim.lng, baseClaim.lat];
    } else {
        updateQuery = `
            UPDATE territories 
            SET area = ST_GeomFromGeoJSON($1), 
                area_sqm = $2 
            WHERE owner_id = $3;
        `;
        queryParams = [finalAreaGeoJSON, finalAreaSqM, userId];
    }
    await client.query(updateQuery, queryParams);

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;