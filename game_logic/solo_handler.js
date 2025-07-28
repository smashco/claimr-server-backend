for (const row of intersectingTerritoriesResult.rows) {
    const victimId = row.owner_id;
    const victimCurrentArea = row.area;
    affectedOwnerIds.add(victimId);

    // 1. Shielded Victim → Carve Island and skip
    if (row.is_shield_active) {
        console.log(`[GAME] ${row.username}'s SHIELD ACTIVATED. Carving hole...`);

        // Subtract victim area from attack trail
        const punchHole = await client.query(`
            SELECT ST_Difference($1::geometry, $2::geometry) AS holed
        `, [attackerNetGainGeom, victimCurrentArea]);

        attackerNetGainGeom = punchHole.rows[0].holed;

        // Deactivate shield
        await client.query(`
            UPDATE territories SET is_shield_active = false WHERE owner_id = $1
        `, [victimId]);

        // Notify victim
        const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victimId);
        if (victimSocketId) {
            io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
        }

        continue;
    }

    // 2. Check for containment and overlap status
    const containmentCheck = await client.query(`
        SELECT 
            ST_Contains($1::geometry, $2::geometry) AS fully_inside,
            ST_Intersects($1::geometry, $2::geometry) AS is_intersecting
    `, [attackerNetGainGeom, victimCurrentArea]);

    const isFullyInside = containmentCheck.rows[0].fully_inside;
    const isIntersecting = containmentCheck.rows[0].is_intersecting;

    // 3. Special Case: Fully Surrounded (not intersected) → Wipeout
    if (!isIntersecting && isFullyInside) {
        console.log(`[GAME] ${row.username} was SURROUNDED and WIPED OUT.`);

        const absorb = await client.query(`
            SELECT ST_Union($1::geometry, $2::geometry) AS result
        `, [attackerNetGainGeom, victimCurrentArea]);

        attackerNetGainGeom = absorb.rows[0].result;

        await client.query(`
            UPDATE territories 
            SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 
            WHERE owner_id = $1
        `, [victimId]);

        continue;
    }

    // 4. Standard Full Wipeout (intersect + fully inside)
    if (isIntersecting && isFullyInside) {
        console.log(`[GAME] ${row.username} was INTERSECTED AND CONTAINED → WIPED OUT.`);

        const absorb = await client.query(`
            SELECT ST_Union($1::geometry, $2::geometry) AS result
        `, [attackerNetGainGeom, victimCurrentArea]);

        attackerNetGainGeom = absorb.rows[0].result;

        await client.query(`
            UPDATE territories 
            SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 
            WHERE owner_id = $1
        `, [victimId]);

        continue;
    }

    // 5. Partial Damage
    if (isIntersecting && !isFullyInside) {
        console.log(`[GAME] ${row.username} was PARTIALLY DAMAGED.`);

        const overlap = await client.query(`
            SELECT 
                ST_Intersection($1::geometry, $2::geometry) AS overlap_geom,
                ST_Difference($2::geometry, $1::geometry) AS remaining_geom
        `, [attackerNetGainGeom, victimCurrentArea]);

        const overlapGeom = overlap.rows[0].overlap_geom;
        const remainingGeom = overlap.rows[0].remaining_geom;

        // Update victim territory with remaining part
        const newVictimAreaResult = await client.query(`
            SELECT ST_AsGeoJSON($1) AS geojson, ST_Area($1::geography) AS area_sqm
        `, [remainingGeom]);

        const newVictimGeoJSON = newVictimAreaResult.rows[0].geojson;
        const newVictimSqM = newVictimAreaResult.rows[0].area_sqm;

        await client.query(`
            UPDATE territories 
            SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 
            WHERE owner_id = $3
        `, [newVictimGeoJSON, newVictimSqM, victimId]);

        // Add intersecting chunk to attacker
        const updatedAttacker = await client.query(`
            SELECT ST_Union($1::geometry, $2::geometry) AS result
        `, [attackerNetGainGeom, overlapGeom]);

        attackerNetGainGeom = updatedAttacker.rows[0].result;

        continue;
    }

    // 6. No Action (not intersecting, not contained)
    console.log(`[GAME] ${row.username} was NOT AFFECTED.`);
}
