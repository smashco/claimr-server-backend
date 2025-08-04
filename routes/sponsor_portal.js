// routes/sponsor_portal.js
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { updateQuestProgress, QUEST_TYPES } = require('../game_logic/quest_handler');

const router = express.Router();

module.exports = (pool, io, players) => {

    const checkSponsorAuth = (req, res, next) => {
        if (req.cookies.sponsor_session && req.cookies.sponsor_name) {
            req.sponsor = { name: req.cookies.sponsor_name, id: req.cookies.sponsor_id };
            return next();
        }
        if (req.originalUrl.startsWith('/sponsor/api')) {
            return res.status(401).json({ message: 'Unauthorized: Please log in.' });
        }
        res.redirect('/sponsor/login');
    };

    router.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'sponsor.html')));
    router.get('/dashboard', checkSponsorAuth, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'sponsor_dashboard.html')));

    router.post('/login', async (req, res) => {
        const { name, password } = req.body;
        try {
            const sponsorRes = await pool.query('SELECT * FROM sponsors WHERE name = $1', [name]);
            if (sponsorRes.rowCount === 0) return res.status(401).send('Invalid sponsor name or password.');
            
            const sponsor = sponsorRes.rows[0];
            const isMatch = await bcrypt.compare(password, sponsor.password_hash);
            
            if (isMatch) {
                const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/sponsor' };
                res.cookie('sponsor_session', 'your_secure_random_token_here', cookieOptions);
                res.cookie('sponsor_name', sponsor.name, cookieOptions);
                res.cookie('sponsor_id', sponsor.id, cookieOptions);
                res.redirect('/sponsor/dashboard');
            } else {
                res.status(401).send('Invalid sponsor name or password.');
            }
        } catch(err) {
            console.error('[Sponsor Login] Error:', err);
            res.status(500).send('Server error during login.');
        }
    });

    router.get('/api/registrations', checkSponsorAuth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT r.id, r.unique_code, r.status, t.username, t.owner_name, t.profile_image_url
                FROM sponsor_quest_registrations r
                JOIN territories t ON r.user_id = t.owner_id
                JOIN quests q ON r.quest_id = q.id
                WHERE q.sponsor_name = $1 AND q.expires_at > NOW()
                ORDER BY r.registered_at DESC
            `, [req.sponsor.name]);
            res.json(result.rows);
        } catch (err) {
            console.error('[API/Sponsor] Error fetching registrations:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    router.post('/api/verify', checkSponsorAuth, async (req, res) => {
        const { unique_code } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const regRes = await client.query(`
                SELECT r.user_id, r.quest_id FROM sponsor_quest_registrations r
                JOIN quests q ON r.quest_id = q.id
                WHERE r.unique_code ILIKE $1 AND q.sponsor_name = $2 AND r.status = 'registered'
            `, [unique_code, req.sponsor.name]);
            
            if (regRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Invalid or already verified code for your active quest.' });
            }
            
            const { user_id, quest_id } = regRes.rows[0];
            await client.query(`UPDATE sponsor_quest_registrations SET status = 'verified' WHERE unique_code ILIKE $1`, [unique_code]);
            
            // This is the key part: linking to the quest system
            await updateQuestProgress(user_id, QUEST_TYPES.SPONSOR_CHECKIN, 1, client, io, players);

            await client.query('COMMIT');
            res.json({ message: `Player verified successfully! Quest progress updated.` });
        } catch(err) {
            await client.query('ROLLBACK');
            console.error('[API/Sponsor] Error verifying code:', err);
            res.status(500).json({ message: 'Server error' });
        } finally {
            client.release();
        }
    });

    return router;
};