// routes/sponsor_portal.js
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { updateQuestProgress } = require('../game_logic/quest_handler');


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
       const { login_id, passcode } = req.body;
       if (!login_id || !passcode) {
           return res.status(400).send('Sponsor ID and Passcode are required.');
       }
       try {
           const sponsorRes = await pool.query('SELECT * FROM sponsors WHERE login_id = $1', [login_id]);
           if (sponsorRes.rowCount === 0) return res.status(401).send('Invalid sponsor ID or passcode.');
          
           const sponsor = sponsorRes.rows[0];
           const isMatch = await bcrypt.compare(passcode, sponsor.passcode_hash);
          
           if (isMatch) {
               const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/sponsor' };
               res.cookie('sponsor_session', sponsor.id, cookieOptions);
               res.cookie('sponsor_name', sponsor.name, cookieOptions);
               res.cookie('sponsor_id', sponsor.id, cookieOptions);
               res.redirect('/sponsor/dashboard');
           } else {
               res.status(401).send('Invalid sponsor ID or passcode.');
           }
       } catch(err) {
           console.error('[Sponsor Login] Error:', err);
           res.status(500).send('Server error during login.');
       }
   });


   router.get('/api/quests', checkSponsorAuth, async (req, res) => {
       const sponsorId = req.cookies.sponsor_session;
       try {
           const result = await pool.query(
               `SELECT id, title, status FROM quests WHERE sponsor_id = $1 ORDER BY created_at DESC`,
               [sponsorId]
           );
           res.json(result.rows);
       } catch (err) {
           console.error('[SPONSOR] Error fetching quests:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   router.post('/api/quests', checkSponsorAuth, async (req, res) => {
       const sponsorId = req.cookies.sponsor_session;
       const { title, description, google_form_url } = req.body;


       if (!title || !description || !google_form_url) {
           return res.status(400).json({ message: 'Title, Description, and Google Form URL are required.' });
       }


       try {
           const result = await pool.query(
               "INSERT INTO quests (title, description, type, objective_type, objective_value, sponsor_id, google_form_url, status, is_first_come_first_served, expiry_time) VALUES ($1, $2, 'sponsor', 'qr_scan', 1, $3, $4, 'pending', false, NOW() + INTERVAL '7 days') RETURNING id",
               [title, description, sponsorId, google_form_url]
           );
           res.status(201).json({ message: 'Quest submitted for admin approval.', questId: result.rows[0].id });
       } catch (err) {
           console.error('[SPONSOR] Error creating quest:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });
      
       async function viewEntries(questId) {
           const tableBody = document.getElementById('entries-table-body');
           tableBody.innerHTML = '<tr><td colspan="4" class="text-center">Loading entries...</td></tr>';
           entriesModal.show();
           try {
               const entries = await apiFetch(`/sponsor/api/quests/${questId}/entries`);
               if (entries.length === 0) {
                    tableBody.innerHTML = '<tr><td colspan="4" class="text-center">No players have registered for this quest yet.</td></tr>';
                    return;
               }
               tableBody.innerHTML = '';
               entries.forEach(entry => {
                   const row = document.createElement('tr');
                   const isSelected = entry.status === 'winner_selected' || entry.status === 'winner_confirmed';
                   row.innerHTML = `
                       <td>${entry.username}</td>
                       <td>${new Date(entry.submitted_at).toLocaleString()}</td>
                       <td>${entry.status}</td>
                       <td>
                           ${!isSelected ? `<button class="btn btn-sm btn-success" onclick="selectWinner(${entry.id}, ${questId})">Select as Winner</button>` : 'Selected'}
                       </td>
                   `;
                   tableBody.appendChild(row);
               });
           } catch (error) {
                tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">${error.message}</td></tr>`;
           }
       }


       async function selectWinner(entryId, questId) {
           if (!confirm('Are you sure you want to select this player as the winner? This will be sent to the admin for final approval.')) return;
           try {
               const result = await apiFetch(`/sponsor/api/quests/entries/${entryId}/select-winner`, { method: 'PUT' });
               alert(result.message);
               viewEntries(questId); // Refresh the modal
           } catch (error) {
               alert(`Error: ${error.message}`);
           }
       }
      
   router.get('/api/quests/:id/entries', checkSponsorAuth, async (req, res) => {
       const sponsorId = req.cookies.sponsor_session;
       const { id: questId } = req.params;


       try {
           const questCheck = await pool.query('SELECT id FROM quests WHERE id = $1 AND sponsor_id = $2', [questId, sponsorId]);
           if (questCheck.rowCount === 0) {
               return res.status(403).json({ message: 'You are not authorized to view entries for this quest.' });
           }


           const entries = await pool.query(
               `SELECT qe.id, qe.user_id, t.username, qe.status, qe.submitted_at
                FROM quest_entries qe
                JOIN territories t ON qe.user_id = t.owner_id
                WHERE qe.quest_id = $1
                ORDER BY qe.submitted_at ASC`,
               [questId]
           );
           res.json(entries.rows);
       } catch (err) {
           console.error('[SPONSOR] Error fetching quest entries:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   router.put('/api/quests/entries/:entryId/select-winner', checkSponsorAuth, async (req, res) => {
       const sponsorId = req.cookies.sponsor_session;
       const { entryId } = req.params;


       try {
           const entryCheck = await pool.query(
               `SELECT q.id FROM quest_entries qe
                JOIN quests q ON qe.quest_id = q.id
                WHERE qe.id = $1 AND q.sponsor_id = $2`,
               [entryId, sponsorId]
           );


           if (entryCheck.rowCount === 0) {
               return res.status(403).json({ message: 'You are not authorized to select a winner for this entry.' });
           }


           await pool.query("UPDATE quest_entries SET status = 'winner_selected' WHERE id = $1", [entryId]);
           res.json({ message: 'Winner selected. Awaiting final admin approval.' });
       } catch (err) {
           console.error('[SPONSOR] Error selecting winner:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });
  
   // --- QR CODE VALIDATION ENDPOINT ---
   router.post('/api/verify', checkSponsorAuth, async (req, res) => {
       const { qr_code_data } = req.body; // The data scanned from the QR code
       const sponsorId = req.sponsor.id;


       if (!qr_code_data) {
           return res.status(400).json({ message: 'QR code data is required.' });
       }
      
       // QR Code data should contain the quest_id and user_id
       // Example format: { "quest_id": 123, "user_id": "google_user_id_string" }
       let parsedData;
       try {
           parsedData = JSON.parse(qr_code_data);
       } catch (e) {
           return res.status(400).json({ message: 'Invalid QR code format.' });
       }


       const { quest_id, user_id } = parsedData;


       if (!quest_id || !user_id) {
           return res.status(400).json({ message: 'QR code is missing necessary information.' });
       }


       const client = await pool.connect();
       try {
           await client.query('BEGIN');
          
           // 1. Verify that the quest belongs to the sponsor and is active
           const questRes = await client.query(`
               SELECT id FROM quests
               WHERE id = $1 AND sponsor_id = $2 AND status = 'active' AND expiry_time > NOW()
           `, [quest_id, sponsorId]);
          
           if (questRes.rowCount === 0) {
               await client.query('ROLLBACK');
               return res.status(404).json({ message: 'Invalid or expired quest for this sponsor.' });
           }
          
           // 2. Check if the user has an entry for this quest (they must have registered first)
           const entryRes = await client.query(`
               SELECT id FROM quest_entries WHERE quest_id = $1 AND user_id = $2
           `, [quest_id, user_id]);


           if (entryRes.rowCount === 0) {
               await client.query('ROLLBACK');
               return res.status(404).json({ message: 'Player is not registered for this quest.' });
           }
          
           // 3. Update the quest progress for the user
           // This is the key part that connects to the quest system
           await updateQuestProgress(client, io, user_id, 'qr_scan', 1);


           await client.query('COMMIT');
           res.json({ success: true, message: `Player verified successfully! Quest progress updated.` });


       } catch(err) {
           await client.query('ROLLBACK');
           console.error('[API/Sponsor] Error verifying QR code:', err);
           res.status(500).json({ message: 'Server error during verification.' });
       } finally {
           client.release();
       }
   });


   return router;
};