const turf = require('@turf/turf');

// Helper function to save the attacker's final territory state
async function saveAttackerTerritory(client, userId, playerName, finalGeomWKT, isInitialBaseClaim, baseClaim) {
    const finalResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [finalGeomWKT]);
    const finalAreaGeoJSON = finalResult.rows[0].geojson;
    const finalAreaSqM = finalResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        console.log(`[DEBUG] Final attacker area is null or empty. No DB update needed.`);
        return; // Avoids saving empty geometries
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
    console.log(`\n\n[DEBUG] =================== NEW CLAIM PROCESS (v5 Attack/Expand) ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    let newAreaPolygon, newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM GEOMETRY ---
    console.log(`[DEBUG] SECTION 1: Validating Claim Geometry...`);
    if (isInitialBaseClaim) {
        const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
        const intersectionCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`);
        if (intersectionCheck.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
            return null;
        }
        newAreaPolygon = turf.circle([baseClaim.lng, baseClaim.lat], baseClaim.radius || 30, { units: 'meters' });
    } else {
        if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Trail is too short.' }); return null; }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try { newAreaPolygon = turf.polygon([pointsForPolygon]); } catch (e) { socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null; }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { socket.emit('claimRejected', { reason: 'Area is too small (min 100sqm).' }); return null; }
    }
    newAreaSqM = turf.area(newAreaPolygon);
    console.log(`[DEBUG]   => Geometry validation PASSED.`);
    
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows.length > 0 ? attackerExistingAreaRes.rows[0].area : null;

    let intersectsOwnTerritory = false;
    if (attackerExistingArea) {
        const intersectsCheck = await client.query(`SELECT ST_Intersects(${newAreaWKT}, $1::geometry) as intersects`, [attackerExistingArea]);
        intersectsOwnTerritory = intersectsCheck.rows[0].intersects;
    }

    // --- SECTION 2: PROCESS CLAIM BASED ON TYPE ---

    if (isInitialBaseClaim) {
        // CASE A: INITIAL BASE CLAIM (In empty space)
        console.log(`[DEBUG] SECTION 2: INITIAL BASE claim.`);
        await saveAttackerTerritory(client, userId, player.name, newAreaWKT, true, baseClaim);
    } 
    else if (intersectsOwnTerritory) {
        // CASE B: EXPANSION (Loop connects to attacker's own territory)
        console.log(`[DEBUG] SECTION 2: EXPANSION claim.`);
        const influenceResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS full_influence`, [attackerExistingArea]);
        let attackerFinalAreaGeom = influenceResult.rows[0].full_influence;

        const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, $2::geometry)`, [userId, attackerFinalAreaGeom]);

        for (const victim of victimsResult.rows) {
            affectedOwnerIds.add(victim.owner_id);
            if (victim.is_shield_active) {
                console.log(`[DEBUG]   - Victim ${victim.username} is SHIELDED.`);
                const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
                attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
            } else {
                console.log(`[DEBUG]   - Victim ${victim.username} is UNSHIELDED.`);
                const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, $2::geometry)), 3)) as remaining_geojson;`, [victim.area, attackerFinalAreaGeom]);
                const remainingSqM = (remainingResult.rows[0].remaining_geojson) ? (turf.area(JSON.parse(remainingResult.rows[0].remaining_geojson)) || 0) : 0;
                if (remainingSqM < 1) await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                else await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingResult.rows[0].remaining_geojson, remainingSqM, victim.owner_id]);
            }
        }
        await saveAttackerTerritory(client, userId, player.name, attackerFinalAreaGeom, false, null);
    } 
    else {
        // CASE C: ATTACK / CARVE-OUT (Loop is in enemy territory, not touching attacker's)
        console.log(`[DEBUG] SECTION 2: ATTACK (Carve-out) claim.`);
        let attackSuccessful = true;
        const victimsResult = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND ST_Intersects(area, ${newAreaWKT})`, [userId]);

        if (victimsResult.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'Attack must be inside enemy territory.' });
            return null;
        }

        for (const victim of victimsResult.rows) {
            affectedOwnerIds.add(victim.owner_id);
            if (victim.is_shield_active) {
                console.log(`[DEBUG]   - Attack FAILED. Victim ${victim.username} is SHIELDED.`);
                attackSuccessful = false;
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
                if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
                socket.emit('claimRejected', { reason: `Attack blocked by ${victim.username}'s shield!` });
                break;
            } else {
                console.log(`[DEBUG]   - Carving territory from ${victim.username}.`);
                const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_MakeValid(ST_Difference($1::geometry, ${newAreaWKT})), 3)) as remaining_geojson;`, [victim.area]);
                const remainingSqM = (remainingResult.rows[0].remaining_geojson) ? (turf.area(JSON.parse(remainingResult.rows[0].remaining_geojson)) || 0) : 0;
                if (remainingSqM < 1) await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
                else await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingResult.rows[0].remaining_geojson, remainingSqM, victim.owner_id]);
            }
        }

        if (attackSuccessful) {
            const finalUnionResult = await client.query(`SELECT ST_MakeValid(ST_Union($1::geometry, ${newAreaWKT})) AS final_area`, [attackerExistingArea || `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`]);
            await saveAttackerTerritory(client, userId, player.name, finalUnionResult.rows[0].final_area, false, null);
        } else {
            return null;
        }
    }

    // --- SECTION 3: FINALIZE AND RETURN ---
    const finalAttackerArea = await client.query('SELECT area_sqm FROM territories WHERE owner_id = $1', [userId]);
    return {
        finalTotalArea: finalAttackerArea.rows[0]?.area_sqm || 0,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;