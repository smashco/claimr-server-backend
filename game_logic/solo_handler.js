const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        // ... (Initial base claim logic is correct, no changes needed)
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
        // ... (Expansion claim validation is correct, no changes needed)
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

    // --- DEFINITIVE FIX STEP 1: Calculate the attacker's total area of influence first ---
    let attackerTotalInfluenceWKT;
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
        const influenceResult = await client.query(`SELECT ST_Union($1, ${newAreaWKT}) AS full_influence`, [attackerExistingAreaRes.rows[0].area]);
        attackerTotalInfluenceWKT = influenceResult.rows[0].full_influence;
    } else {
        attackerTotalInfluenceWKT = newAreaWKT;
    }

    const intersectingTerritoriesQuery = `
        SELECT owner_id, username, area, is_shield_active
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);
    
    let finalAttackerArea = attackerTotalInfluenceWKT;

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        
        if (row.is_shield_active) {
            console.log(`[GAME] Attack on ${row.username} blocked by LAST STAND. Creating island.`);
            
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            
            // Update client UI
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) {
                const victimPlayer = players[victimSocketId];
                if (victimPlayer) {
                    victimPlayer.isLastStandActive = false; 
                    io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: victimPlayer.lastStandCharges });
                }
            }
            
            // The attacker's final area has the victim's territory "cut out" of it.
            const protectedResult = await client.query(`SELECT ST_Difference($1, $2) as final_geom;`, [finalAttackerArea, victimCurrentArea]);
            finalAttackerArea = protectedResult.rows[0].final_geom;
            
            affectedOwnerIds.add(victimId);
            continue; 
        }
        
        // --- DEFINITIVE FIX STEP 2: Use the total influence to calculate damage against unshielded players ---
        const diffGeomResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Difference($1, $2)) AS remaining_area;
        `, [victimCurrentArea, attackerTotalInfluenceWKT]);

        const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;
        const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
        
        if (Math.round(remainingAreaSqM) > 10) { 
            // Victim survives with a smaller territory.
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
        } else {
            // Victim is wiped out. Set their area to empty. The attacker's area already includes their space.
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
            console.log(`[SoloClaim] Entire territory of ${victimId} was wiped out.`);
        }
        affectedOwnerIds.add(victimId);
    }

    // --- DEFINITIVE FIX STEP 3: Finalize the attacker's new territory ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [finalAttackerArea]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        console.log(`[SoloClaim] Final claim area for ${userId} is too small after subtractions. Claim rejected.`);
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }

    const updateQuery = `
        UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;
    `;
    const queryParams = [finalAreaGeoJSON, finalAreaSqM, userId];
    await client.query(updateQuery, queryParams);

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;