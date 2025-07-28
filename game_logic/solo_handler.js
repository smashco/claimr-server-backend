const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v13 Final Logic) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

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
    
    // --- SECTION 2: CALCULATE ATTACKER'S TOTAL INFLUENCE ---
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    
    const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
    let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;

    console.log(`[DEBUG] Attacker's potential total area (influence zone) calculated.`);
    
    // --- SECTION 3: PROCESS VICTIMS ---
    const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);
    console.log(`[DEBUG] SECTION 3: Found ${victimsResult.rowCount} potential victims in influence zone.`);

    // First Pass: Handle Shields. This modifies the attacker's final geometry for the turn.
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

    // Second Pass: Process Damage for unshielded players using the final, modified attacker geometry.
    for (const victim of victimsResult.rows) {
        if (!victim.is_shield_active) {
            affectedOwnerIds.add(victim.owner_id);
            console.log(`[DEBUG]   [PASS 2] Processing unshielded victim: ${victim.username}.`);
            
            // ** THE FIX: Use ST_Relate for a robust encirclement check. **
            // The pattern 'T*F**F***' checks if a geometry is truly *within* another without touching boundaries.
            const encirclementCheck = await client.query("SELECT ST_Relate($1::geometry, $2::geometry, 'T*F**F***') as is_encircled", [victim.area, attackerFinalAreaGeom]);

            if (encirclementCheck.rows[0].is_encircled) {
                console.log(`[DEBUG]     [DECISION] ST_Relate confirmed victim is encircled -> WIPEOUT.`);
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

    // --- SECTION 4: SAVE ATTACKER'S FINAL STATE ---
    console.log(`[DEBUG] SECTION 4: Saving final state for attacker ${player.name}.`);
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;

    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
    console.log(`[DEBUG]   => Attacker state saved successfully. Final Area: ${finalAreaSqM.toFixed(2)} sqm`);

    // --- SECTION 5: FINALIZE AND RETURN ---
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;