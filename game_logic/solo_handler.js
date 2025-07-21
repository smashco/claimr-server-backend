// claimr_server/game_logic/solo_handler.js

const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        // --- FIX FOR REBUILDING ON ENEMY TERRITORY ---
        // Check if the proposed base point is inside any existing territory
        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
        const intersectionResult = await client.query(intersectionCheckQuery);

        if (intersectionResult.rowCount > 0) {
            console.log(`[SoloClaim] Rejected initial base claim for ${userId} because it's inside existing territory.`);
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory. Move to an unclaimed area.' });
            return null;
        }
        // --- END OF FIX ---

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
        SELECT owner_id, username, area, has_shield, ST_AsText(original_base_point) as original_base_point_wkt
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        const victimUsername = row.username;
        const victimHasShield = row.has_shield;
        const victimOriginalBasePointWKT = row.original_base_point_wkt;

        const intersectionGeomResult = await client.query(`SELECT ST_AsGeoJSON(ST_Intersection(ST_GeomFromGeoJSON($1), $2)) AS intersected_geom;`, [JSON.stringify(newAreaPolygon.geometry), victimCurrentArea]);
        const intersectedGeomGeoJSON = intersectionGeomResult.rows[0].intersected_geom;
        const intersectedSqM = intersectedGeomGeoJSON ? turf.area(JSON.parse(intersectedGeomGeoJSON)) : 0;

        if (intersectedSqM > 0) {
            console.log(`[SoloClaim] ${player.name} intersects ${victimUsername}'s territory. Intersected area: ${intersectedSqM} sqm`);

            let shieldActivated = false;
            if (victimHasShield && victimOriginalBasePointWKT) {
                const basePointIntersectsClaim = await client.query(`SELECT ST_Intersects(ST_GeomFromText($1), ST_GeomFromGeoJSON($2)) AS intersects_base_point;`, [victimOriginalBasePointWKT, intersectedGeomGeoJSON]);
                if (basePointIntersectsClaim.rows[0].intersects_base_point) {
                    shieldActivated = true;
                    console.log(`[SoloClaim] Shield activated for ${victimUsername}'s base point! Claim Rejected.`);
                    socket.emit('claimRejected', { reason: `Shield activated for ${victimUsername}'s base! Cannot steal this area.` });
                    return null; 
                }
            }
            
            if (!shieldActivated) { 
                const diffGeomResult = await client.query(`
                    SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
                `, [victimCurrentArea]);

                const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;

                if (remainingAreaGeoJSON && JSON.parse(remainingAreaGeoJSON).coordinates.length > 0) { 
                    const remainingAreaTurf = JSON.parse(remainingAreaGeoJSON);
                    const remainingAreaSqM = turf.area(remainingAreaTurf);
                    
                    await client.query(`
                        UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                        WHERE owner_id = $3;
                    `, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
                    console.log(`[SoloClaim] Stolen from ${victimId}. Remaining area: ${remainingAreaSqM}`);
                    affectedOwnerIds.add(victimId);

                    const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                    if (victimSocket) {
                    victimSocket.emit('runTerminated', { reason: `${player.name} has stolen some of your territory!` }); 
                    }
                } else {
                    await client.query(`
                        UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0
                        WHERE owner_id = $1;
                    `, [victimId]);
                    console.log(`[SoloClaim] Entire territory stolen from ${victimId}.`);
                    affectedOwnerIds.add(victimId);
                    const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                    if (victimSocket) {
                    victimSocket.emit('runTerminated', { reason: `${player.name} has acquired your entire area!` });
                    }
                }
            }
        }
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