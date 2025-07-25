const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM AND DEFINE THE NEW GEOMETRY ---
    // This section is purely for validating the player's action and creating the initial shape of the new claim.
    // It has been confirmed to work correctly.

    if (isInitialBaseClaim) {
        // Infiltrator check: An infiltrator can ignore the intersection rule.
        if (!player.isInfiltratorActive) {
            const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
            const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
            const intersectionResult = await client.query(intersectionCheckQuery);
            if (intersectionResult.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; 
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
    } else {
        // Expansion validation
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        newAreaPolygon = turf.polygon([pointsForPolygon]);
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
        const existingAreaGeoJSON = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].geojson_area : null;
        if (!existingAreaGeoJSON || turf.area(JSON.parse(existingAreaGeoJSON)) === 0) { 
            socket.emit('claimRejected', { reason: 'You must claim an initial base first.' });
            return null;
        }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }
    
    // --- SECTION 2: PREPARE FOR COMBAT ---

    // The raw geometry of the new loop. This will be used to calculate damage on partial hits.
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set([userId]);
    
    // This variable represents the "spoils of war". It starts as the new loop and is modified by combat.
    let attackerNetGainGeom;
    const geomResult = await client.query(`SELECT ${newAreaWKT} as geom`);
    attackerNetGainGeom = geomResult.rows[0].geom;

    // Find all victims intersected by the new loop.
    const intersectingTerritoriesQuery = `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    // --- SECTION 3: PROCESS COMBAT INTERACTIONS (THE CORE LOGIC) ---
    
    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        affectedOwnerIds.add(victimId);
        
        if (row.is_shield_active) {
            // RULE A: SHIELDED VICTIM
            console.log(`[GAME] Shield blocked attack from ${player.name}. Creating island.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            // The attacker's net gain for this turn is reduced by the victim's territory. The victim is unharmed.
            const protectedResult = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victimCurrentArea]);
            attackerNetGainGeom = protectedResult.rows[0].final_geom;

        } else if (player.isInfiltratorActive && isInitialBaseClaim) {
            // RULE B: INFILTRATOR BASE CLAIM
            console.log(`[GAME] Infiltrator carving out a base from ${row.username}.`);
            // The victim's territory has the infiltrator's base carved out of it. The attacker's gain is just their base.
            const carveResult = await client.query(`SELECT ST_AsGeoJSON(ST_Difference($1::geometry, $2::geometry)) as remaining_area;`, [victimCurrentArea, attackerNetGainGeom]);
            const remainingAreaGeoJSON = carveResult.rows[0].remaining_area;
            const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
            
        } else {
            // RULE C & D: NORMAL UNSHIELDED ATTACK
            // First, determine if this is a full wipeout by checking against the attacker's total influence.
            const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
            let attackerTotalInfluenceGeom = attackerNetGainGeom;
            if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
                const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingAreaRes.rows[0].area]);
                attackerTotalInfluenceGeom = influenceResult.rows[0].full_influence;
            }

            const diffForWipeoutCheck = await client.query(`SELECT ST_AsGeoJSON(ST_Difference($1::geometry, $2::geometry)) AS remaining_area;`, [victimCurrentArea, attackerTotalInfluenceGeom]);
            const remainingAreaForWipeout = diffForWipeoutCheck.rows[0].remaining_area;
            const remainingSqMWipeout = remainingAreaForWipeout ? turf.area(JSON.parse(remainingAreaForWipeout)) : 0;

            if (Math.round(remainingSqMWipeout) > 10) {
                // RULE C: PARTIAL HIT. Victim survives with a smaller area.
                console.log(`[GAME] Partially claiming territory from ${row.username}.`);
                // Damage is calculated only from the new claim loop, NOT the total influence.
                const partialHitResult = await client.query(`SELECT ST_AsGeoJSON(ST_Difference($1::geometry, ${newAreaWKT})) as remaining_area;`, [victimCurrentArea]);
                const remainingAreaGeoJSON = partialHitResult.rows[0].remaining_area;
                const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
            } else {
                // RULE D: FULL WIPEOUT. Victim is eliminated.
                console.log(`[GAME] Wiping out unshielded player: ${row.username}.`);
                // To fill holes, the attacker's gain for this turn absorbs the victim's entire original territory.
                const absorptionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victimCurrentArea]);
                attackerNetGainGeom = absorptionResult.rows[0].final_geom;
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
            }
        }
    }

    // --- SECTION 4: FINALIZE AND SAVE ---
    
    // The attacker's final territory is their original land combined with the net gain from this turn.
    let attackerFinalCombinedGeom;
    const attackerExistingAreaResFinal = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaResFinal.rowCount > 0 && attackerExistingAreaResFinal.rows[0].area) {
        const unionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [attackerExistingAreaResFinal.rows[0].area, attackerNetGainGeom]);
        attackerFinalCombinedGeom = unionResult.rows[0].final_area;
    } else {
        attackerFinalCombinedGeom = attackerNetGainGeom;
    }

    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalCombinedGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }
    
    // Use separate save logic for initial claims vs. expansions.
    if (isInitialBaseClaim) {
        const profileRes = await client.query('SELECT username, owner_name, profile_image_url FROM territories WHERE owner_id=$1', [userId]);
        const pUsername = profileRes.rowCount > 0 ? profileRes.rows[0].username : player.name;
        const pOwnerName = profileRes.rowCount > 0 ? profileRes.rows[0].owner_name : player.name;
        const pImageUrl = profileRes.rowCount > 0 ? profileRes.rows[0].profile_image_url : null;
        
        const query = `
            INSERT INTO territories (owner_id, owner_name, username, profile_image_url, area, area_sqm, original_base_point)
            VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, ST_SetSRID(ST_Point($7, $8), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET 
            area = ST_GeomFromGeoJSON($5), 
            area_sqm = $6,
            original_base_point = ST_SetSRID(ST_Point($7, $8), 4326);
        `;
        await client.query(query, [userId, pOwnerName, pUsername, pImageUrl, finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat]);
    } else {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }
    
    if (player.isInfiltratorActive) {
        player.isInfiltratorActive = false;
        console.log(`[GAME] Consuming INFILTRATOR power for ${player.name}.`);
    }
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;