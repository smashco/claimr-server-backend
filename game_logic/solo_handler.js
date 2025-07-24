const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- Part 1: Validate the claim (This section is correct and unchanged) ---
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
    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [p.lng, p.lat] : null].filter(Boolean);
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
    const affectedOwnerIds = new Set([userId]);

    // --- Part 2: Calculate the Attacker's intended final territory (always additive) ---
    let attackerFinalAreaGeom;
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
        const unionResult = await client.query(`SELECT ST_Union($1, ${newAreaWKT}) AS final_area`, [attackerExistingAreaRes.rows[0].area]);
        attackerFinalAreaGeom = unionResult.rows[0].final_area;
    } else {
        const geomResult = await client.query(`SELECT ${newAreaWKT} as geom`);
        attackerFinalAreaGeom = geomResult.rows[0].geom;
    }

    // --- Part 3: Find victims and process combat logic ---
    const intersectingTerritoriesQuery = `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        affectedOwnerIds.add(victimId);
        
        if (row.is_shield_active) {
            console.log(`[GAME] Attack on ${row.username} blocked by LAST STAND.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            
            // The attacker's final territory has the shielded victim's area "cut out" of it.
            const protectedResult = await client.query(`SELECT ST_Difference($1, $2) as final_geom;`, [attackerFinalAreaGeom, victimCurrentArea]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;

        } else {
            console.log(`[GAME] Attacking unshielded player: ${row.username}.`);
            // Calculate damage to the victim by subtracting the attacker's full intended area.
            const diffResult = await client.query(`SELECT ST_AsGeoJSON(ST_Difference($1, $2)) AS remaining_area;`, [victimCurrentArea, attackerFinalAreaGeom]);
            const remainingAreaGeoJSON = diffResult.rows[0].remaining_area;
            const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
            
            if (Math.round(remainingAreaSqM) > 10) {
                // Victim survives with a smaller piece of land.
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
            } else {
                // Victim is wiped out. Their territory becomes empty.
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
            }
        }
    }

    // --- Part 4: Finalize and save the attacker's territory ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }

    const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
    await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);

    if (isInitialBaseClaim) {
        const baseQuery = `UPDATE territories SET original_base_point = ST_SetSRID(ST_Point($1, $2), 4326) WHERE owner_id = $3;`;
        await client.query(baseQuery, [baseClaim.lng, baseClaim.lat, userId]);
    }
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;