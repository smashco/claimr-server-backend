require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('SERVER ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('SERVER ERROR: Uncaught Exception:', error);
  process.exit(1);
});

// --- App & Server Setup ---
const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- Firebase Admin SDK Initialization ---
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: 'claimr-6464.firebasestorage.app'
    });
    console.log('[Firebase Admin] Initialized successfully.');
  } else {
    console.log('[Firebase Admin] Skipping initialization.');
  }
} catch (error) {
  console.error('[Firebase Admin] FATAL: Failed to initialize.', error.message);
}

// --- Constants & Database Pool ---
const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 100;
const MINIMUM_CLAIM_AREA_SQM = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const players = {};

// --- Database Schema Setup ---
const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');

    // Original territories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE,
        owner_name VARCHAR(255),
        username VARCHAR(50) UNIQUE,
        profile_image_url TEXT,
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "territories" table is ready.');

    // NEW: Clans table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        tag VARCHAR(5) NOT NULL UNIQUE,
        description TEXT,
        clan_image_url TEXT,
        leader_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id),
        base_location GEOMETRY(POINT, 4326),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "clans" table is ready.');

    // NEW: Clan members linking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_members (
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL DEFAULT 'member', -- 'leader' or 'member'
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_members" table is ready.');

    // NEW: Clan join requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_join_requests (
        id SERIAL PRIMARY KEY,
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'denied'
        requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_join_requests" table is ready.');

  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err;
  } finally {
    client.release();
  }
};


// --- Middleware (Unchanged) ---
const checkAdminSecret = (req, res, next) => { /* ... unchanged ... */ };
const authenticate = async (req, res, next) => { /* ... unchanged ... */ };

// --- Basic & Profile API Endpoints (Updated) ---
app.get('/', (req, res) => { res.send('Claimr Server is running!'); });

// MODIFIED: /check-profile now also returns clan info
app.get('/check-profile', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required.' });
    try {
        const query = `
            SELECT 
                t.username, t.profile_image_url, t.area_sqm,
                c.id as clan_id, c.name as clan_name, c.tag as clan_tag, cm.role as clan_role,
                (c.base_location IS NOT NULL) as base_is_set
            FROM territories t
            LEFT JOIN clan_members cm ON t.owner_id = cm.user_id
            LEFT JOIN clans c ON cm.clan_id = c.id
            WHERE t.owner_id = $1;
        `;
        const result = await pool.query(query, [googleId]);

        if (result.rowCount > 0 && result.rows[0].username) {
            const row = result.rows[0];
            const response = {
                profileExists: true,
                username: row.username,
                profileImageUrl: row.profile_image_url,
                area_sqm: row.area_sqm,
                clan_info: null
            };
            if (row.clan_id) {
                response.clan_info = {
                    id: row.clan_id,
                    name: row.clan_name,
                    tag: row.clan_tag,
                    role: row.clan_role,
                    base_is_set: row.base_is_set
                };
            }
            res.json(response);
        } else {
            res.json({ profileExists: false });
        }
    } catch (err) {
        console.error('[API] Error checking profile:', err);
        res.status(500).json({ error: 'Server error while checking profile.' });
    }
});

app.get('/check-username', async (req, res) => { /* ... unchanged ... */ });
app.post('/setup-profile', async (req, res) => { /* ... unchanged ... */ });

// --- Leaderboard & User Rank Endpoints (Updated) ---
app.get('/leaderboard', async (req, res) => { /* ... unchanged ... */ });

// NEW: User Rank endpoint
app.get('/user-rank', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required' });
    try {
        const query = `
            WITH ranked_users AS (
                SELECT owner_id, RANK() OVER (ORDER BY area_sqm DESC) as rank
                FROM territories
                WHERE area_sqm > 0 AND username IS NOT NULL
            )
            SELECT rank FROM ranked_users WHERE owner_id = $1;
        `;
        const result = await pool.query(query, [googleId]);
        if (result.rowCount > 0) {
            res.status(200).json({ rank: result.rows[0].rank });
        } else {
            res.status(200).json({ rank: 'N/A' }); // User not ranked yet
        }
    } catch (err) {
        console.error('[API] Error fetching user rank:', err);
        res.status(500).json({ error: 'Failed to fetch user rank' });
    }
});

// --- CLAN API ENDPOINTS ---

// NEW: GET /leaderboard/clans
app.get('/leaderboard/clans', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.name, c.tag, c.clan_image_url,
                COUNT(cm.user_id) as member_count,
                COALESCE(SUM(t.area_sqm), 0) as total_area_sqm
            FROM clans c
            LEFT JOIN clan_members cm ON c.id = cm.clan_id
            LEFT JOIN territories t ON cm.user_id = t.owner_id
            GROUP BY c.id
            ORDER BY total_area_sqm DESC
            LIMIT 100;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching clan leaderboard:', err);
        res.status(500).json({ error: 'Failed to fetch clan leaderboard' });
    }
});

// NEW: POST /clans
app.post('/clans', async (req, res) => {
    const { name, tag, description, leaderId } = req.body;
    if (!name || !tag || !leaderId) return res.status(400).json({ error: 'Name, tag, and leaderId are required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Check if user is already in a clan
        const memberCheck = await client.query('SELECT 1 FROM clan_members WHERE user_id = $1', [leaderId]);
        if (memberCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'You are already in a clan.' });
        }

        // Create the clan
        const insertClanQuery = 'INSERT INTO clans(name, tag, description, leader_id) VALUES($1, $2, $3, $4) RETURNING id, name, tag';
        const clanResult = await client.query(insertClanQuery, [name, tag, description || '', leaderId]);
        const newClan = clanResult.rows[0];

        // Add the leader to the clan_members table
        const insertMemberQuery = 'INSERT INTO clan_members(clan_id, user_id, role) VALUES($1, $2, $3)';
        await client.query(insertMemberQuery, [newClan.id, leaderId, 'leader']);

        await client.query('COMMIT');

        // Return the info needed for the AppUser model
        res.status(201).json({
            id: newClan.id,
            name: newClan.name,
            tag: newClan.tag,
            role: 'leader',
            base_is_set: false
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') { // Unique constraint violation
            return res.status(409).json({ message: 'A clan with that name or tag already exists.' });
        }
        console.error('[API] Error creating clan:', err);
        res.status(500).json({ message: 'Server error while creating clan.' });
    } finally {
        client.release();
    }
});

// NEW: GET /clans
app.get('/clans', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
        const query = `
            SELECT 
                c.id, c.name, c.tag, c.description, c.clan_image_url,
                t.username as leader_name,
                (SELECT COUNT(*) FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                (SELECT status FROM clan_join_requests cjr WHERE cjr.clan_id = c.id AND cjr.user_id = $1 AND cjr.status = 'pending') as join_request_status
            FROM clans c
            JOIN territories t ON c.leader_id = t.owner_id
            ORDER BY member_count DESC;
        `;
        const result = await pool.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching clans list:', err);
        res.status(500).json({ error: 'Failed to fetch clans' });
    }
});

// NEW: PUT /clans/:id/photo
app.put('/clans/:id/photo', async (req, res) => {
    const { id } = req.params;
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    try {
        await pool.query('UPDATE clans SET clan_image_url = $1 WHERE id = $2', [imageUrl, id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('[API] Error updating clan photo:', err);
        res.status(500).json({ error: 'Failed to update clan photo' });
    }
});

// NEW: POST /clans/:id/set-base
app.post('/clans/:id/set-base', async (req, res) => {
    const { id } = req.params;
    const { baseLocation } = req.body;
    if (!baseLocation || !baseLocation.lat || !baseLocation.lng) return res.status(400).json({ error: 'baseLocation is required' });
    try {
        const pointWKT = `POINT(${baseLocation.lng} ${baseLocation.lat})`;
        const query = `UPDATE clans SET base_location = ST_SetSRID(ST_GeomFromText($1), 4326) WHERE id = $2`;
        await pool.query(query, [pointWKT, id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('[API] Error setting clan base:', err);
        res.status(500).json({ error: 'Failed to set clan base' });
    }
});

// --- Admin Endpoints (Unchanged) ---
app.post('/dev/reset-user', authenticate, async (req, res) => { /* ... unchanged ... */ });
app.get('/admin/factory-reset', checkAdminSecret, async (req, res) => { /* ... unchanged ... */ });
app.get('/admin/reset-all-territories', checkAdminSecret, async (req, res) => { /* ... unchanged ... */ });


// --- Socket.IO Logic (Unchanged) ---
async function broadcastAllPlayers() { /* ... unchanged ... */ }
io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', async (data) => { /* ... unchanged ... */ });
  socket.on('locationUpdate', (data) => { /* ... unchanged ... */ });
  socket.on('startDrawingTrail', () => { /* ... unchanged ... */ });
  socket.on('stopDrawingTrail', () => { /* ... unchanged ... */ });
  socket.on('claimTerritory', async (data) => { /* ... unchanged ... */ });
  socket.on('deleteMyTerritories', async () => { /* ... unchanged ... */ });
  socket.on('disconnect', () => { /* ... unchanged ... */ });
});

// --- Server Start ---
setInterval(async () => { await broadcastAllPlayers(); }, SERVER_TICK_RATE_MS);
const main = async () => {
  server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
    setupDatabase().catch(err => {
        console.error("Failed to setup database after server start:", err);
        process.exit(1); 
    });
  });
};

main();