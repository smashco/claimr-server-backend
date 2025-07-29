/**
 * @file shield_interaction.js
 * @description Handles the interaction when an attacker's claim hits a shielded player.
 */

/**
 * Breaks a victim's shield and calculates the attacker's resulting geometry
 * after the shielded area is subtracted from the claim.
 *
 * @param {object} victim - The victim player's data { owner_id, username, area }.
 * @param {string} attackerNetGainGeom - The WKT representation of the attacker's claim geometry.
 * @param {object} client - The PostgreSQL database client.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} players - The server's map of all active players.
 * @returns {Promise<string>} The updated WKT geometry for the attacker's claim.
 */
async function handleShieldHit(victim, attackerNetGainGeom, client, io, players) {
    console.log(`[SHIELD] Attacker hit a shield owned by ${victim.username}.`);

    // Break the shield
    await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
    const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
    if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

    // The attacker's claim is reduced by the victim's shielded territory
    const protectedResult = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victim.area]);
    return protectedResult.rows[0].final_geom;
}

module.exports = { handleShieldHit };