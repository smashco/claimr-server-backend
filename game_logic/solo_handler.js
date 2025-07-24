const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        // This part is correct and remains unchanged.
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
    } else {
        // This part is correct and remains unchanged.
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

    // --- STEP 1: Determine the Attacker's final intended territory ---
    let attackerFinalAreaGeom;
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
        // If attacker has land, their final area is the UNION of their old land and new loop.
        const influenceResult = await client.query(`SELECT ST_Union($1, ${newAreaWKT}) AS final_area`, [attackerExistingAreaRes.rows[0].area]);
        attackerFinalAreaGeom = influenceResult.rows[0].final_area;
    } else {
        // If attacker is new, their final area is just the new loop.
        const geomResult = await client.query(`SELECT ${newAreaWKT} as geom`);
        attackerFinalAreaGeom = geomResult.rows[0].geom;
    }

    // --- STEP 2: Find all players who are touched by the attacker's NEW loop ---
    const intersectingTerritoriesQuery = `
        SELECT owner_id, username, area, is_shield_active
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);
    
    // --- STEP 3: Process victims ---
    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        
        if (row.is_shield_active) {
            console.log(`[GAME] Attack on ${row.username} blocked by LAST STAND. Creating island.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) {
                io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: players[victimSocketId].lastStandCharges });
            }
            
            // Cut the victim's territory out of the attacker's final shape.
            const protectedResult = await client.query(`SELECT ST_Difference($1, $2) as final_geom;`, [attackerFinalAreaGeom, victimCurrentArea]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
            
        } else {
            // Unshielded victim. They are simply wiped out. No complex math needed.
            console.log(`[SoloClaim] Unshielded player ${row.username} was inside the claim. Wiping them out.`);
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
        }
        affectedOwnerIds.add(victimId);
    }

    // --- STEP 4: Save the attacker's final, calculated territory ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    let finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }

    // For initial base claims, we must ensure it's not being placed on top of another claim now.
    // The previous logic for initial claims was slightly flawed. This is more robust.
    if (isInitialBaseClaim) {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2, original_base_point = ST_SetSRID(ST_Point($4, $5), 4326) WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId, baseClaim.lng, baseClaim.lat]);
    } else {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;