// /routes/admin_api.js

const express = require('express');
const multer = require('multer');


const upload = multer({ storage: multer.memoryStorage() });


module.exports = (pool, io, geofenceService, players) => {
   const router = express.Router();


   // --- Player Management ---
   router.get('/players', async (req, res) => {
       try {
           const result = await pool.query('SELECT owner_id, username, area_sqm, superpowers FROM territories ORDER BY username');
           const playersList = result.rows.map(dbPlayer => {
               const onlinePlayer = Object.values(players).find(p => p.googleId === dbPlayer.owner_id);
               return {
                   ...dbPlayer,
                   isOnline: !!onlinePlayer,
                   lastKnownPosition: onlinePlayer ? onlinePlayer.lastKnownPosition : null
               };
           });
           res.json(playersList);
       } catch (err) {
           console.error('[API/Admin] Error fetching players:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   router.get('/player/:id', async (req, res) => {
       const { id } = req.params;
       try {
           const result = await pool.query('SELECT * FROM territories WHERE owner_id = $1', [id]);
           if (result.rowCount === 0) {
               return res.status(404).json({ message: 'Player not found.' });
           }
           res.json(result.rows[0]);
       } catch (err) {
           console.error(`[API/Admin] Error fetching details for player ${id}:`, err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   router.post('/player/:id/reset-territory', async (req, res) => {
       const { id } = req.params;
       try {
           await pool.query("UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0 WHERE owner_id = $1", [id]);
           io.emit('batchTerritoryUpdate', [{ ownerId: id, area: 0, geojson: null }]);
           return res.json({ message: `Territory for player ${id} has been reset.` });
       } catch (err) {
           console.error(`[API/Admin] Error on player action reset-territory:`, err);
           res.status(500).json({ message: 'Server error' });
       }
   });
  
   router.delete('/player/:id/delete', async (req, res) => {
       const { id } = req.params;
       try {
          const playerSocket = Object.values(players).find(p => p.googleId === id);
          await pool.query('DELETE FROM territories WHERE owner_id = $1', [id]);
          if (playerSocket) io.to(playerSocket.id).disconnect(true);
          return res.json({ message: `Player ${id} and all their data have been permanently deleted.` });
      } catch (err) {
          console.error(`[ADMIN] Error deleting player ${id}:`, err);
          res.status(500).json({ message: 'Server error' });
      }
  });


   // --- Quest Management ---
   router.get('/quests', async (req, res) => {
       try {
           const result = await pool.query(`
               SELECT q.*, s.name as sponsor_name, t.username as winner_username
               FROM quests q
               LEFT JOIN sponsors s ON q.sponsor_id = s.id
               LEFT JOIN territories t ON q.winner_user_id = t.owner_id
               ORDER BY q.created_at DESC
           `);
           res.json(result.rows);
       } catch (err) {
           console.error('[API/Admin] Error fetching quests:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });

    // =======================================================================//
    // ======================== QUEST CREATION FIX HERE ======================//
    // =======================================================================//
   router.post('/quests', async (req, res) => {
       const { title, description, objective_type, objective_value, is_first_come_first_served, expiry_time } = req.body;
       
       if (!title || !description || !objective_type || !objective_value || !expiry_time) {
           return res.status(400).json({ message: 'Missing required quest fields for admin quest.' });
       }
       
       try {
           // The 'type' is now hardcoded to 'admin' for quests created through this form.
           // The 'objective_type' from the form is correctly inserted into the 'objective_type' column.
           const newQuest = await pool.query(
               `INSERT INTO quests (title, description, type, objective_type, objective_value, is_first_come_first_served, expiry_time, status)
                VALUES ($1, $2, 'admin', $3, $4, $5, $6, 'active') RETURNING *`,
               [title, description, objective_type, objective_value, !!is_first_come_first_served, expiry_time]
           );
           io.emit('newQuestLaunched', newQuest.rows[0]);
           res.status(201).json(newQuest.rows[0]);
       } catch (err) {
           console.error('[API/Admin] Error creating quest:', err);
           res.status(500).json({ message: 'Server error while creating quest.' });
       }
   });
    // =======================================================================//
    // ====================== END OF QUEST CREATION FIX ======================//
    // =======================================================================//
  
   router.delete('/quests/:id', async (req, res) => {
       try {
           await pool.query('DELETE FROM quests WHERE id = $1', [req.params.id]);
           io.emit('questDeleted', { questId: req.params.id });
           res.json({ message: 'Quest deleted successfully.' });
       } catch (err) {
           console.error('[API/Admin] Error deleting quest:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   router.put('/quests/:id/extend', async (req, res) => {
       const { new_expiry_time } = req.body;
       if (!new_expiry_time) {
           return res.status(400).json({ message: 'new_expiry_time is required.' });
       }
       try {
           await pool.query('UPDATE quests SET expiry_time = $1 WHERE id = $2', [new_expiry_time, req.params.id]);
           io.emit('questUpdated', { questId: req.params.id, expiry_time: new_expiry_time });
           res.json({ message: 'Quest expiry time extended.' });
       } catch (err) {
           console.error('[API/Admin] Error extending quest:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });


   // --- Geofence Management ---
   router.get('/geofence-zones', async (req, res) => {
       try {
           const zones = await geofenceService.getGeofencePolygons();
           res.json(zones);
       } catch (error) {
           console.error('[API/Admin] Error fetching geofence zones:', error);
           res.status(500).json({ message: 'Server error while fetching zones.' });
       }
   });


   router.post('/geofence-zones/upload', upload.single('kmlFile'), async (req, res) => {
       const { name, zoneType } = req.body;
       if (!req.file || !name || !zoneType) {
           return res.status(400).json({ message: 'KML file, name, and zoneType are required.' });
       }
       try {
           const kmlString = req.file.buffer.toString('utf8');
           await geofenceService.addZoneFromKML(kmlString, name, zoneType);
          
           const allZones = await geofenceService.getGeofencePolygons();
           io.emit('geofenceUpdate', allZones);
          
           res.status(201).json({ message: 'Geofence zone added successfully.' });
       } catch (error) {
           console.error('[API/Admin] Error adding geofence zone:', error);
           res.status(500).json({ message: error.message });
       }
   });


   router.delete('/geofence-zones/:id', async (req, res) => {
       try {
           await geofenceService.deleteZone(req.params.id);
          
           const allZones = await geofenceService.getGeofencePolygons();
           io.emit('geofenceUpdate', allZones);


           res.json({ message: 'Geofence zone deleted successfully.' });
       } catch (error) {
           console.error('[API/Admin] Error deleting geofence zone:', error);
           res.status(500).json({ message: 'Server error while deleting zone.' });
       }
   });


   // --- Superpower Chest Management ---
   router.post('/spawn-chest', async (req, res) => {
       const { lat, lng } = req.body;
       if (lat === undefined || lng === undefined) {
           return res.status(400).json({ message: 'Latitude and Longitude are required.' });
       }
       try {
           const pointWKT = `ST_SetSRID(ST_Point(${lng}, ${lat}), 4326)`;
           const result = await pool.query(
               `INSERT INTO superpower_chests (location) VALUES (${pointWKT}) RETURNING id, ST_AsGeoJSON(location) as location`,
           );
           const newChest = {
               id: result.rows[0].id,
               location: JSON.parse(result.rows[0].location).coordinates.reverse()
           };
           io.emit('chestSpawned', newChest);
           res.status(201).json({ message: 'Superpower chest spawned successfully.', chest: newChest });
       } catch (err) {
           console.error('[ADMIN] Error spawning chest:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });
  
   router.get('/chests', async (req, res) => {
       try {
           const result = await pool.query(`
               SELECT id, ST_AsGeoJSON(location) as location
               FROM superpower_chests WHERE is_active = TRUE
           `);
           const chests = result.rows.map(c => ({
               id: c.id,
               location: JSON.parse(c.location).coordinates.reverse()
           }));
           res.json(chests);
       } catch (err) {
           console.error('[ADMIN] Error fetching chests:', err);
           res.status(500).json({ message: 'Server error' });
       }
   });
  
   // --- SHOP & PRIZE MANAGEMENT APIS ---
   router.get('/shop/items', async (req, res) => {
       try {
           const result = await pool.query('SELECT item_id, name, price FROM shop_items WHERE item_type = $1 ORDER BY price ASC', ['superpower']);
           res.json(result.rows);
       } catch (err) {
           console.error('[Admin API] Error fetching shop items:', err);
           res.status(500).json({ message: 'Failed to fetch shop items.' });
       }
   });


   router.put('/shop/items', async (req, res) => {
       const { itemId, price } = req.body;
       if (!itemId || typeof price !== 'number' || price < 0) {
           return res.status(400).json({ message: 'Valid itemId and a non-negative price are required.' });
       }
       try {
           await pool.query('UPDATE shop_items SET price = $1 WHERE item_id = $2', [price, itemId]);
           res.json({ message: `Price for ${itemId} updated to ${price} G.` });
       } catch(error) {
           console.error('[Admin API] Error updating item price:', err);
           res.status(500).json({ message: 'Failed to update item price.' });
       }
   });


   router.get('/mega-prize', async (req, res) => {
       try {
           const settingsRes = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mega_prize_voting_active'");
           const voting_active = settingsRes.rowCount > 0 && settingsRes.rows[0].setting_value === 'true';


           const candidatesRes = await pool.query(`
               SELECT c.id, c.name, c.brand, COUNT(v.user_id)::int as vote_count
               FROM mega_prize_candidates c
               LEFT JOIN mega_prize_votes v ON c.id = v.candidate_id
               WHERE c.is_active = TRUE
               GROUP BY c.id ORDER BY c.id;
           `);
          
           const winnersRes = await pool.query(`
               SELECT w.prize_name, w.win_date, t.username
               FROM mega_prize_winners w
               JOIN territories t ON w.winner_user_id = t.owner_id
               ORDER BY w.win_date DESC LIMIT 10;
           `);


           res.json({
               voting_active,
               candidates: candidatesRes.rows,
               winners: winnersRes.rows,
           });
       } catch (err) {
           console.error('[Admin API] Error fetching mega prize data:', err);
           res.status(500).json({ message: 'Failed to fetch mega prize data.' });
       }
   });


   router.post('/mega-prize/candidates', async (req, res) => {
       const { name, brand } = req.body;
       if (!name) return res.status(400).json({ message: 'Prize name is required.' });
       try {
           await pool.query('INSERT INTO mega_prize_candidates (name, brand) VALUES ($1, $2)', [name, brand || null]);
           res.json({ message: 'Prize candidate added.' });
       } catch (err) {
           console.error('[Admin API] Error adding prize candidate:', err);
           res.status(500).json({ message: 'Failed to add prize candidate.' });
       }
   });


   router.delete('/mega-prize/candidates/:id', async (req, res) => {
       const { id } = req.params;
       try {
           await pool.query('DELETE FROM mega_prize_candidates WHERE id = $1', [id]);
           res.json({ message: 'Prize candidate deleted.' });
       } catch (err) {
           console.error('[Admin API] Error deleting prize candidate:', err);
           res.status(500).json({ message: 'Failed to delete prize candidate.' });
       }
   });


   router.post('/mega-prize/start-voting', async (req, res) => {
       const client = await pool.connect();
       try {
           await client.query('BEGIN');
           await client.query('DELETE FROM mega_prize_votes');
           await client.query("UPDATE system_settings SET setting_value = 'true' WHERE setting_key = 'mega_prize_voting_active'");
           await client.query('COMMIT');
           res.json({ message: 'Voting has been started and previous votes have been cleared.' });
       } catch (err) {
           await client.query('ROLLBACK');
           console.error('[Admin API] Error starting voting:', err);
           res.status(500).json({ message: 'Failed to start voting.' });
       } finally {
           client.release();
       }
   });


   router.post('/mega-prize/stop-voting', async (req, res) => {
       try {
           await pool.query("UPDATE system_settings SET setting_value = 'false' WHERE setting_key = 'mega_prize_voting_active'");
           res.json({ message: 'Voting has been stopped.' });
       } catch (err) {
           console.error('[Admin API] Error stopping voting:', err);
           res.status(500).json({ message: 'Failed to stop voting.' });
       }
   });


   router.post('/mega-prize/declare-winner', async (req, res) => {
       const client = await pool.connect();
       try {
           await client.query('BEGIN');


           const votingStatus = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mega_prize_voting_active'");
           if (votingStatus.rows[0].setting_value === 'true') {
               await client.query('ROLLBACK');
               return res.status(400).json({ message: 'Cannot declare a winner while voting is active. Please stop voting first.' });
           }
          
           const winningCandidateRes = await client.query(`
               SELECT c.id, c.name, COUNT(v.user_id) as votes
               FROM mega_prize_candidates c
               JOIN mega_prize_votes v ON c.id = v.candidate_id
               WHERE c.is_active = TRUE
               GROUP BY c.id
               ORDER BY votes DESC, RANDOM() LIMIT 1;
           `);


           if (winningCandidateRes.rowCount === 0) {
               await client.query('ROLLBACK');
               return res.status(404).json({ message: 'No votes found for any candidate. Cannot declare a winner.' });
           }


           const winningPrize = winningCandidateRes.rows[0];
           const votersRes = await client.query('SELECT user_id FROM mega_prize_votes WHERE candidate_id = $1', [winningPrize.id]);
          
           if (votersRes.rowCount === 0) {
                await client.query('ROLLBACK');
               return res.status(404).json({ message: 'Winning prize had no voters. This should not happen.' });
           }


           const winner = votersRes.rows[Math.floor(Math.random() * votersRes.rowCount)];
           await client.query(
               'INSERT INTO mega_prize_winners (prize_name, winner_user_id) VALUES ($1, $2)',
               [`${winningPrize.name}`, winner.user_id]
           );


           await client.query('DELETE FROM mega_prize_votes');
           await client.query('DELETE FROM mega_prize_candidates');


           await client.query('COMMIT');
          
           const winnerUsernameRes = await pool.query('SELECT username FROM territories WHERE owner_id = $1', [winner.user_id]);
           const winnerUsername = winnerUsernameRes.rows[0].username;


           res.json({ message: `🎉 WINNER DECLARED! 🎉\n\n${winnerUsername} has won "${winningPrize.name}"!` });


       } catch (err) {
           await client.query('ROLLBACK');
           console.error('[Admin API] Error declaring winner:', err);
           res.status(500).json({ message: 'Failed to declare winner.' });
       } finally {
           client.release();
       }
   });


   return router;
};