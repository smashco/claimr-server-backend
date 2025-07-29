const turf = require('@turf/turf');
// Import the new specialized handler for infiltrator actions
const { handleInfiltratorBaseClaim } = require('./interactions/infiltrator_interaction');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive;

    let newAreaPolygon, newAreaSqM;

    // --- Part 1: Initial Claim Logic (Base or Delegate to Infiltrator) ---
    if (isInitialBaseClaim) {
        console.log(`[DEBUG] SECTION 1: Processing Initial Base Claim.`);
        
        // If it's an infiltrator claim, delegate to the specialized handler and exit.
        if (isInfiltrator) {
            console.log(`[DEBUG]   => Mode: INFILTRATOR. Delegating to handler.`);
            return await handleInfiltratorBaseClaim(io, socket, player, players, baseClaim, client);
        }

        // --- Logic for REGULAR base claims ---
        console.log(`[DEBUG]   => Mode: REGULAR BASE.`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        
        try { newAreaPolygon = turf.circle(center, radius, { units: 'meters' }); } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        
        const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`;
        const intersectionResult = await client.query(intersectionCheckQuery);

        if (intersectionResult.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
            return null;
        }

    } else {
        // --- Part 2: Expansion Logic ---
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

    // --- Part 3: Shared Logic for Regular Base & Expansion (Victim Interactions) ---
    console.log(`[DEBUG] SECTION 2: Calculating territory changes...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;
    
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
            const encirclementCheck = await client.query("SELECT ST_Relate($1::geometry, $2::geometry, 'T*F**F***') as is_encircled", [victim.area, attackerInfluenceZone]);
            
            if (encirclementCheck.rows[0].is_encircled) {
                console.log(`[DEBUG]   - Absorbing ENCIRCLED unshielded victim: ${victim.username}.`);
                const absorptionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victim.area]);
                attackerNetGainGeom = absorptionResult.rows[0].final_geom;
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
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
        }
    }

    // --- Part 4: Final Merge and Save ---
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

    // Reset infiltrator state as a fallback
    player.isInfiltratorActive = false;

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;