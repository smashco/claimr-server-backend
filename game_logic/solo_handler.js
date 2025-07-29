const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    // =======================================================================
    // =============== START OF ADDED INFILTRATOR LOGIC ======================
    // =======================================================================
    // This block handles the special 'infiltrator' power.
    // If the player is an infiltrator, this logic runs and returns.
    // If not, the function proceeds to the original, unmodified code below.
    if (player.power === 'infiltrator') {
        const userId = player.googleId;
        const isInitialBaseClaim = !!baseClaim;

        if (isInitialBaseClaim) {
            console.log(`\n\n[DEBUG] =================== NEW INFILTRATOR STAGING ===================`);
            // This is the first part of the move: defining the start point.
            // It doesn't actually claim land, just stages the polygon for the next move.
            const center = [baseClaim.lng, baseClaim.lat];
            const radius = baseClaim.radius || 10; // Infiltrator start point is a small anchor
            player.infiltratorStagedPolygon = turf.circle(center, radius, { units: 'meters' });

            // Check that the staging area is inside the player's own territory.
            const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
            if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
                const intersectsCheck = await client.query(
                    `SELECT ST_Intersects($1::geometry, ST_GeomFromGeoJSON($2)) as connects`,
                    [userExisting.rows[0].area, JSON.stringify(player.infiltratorStagedPolygon.geometry)]
                );
                if (!intersectsCheck.rows[0].connects) {
                    socket.emit('claimRejected', { reason: 'Infiltrator move must start inside your territory.' });
                    player.infiltratorStagedPolygon = null; // Clear invalid stage
                    return null;
                }
            } else {
                 socket.emit('claimRejected', { reason: 'You must have a base to start an infiltration.' });
                 return null;
            }

            console.log('[DEBUG] Infiltrator move staged successfully.');
            socket.emit('infiltratorMoveStaged');
            return null; // Stop execution here, wait for the second part of the move.

        } else {
            // This is the second part of the move: the trail completes the loop.
            console.log(`\n\n[DEBUG] =================== NEW INFILTRATOR CLAIM ===================`);
            if (!player.infiltratorStagedPolygon) {
                socket.emit('claimRejected', { reason: 'Infiltrator move not started. Place a start point first.' });
                return null;
            }
            if (trail.length < 3) {
                 socket.emit('claimRejected', { reason: 'Infiltration trail is too short.' });
                 return null;
            }

            // Combine the staged start point and the new trail to form the full attack polygon.
            const trailPolygon = turf.polygon([[...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]]]);
            const newAreaPolygon = turf.union(player.infiltratorStagedPolygon, trailPolygon);
            player.infiltratorStagedPolygon = null; // Consume the staged polygon

            const newAreaSqM = turf.area(newAreaPolygon);
            console.log(`[DEBUG] Infiltrator attack area: ${newAreaSqM.toFixed(2)} sqm`);

            const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
            const affectedOwnerIds = new Set([userId]);
            let totalStolenGeom = null;

            const victims = await client.query(`
                SELECT owner_id, username, area FROM territories
                WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
            `, [userId]);

            console.log(`[DEBUG] Infiltrating ${victims.rowCount} enemy territories.`);

            for (const victim of victims.rows) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG] Carving from ${victim.username}`);

                // Calculate the actual piece of land being stolen (the intersection).
                const stolenPieceRes = await client.query(`SELECT ST_Intersection(${newAreaWKT}, $1::geometry) as stolen_geom`, [victim.area]);
                const stolenPiece = stolenPieceRes.rows[0].stolen_geom;

                // Update the victim's territory by removing the stolen piece.
                await client.query(`
                    UPDATE territories
                    SET area = ST_Difference(area, $1::geometry),
                        area_sqm = ST_Area(ST_Difference(area, $1::geometry)::geography)
                    WHERE owner_id = $2
                `, [stolenPiece, victim.owner_id]);

                // Add the stolen piece to the collection of land for the attacker.
                if (!totalStolenGeom) {
                    totalStolenGeom = stolenPiece;
                } else {
                    const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as geom`, [totalStolenGeom, stolenPiece]);
                    totalStolenGeom = unionRes.rows[0].geom;
                }
            }

            if (!totalStolenGeom) {
                console.log(`[REJECTED] Infiltration did not overlap with any enemy territory.`);
                socket.emit('claimRejected', { reason: 'Your loop must enclose enemy territory.' });
                return null;
            }

            // Merge the newly acquired land with the attacker's existing territory.
            const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
            const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, totalStolenGeom]);
            const finalArea = unionRes.rows[0].final_area;

            const patched = await client.query(`
                SELECT
                    ST_AsGeoJSON(ST_CollectionExtract(ST_Multi(ST_MakeValid($1)), 3)) AS geojson,
                    ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
            `, [finalArea]);

            const finalAreaGeoJSON = patched.rows[0].geojson;
            const finalAreaSqM = patched.rows[0].area_sqm || 0;

            await client.query(`
                UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                WHERE owner_id = $3
            `, [finalAreaGeoJSON, finalAreaSqM, userId]);

            console.log(`[SUCCESS] Infiltration committed: +${turf.area(turf.geomFromWKT(totalStolenGeom)).toFixed(2)} sqm`);
            return {
                finalTotalArea: finalAreaSqM,
                areaClaimed: newAreaSqM, // This is the loop area, not the stolen area
                ownerIdsToUpdate: Array.from(affectedOwnerIds)
            };
        }
    }
    // =======================================================================
    // ================= END OF ADDED INFILTRATOR LOGIC ======================
    // =======================================================================


    // =======================================================================
    // =============== ORIGINAL UNMODIFIED SCRIPT STARTS HERE ================
    // =======================================================================
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

    let newAreaPolygon, newAreaSqM;

    if (isInitialBaseClaim) {
        console.log(`[DEBUG] Processing Initial Base Claim`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;

        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (err) {
            console.log(`[ERROR] Failed to generate base circle: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);

        if (check.rowCount > 0) {
            console.log(`[REJECTED] Base overlaps existing territory`);
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
            return null;
        }
    } else {
        console.log(`[DEBUG] Processing Expansion Claim`);
        if (trail.length < 3) {
            console.log(`[REJECTED] Trail too short`);
            socket.emit('claimRejected', { reason: 'Need at least 3 points.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch (err) {
            console.log(`[ERROR] Invalid polygon: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid polygon geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG] Expansion Area: ${newAreaSqM.toFixed(2)} sqm`);

        if (newAreaSqM < 100) {
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'You must claim a base before expanding.' });
            return null;
        }

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            console.log(`[REJECTED] Expansion does not connect`);
            socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing land.' });
            return null;
        }
    }

    console.log(`[DEBUG] Calculating geometry overlaps and adjustments...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    console.log(`[DEBUG] Overlapping enemies found: ${victims.rowCount}`);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            console.log(`[DEBUG] ${victim.username} is shielded, skipping carve.`);
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            const diff = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = diff.rows[0].final_geom;
            continue;
        }

        console.log(`[DEBUG] Absorbing ${victim.username}`);
        const merge = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
        attackerNetGainGeom = merge.rows[0].final_geom;

        await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
    }

    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        console.log(`[DEBUG] Merging with existing area`);
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const patched = await client.query(`
        SELECT
            ST_AsGeoJSON(
                ST_CollectionExtract(ST_Multi(ST_RemoveRepeatedPoints(ST_MakeValid($1))), 3)
            ) AS geojson,
            ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
    `, [finalArea]);

    const finalAreaGeoJSON = patched.rows[0].geojson;
    const finalAreaSqM = patched.rows[0].area_sqm || 0;
    console.log(`[DEBUG] Final total area: ${finalAreaSqM.toFixed(2)} sqm`);

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Final area is invalid.' });
        return null;
    }

    await client.query(`
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
            CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE
        SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
            original_base_point = CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326)
                                       ELSE territories.original_base_point END;
    `, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, isInitialBaseClaim, baseClaim?.lng, baseClaim?.lat]);

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;