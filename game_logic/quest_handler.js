const QUEST_TYPES = {
    MAKE_TRAIL: 'MAKE_TRAIL',
    ATTACK_BASE: 'ATTACK_BASE',
    CUT_TRAIL: 'CUT_TRAIL',
    SPONSOR_CHECKIN: 'SPONSOR_CHECKIN',
    COMPLETE_RUN: 'COMPLETE_RUN'
};

async function updateQuestProgress(userId, questType, value, client, io, players) {
    try {
        const questRes = await client.query(
            `SELECT id, title, target_value FROM quests WHERE quest_type = $1 AND is_active = true AND winner_id IS NULL`,
            [questType]
        );

        if (questRes.rowCount === 0) return;

        for (const quest of questRes.rows) {
            const progressRes = await client.query(
                `INSERT INTO quest_progress (quest_id, user_id, current_value) VALUES ($1, $2, $3)
                 ON CONFLICT (quest_id, user_id) DO UPDATE SET current_value = quest_progress.current_value + $3
                 RETURNING current_value`,
                [quest.id, userId, value]
            );

            const newProgress = progressRes.rows[0].current_value;
            console.log(`[QUEST] User ${userId} progress for quest "${quest.title}": ${newProgress}/${quest.target_value}`);

            const playerSocketId = Object.keys(players).find(id => players[id]?.googleId === userId);
            if (playerSocketId) {
                io.to(playerSocketId).emit('questProgressUpdate', { questId: quest.id, currentProgress: newProgress });
            }
            
            if (newProgress >= quest.target_value) {
                await client.query('BEGIN');
                const winnerCheck = await client.query('SELECT winner_id FROM quests WHERE id = $1 FOR UPDATE', [quest.id]);

                if (winnerCheck.rows[0].winner_id === null) {
                    await client.query('UPDATE quests SET winner_id = $1, is_active = false WHERE id = $2', [userId, quest.id]);
                    await client.query('COMMIT');

                    const playerInfo = await client.query('SELECT username FROM territories WHERE owner_id = $1', [userId]);
                    const winnerName = playerInfo.rows[0].username;

                    console.log(`[QUEST] WINNER! ${winnerName} has completed the quest: "${quest.title}"`);
                    io.emit('questCompleted', { questId: quest.id, title: quest.title, winnerName: winnerName });
                } else {
                    await client.query('ROLLBACK');
                }
            }
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[QUEST] Error updating quest progress:', err);
    }
}

module.exports = { updateQuestProgress, QUEST_TYPES };