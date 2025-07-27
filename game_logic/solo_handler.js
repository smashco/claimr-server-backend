const turf = require('@turf/turf');

// Helper function to save the attacker's final territory state.
async function saveAttackerTerritory(client, userId, playerName, finalGeom, isInitialBaseClaim, baseClaim) {
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [finalGeom]);
    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        console.log(`[DEBUG] Final attacker area is null or empty. Updating to empty.`);
        await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [userId]);
        return;
    }

    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, playerName, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
}

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM PROCESS (v9 Diagram Logic) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id}) | Superpowers: Infiltrator=${player.isInfiltratorActive}`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    let newAreaPolygon, newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM GEOMETRY ---
    if (isInitialBaseClaim) {
        newAreaPolygon = turf.circle([baseClaim.lng, baseClaim.lat], baseClaim.radius || 30, { units: 'meters' });
    } else {
        if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Trail is too short.' }); return null; }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try { newAreaPolygon = turf.polygon([pointsForPolygon]); } catch (e) { socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null; }
    }
    newAreaSqM = turf.area(newAreaPolygon);
    if (newAreaSqM < 100 && !isInitialBaseClaim) { socket.emit('claimRejected', { reason: 'Area is too small (min 100sqm).' }); return null; }
    console.log(`[DEBUG]   => Geometry validation PASSED. New area: ${newAreaSqM.toFixed(2)} sqm.`);
    
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    // --- SECTION 2: PROCESS SPECIAL CLAIM TYPES (INFILTRATOR) ---
    if (isInitialBaseClaim && player.isInfiltratorActive) {
        console.log(`[DEBUG] SECTION 2: INFILTRATOR 'CARVE OUT' claim.`);
        const victimRes = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1 LIMIT 1;`, [userId]);

        if (victimRes.rowCount === 0) { socket.emit('claimRejected', { reason: 'Infiltrator base must be inside enemy territory.' }); return null; }
        
        const victim = victimRes.rows[0];
        affectedOwnerIds.add(victim.owner_id);
        console.log(`[DEBUG]   => Target found: ${victim.username}`);

        if (victim.is_shield_active) {
            console.log(`[DEBUG]   => Target is SHIELDED. Infiltrator attack failed.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            socket.emit('claimRejected', { reason: 'Infiltrator attack blocked by shield!' });
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if(victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            return null;
        }

        console.log(`[DEBUG]   => Carving new base from ${victim.username}'s territory.`);
        const carveQuery = `UPDATE territories SET area = ST_CollectionExtract(ST_MakeValid(ST_Difference(area, ${newAreaWKT})), 3) WHERE owner_id = $1;`;
        await client.query(carveQuery, [victim.owner_id]);
        
        const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
        const finalUnionResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS final_area`, [attackerExistingArea]);
        await saveAttackerTerritory(client, userId, player.name, finalUnionResult.rows[0].final_area, true, baseClaim);
        
        player.isInfiltratorActive = false; // Consume the power
    } else {
        // --- SECTION 3: PROCESS REGULAR CLAIMS (EXPANSION / ATTACK) ---
        console.log(`[DEBUG] SECTION 2/3: REGULAR claim processing.`);
        const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
        const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
        let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;
        
        const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);
        
        // First Pass: Process Shields. This modifies the attacker's final geometry.
        for (const victim of victimsResult.rows) {
            if (victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   - Shield detected for ${victim.username}. Punching hole in claim.`);
                const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
                attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            }
        }

        // Second Pass: Process Damage for unshielded players using the final, modified attacker geometry.
        for (const victim of victimsResult.rows) {
            if (!victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   - Calculating damage for unshielded ${victim.username}.`);
                const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3)) as remaining_geojson;`, [victim.area, attackerFinalAreaGeom]);
                const remainingSqM = (remainingResult.rows[0].remaining_geojson) ? (turf.area(JSON.parse(remainingResult.rows[0].remaining_geojson)) || 0) : 0;
                if (remainingSqM < 1) {
                    console.log(`[DEBUG]     -> Wiped out.`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                } else {
                    console.log(`[DEBUG]     -> Partially hit. Remaining: ${remainingSqM.toFixed(2)} sqm`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingResult.rows[0].remaining_geojson, remainingSqM, victim.owner_id]);
                }
            }
        }
        await saveAttackerTerritory(client, userId, player.name, attackerFinalAreaGeom, isInitialBaseClaim, baseClaim);
    }
    
    // --- SECTION 4: FINALIZE AND RETURN ---
    const finalAttackerArea = await client.query('SELECT area_sqm FROM territories WHERE owner_id = $1', [userId]);
    return {
        finalTotalArea: finalAttackerArea.rows[0]?.area_sqm || 0,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;