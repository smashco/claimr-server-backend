const turf = require('@turf/turf');

/**
 * Handles the combat interaction when an attack hits a SHIELDED player.
 * The victim is unharmed, but their shield is consumed. A hole is cut from the attacker's final territory.
 * @returns The new, modified geometry for the attacker.
 */
async function handleShieldInteraction(client, attackerCurrentGeom, victim, io, players) {
    console.log(`[DEBUG] ---> Starting Shield Interaction with ${victim.username}.`);
    
    // Consume the victim's shield
    await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
    
    // Notify the victim's client that their shield was used
    const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
    if (victimSocketId) {
        io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
        console.log(`[DEBUG]      Notified ${victim.username} their shield was consumed.`);
    }

    // Cut a hole in the attacker's territory corresponding to the victim's area
    const protectedResult = await client.query(
        `SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`,
        [attackerCurrentGeom, victim.area]
    );
    console.log(`[DEBUG] ---> Shield Interaction complete. Attacker's geometry has been modified.`);
    
    return protectedResult.rows[0].final_geom;
}

/**
 * Handles the combat interaction for an UNSHIELDED player.
 * This function determines if it's a partial hit or a full wipeout and updates the victim's territory directly.
 */
async function handleUnshieldedInteraction(client, victim, attackerTotalInfluenceGeom) {
    console.log(`[DEBUG] ---> Starting Unshielded Interaction with ${victim.username}.`);

    // The key calculation: What is left of the victim's area after subtracting the attacker's TOTAL influence?
    const remainingVictimAreaResult = await client.query(
        `SELECT ST_AsGeoJSON(ST_Difference($1::geometry, $2::geometry)) as remaining_geojson;`,
        [victim.area, attackerTotalInfluenceGeom]
    );

    const remainingGeoJSON = remainingVictimAreaResult.rows[0].remaining_geojson;
    const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
    console.log(`[DEBUG]      Calculated remaining area for ${victim.username}: ${remainingSqM.toFixed(2)} sqm.`);

    if (remainingSqM < 1) {
        // FULL WIPEOUT
        console.log(`[DEBUG]      WIPEOUT DETECTED. Removing ${victim.username}'s territory.`);
        await client.query(
            `UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`,
            [victim.owner_id]
        );
    } else {
        // PARTIAL HIT
        console.log(`[DEBUG]      PARTIAL HIT DETECTED. Updating ${victim.username}'s territory.`);
        await client.query(
            `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`,
            [remainingGeoJSON, remainingSqM, victim.owner_id]
        );
    }
    console.log(`[DEBUG] ---> Unshielded Interaction complete for ${victim.username}.`);
}


module.exports = {
    handleShieldInteraction,
    handleUnshieldedInteraction
};