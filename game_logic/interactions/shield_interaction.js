// This script handles ONLY the "island creation" logic for a shielded victim.

/**
 * Calculates the result of an attack hitting a shielded player.
 * The victim is unharmed, and a hole is cut out of the attacker's territory.
 * @param {object} client - The database client.
 * @param {object} attackerFinalGeom - The attacker's full potential territory for this turn.
 * @param {object} victimCurrentArea - The victim's current territory geometry.
 * @param {string} victimId - The ID of the victim.
 * @returns {object} The new, modified geometry for the attacker.
 */
async function handleShieldInteraction(client, attackerFinalGeom, victimCurrentArea, victimId) {
    console.log(`[Interaction] Shield activated for victim ${victimId}. Creating island.`);
    
    // Deactivate the shield in the database.
    await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);

    // The attacker's final area has the victim's territory "cut out" of it.
    const protectedResult = await client.query(
        `SELECT ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3) as final_geom;`, 
        [attackerFinalGeom, victimCurrentArea]
    );
    
    // Return the new shape for the attacker's territory.
    return protectedResult.rows[0].final_geom;
}

module.exports = handleShieldInteraction;