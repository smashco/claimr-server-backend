// game_logic/jobs/shield_expiry_job.js


/**
* Checks for and deactivates shields that have expired (older than 48 hours).
* Notifies affected players via Socket.IO.
* @param {object} pool - The PostgreSQL connection pool.
* @param {object} io - The Socket.IO server instance.
* @param {object} players - The map of online players.
*/
async function checkExpiredShields(pool, io, players) {
    const client = await pool.connect();
    try {
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
 
 
        // Find shields that are active and were activated more than 48 hours ago
        const expiredShields = await client.query(
            `SELECT owner_id, username FROM territories WHERE is_shield_active = true AND shield_activated_at < $1`,
            [fortyEightHoursAgo]
        );
 
 
        if (expiredShields.rowCount > 0) {
            console.log(`[SHIELD EXPIRY] Found ${expiredShields.rowCount} expired shield(s).`);
            for (const shield of expiredShields.rows) {
                console.log(`[SHIELD EXPIRY] Shield for ${shield.username} (${shield.owner_id}) has expired. Deactivating.`);
               
                // Update the database to turn off the shield
                await client.query(
                    `UPDATE territories SET is_shield_active = false, shield_activated_at = NULL WHERE owner_id = $1`,
                    [shield.owner_id]
                );
               
                // Find the player's socket to notify them
                const playerSocketId = Object.keys(players).find(id => players[id]?.googleId === shield.owner_id);
                if (playerSocketId) {
                    // Update the in-memory state
                    if (players[playerSocketId]) {
                        players[playerSocketId].isLastStandActive = false;
                    }
                    // Send the notification
                    io.to(playerSocketId).emit('shieldExpired');
                    console.log(`[SHIELD EXPIRY] Notified player ${shield.username}.`);
                }
            }
        }
    } catch (err) {
        console.error('[SHIELD EXPIRY] Error during shield expiration check:', err);
    } finally {
        client.release();
    }
 }
 
 
 module.exports = { checkExpiredShields };