const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
        const intersectionResult = await client.query(intersectionCheckQuery);

        if (intersectionResult.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
            return null;
        }

        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; 
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);

        const existingBaseCheck = await client.query('SELECT original_base_point FROM territories WHERE owner_id = $1', [userId]);
        if (existingBaseCheck.rows.length > 0 && existingBaseCheck.rows[0].original_base_point) {
            socket.emit('claimRejected', { reason: 'You already have an initial base.' });
            return null;
        }

    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try {
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        } catch (e) {
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
        if (!existingAreaGeoJSON || turf.area(JSON.parse(existingAreaGeoJSON)) === 0) { 
            socket.emit('claimRejected', { reason: 'You must claim an initial base first.' });
            return null;
        }

        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }

    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set(); 
    affectedOwnerIds.add(userId); 

    const intersectingTerritoriesQuery = `
        SELECT owner_id, username, area, is_shield_active
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);
    
    let attackerFinalClaimWKT = newAreaWKT;

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        
        if (row.is_shield_active) {
            console.log(`[GAME] Attack on ${row.username} blocked by LAST STAND. Creating island.`);
            
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) {
                const victimPlayer = players[victimSocketId];
                if (victimPlayer) {
                    victimPlayer.isLastStandActive = false; 
                    io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: victimPlayer.lastStandCharges });
                }
            }
            
            const protectedAreaResult = await client.query(`
                SELECT ST_AsGeoJSON(ST_Difference(${attackerFinalClaimWKT}, $1)) as final_geom;
            `, [victimCurrentArea]);
            
            const finalGeom = protectedAreaResult.rows[0].final_geom;
            if(finalGeom) {
                attackerFinalClaimWKT = `ST_GeomFromGeoJSON('${finalGeom}')`;
            } else {
                 attackerFinalClaimWKT = `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
            }
            
            affectedOwnerIds.add(victimId);
            continue; 
        }
        
        // --- THIS IS THE CORRECTED LOGIC ---
        // Treat it as a NORMAL territory attack. The damage is the attacker's new loop.
        const diffGeomResult = await client.query(`
            SELECT ST_AsGeoJSON(
                ST_CollectionExtract(
                    ST_Difference($1, ${newAreaWKT}), 
                3)
            ) AS remaining_area;
        `, [victimCurrentArea]);

        const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;
        const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
        
        if (Math.round(remainingAreaSqM) > 10) { 
            // The victim survived with a smaller territory.
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
        } else {
            // The victim is wiped out. The attacker's claim should absorb the victim's *entire original area* to fill any holes.
            const unionResult = await client.query(`
                SELECT ST_AsGeoJSON(ST_Union(${attackerFinalClaimWKT}, $1)) as final_geom;
            `, [victimCurrentArea]);
            
            if (unionResult.rows[0].final_geom) {
                attackerFinalClaimWKT = `ST_GeomFromGeoJSON('${unionResult.rows[0].final_geom}')`;
            }

            // Now, set the victim's territory to empty.
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
            console.log(`[SoloClaim] Entire territory of ${victimId} absorbed by attacker.`);
        }
        affectedOwnerIds.add(victimId);
    }

    let finalAreaSqM;
    let finalAreaGeoJSON;

    const existingUserAreaResult = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
    const existingUserAreaGeoJSON = existingUserAreaResult.rows.length > 0 ? existingUserAreaResult.rows[0].geojson_area : null;

    if (existingUserAreaGeoJSON && turf.area(JSON.parse(existingUserAreaGeoJSON)) > 0) { 
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(ST_GeomFromGeoJSON($1), ${attackerFinalClaimWKT})) AS united_area;
        `, [existingUserAreaGeoJSON]); 
        finalAreaGeoJSON = unionResult.rows[0].united_area;
    } else {
        const finalClaimResult = await client.query(`SELECT ST_AsGeoJSON(${attackerFinalClaimWKT}) as geojson`);
        finalAreaGeoJSON = finalClaimResult.rows[0].geojson;
    }

    finalAreaSqM = finalAreaGeoJSON ? turf.area(JSON.parse(finalAreaGeoJSON)) : 0;

    if (finalAreaSqM < 1) {
        console.log(`[SoloClaim] Final claim area for ${userId} is too small after subtractions. Claim rejected.`);
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
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