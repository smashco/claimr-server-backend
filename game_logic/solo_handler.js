const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    console.log(`\n\n[DEBUG] =================== NEW CLAIM PROCESS (Refined) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon, newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM ---
    // (This section is based on your correct validation logic)
    console.log(`[DEBUG] SECTION 1: Validating Claim...`);
    if (isInitialBaseClaim) {
        // For a new base, ensure it's not placed inside any existing territory
        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const intersectionCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`);
        if (intersectionCheck.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
            return null;
        }
        newAreaPolygon = turf.circle([baseClaim.lng, baseClaim.lat], baseClaim.radius || 30, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
    } else { // For an expansion
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail is too short.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try {
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }

        // Ensure expansion connects to existing territory
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1 AND NOT ST_IsEmpty(area)', [userId]); 
        if (existingUserAreaRes.rowCount === 0) { 
            socket.emit('claimRejected', { reason: 'You must have a base to expand.' });
            return null;
        }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingUserAreaRes.rows[0].geojson_area]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }
    console.log(`[DEBUG]   => Claim validation PASSED.`);
    
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    // --- SECTION 2: CALCULATE ATTACKER'S TOTAL INFLUENCE & RESOLVE COMBAT ---
    console.log(`[DEBUG] SECTION 2: Calculating Combat Outcome...`);

    // First, determine the attacker's total potential area for this turn.
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
    let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;

    // Find all victims whose territories are touched by this new total influence.
    const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);
    console.log(`[DEBUG]   => Found ${victimsResult.rowCount} players within the influence zone.`);

    for (const victim of victimsResult.rows) {
        affectedOwnerIds.add(victim.owner_id);
        if (victim.is_shield_active) {
            // SHIELDED: The victim is safe. A "hole" is punched in the attacker's final territory.
            console.log(`[DEBUG]     - Victim ${victim.username} is SHIELDED. Protecting their area.`);
            const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
            
            // Consume the shield.
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

        } else {
            // UNSHIELDED: Calculate the damage. The victim's new area is what's left after subtracting the attacker's total influence.
            console.log(`[DEBUG]     - Victim ${victim.username} is UNSHIELDED. Calculating damage.`);
            const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3)) as remaining_geojson;`, [victim.area, attackerFinalAreaGeom]);
            const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
            const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
            
            if (remainingSqM < 1) {
                console.log(`[DEBUG]       => RESULT: WIPEOUT.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                console.log(`[DEBUG]       => RESULT: PARTIAL HIT. Remaining area: ${remainingSqM.toFixed(2)} sqm`);
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
            }
        }
    }

    // --- SECTION 3: FINALIZE AND SAVE ATTACKER'S TERRITORY ---
    console.log(`[DEBUG] SECTION 3: Finalizing Attacker's Territory...`);
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claim nullified by protected territories.' });
        return null;
    }
    
    // Use robust INSERT ... ON CONFLICT to handle both new and existing players
    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($3), 
            area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
    
    console.log(`[DEBUG] =================== CLAIM PROCESS END (Refined) =====================\n`);
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;