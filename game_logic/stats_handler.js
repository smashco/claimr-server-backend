/**
 * @file stats_handler.js
 * @description Centralized handler for updating permanent player lifetime statistics.
 */

/**
 * Increments a player's lifetime statistics in the territories table.
 * @param {object} client - The PostgreSQL database client.
 * @param {string} userId - The Google ID of the player to update.
 * @param {object} statsToIncrement - An object with keys for the stats and values for how much to increment them.
 * E.g., { lifetime_trail_cuts: 1, lifetime_attacks_made: 1 }
 */
async function incrementPlayerStats(client, userId, statsToIncrement) {
    if (!userId || Object.keys(statsToIncrement).length === 0) {
        return;
    }

    const setClauses = [];
    const values = [userId];
    let valueIndex = 2;

    for (const [key, value] of Object.entries(statsToIncrement)) {
        // Basic validation to prevent SQL injection with column names
        if (['lifetime_area_claimed', 'lifetime_trail_cuts', 'lifetime_distance_run', 'lifetime_attacks_made'].includes(key)) {
            setClauses.push(`${key} = ${key} + $${valueIndex}`);
            values.push(value);
            valueIndex++;
        }
    }

    if (setClauses.length === 0) {
        return;
    }

    const query = `UPDATE territories SET ${setClauses.join(', ')} WHERE owner_id = $1`;

    try {
        await client.query(query, values);
        console.log(`[STATS] Updated lifetime stats for user ${userId}:`, statsToIncrement);
    } catch (err) {
        console.error(`[STATS] Failed to update lifetime stats for user ${userId}:`, err);
        // Do not throw, as this is a non-critical background operation.
    }
}

module.exports = { incrementPlayerStats };