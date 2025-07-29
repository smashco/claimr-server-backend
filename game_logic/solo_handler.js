const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v16 Final Targeted Fix) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive; // Use the established in-memory flag

    let newAreaPolygon, newAreaSqM;

    // --- Part 1: Initial Claim Logic (Base or Infiltrator) ---
    // THIS SECTION IS UNCHANGED
    if (isInitialBaseClaim) {
        console.log(`[DEBUG] SECTION 1: Processing Initial Base Claim.`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        
        try { newAreaPolygon = turf.circle(center, radius, { units: 'meters' }); } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        
        if (isInfiltrator) {
            console.log(`[DEBUG]   => Mode: INFILTRATOR.`);
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
                player.isInfiltratorActive = false;
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
            
            player.isInfiltratorActive = false;
            return {
                finalTotalArea: newAreaSqM,
                areaClaimed: newAreaSqM,
                ownerIdsToUpdate: [victimId, userId]
            };
        } else {
            console.log(`[DEBUG]   => Mode: REGULAR BASE.`);
            const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`;
            const intersectionResult = await client.query(intersectionCheckQuery);

            if (intersectionResult.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
    } else {
        // --- Part 2: Expansion Logic ---
        // THIS SECTION IS UNCHANGED
        console.log(`[DEBUG] SECTION 1: Processing Expansion Claim.`);
        if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' }); return null; }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try { newAreaPolygon = turf.polygon([pointsForPolygon]); } catch (e) { socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null; }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' }); return null; }
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
        if (existingUserAreaRes.rowCount === 0 || turf.area(JSON.parse(existingUserAreaRes.rows[0].geojson_area)) === 0) { socket.emit('claimRejected', { reason: 'You must have a base to expand.' }); return null; }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingUserAreaRes.rows[0].geojson_area]);
        if (!intersectsExisting.rows[0].intersects) { socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' }); return null; }
    }

    // --- Part 3: Shared Logic for Regular Base & Expansion ---
    console.log(`[DEBUG] SECTION 2: Calculating territory changes...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;
    
    // This pre-calculation is necessary for the encirclement check
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows[0]?.area || `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingArea]);
    const attackerInfluenceZone = influenceResult.rows[0].full_influence;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            console.log(`[DEBUG]   - Victim ${victim.username} is SHIELDED. Punching hole in net gain.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            const protectedResult = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = protectedResult.rows[0].final_geom;
        } else {
            // ========================= THE FIX IS HERE =========================
            // This logic now correctly differentiates between a wipeout and a partial hit.
            const encirclementCheck = await client.query("SELECT ST_Relate($1::geometry, $2::geometry, 'T*F**F***') as is_encircled", [victim.area, attackerInfluenceZone]);
            
            if (encirclementCheck.rows[0].is_encircled) {
                // VICTIM IS ENCIRCLED -> This is a total wipeout, use your absorption logic.
                console.log(`[DEBUG]   - Absorbing ENCIRCLED unshielded victim: ${victim.username}.`);
                const absorptionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victim.area]);
                attackerNetGainGeom = absorptionResult.rows[0].final_geom;
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                // VICTIM IS NOT ENCIRCLED -> This is a partial hit. Only subtract the new loop.
                console.log(`[DEBUG]   - Calculating PARTIAL HIT on unshielded victim: ${victim.username}.`);
                const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_MakeValid(ST_Difference($1::geometry, ${newAreaWKT}))) as remaining_geojson;`, [victim.area]);
                const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
                const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
                
                if (remainingSqM < 1) {
                    await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                } else {
                    await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
                }
            }
            // ======================= END OF THE FIX ========================
        }
    }

    // --- Part 4: Final Merge and Save (Unchanged) ---
    let attackerFinalAreaGeom;
    const attackerCurrentAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerCurrentAreaRes.rowCount > 0 && attackerCurrentAreaRes.rows[0].area) {
        const unionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [attackerCurrentAreaRes.rows[0].area, attackerNetGainGeom]);
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

    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);

    player.isInfiltratorActive = false;

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;