// routes/admin_api.js
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

module.exports = (pool, io, geofenceService) => {
    // --- Player Management ---
    router.get('/players', async (req, res) => {
        // This logic is moved from server.js
        try {
            const result = await pool.query('SELECT owner_id, username, area_sqm FROM territories ORDER BY username');
            const players = result.rows.map(dbPlayer => {
                // You will need to pass the `players` map from server.js if you want online status here
                // For simplicity, we are omitting it for now. Re-add if needed.
                return { ...dbPlayer, isOnline: false }; // Simplified for modularity
            });
            res.json(players);
        } catch (err) {
            console.error('[API/Admin] Error fetching players:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    router.post('/player/:id/:action', async (req, res) => {
        // This logic is moved from server.js
        const { id, action } = req.params;
        try {
            if (action === 'reset-territory') {
                await pool.query("UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0 WHERE owner_id = $1", [id]);
                io.emit('batchTerritoryUpdate', [{ ownerId: id, area: 0, geojson: null }]);
                return res.json({ message: `Territory for player ${id} has been reset.` });
            } else if (action === 'delete') {
                await pool.query('DELETE FROM territories WHERE owner_id = $1', [id]);
                return res.json({ message: `Player ${id} has been deleted.` });
            }
            res.status(400).json({ message: 'Invalid action.' });
        } catch (err) {
            console.error(`[API/Admin] Error on player action ${action}:`, err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    // --- Quest Management ---
    router.get('/quests', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT q.*, t.username as winner_username, t.owner_name as winner_fullname
                FROM quests q LEFT JOIN territories t ON q.winner_id = t.owner_id
                ORDER BY q.created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('[API/Admin] Error fetching quests:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    router.post('/quests', async (req, res) => {
        const { title, description, quest_type, target_value, reward_description, expires_at, sponsor_name } = req.body;
        const type = sponsor_name ? 'sponsor' : 'admin'; // Determine if it's a sponsor quest
        try {
            const newQuest = await pool.query(
                `INSERT INTO quests (title, description, type, quest_type, target_value, reward_description, sponsor_name, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [title, description, type, quest_type, target_value, reward_description, sponsor_name || null, expires_at]
            );
            io.emit('questUpdate'); // Notify all clients of a new quest
            res.status(201).json(newQuest.rows[0]);
        } catch (err) {
            console.error('[API/Admin] Error creating quest:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });
    
    router.delete('/quests/:id', async (req, res) => {
        try {
            await pool.query('DELETE FROM quests WHERE id = $1', [req.params.id]);
            io.emit('questUpdate');
            res.json({ message: 'Quest deleted successfully.' });
        } catch (err) {
            console.error('[API/Admin] Error deleting quest:', err);
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

    router.post('/geofence-zones', upload.single('kmlFile'), async (req, res) => {
        const { name, zoneType } = req.body;
        if (!req.file || !name || !zoneType) {
            return res.status(400).json({ message: 'KML file, name, and zoneType are required.' });
        }
        try {
            const kmlString = req.file.buffer.toString('utf8');
            await geofenceService.addZoneFromKML(kmlString, name, zoneType);
            
            // Broadcast the update to all connected game clients
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
            
            // Broadcast the update to all connected game clients
            const allZones = await geofenceService.getGeofencePolygons();
            io.emit('geofenceUpdate', allZones);

            res.json({ message: 'Geofence zone deleted successfully.' });
        } catch (error) {
            console.error('[API/Admin] Error deleting geofence zone:', error);
            res.status(500).json({ message: 'Server error while deleting zone.' });
        }
    });

    return router;
};