const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v16 Final Combined Logic) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id}) | Infiltrator Active: ${player.isInfiltratorActive}`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive;

    let newAreaPolygon, newAreaSqM;

    // --- SECTION 1: VALIDATE & CREATE GEOMETRY ---
    try {
        if (isInitialBaseClaim) {
            newAreaPolygon = turf.circle([baseClaim.lng, baseClaim.lat], baseClaim.radius || 30, { units: 'meters' });
        } else {
            if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Trail is too short.' }); return null; }
            const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100 && !isInitialBaseClaim) { socket.emit('claimRejected', { reason: 'Area is too small (min 100sqm).' }); return null; }
        console.log(`[DEBUG] SECTION 1: Geometry validation PASSED. New area: ${newAreaSqM.toFixed(2)} sqm.`);
    } catch(e) {
        console.error('[DEBUG] FATAL: Geometry creation failed.', e);
        socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); 
        return null;
    }
    
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    // --- SECTION 2: PROCESS SPECIAL CLAIM (INFILTRATOR) ---
    // This block is taken directly from your v15 logic.
    if (isInitialBaseClaim && isInfiltrator) {
        console.log(`[DEBUG] SECTION 2: INFILTRATOR 'CARVE OUT' claim.`);
        const infiltrateQuery = `SELECT owner_id, username, is_shield_active, area FROM territories WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1 LIMIT 1`;
        const result = await client.query(infiltrateQuery, [userId]);

        if (result.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'Infiltrator base must be inside enemy territory.' });
            return null;
        }

        const victim = result.rows[0];
        const victimId = victim.owner_id;

        if (victim.is_shield_active) {
            console.log(`[DEBUG]     - Victim ${victim.username} is SHIELDED. Infiltration failed.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator base.` });

            const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victimId);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            player.isInfiltratorActive = false; // Consume power on failed attempt
            return null;
        }

        console.log(`[DEBUG]     - Carving new base from unshielded victim: ${victim.username}.`);
        await client.query(`UPDATE territories SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})), area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography) WHERE owner_id = $1`, [victimId]);
        
        const saveQuery = `
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ${newAreaWKT}, $3, ST_SetSRID(ST_Point($4, $5), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET area = ${newAreaWKT}, area_sqm = $3, original_base_point = ST_SetSRID(ST_Point($4, $5), 4326);
        `;
        await client.query(saveQuery, [userId, player.name, newAreaSqM, baseClaim.lng, baseClaim.lat]);
        
        player.isInfiltratorActive = false; // Consume power on success
        affectedOwnerIds.add(victimId);

    } else {
        // --- SECTION 3: PROCESS REGULAR CLAIMS (Expansion / Regular Base / Attack) ---
        // This block uses the robust "Total Influence Zone" and "ST_Relate" logic.
        console.log(`[DEBUG] SECTION 2/3: REGULAR claim processing.`);
        if (!isInitialBaseClaim) {
            const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
            if (existingUserAreaRes.rowCount === 0 || turf.area(JSON.parse(existingUserAreaRes.rows[0].geojson_area)) === 0) { socket.emit('claimRejected', { reason: 'You must have a base to expand.' }); return null; }
            const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingUserAreaRes.rows[0].geojson_area]);
            if (!intersectsExisting) { socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' }); return null; }
        }

        const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const attackerExistingArea = attackerExistingAreaRes.rows[0]?.area || `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
        const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
        let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;
        
        const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);
        
        // Pass 1: Handle Shields
        for (const victim of victimsResult.rows) {
            if (victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   [PASS 1] Shield detected for ${victim.username}. Punching hole.`);
                const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
                attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            }
        }

        // Pass 2: Handle Unshielded
        for (const victim of victimsResult.rows) {
            if (!victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   [PASS 2] Processing unshielded victim: ${victim.username}.`);
                const encirclementCheck = await client.query("SELECT ST_Relate($1::geometry, $2::geometry, 'T*F**F***') as is_encircled", [victim.area, attackerFinalAreaGeom]);
                
                if (encirclementCheck.rows[0].is_encircled) {
                    console.log(`[DEBUG]     [DECISION] Victim is fully encircled -> WIPEOUT.`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                } else {
                    console.log(`[DEBUG]     [DECISION] Victim is not encircled, processing as partial hit.`);
                    const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3)) as remaining_geojson;`, [victim.area, attackerFinalAreaGeom]);
                    const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
                    const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
                    if (remainingSqM < 1) {
                         await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                    } else {
                         await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
                    }
                }
            }
        }
        
        const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
        const finalAreaGeoJSON = finalResult.rows[0].geojson;
        const finalAreaSqM = finalResult.rows[0].area_sqm || 0;
        
        const saveQuery = `
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
            ON CONFLICT (owner_id) DO UPDATE SET area = ST_GeomFromGeoJSON($3), area_sqm = $4;
        `;
        await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
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