// routes/quests_api.js
const express = require('express');
const router = express.Router();


module.exports = (pool, authenticate) => {
   // Get active quests with user's progress
   router.get('/active', authenticate, async (req, res) => {
       try {
           // Fetch all active, non-expired quests
           const questsRes = await pool.query(`
               SELECT id, title, description, type, objective_type, target_value, reward_description, sponsor_name, expires_at, google_form_url, requires_qr_validation, is_first_come_first_served
               FROM quests WHERE status = 'active' AND expiry_time > NOW() AND winner_user_id IS NULL
           `);
          
           // Fetch the user's progress for these quests
           const progressRes = await pool.query(
               'SELECT quest_id, progress FROM quest_progress WHERE user_id = $1',
               [req.user.googleId]
           );


           // Create a map for quick lookup
           const progressMap = progressRes.rows.reduce((acc, row) => {
               acc[row.quest_id] = row.progress;
               return acc;
           }, {});


           // Combine the data
           const questsWithProgress = questsRes.rows.map(q => ({
               ...q,
               progress: progressMap[q.id] || 0
           }));


           res.json(questsWithProgress);
       } catch (err) {
           console.error('[API/Quests] Error fetching active quests:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   // Register for a sponsor quest by submitting the Google Form link (handled client-side)
   // This endpoint could be used for server-side validation if needed in the future.
   router.post('/:id/register', authenticate, async (req, res) => {
       const { id: questId } = req.params;
       const { googleId } = req.user;
      
       try {
           // Simply log the registration attempt on the server.
           // The actual registration is through the Google Form.
           console.log(`[QUESTS] User ${googleId} is registering for sponsor quest ${questId}.`);
           // In a more advanced system, you might add an entry to a registration table here.
           res.status(200).json({ message: 'Registration acknowledged. Please complete the form.' });
       } catch (err) {
           console.error('[API/Quests] Error acknowledging sponsor quest registration:', err);
           res.status(500).json({ message: 'Server error.' });
       }
   });

   // Endpoint for verifying a QR code for a quest
    router.post('/verify-qr', authenticate, async (req, res) => {
        const { questId, qrCodeData } = req.body;
        const { googleId } = req.user;

        try {
            // This is a placeholder. In a real scenario, you would validate the qrCodeData
            // against a value stored in the database for that specific quest.
            const questRes = await pool.query('SELECT id FROM quests WHERE id = $1 AND status = \'active\'', [questId]);
            if(questRes.rowCount === 0) {
                return res.status(404).json({ message: 'Quest not found or is not active.'});
            }

            // For now, any QR code is accepted for a valid quest.
            // Let's log the entry.
            await pool.query(
                `INSERT INTO quest_entries (quest_id, user_id, submission_details, status) VALUES ($1, $2, $3, 'completed') ON CONFLICT (quest_id, user_id) DO UPDATE SET status = 'completed', submitted_at = NOW()`,
                [questId, googleId, `QR Scan: ${qrCodeData}`]
            );

            res.status(200).json({ message: 'QR Code validated successfully!' });
        } catch (err) {
            console.error('[API/Quests] Error verifying QR code:', err);
            res.status(500).json({ message: 'Server error during QR code verification.' });
        }
    });


   return router;
};