// routes/admin_api.js
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

module.exports = (pool, io, geofenceService) => {
    // --- Player Management ---
    router.get('/players', async (req, res) => {
        try {
            const result = await pool.query('SELECT owner_id, username, area_sqm FROM territories ORDER BY username');
            const playersList = result.rows.map(dbPlayer => {
                // Check against the in-memory 'players' map for online status
                const isOnline = Object.values(players).some(p => p.googleId === dbPlayer.owner_id);
                return { ...dbPlayer, isOnline };
            });
            res.json(playersList);
        } catch (err) {
            console.error('[API/Admin] Error fetching players:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    // NEW: Endpoint to get full details for a single player
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

    router.post('/player/:id/:action', async (req, res) => {
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
                SELECT q.*, s.name as sponsor_name
                FROM quests q
                LEFT JOIN sponsors s ON q.sponsor_id = s.id
                ORDER BY q.created_at DESC
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('[API/Admin] Error fetching quests:', err);
            res.status(500).json({ message: 'Server error' });
        }
    });

    router.post('/quests', async (req, res) => {
        const { title, description, type, objective_type, objective_value, is_first_come_first_served, launch_time, expiry_time, sponsor_id, google_form_url } = req.body;
        if (!title || !description || !type || !objective_type || !objective_value || !expiry_time) {
            return res.status(400).json({ message: 'Missing required quest fields.' });
        }
        try {
            const newQuest = await pool.query(
                `INSERT INTO quests (title, description, type, objective_type, objective_value, is_first_come_first_served, launch_time, expiry_time, sponsor_id, google_form_url, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active') RETURNING *`,
                [title, description, type, objective_type, objective_value, !!is_first_come_first_served, launch_time, expiry_time, sponsor_id, google_form_url]
            );
            io.emit('newQuestLaunched', newQuest.rows[0]);
            res.status(201).json(newQuest.rows[0]);
        } catch (err) {
            console.error('[API/Admin] Error creating quest:', err);
            res.status(500).json({ message: 'Server error while creating quest.' });
        }
    });
    
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

    return router;
};