const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = !!player.superpowers?.infiltratorActive; // Infiltrator flag

    let newAreaPolygon;
    let newAreaSqM;

    // --- Part 1: Validate the claim ---
    if (isInitialBaseClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; 

        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);

        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const baseGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        const newAreaWKT = `ST_GeomFromGeoJSON('${baseGeoJSON}')`;

        if (isInfiltrator) {
            // Infiltrator Mode: Must be inside someone's territory
            const infiltrateQuery = `SELECT owner_id, username, is_shield_active, area FROM territories WHERE ST_Contains(area, ${basePointWKT}) AND owner_id != $1`;
            const result = await client.query(infiltrateQuery, [userId]);

            if (result.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Must start infiltrator base *inside* enemy territory.' });
                return null;
            }

            const victim = result.rows[0];
            const victimId = victim.owner_id;
            const victimArea = victim.area;

            if (victim.is_shield_active) {
                // Shield blocks infiltration
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
                socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator base.` });

                const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victimId);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

                // Consume infiltrator charge
                await client.query('UPDATE users SET infiltrator_active = false WHERE google_id = $1', [userId]);
                return null;
            }

            // Shield inactive: carve out new base from enemy
            const subtractQuery = `SELECT ST_Difference($1::geometry, $2::geometry) as victim_area, ST_Intersection($1::geometry, $2::geometry) as claimed_island`;
            const diffResult = await client.query(subtractQuery, [victimArea, newAreaWKT]);

            const remainingVictimArea = diffResult.rows[0].victim_area;
            const claimedIsland = diffResult.rows[0].claimed_island;

            if (!claimedIsland) {
                socket.emit('claimRejected', { reason: 'Infiltration failed: no overlap with enemy area.' });
                return null;
            }

            const geoResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as sqm', [claimedIsland]);
            const finalAreaGeoJSON = geoResult.rows[0].geojson;
            const finalAreaSqM = geoResult.rows[0].sqm;

            if (!finalAreaGeoJSON || finalAreaSqM < 10) {
                socket.emit('claimRejected', { reason: 'Infiltrated area too small.' });
                return null;
            }

            // Save both changes
            await client.query('UPDATE territories SET area = $1, area_sqm = ST_Area($1::geography) WHERE owner_id = $2', [remainingVictimArea, victimId]);
            await client.query('UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2, original_base_point = ST_SetSRID(ST_Point($3, $4), 4326) WHERE owner_id = $5', [finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat, userId]);

            // Consume infiltrator charge
            await client.query('UPDATE users SET infiltrator_active = false WHERE google_id = $1', [userId]);

            return {
                finalTotalArea: finalAreaSqM,
                areaClaimed: finalAreaSqM,
                ownerIdsToUpdate: [victimId, userId]
            };
        } else {
            // Regular base claim: must NOT intersect anyone
            const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
            const intersectionResult = await client.query(intersectionCheckQuery);

            if (intersectionResult.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
    } else {
        // --- Expansion mode ---
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
    const affectedOwnerIds = new Set([userId]);

    // --- Part 2: Calculate the "Net Gain" ---
    let attackerNetGainGeom;
    const geomResult = await client.query(`SELECT ${newAreaWKT} as geom`);
    attackerNetGainGeom = geomResult.rows[0].geom;

    const intersectingTerritoriesQuery = `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        affectedOwnerIds.add(victimId);

        if (row.is_shield_active) {
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victimId);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            const protectedResult = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victimCurrentArea]);
            attackerNetGainGeom = protectedResult.rows[0].final_geom;
        } else {
            const absorptionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victimCurrentArea]);
            attackerNetGainGeom = absorptionResult.rows[0].final_geom;
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
        }
    }

    let attackerFinalAreaGeom;
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
        const unionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [attackerExistingAreaRes.rows[0].area, attackerNetGainGeom]);
        attackerFinalAreaGeom = unionResult.rows[0].final_area;
    } else {
        attackerFinalAreaGeom = attackerNetGainGeom;
    }

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
