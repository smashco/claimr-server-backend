const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!(baseClaim && baseClaim.lat && baseClaim.lng);
    const playerPower = (player.power || '').toLowerCase();

    // =========================================================
    // ⛔ GUARD: Prevent Infiltrator from falling into normal claim
    // =========================================================
    if (playerPower === 'infiltrator' && isInitialBaseClaim && !trail?.length) {
        const hasStaged = !!player.infiltratorStagedPolygon;
        if (!hasStaged) {
            socket.emit('claimRejected', { reason: 'Use your Infiltrator power correctly: first stage a point, then carve a path.' });
            return null;
        }
    }

    // =========================================================
    // 🕵️ INFILTRATOR POWER LOGIC
    // =========================================================
    if (playerPower === 'infiltrator') {
        // --- Step 1: User places the initial circle in their own base ---
        if (isInitialBaseClaim) {
            console.log(`[DEBUG] =================== INFILTRATOR STAGING (INITIAL CIRCLE) ===================`);
            const center = [baseClaim.lng, baseClaim.lat];
            const radius = baseClaim.radius || 10;
            player.infiltratorStagedPolygon = turf.circle(center, radius, { units: 'meters' });

            const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
            if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
                // Check that the staging circle is inside the player's own land
                const intersectsCheck = await client.query(
                    `SELECT ST_Intersects($1::geometry, ST_GeomFromGeoJSON($2)) as connects`,
                    [userExisting.rows[0].area, JSON.stringify(player.infiltratorStagedPolygon.geometry)]
                );
                if (!intersectsCheck.rows[0].connects) {
                    socket.emit('claimRejected', { reason: 'Infiltrator staging must start inside your own land.' });
                    player.infiltratorStagedPolygon = null;
                    return null;
                }
            } else {
                socket.emit('claimRejected', { reason: 'You must have a base before using Infiltrator.' });
                return null;
            }

            socket.emit('infiltratorMoveStaged');
            return null;
        } 
        // --- Step 2: User carves a path into enemy territory and returns to their base ---
        else {
            console.log(`[DEBUG] =================== INFILTRATOR EXECUTION (CARVE & MERGE) ===================`);

            if (!player.infiltratorStagedPolygon) {
                socket.emit('claimRejected', { reason: 'No Infiltrator staging point found. Tap your land first.' });
                return null;
            }
            if (!trail || trail.length < 3) {
                socket.emit('claimRejected', { reason: 'Infiltrator trail must form a loop.' });
                return null;
            }

            // Create a polygon from the trail the user carved
            const trailPolygon = turf.polygon([[...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]]]);

            // --- Step 3: Merge the initial circle with the carved area ---
            // This combines the starting circle with the expansion trail into one big shape.
            const fullInfiltratorPolygon = turf.union(player.infiltratorStagedPolygon, trailPolygon);
            player.infiltratorStagedPolygon = null; // Clear the staged polygon for the next use

            const infiltratorAreaSqM = turf.area(fullInfiltratorPolygon);
            console.log(`[DEBUG] Infiltrator total merged area (trail + circle): ${infiltratorAreaSqM.toFixed(2)} sqm`);

            const fullInfilGeoJSON = JSON.stringify(fullInfiltratorPolygon.geometry);
            const fullInfilWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${fullInfilGeoJSON}'))`;

            // Find all enemy territories that this new shape intersects with
            const victims = await client.query(`
                SELECT owner_id, username, area FROM territories
                WHERE ST_Intersects(area, ${fullInfilWKT}) AND owner_id != $1;
            `, [userId]);

            console.log(`[DEBUG] Infiltrator targeting ${victims.rowCount} enemy territories`);

            let affectedOwnerIds = new Set();
            let carvedSuccess = false;

            // --- Step 4: Use the total merged area to create a hole/island in enemy land ---
            for (const victim of victims.rows) {
                affectedOwnerIds.add(victim.owner_id);

                // The ST_Difference function subtracts the infiltrator's shape from the victim's territory.
                const carved = await client.query(`
                    SELECT ST_Difference($1::geometry, ${fullInfilWKT}) AS updated_geom,
                           ST_Area(ST_Difference($1::geometry, ${fullInfilWKT})::geography) AS updated_area
                `, [victim.area]);

                const updatedGeom = carved.rows[0].updated_geom;
                const updatedAreaSqM = carved.rows[0].updated_area;

                if (updatedGeom && updatedAreaSqM > 0) {
                    carvedSuccess = true;
                    // Update the victim's territory with the new, smaller geometry
                    await client.query(`
                        UPDATE territories
                        SET area = $1::geometry, area_sqm = $2
                        WHERE owner_id = $3
                    `, [updatedGeom, updatedAreaSqM, victim.owner_id]);
                } else {
                    // If the difference is empty, the victim lost all their land
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
                }
            }

            if (!carvedSuccess && victims.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Your loop must carve into enemy land.' });
                return null;
            }

            console.log(`[SUCCESS] Infiltrator island carved into enemy land.`);
            // Infiltrator does not gain any territory, only destroys
            return {
                finalTotalArea: 0,
                areaClaimed: 0,
                ownerIdsToUpdate: Array.from(affectedOwnerIds)
            };
        }
    }

    // =========================================================
    // 🧱 NORMAL BASE / EXPANSION CLAIM LOGIC
    // =========================================================
    console.log(`[DEBUG] =================== NEW CLAIM ===================`);
    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

    let newAreaPolygon, newAreaSqM;

    if (isInitialBaseClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (err) {
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);

        if (check.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
            return null;
        }
    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Trail must form a polygon.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch (err) {
            socket.emit('claimRejected', { reason: 'Invalid polygon geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) {
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'You must place a base first.' });
            return null;
        }

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your land.' });
            return null;
        }
    }

    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);
            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            const diff = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = diff.rows[0].final_geom;
            continue;
        }

        const merge = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
        attackerNetGainGeom = merge.rows[0].final_geom;
        await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
    }

    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const patched = await client.query(`
        SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Multi(ST_RemoveRepeatedPoints(ST_MakeValid($1))), 3)) AS geojson,
               ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
    `, [finalArea]);

    const finalAreaGeoJSON = patched.rows[0].geojson;
    const finalAreaSqM = patched.rows[0].area_sqm || 0;

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