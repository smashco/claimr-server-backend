const turf = require('@turf/turf');

// Helper to get GeoJSON for logging
async function getGeoJSON(client, geom) {
    if (!geom) return 'null';
    try {
        const result = await client.query('SELECT ST_AsGeoJSON($1) as geojson', [geom]);
        return result.rows[0].geojson;
    } catch (e) {
        return `Error getting GeoJSON: ${e.message}`;
    }
}

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v11 Diagram Logic) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id}) | Infiltrator Active: ${player.isInfiltratorActive}`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
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
        
        // Finalize attacker state in DB
        const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [finalUnionResult.rows[0].final_area]);
        await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3`, [finalResult.rows[0].geojson, finalResult.rows[0].area_sqm, userId]);
        
        player.isInfiltratorActive = false;
    } else {
        // --- SECTION 3: PROCESS REGULAR CLAIMS ---
        console.log(`[DEBUG] SECTION 2/3: REGULAR claim processing.`);
        const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
        const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
        let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;
        
        const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);
        
        // Pass 1: Handle Shields (creates islands)
        for (const victim of victimsResult.rows) {
            if (victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   [PASS 1] Shield detected for ${victim.username}. Punching hole in claim.`);
                const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
                attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            }
        }

        // Pass 2: Handle Unshielded (checks for encirclement)
        for (const victim of victimsResult.rows) {
            if (!victim.is_shield_active) {
                affectedOwnerIds.add(victim.owner_id);
                console.log(`[DEBUG]   [PASS 2] Processing unshielded victim: ${victim.username}.`);

                const encirclementCheck = await client.query('SELECT ST_Covers($1::geometry, $2::geometry) as is_covered', [attackerFinalAreaGeom, victim.area]);
                
                if (encirclementCheck.rows[0].is_covered) {
                    console.log(`[DEBUG]     [DECISION] Victim is completely encircled -> WIPEOUT.`);
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                } else {
                    console.log(`[DEBUG]     [DECISION] Victim is not fully covered, processing as partial hit.`);
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
        await client.query(`
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
            ON CONFLICT (owner_id) DO UPDATE SET area = ST_GeomFromGeoJSON($3), area_sqm = $4;
        `, [userId, player.name, finalResult.rows[0].geojson, finalResult.rows[0].area_sqm || 0, baseClaim?.lng, baseClaim?.lat]);
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