// game_logic/interactions/shield_interaction.js

/**
 * @file shield_interaction.js
 * @description Handles the logic for when a claim hits a shielded territory.
 */
const { updateQuestProgress, QUEST_TYPES } = require('../quest_handler');

/**
 * Processes the interaction when an attacker's claim hits a shielded victim's territory.
 * The shield is destroyed, but the attacker does not gain the shielded land.
 * @param {object} attacker - The attacker's player object from the `players` map.
 * @param {object} victim - The victim player's data { owner_id, username, area }.
 * @param {string} attackerNetGainGeom - The WKT representation of the attacker's current claim geometry.
 * @param {object} client - The PostgreSQL database client.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} players - The in-memory players object.
 * @returns {Promise<string>} The updated WKT geometry for the attacker's claim after the shielded area is subtracted.
 */
async function handleShieldHit(attacker, victim, attackerNetGainGeom, client, io, players) {
    console.log(`[SHIELD HIT] ${attacker.name}'s claim on ${victim.username}'s territory was blocked by a shield.`);

    // 1. Destroy the victim's shield in the database
    await client.query(
        `UPDATE territories SET is_shield_active = false, has_shield = false, shield_activated_at = NULL WHERE owner_id = $1`,
        [victim.owner_id]
    );

    // 2. Notify the victim that their shield was broken
    const victimSocketId = Object.keys(players).find(id => players[id].googleId === victim.owner_id);
    if (victimSocketId) {
        io.to(victimSocketId).emit('shieldBroken', { attackerName: attacker.name });
        io.to(victimSocketId).emit('notification', { type: 'error', message: 'Your shield has been broken!' });
    }
    
    // 3. Notify the attacker
    io.to(attacker.id).emit('notification', { type: 'info', message: `You broke ${victim.username}'s shield!` });

    // 4. Update quest progress for the attacker
    await updateQuestProgress(attacker.googleId, QUEST_TYPES.BREAK_SHIELD, 1, client, io, players);

    // 5. Subtract the victim's entire territory from the attacker's gain
    // This ensures the attacker gains no land from the shielded player.
    const differenceResult = await client.query(
        `SELECT ST_Difference($1::geometry, $2::geometry) AS remaining_geom`,
        [attackerNetGainGeom, victim.area]
    );

    const remainingGeom = differenceResult.rows[0].remaining_geom;

    console.log(`[SHIELD HIT] Attacker's gain was reduced to prevent taking shielded land.`);
    
    // Return the new, smaller geometry for the attacker's claim.
    return remainingGeom;
}

module.exports = { handleShieldHit };