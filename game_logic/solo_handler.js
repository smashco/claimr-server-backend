const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM AND CREATE THE NEW POLYGON ---
    if (isInitialBaseClaim) {
        // This is a new base claim (circle)
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
        
        // Non-infiltrators cannot claim a base inside existing territory.
        if (!player.isInfiltratorActive) {
            const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
            const intersectionCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`);
            if (intersectionCheck.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
    } else {
        // This is an expansion claim (loop)
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
        
        // Expansion must connect to the player's own land.
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]);
        const existingAreaGeoJSON = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].geojson_area : null;
        if (!existingAreaGeoJSON || turf.area(JSON.parse(existingAreaGeoJSON)) === 0) {
            socket.emit('claimRejected', { reason: 'You must have an established base to expand.' });
            return null;
        }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }

    // --- SECTION 2: CALCULATE ATTACKER'S TOTAL INFLUENCE & FIND VICTIMS ---
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set([userId]);

    // Get the attacker's current territory
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rowCount > 0 ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    
    // The attacker's "total potential influence" is their old land PLUS their new claim.
    // This is the key to determining a full wipeout correctly.
    const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingArea]);
    const attackerTotalInfluenceGeom = influenceResult.rows[0].full_influence;
    
    // This variable will hold the final shape of the attacker's land after combat.
    // We start by assuming they get everything, and then subtract shielded areas from it.
    let attackerFinalAreaGeom = attackerTotalInfluenceGeom;
    
    // Find all players whose land intersects with the new claim.
    const intersectingTerritoriesResult = await client.query(
        `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`,
        [userId]
    );

    // --- SECTION 3: RESOLVE COMBAT ---
    for (const victim of intersectingTerritoriesResult.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            // SHIELDED VICTIM: They are immune. A hole is cut out of the attacker's final territory.
            console.log(`[GAME] Shield from ${victim.username} blocked the attack.`);
            
            // Subtract the victim's area from the attacker's final geometry.
            const protectedResult = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`, [attackerFinalAreaGeom, victim.area]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;
            
            // Consume the shield and notify the victim.
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

        } else {
            // UNSHIELDED VICTIM: They lose any territory covered by the attacker's total influence.
            // This is the logic that correctly handles the island wipeout.
            const remainingVictimAreaResult = await client.query(
                `SELECT ST_AsGeoJSON(ST_Difference($1::geometry, $2::geometry)) as remaining_geojson;`,
                [victim.area, attackerTotalInfluenceGeom] // Victim's Area - Attacker's TOTAL Influence
            );
            
            const remainingGeoJSON = remainingVictimAreaResult.rows[0].remaining_geojson;
            const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;

            if (remainingSqM < 1) {
                // FULL WIPEOUT: The victim's remaining area is negligible.
                console.log(`[GAME] Wiping out unshielded player: ${victim.username}.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                // PARTIAL HIT: The victim survives with their remaining territory.
                console.log(`[GAME] Partially claiming territory from ${victim.username}.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
            }
        }
    }

    // --- SECTION 4: FINALIZE AND SAVE ATTACKER'S TERRITORY ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }
    
    // Save the attacker's new territory. Use a separate query for base claims vs expansions to avoid SQL errors.
    if (isInitialBaseClaim) {
        const query = `
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, ST_SetSRID(ST_Point($5, $6), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET 
                area = ST_GeomFromGeoJSON($3), 
                area_sqm = $4,
                original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);
        `;
        await client.query(query, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat]);
    } else {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;