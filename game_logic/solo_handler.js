const turf = require('@turf/turf');
const { handleShieldInteraction, handleUnshieldedInteraction } = require('./interactions');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =======================================================`);
    console.log(`[DEBUG] Claim Process Started for ${player.name} (${player.id})`);
    console.log(`[DEBUG] =======================================================`);
    
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM AND CREATE THE NEW POLYGON ---
    console.log(`[DEBUG] Section 1: Validating Claim...`);
    if (isInitialBaseClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG]   Type: Initial Base Claim. Area: ${newAreaSqM.toFixed(2)} sqm.`);
    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' }); return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try { newAreaPolygon = turf.polygon([pointsForPolygon]); } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG]   Type: Expansion Claim. Area: ${newAreaSqM.toFixed(2)} sqm.`);
        
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]);
        const existingAreaGeoJSON = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].geojson_area : null;
        if (!existingAreaGeoJSON || turf.area(JSON.parse(existingAreaGeoJSON)) === 0) {
            socket.emit('claimRejected', { reason: 'You must have a base to expand.' }); return null;
        }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' }); return null;
        }
    }
    console.log(`[DEBUG]   Claim validation PASSED.`);

    // --- SECTION 2: CALCULATE ATTACKER'S TOTAL INFLUENCE & FIND ALL POTENTIAL VICTIMS ---
    console.log(`[DEBUG] Section 2: Calculating Geometries and Finding Victims...`);
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set([userId]);

    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area ? attackerExistingAreaRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;

    // THE MOST IMPORTANT STEP: Calculate the attacker's total potential territory (their "ambition").
    const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingArea]);
    const attackerTotalInfluenceGeom = influenceResult.rows[0].full_influence;
    console.log(`[DEBUG]   Calculated attacker's Total Potential Influence geometry.`);
    
    // Find ALL players whose land intersects with the attacker's TOTAL INFLUENCE.
    // This correctly finds players who are directly touched AND those who are now encircled.
    const potentialVictimsResult = await client.query(
        `SELECT owner_id, username, area, is_shield_active FROM territories WHERE owner_id != $1 AND NOT ST_IsEmpty(area) AND ST_Intersects(area, $2::geometry);`,
        [userId, attackerTotalInfluenceGeom]
    );
    console.log(`[DEBUG]   Found ${potentialVictimsResult.rowCount} potentially affected players.`);

    // --- SECTION 3: RESOLVE COMBAT BY DELEGATING TO INTERACTION HANDLERS ---
    console.log(`[DEBUG] Section 3: Resolving Combat...`);
    let attackerFinalAreaGeom = attackerTotalInfluenceGeom; // Start with the full ambition.

    for (const victim of potentialVictimsResult.rows) {
        console.log(`[DEBUG]   Processing victim: ${victim.username} (ID: ${victim.owner_id})`);
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            // DELEGATE to the shield handler. It returns the modified attacker geometry.
            attackerFinalAreaGeom = await handleShieldInteraction(client, attackerFinalAreaGeom, victim, io, players);
        } else {
            // DELEGATE to the unshielded handler. It handles the victim's update internally.
            await handleUnshieldedInteraction(client, victim, attackerTotalInfluenceGeom);
        }
    }
    console.log(`[DEBUG]   All combat interactions resolved.`);


    // --- SECTION 4: FINALIZE AND SAVE ATTACKER'S TERRITORY ---
    console.log(`[DEBUG] Section 4: Finalizing and Saving...`);
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        console.log(`[DEBUG]   Claim resulted in null/empty area. Rejecting.`);
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }
    console.log(`[DEBUG]   Attacker's final area is ${finalAreaSqM.toFixed(2)} sqm.`);

    // Save the attacker's new territory.
    if (isInitialBaseClaim) {
        const query = `
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, ST_SetSRID(ST_Point($5, $6), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET 
                area = ST_GeomFromGeoJSON($3), area_sqm = $4, original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);`;
        await client.query(query, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat]);
    } else {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }
    console.log(`[DEBUG]   Attacker's territory successfully saved to the database.`);
    
    console.log(`[DEBUG] Claim Process Finished. Affected players: ${Array.from(affectedOwnerIds).join(', ')}`);
    console.log(`[DEBUG] =======================================================\n`);
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;