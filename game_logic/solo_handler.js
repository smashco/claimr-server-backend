const turf = require('@turf/turf');

// Helper function (no changes needed here)
async function getArea(client, geom) {
    if (!geom) return 0;
    try {
        const result = await client.query('SELECT ST_Area($1::geography) as area', [geom]);
        return result.rows[0].area || 0;
    } catch (e) { return -1; }
}

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM (v19 Ambiguity Fix) ===================`);
    console.log(`[DEBUG] [STEP 1] INITIATION`);
    console.log(`[DEBUG]   - Attacker: ${player.name} (${player.id})`);

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
        console.log(`[DEBUG]   - New Claim Loop Area: ${newAreaSqM.toFixed(2)} sqm.`);
    } catch(e) {
        console.error('[DEBUG] FATAL: Geometry creation failed.', e);
        socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); 
        return null;
    }
    
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);
    
    // --- SECTION 2: CALCULATE TOTAL INFLUENCE & FIND VICTIMS ---
    const attackerExistingAreaRes = await client.query('SELECT area, area_sqm FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    const attackerInitialAreaSqM = attackerExistingAreaRes.rows.length > 0 ? (attackerExistingAreaRes.rows[0].area_sqm || 0) : 0;
    console.log(`[DEBUG] [STEP 2] CALCULATING INFLUENCE ZONE`);
    console.log(`[DEBUG]   - Attacker's Area BEFORE claim: ${attackerInitialAreaSqM.toFixed(2)} sqm.`);
    
    const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
    const attackerInfluenceZone = influenceResult.rows[0].full_influence;
    let attackerFinalGeom = attackerInfluenceZone; 
    
    console.log(`[DEBUG]   - Attacker's Total Influence Zone Area: ${(await getArea(client, attackerInfluenceZone)).toFixed(2)} sqm.`);
    
    const victimsResult = await client.query(`SELECT owner_id, username, area, area_sqm, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerInfluenceZone]);
    console.log(`[DEBUG] [STEP 3] PROCESSING VICTIMS`);
    console.log(`[DEBUG]   - Found ${victimsResult.rowCount} potential victims in influence zone.`);

    for (const victim of victimsResult.rows) {
        affectedOwnerIds.add(victim.owner_id);
        
        if (victim.is_shield_active) {
            console.log(`[DEBUG]   - Processing SHIELDED victim: ${victim.username}.`);
            const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalGeom, victim.area]);
            attackerFinalGeom = protectedResult.rows[0].final_geom;
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
        } else {
            console.log(`[DEBUG]   - Processing UNSHIELDED victim: ${victim.username}.`);
            const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3)) as remaining_geojson;`, [victim.area, attackerInfluenceZone]);
            const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
            const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
            
            if (remainingSqM < 1) {
                console.log(`[DEBUG]     [DECISION] Victim consumed by attack -> WIPEOUT.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                console.log(`[DEBUG]     [DECISION] Partial hit. Victim's new area: ${remainingSqM.toFixed(2)} sqm.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
            }
        }
    }

    // --- SECTION 4: SAVE ATTACKER'S FINAL STATE ---
    console.log(`[DEBUG] [STEP 4] SAVING ATTACKER STATE`);
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalGeom]);
    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;
    
    // ** THE FIX IS HERE **
    // Explicitly reference `territories.original_base_point` to resolve ambiguity.
    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
    console.log(`[DEBUG]   - Attacker state saved. Final Area: ${finalAreaSqM.toFixed(2)} sqm`);

    // --- SECTION 4.5: POST-CLAIM ENCIRCLEMENT CLEANUP ---
    console.log(`[DEBUG] [STEP 4.5] POST-CLAIM ENCIRCLEMENT CLEANUP`);
    const encircledVictims = await client.query(`
        SELECT owner_id, username FROM territories 
        WHERE owner_id != $1 
        AND is_shield_active = false 
        AND NOT ST_IsEmpty(area) 
        AND ST_Within(area, ST_GeomFromGeoJSON($2));
    `, [userId, finalAreaGeoJSON]);

    if (encircledVictims.rowCount > 0) {
        console.log(`[DEBUG]   - Found ${encircledVictims.rowCount} unshielded players now fully inside the new territory.`);
        for (const victim of encircledVictims.rows) {
            console.log(`[DEBUG]     -> Wiping out encircled victim: ${victim.username}`);
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            affectedOwnerIds.add(victim.owner_id);
        }
    } else {
        console.log(`[DEBUG]   - No new unshielded islands were created.`);
    }

    // --- SECTION 5: FINALIZE AND RETURN ---
    console.log(`[DEBUG] [STEP 5] CLAIM COMPLETE`);
    console.log(`[DEBUG]   - Final Total Area: ${finalAreaSqM.toFixed(2)}`);
    console.log(`[DEBUG]   - Area of this Claim: ${newAreaSqM.toFixed(2)}`);
    console.log(`[DEBUG]   - Owner IDs to Update: ${Array.from(affectedOwnerIds).join(', ')}`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;