// routes/quests_api.js
const express = require('express');
const router = express.Router();

module.exports = (pool, authenticate) => {
    // Get active quests with user's progress
    router.get('/active', authenticate, async (req, res) => {
        try {
            // Fetch all active, non-expired quests
            const questsRes = await pool.query(`
                SELECT id, title, description, type, quest_type, target_value, reward_description, sponsor_name, expires_at
                FROM quests WHERE is_active = true AND expires_at > NOW() AND winner_id IS NULL
            `);
            
            // Fetch the user's progress for these quests
            const progressRes = await pool.query(
                'SELECT quest_id, current_value FROM quest_progress WHERE user_id = $1',
                [req.user.googleId]
            );

            // Fetch sponsor registrations
            const registrationRes = await pool.query(
                'SELECT quest_id, unique_code FROM sponsor_quest_registrations WHERE user_id = $1',
                [req.user.googleId]
            );

            // Create maps for quick lookup
            const progressMap = progressRes.rows.reduce((acc, row) => {
                acc[row.quest_id] = row.current_value;
                return acc;
            }, {});
            const registrationMap = registrationRes.rows.reduce((acc, row) => {
                acc[row.quest_id] = row.unique_code;
                return acc;
            }, {});

            // Combine the data
            const questsWithProgress = questsRes.rows.map(q => ({
                ...q,
                progress: progressMap[q.id] || 0,
                registrationCode: registrationMap[q.id] || null
            }));

            res.json(questsWithProgress);
        } catch (err) {
            console.error('[API/Quests] Error fetching active quests:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    // Register for a sponsor quest to get a code
    router.post('/:id/register', authenticate, async (req, res) => {
        const { id: questId } = req.params;
        const { googleId } = req.user;
        const uniqueCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        try {
            await pool.query(
                `INSERT INTO sponsor_quest_registrations (quest_id, user_id, unique_code) VALUES ($1, $2, $3)`,
                [questId, googleId, uniqueCode]
            );
            res.status(201).json({ message: 'Successfully registered!', code: uniqueCode });
        } catch (err) {
            if (err.code === '23505') { // unique_violation
                const existing = await pool.query(
                    'SELECT unique_code FROM sponsor_quest_registrations WHERE quest_id = $1 AND user_id = $2',
                    [questId, googleId]
                );
                return res.status(409).json({ message: 'You are already registered.', code: existing.rows[0]?.unique_code });
            }
            console.error('[API/Quests] Error registering for sponsor quest:', err);
            res.status(500).json({ message: 'Server error.' });
        }
    });

    return router;
};