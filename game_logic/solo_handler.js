const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM PROCESS ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id}) | Superpowers: Infiltrator=${player.isInfiltratorActive}`);
    
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM AND CREATE THE NEW POLYGON ---
    console.log(`[DEBUG] SECTION 1: Validating Claim...`);
    if (isInitialBaseClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG]   => Type: Initial Base Claim. Area: ${newAreaSqM.toFixed(2)} sqm.`);
    } else { // Expansion Claim
        if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Expansion trail must have > 2 points.' }); return null; }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try { newAreaPolygon = turf.polygon([pointsForPolygon]); } catch (e) { socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null; }
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG]   => Type: Expansion Claim. Area: ${newAreaSqM.toFixed(2)} sqm.`);
        
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
        const existingAreaGeoJSON = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].geojson_area : null;
        if (!existingAreaGeoJSON || turf.area(JSON.parse(existingAreaGeoJSON)) === 0) { socket.emit('claimRejected', { reason: 'You must have a base to expand.' }); return null; }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) { socket.emit('claimRejected', { reason: 'Expansion must connect to your territory.' }); return null; }
    }
    console.log(`[DEBUG]   => Claim validation PASSED.`);

    // Use ST_MakeValid to clean the incoming geometry from the client. This prevents many potential errors.
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    // --- SCENARIO A: INFILTRATOR BASE CLAIM ---
    // This logic runs ONLY if the claim is a new base AND the infiltrator power is active.
    if (isInitialBaseClaim && player.isInfiltratorActive) {
        console.log(`[DEBUG] SECTION 2: SCENARIO A - INFILTRATOR 'CARVE OUT'`);
        const victimRes = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1 LIMIT 1;`, [userId]);

        if (victimRes.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'Infiltrator base must be placed inside enemy territory.' });
            return null;
        }
        const victim = victimRes.rows[0];
        affectedOwnerIds.add(victim.owner_id);
        console.log(`[DEBUG]   => Target found: ${victim.username}`);

        if (victim.is_shield_active) {
            console.log(`[DEBUG]   => Target is SHIELDED. Infiltrator attack failed.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            socket.emit('claimRejected', { reason: 'Infiltrator attack blocked by shield!' });
            return null;
        }

        console.log(`[DEBUG]   => Carving new base out of ${victim.username}'s territory.`);
        // Carve the new base area out of the victim's territory, ensuring the result is valid.
        await client.query(`UPDATE territories SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})), area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography) WHERE owner_id = $1;`, [victim.owner_id]);
        
        // Save the new base for the attacker.
        const attackerUpdateQuery = `INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point) VALUES ($1, $2, $2, ${newAreaWKT}, $3, ST_SetSRID(ST_Point($4, $5), 4326)) ON CONFLICT (owner_id) DO UPDATE SET area = ST_MakeValid(ST_Union(territories.area, ${newAreaWKT})), area_sqm = ST_Area(ST_MakeValid(ST_Union(territories.area, ${newAreaWKT}))::geography);`;
        await client.query(attackerUpdateQuery, [userId, player.name, newAreaSqM, baseClaim.lng, baseClaim.lat]);
        
        player.isInfiltratorActive = false; // Consume the power
        console.log(`[DEBUG]   => Infiltrator claim successful.`);
        const finalAreaRes = await client.query('SELECT area_sqm FROM territories WHERE owner_id = $1', [userId]);
        return { finalTotalArea: finalAreaRes.rows[0].area_sqm, areaClaimed: newAreaSqM, ownerIdsToUpdate: Array.from(affectedOwnerIds) };
    }

    // --- Find all players (self and others) intersecting the new loop ---
    const allIntersectingRes = await client.query(`SELECT owner_id FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
    const otherIntersectingIds = allIntersectingRes.rows.map(r => r.owner_id).filter(id => id !== userId);

    // --- SCENARIO B: SELF-ATTACK / FILLING A HOLE ---
    // This logic runs ONLY if the claim is an expansion and it touches NO OTHER players.
    if (otherIntersectingIds.length === 0 && !isInitialBaseClaim) {
        console.log(`[DEBUG] SECTION 2: SCENARIO B - SELF-ATTACK / FILLING HOLE`);
        const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const unionResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS final_area`, [attackerExistingAreaRes.rows[0].area]);
        const finalGeom = unionResult.rows[0].final_area;
        
        const finalAreaResult = await client.query(`SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm`, [finalGeom]);
        
        await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [finalAreaResult.rows[0].geojson, finalAreaResult.rows[0].area_sqm, userId]);
        console.log(`[DEBUG]   => Hole filled successfully. New area: ${finalAreaResult.rows[0].area_sqm.toFixed(2)} sqm.`);
        return { finalTotalArea: finalAreaResult.rows[0].area_sqm, areaClaimed: newAreaSqM, ownerIdsToUpdate: [userId] };
    }

    // --- SCENARIO C: REGULAR COMBAT (ATTACKING OTHERS OR INITIAL BASE) ---
    console.log(`[DEBUG] SECTION 2: SCENARIO C - REGULAR COMBAT/BASE CLAIM`);
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
    const attackerTotalInfluenceGeom = influenceResult.rows[0].full_influence;
    let attackerFinalAreaGeom = attackerTotalInfluenceGeom;
    
    // PHASE 1: DIRECT COMBAT
    console.log(`[DEBUG] SECTION 3: Resolving DIRECT Combat (Phase 1)...`);
    const directHitVictimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id = ANY($1::varchar[])`, [otherIntersectingIds]);
    console.log(`[DEBUG]   => Found ${directHitVictimsResult.rowCount} players directly hit.`);

    for (const victim of directHitVictimsResult.rows) {
        affectedOwnerIds.add(victim.owner_id);
        if (victim.is_shield_active) {
            console.log(`[DEBUG]        - Victim ${victim.username} is SHIELDED. Punching hole in attacker's territory.`);
            const protectedResult = await client.query(`SELECT ST_MakeValid(ST_Difference($1::geometry, $2::geometry)) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
        } else {
            console.log(`[DEBUG]        - Victim ${victim.username} is UNSHIELDED. Calculating damage.`);
            const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_MakeValid(ST_Difference($1::geometry, $2::geometry))) as remaining_geojson;`, [victim.area, attackerTotalInfluenceGeom]);
            const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
            const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
            if (remainingSqM < 1) {
                console.log(`[DEBUG]          => RESULT: WIPEOUT.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                console.log(`[DEBUG]          => RESULT: PARTIAL HIT.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
            }
        }
    }
    
    // PHASE 2: ENCIRCLEMENT CLEANUP
    console.log(`[DEBUG] SECTION 4: Checking for ENCIRCLEMENTS (Phase 2)...`);
    const trappedVictimsResult = await client.query(`SELECT owner_id, username FROM territories WHERE owner_id != $1 AND is_shield_active = false AND NOT ST_IsEmpty(area) AND ST_Covers($2::geometry, area);`, [userId, attackerFinalAreaGeom]);
    if (trappedVictimsResult.rowCount > 0) {
        console.log(`[DEBUG]   => Found ${trappedVictimsResult.rowCount} unshielded players fully encircled.`);
        for (const v of trappedVictimsResult.rows) {
            console.log(`[DEBUG]     -> WIPING OUT encircled victim: ${v.username}`);
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [v.owner_id]);
            affectedOwnerIds.add(v.owner_id);
        }
    } else { console.log(`[DEBUG]   => No encircled players found.`); }

    // SECTION 5: FINALIZE AND SAVE
    console.log(`[DEBUG] SECTION 5: Finalizing Attacker's Territory...`);
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    
    if (!finalResult.rows[0].geojson || finalResult.rows[0].area_sqm < 1) { socket.emit('claimRejected', { reason: 'Claim nullified by protected territories.' }); return null; }
    
    if (isInitialBaseClaim) {
        const q = `INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point) VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, ST_SetSRID(ST_Point($5, $6), 4326)) ON CONFLICT (owner_id) DO UPDATE SET area = ST_GeomFromGeoJSON($3), area_sqm = $4, original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);`;
        await client.query(q, [userId, player.name, finalResult.rows[0].geojson, finalResult.rows[0].area_sqm, baseClaim.lng, baseClaim.lat]);
    } else {
        await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [finalResult.rows[0].geojson, finalResult.rows[0].area_sqm, userId]);
    }

    console.log(`[DEBUG] =================== CLAIM PROCESS END =====================\n\n`);
    return { finalTotalArea: finalResult.rows[0].area_sqm, areaClaimed: newAreaSqM, ownerIdsToUpdate: Array.from(affectedOwnerIds) };
}

module.exports = handleSoloClaim;