// game_logic/quest_handler.js
/**
 * @file game_logic/quest_handler.js
 * @description Handles tracking and completion of player quests.
 */

const QUEST_TYPES = {
    MAKE_TRAIL: 'MAKE_TRAIL',       // Target: distance in meters
    ATTACK_BASE: 'ATTACK_BASE',     // Target: number of bases
    CUT_TRAIL: 'CUT_TRAIL',         // Target: number of trails cut
    COMPLETE_RUN: 'COMPLETE_RUN',   // Target: number of successful runs/claims
    SPONSOR_CHECKIN: 'SPONSOR_CHECKIN' // Target: 1 (for completion)
};

/**
 * Updates a player's progress for a specific type of quest.
 * @param {string} userId - The Google ID of the player.
 * @param {string} questType - The type of quest action (e.g., 'ATTACK_BASE').
 * @param {number} value - The value to add to the progress (e.g., 1 for one attack, or distance for a trail).
 * @param {object} client - The PostgreSQL client.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} players - The server's map of active players.
 */
async function updateQuestProgress(userId, questType, value, client, io, players) {
    if (!userId || !questType || value === undefined) {
        console.warn(`[QUEST] Aborting updateQuestProgress due to invalid parameters: userId=${userId}, questType=${questType}, value=${value}`);
        return;
    }

    try {
        // Find all active quests of the specified type that aren't already won
        const questRes = await client.query(
            `SELECT id, title, target_value FROM quests WHERE quest_type = $1 AND is_active = true AND expires_at > NOW() AND winner_id IS NULL`,
            [questType]
        );

        if (questRes.rowCount === 0) {
            // No active quest for this action, so do nothing.
            return;
        }

        // --- THE FIX IS HERE: The winner check logic is now INSIDE the loop ---
        for (const quest of questRes.rows) {
            const progressRes = await client.query(
                `INSERT INTO quest_progress (quest_id, user_id, current_value)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (quest_id, user_id) DO UPDATE
                 SET current_value = quest_progress.current_value + $3
                 RETURNING current_value`,
                [quest.id, userId, value]
            );

            const newProgress = progressRes.rows[0].current_value;
            console.log(`[QUEST] User ${userId} progress for quest "${quest.title}": ${newProgress}/${quest.target_value}`);

            const playerSocketId = Object.keys(players).find(id => players[id]?.googleId === userId);
            if (playerSocketId) {
                io.to(playerSocketId).emit('questProgressUpdate', {
                    questId: quest.id,
                    currentProgress: newProgress
                });
            }
            
            // CHECK FOR WINNER IMMEDIATELY AFTER UPDATING THIS SPECIFIC QUEST
            if (newProgress >= quest.target_value) {
                // Use a transaction to prevent race conditions for the winner.
                // We will use the same client connection passed into this function.
                await client.query('BEGIN');
                try {
                    // Lock the quest row to ensure only one process can declare a winner.
                    const winnerCheck = await client.query(
                        'SELECT winner_id FROM quests WHERE id = $1 FOR UPDATE',
                        [quest.id]
                    );

                    // Double-check that another process hasn't declared a winner in the meantime.
                    if (winnerCheck.rows[0].winner_id === null) {
                        // We have a winner!
                        await client.query(
                            'UPDATE quests SET winner_id = $1, is_active = false WHERE id = $2',
                            [userId, quest.id]
                        );
                        
                        const playerInfo = await client.query('SELECT username FROM territories WHERE owner_id = $1', [userId]);
                        const winnerName = playerInfo.rows.length > 0 ? playerInfo.rows[0].username : 'Unknown Player';

                        console.log(`[QUEST] WINNER! ${winnerName} has completed the quest: "${quest.title}"`);
                        
                        // Emit to everyone that the quest is over and who won
                        io.emit('questCompleted', {
                            questId: quest.id,
                            title: quest.title,
                            winnerName: winnerName
                        });
                        
                        // Also broadcast a general quest update to refresh lists in the app and admin panel
                        io.emit('questUpdate'); 

                        await client.query('COMMIT');
                    } else {
                        // Someone else won just before we could commit.
                        await client.query('ROLLBACK');
                        console.log(`[QUEST] User ${userId} completed quest "${quest.title}", but a winner was already declared.`);
                    }
                } catch (transactionError) {
                    await client.query('ROLLBACK');
                    console.error('[QUEST] FATAL: Error during winner declaration transaction, rolling back.', transactionError);
                }
            }
        }
        // --- END OF FIX ---
        
    } catch (err) {
        console.error('[QUEST] Error during main quest progress update logic:', err);
        // If an error happens here, a transaction might be open. It's safer to attempt a rollback.
        // Although the transaction logic is now nested, this is a good fail-safe.
        try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* ignore */ }
    }
}

module.exports = { updateQuestProgress, QUEST_TYPES };