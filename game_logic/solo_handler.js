const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v21 Sliver Deletion Fix) ===================`);
    console.log(`[DEBUG] [STEP 1] INITIATION`);
    console.log(`[DEBUG]   - Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    let newAreaPolygon, newAreaSqM;

    // --- SECTION 1: CREATE NEW AREA ---
    try {
        if (isInitialBaseClaim) {
            newAreaPolygon = turf.circle([baseClaim.lng, baseClaim.lat], baseClaim.radius || 30, { units: 'meters' });
        } else {
            if (trail.length < 3) {
                socket.emit('claimRejected', { reason: 'Trail is too short.' });
                return null;
            }
            const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        }

        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100 && !isInitialBaseClaim) {
            socket.emit('claimRejected', { reason: 'Area is too small (min 100sqm).' });
            return null;
        }
        console.log(`[DEBUG]   - New Claim Loop Area: ${newAreaSqM.toFixed(2)} sqm.`);
    } catch (e) {
        console.error('[DEBUG] FATAL: Geometry creation failed.', e);
        socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
        return null;
    }

    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    // --- SECTION 2: CALCULATE INFLUENCE ZONE ---
    console.log(`[DEBUG] [STEP 2] CALCULATING INFLUENCE & INITIAL STATE`);
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;

    const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
    let attackerFinalGeom = influenceResult.rows[0].full_influence;

    const victimsResult = await client.query(`
        SELECT owner_id, username, area, area_sqm, is_shield_active
        FROM territories
        WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)
    `, [userId, attackerFinalGeom]);

    const allInvolvedIds = new Set([userId, ...victimsResult.rows.map(v => v.owner_id)]);
    const beforeStateRes = await client.query('SELECT username, area_sqm FROM territories WHERE owner_id = ANY($1::varchar[])', [Array.from(allInvolvedIds)]);
    console.log(`[DEBUG]   --- TRANSACTION STATE: BEFORE ---`);
    for (const row of beforeStateRes.rows) {
        console.log(`[DEBUG]     - Player: ${row.username}, Area: ${(row.area_sqm || 0).toFixed(2)} sqm`);
    }
    console.log(`[DEBUG]   ------------------------------------`);

    // --- SECTION 3: PROCESS VICTIMS ---
    console.log(`[DEBUG] [STEP 3] PROCESSING ${victimsResult.rowCount} VICTIMS`);
    for (const victim of victimsResult.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            console.log(`[DEBUG]   - ACTION: ${victim.username}'s SHIELD is active. Punching hole in attacker's claim.`);

            const protectedResult = await client.query(`
                SELECT ST_MakeValid(
                    ST_Buffer(
                        ST_SnapToGrid(
                            ST_Difference($1::geometry, $2::geometry),
                            0.0000001
                        ), 0
                    )
                ) as final_geom
            `, [attackerFinalGeom, victim.area]);

            attackerFinalGeom = protectedResult.rows[0].final_geom;
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);

            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

        } else {
            console.log(`[DEBUG]   - ACTION: Processing UNSHIELDED victim ${victim.username}.`);
            const encirclementCheck = await client.query(`SELECT ST_Within($1::geometry, $2::geometry) as is_encircled`, [victim.area, attackerFinalGeom]);

            if (encirclementCheck.rows[0].is_encircled) {
                console.log(`[DEBUG]     -> DECISION: Victim is ENCIRCLED. Result: WIPEOUT.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
            } else {
                const remainingResult = await client.query(`
                    SELECT ST_AsGeoJSON(
                        ST_MakeValid(
                            ST_Buffer(
                                ST_SnapToGrid(
                                    ST_Difference($1::geometry, $2::geometry),
                                    0.0000001
                                ), 0
                            )
                        )
                    ) as remaining_geojson
                `, [victim.area, attackerFinalGeom]);

                const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
                const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;

                const originalSqM = victim.area_sqm || 0;
                const wipeThreshold = 1000;
                const percentThreshold = 0.10;

                if (remainingSqM < wipeThreshold || remainingSqM < (originalSqM * percentThreshold)) {
                    console.log(`[DEBUG]     -> DECISION: Remaining area too small (${remainingSqM.toFixed(2)} sqm). Result: WIPEOUT.`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
                } else {
                    console.log(`[DEBUG]     -> DECISION: Partial hit. Victim's new area: ${remainingSqM.toFixed(2)} sqm.`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
                }
            }
        }
    }

    // --- SECTION 4: SAVE FINAL ATTACKER STATE ---
    console.log(`[DEBUG] [STEP 4] SAVING ATTACKER STATE & CLEANUP`);

    const finalResult = await client.query(`
        SELECT
            ST_AsGeoJSON(
                ST_MakeValid(
                    ST_Buffer(
                        ST_SnapToGrid($1::geometry, 0.0000001),
                        0
                    )
                )
            ) as geojson,
            ST_Area(
                ST_MakeValid(
                    ST_Buffer(
                        ST_SnapToGrid($1::geometry, 0.0000001),
                        0
                    )
                )::geography
            ) as area_sqm
    `, [attackerFinalGeom]);

    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;

    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
            CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END
        )
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);

    // --- POST-CLAIM CLEANUP: ENCIRCLEMENT RE-CHECK ---
    if (finalAreaGeoJSON) {
        const encircledVictims = await client.query(`
            SELECT owner_id, username FROM territories 
            WHERE owner_id != $1 AND is_shield_active = false AND NOT ST_IsEmpty(area)
            AND ST_Within(area, ST_GeomFromGeoJSON($2));
        `, [userId, finalAreaGeoJSON]);

        if (encircledVictims.rowCount > 0) {
            console.log(`[DEBUG]   - POST-CLAIM CLEANUP: Found ${encircledVictims.rowCount} newly encircled players.`);
            for (const victim of encircledVictims.rows) {
                console.log(`[DEBUG]     -> Wiping out encircled victim: ${victim.username}`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
                affectedOwnerIds.add(victim.owner_id);
            }
        }
    }

    // --- STATE AFTER LOG ---
    const afterStateRes = await client.query('SELECT username, area_sqm FROM territories WHERE owner_id = ANY($1::varchar[])', [Array.from(affectedOwnerIds)]);
    console.log(`[DEBUG]   --- TRANSACTION STATE: AFTER ---`);
    for (const row of afterStateRes.rows) {
        console.log(`[DEBUG]     - Player: ${row.username}, Area: ${(row.area_sqm || 0).toFixed(2)} sqm`);
    }
    console.log(`[DEBUG]   -----------------------------------`);

    // --- SECTION 5: DONE ---
    console.log(`[DEBUG] [STEP 5] CLAIM COMPLETE`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;
