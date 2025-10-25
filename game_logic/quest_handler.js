/**
* @file game_logic/quest_handler.js
* @description Handles tracking and completion of player quests.
*/


const debug = require('debug')('server:game');


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
* @param {string} questType - The type of quest action (e.g., 'cover_area').
* @param {number} value - The value to add to the progress (e.g., area in sqm, distance in km).
* @param {object} client - The PostgreSQL client for the current transaction.
* @param {object} io - The Socket.IO server instance.
* @param {object} players - The server's map of active players.
*/
async function updateQuestProgress(userId, questType, value, client, io, players) {
   if (!userId || !questType || value === undefined) {
       console.warn(`[QUEST] Aborting updateQuestProgress due to invalid parameters: userId=${userId}, questType=${questType}, value=${value}`);
       debug(`[QUEST] Aborting updateQuestProgress due to invalid parameters: userId=${userId}, questType=${questType}, value=${value}`);
       return;
   }


   debug(`[QUEST] Updating progress for user ${userId}, type: ${questType}, value: ${value}`);


   try {
       const questRes = await client.query(
           `SELECT id, title, objective_value FROM quests WHERE objective_type = $1 AND status = 'active' AND expiry_time > NOW() AND winner_user_id IS NULL`,
           [questType]
       );


       if (questRes.rowCount === 0) {
           debug(`[QUEST] No active quests of type '${questType}' found for user ${userId}.`);
           return;
       }


       for (const quest of questRes.rows) {
           debug(`[QUEST] Processing quest "${quest.title}" (ID: ${quest.id}) for user ${userId}.`);

           let valueToInsert = value;
           if (questType === 'cover_area') {
               valueToInsert = value / 1000000;
           }
           valueToInsert = Math.round(valueToInsert);
          
           const progressRes = await client.query(
               `INSERT INTO quest_progress (quest_id, user_id, current_value)
                VALUES ($1, $2, $3)
                ON CONFLICT (quest_id, user_id) DO UPDATE
                SET current_value = quest_progress.current_value + $3
                RETURNING current_value`,
               [quest.id, userId, valueToInsert]
           );


           const newProgress = progressRes.rows[0].current_value;
           
           debug(`[QUEST] User ${userId} progress for quest "${quest.title}" is now: ${newProgress}/${quest.objective_value}`);


           const playerSocketId = Object.keys(players).find(id => players[id]?.googleId === userId);
           if (playerSocketId) {
               io.to(playerSocketId).emit('questProgressUpdate', {
                   questId: quest.id,
                   currentProgress: newProgress
               });
               debug(`[QUEST] Emitted progress update to socket ${playerSocketId}`);
           }
          
           if (newProgress >= quest.objective_value) {
               debug(`[QUEST] User ${userId} has met the target for quest ${quest.id}. Attempting to declare winner.`);
               await client.query('SAVEPOINT declare_winner');
               try {
                   const winnerCheck = await client.query(
                       'SELECT winner_user_id FROM quests WHERE id = $1 FOR UPDATE',
                       [quest.id]
                   );


                   if (winnerCheck.rows[0].winner_user_id === null) {
                       await client.query(
                           "UPDATE quests SET winner_user_id = $1, status = 'completed' WHERE id = $2",
                           [userId, quest.id]
                       );
                      
                       const playerInfo = await client.query('SELECT username FROM territories WHERE owner_id = $1', [userId]);
                       const winnerName = playerInfo.rows.length > 0 ? playerInfo.rows[0].username : 'Unknown Player';


                       debug(`[QUEST] WINNER DECLARED! ${winnerName} has completed the quest: "${quest.title}"`);
                      
                       io.emit('questCompleted', {
                           questId: quest.id,
                           title: quest.title,
                           winnerName: winnerName
                       });
                      
                       io.emit('questUpdate');
                      
                       await client.query('RELEASE SAVEPOINT declare_winner');
                   } else {
                       await client.query('ROLLBACK TO SAVEPOINT declare_winner');
                       debug(`[QUEST] User ${userId} completed quest "${quest.title}", but a winner was already declared.`);
                   }
               } catch (transactionError) {
                   await client.query('ROLLBACK TO SAVEPOINT declare_winner');
                   console.error('[QUEST] FATAL: Error during winner declaration savepoint, rolling back to savepoint.', transactionError);
               }
           }
       }
      
   } catch (err) {
       console.error('[QUEST] Error during main quest progress update logic:', err);
   }
}


module.exports = { updateQuestProgress, QUEST_TYPES };