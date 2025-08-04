require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');
const turf = require('@turf/turf');
const multer = require('multer');
const bcrypt = require('bcryptjs'); // For sponsor password hashing

// --- Require the Game and Service Logic Handlers ---
const handleSoloClaim = require('./game_logic/solo_handler');
const handleClanClaim = require('./game_logic/clan_handler');
const GeofenceService = require('./geofence_service');
const { updateQuestProgress, QUEST_TYPES } = require('./game_logic/quest_handler');

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
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

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
    console.log('[Firebase Admin] Skipping initialization (FIREBASE_SERVICE_ACCOUNT env var not set).');
  }
} catch (error) {
  console.error('[Firebase Admin] FATAL: Failed to initialize Firebase Admin.', error.message);
}

// --- Constants & Database Pool ---
const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 500;
const DISCONNECT_TRAIL_PERSIST_SECONDS = 60;
const CLAN_BASE_RADIUS_METERS = 56.42;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const geofenceService = new GeofenceService(pool);
const players = {};

// --- Database Schema Setup ---
const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');

    // Territories Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE,
        owner_name VARCHAR(255),
        username VARCHAR(50),
        profile_image_url TEXT,
        identity_color VARCHAR(10) DEFAULT '#39FF14',
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        original_base_point GEOMETRY(POINT, 4326),
        has_shield BOOLEAN DEFAULT FALSE,
        is_shield_active BOOLEAN DEFAULT FALSE,
        shield_activated_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        is_carve_mode_active BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "territories" table is ready.');

    // Clans Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        tag VARCHAR(5) NOT NULL UNIQUE,
        description TEXT,
        clan_image_url TEXT,
        leader_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        base_location GEOMETRY(POINT, 4326),
        has_shield BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "clans" table is ready.');

    // Clan Members Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_members (
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_members" table is ready.');

    // Clan Join Requests Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_join_requests (
        id SERIAL PRIMARY KEY,
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_join_requests" table is ready.');

    // Clan Territories Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_territories (
        clan_id INTEGER NOT NULL PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "clan_territories" table is ready.');

    // Geofence Zones Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS geofence_zones (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        zone_type VARCHAR(10) NOT NULL CHECK (zone_type IN ('allowed', 'blocked')),
        geom GEOMETRY(GEOMETRY, 4326) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "geofence_zones" table is ready.');
    await client.query('CREATE INDEX IF NOT EXISTS geofence_geom_idx ON geofence_zones USING GIST (geom);');

    // --- NEW QUEST TABLES ---
    await client.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id SERIAL PRIMARY KEY,
            title VARCHAR(100) NOT NULL,
            description TEXT,
            type VARCHAR(20) NOT NULL CHECK (type IN ('admin', 'sponsor')),
            quest_type VARCHAR(50) NOT NULL,
            target_value NUMERIC NOT NULL,
            reward_description TEXT,
            sponsor_name VARCHAR(100),
            is_active BOOLEAN DEFAULT TRUE,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            winner_id VARCHAR(255) REFERENCES territories(owner_id) ON DELETE SET NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('[DB] "quests" table is ready.');

    await client.query(`
        CREATE TABLE IF NOT EXISTS quest_progress (
            id SERIAL PRIMARY KEY,
            quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
            user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
            current_value NUMERIC DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(quest_id, user_id)
        );
    `);
    console.log('[DB] "quest_progress" table is ready.');

    await client.query(`
        CREATE TABLE IF NOT EXISTS sponsor_quest_registrations (
            id SERIAL PRIMARY KEY,
            quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
            user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
            unique_code VARCHAR(10) NOT NULL UNIQUE,
            status VARCHAR(20) DEFAULT 'registered' CHECK (status IN ('registered', 'verified')),
            registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(quest_id, user_id)
        );
    `);
    console.log('[DB] "sponsor_quest_registrations" table is ready.');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "sponsors" table is ready.');


  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err;
  } finally {
    client.release();
  }
};

// --- Shield Expiry Check Function ---
async function checkExpiredShields() {
    const client = await pool.connect();
    try {
        const expiredShields = await client.query(
            `SELECT owner_id, username FROM territories WHERE is_shield_active = true AND shield_activated_at < NOW() - INTERVAL '48 hours'`
        );

        if (expiredShields.rowCount > 0) {
            for (const shield of expiredShields.rows) {
                console.log(`[SHIELD EXPIRY] Shield for ${shield.username} (${shield.owner_id}) has expired. Deactivating.`);
                await client.query(
                    `UPDATE territories SET is_shield_active = false, shield_activated_at = NULL WHERE owner_id = $1`,
                    [shield.owner_id]
                );
                const playerSocketId = Object.keys(players).find(id => players[id]?.googleId === shield.owner_id);
                if (playerSocketId) {
                    if (players[playerSocketId]) {
                        players[playerSocketId].isLastStandActive = false;
                    }
                    io.to(playerSocketId).emit('shieldExpired');
                }
            }
        }
    } catch (err) {
        console.error('[SHIELD EXPIRY] Error during shield expiration check:', err);
    } finally {
        client.release();
    }
}

// --- Middleware ---
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized: No token provided.');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    if (decodedToken.firebase.identities && decodedToken.firebase.identities['google.com']) {
        req.user.googleId = decodedToken.firebase.identities['google.com'][0];
    }
    next();
  } catch (error) {
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// =======================================================================
// --- ADMIN & SPONSOR PANEL LOGIC ---
// =======================================================================
const adminRouter = express.Router();
const sponsorRouter = express.Router();

const checkAdminAuth = (req, res, next) => {
    if (req.cookies.admin_session === process.env.ADMIN_SECRET_KEY) {
        return next();
    }
    if (req.originalUrl.startsWith('/admin/api')) {
        return res.status(401).json({ message: 'Unauthorized: Please log in.' });
    }
    res.redirect('/admin/login');
};

const checkSponsorAuth = (req, res, next) => {
    if (req.cookies.sponsor_session && req.cookies.sponsor_name) {
        req.sponsor = { name: req.cookies.sponsor_name };
        return next();
    }
    if (req.originalUrl.startsWith('/sponsor/api')) {
        return res.status(401).json({ message: 'Unauthorized: Please log in.' });
    }
    res.redirect('/sponsor/login');
};

app.use('/admin', adminRouter);
app.use('/sponsor', sponsorRouter);

// --- Admin Panel Routes ---
adminRouter.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
adminRouter.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_SECRET_KEY) {
        res.cookie('admin_session', password, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/admin' });
        res.redirect('/admin/dashboard');
    } else {
        res.status(401).send('Invalid Password. <a href="/admin/login">Try again</a>');
    }
});
adminRouter.get('/dashboard', checkAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// --- Player Admin API ---
adminRouter.get('/api/players', checkAdminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT owner_id, username, area_sqm, is_carve_mode_active FROM territories ORDER BY username');
        const dbPlayers = result.rows;
        const enhancedPlayers = dbPlayers.map(dbPlayer => {
            const onlinePlayer = Object.values(players).find(p => p.googleId === dbPlayer.owner_id);
            return { ...dbPlayer, isOnline: !!onlinePlayer, lastKnownPosition: onlinePlayer?.lastKnownPosition };
        });
        res.json(enhancedPlayers);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

adminRouter.post('/api/player/:id/:action', checkAdminAuth, async (req, res) => {
    const { id, action } = req.params;
    try {
        if (action === 'reset-territory') {
            await pool.query("UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0, original_base_point = NULL, is_carve_mode_active = false WHERE owner_id = $1", [id]);
            io.emit('batchTerritoryUpdate', [{ ownerId: id, area: 0, geojson: null }]);
            return res.json({ message: `Territory for player ${id} has been reset.` });
        }
        return res.status(400).json({ message: 'Invalid action.' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.delete('/api/player/:id/delete', checkAdminAuth, async (req, res) => {
    const { id } = req.params;
     try {
        await pool.query('DELETE FROM territories WHERE owner_id = $1', [id]);
        return res.json({ message: `Player ${id} and all their data have been permanently deleted.` });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Geofence Admin API ---
adminRouter.get('/api/geofence-zones', checkAdminAuth, async (req, res) => {
    try {
        const zones = await geofenceService.getGeofencePolygons();
        res.json(zones);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

adminRouter.post('/api/geofence-zones/upload', checkAdminAuth, upload.single('kmlFile'), async (req, res) => {
    try {
        const { name, zoneType } = req.body;
        const kmlFile = req.file;
        const kmlString = kmlFile.buffer.toString('utf8');
        await geofenceService.addZoneFromKML(kmlString, name, zoneType);
        const updatedZones = await geofenceService.getGeofencePolygons();
        io.emit('geofenceUpdate', updatedZones);
        res.json({ message: 'Geofence zone uploaded successfully!' });
    } catch (err) { res.status(500).json({ message: err.message || 'Failed to process KML file.' }); }
});

adminRouter.delete('/api/geofence-zones/:id', checkAdminAuth, async (req, res) => {
    try {
        await geofenceService.deleteZone(req.params.id);
        const updatedZones = await geofenceService.getGeofencePolygons();
        io.emit('geofenceUpdate', updatedZones);
        res.json({ message: 'Zone deleted successfully.' });
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// --- Admin Quest Management API ---
adminRouter.get('/api/quests', checkAdminAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT q.*, t.username as winner_username, t.owner_name as winner_fullname
            FROM quests q
            LEFT JOIN territories t ON q.winner_id = t.owner_id
            ORDER BY q.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { 
        console.error('[ADMIN] Error fetching quests:', err);
        res.status(500).json({ message: 'Server error' }); 
    }
});

adminRouter.post('/api/quests', checkAdminAuth, async (req, res) => {
    const { title, description, quest_type, target_value, reward_description, expires_at } = req.body;
    try {
        const newQuest = await pool.query(
            `INSERT INTO quests (title, description, type, quest_type, target_value, reward_description, expires_at)
             VALUES ($1, $2, 'admin', $3, $4, $5, $6) RETURNING *`,
            [title, description, quest_type, target_value, reward_description, expires_at]
        );
        io.emit('questUpdate');
        res.status(201).json(newQuest.rows[0]);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

adminRouter.delete('/api/quests/:id', checkAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM quests WHERE id = $1', [req.params.id]);
        io.emit('questUpdate');
        res.json({ message: 'Quest deleted successfully.' });
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// --- Sponsor Panel Routes ---
sponsorRouter.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sponsor.html')));
sponsorRouter.get('/dashboard', checkSponsorAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'sponsor_dashboard.html')));

sponsorRouter.post('/login', async (req, res) => {
    const { name, password } = req.body;
    try {
        const sponsorRes = await pool.query('SELECT * FROM sponsors WHERE name = $1', [name]);
        if (sponsorRes.rowCount === 0) return res.status(401).send('Invalid sponsor name or password.');
        const isMatch = await bcrypt.compare(password, sponsorRes.rows[0].password_hash);
        if (isMatch) {
            res.cookie('sponsor_session', 'your_sponsor_session_token_here', { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/sponsor' });
            res.cookie('sponsor_name', sponsorRes.rows[0].name, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/sponsor' });
            res.redirect('/sponsor/dashboard');
        } else {
            res.status(401).send('Invalid sponsor name or password.');
        }
    } catch(err) { res.status(500).send('Server error during login.'); }
});

sponsorRouter.get('/api/registrations', checkSponsorAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.unique_code, r.status, t.username, t.owner_name, t.profile_image_url
            FROM sponsor_quest_registrations r
            JOIN territories t ON r.user_id = t.owner_id
            JOIN quests q ON r.quest_id = q.id
            WHERE q.sponsor_name = $1 AND q.is_active = true
            ORDER BY r.registered_at DESC
        `, [req.sponsor.name]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

sponsorRouter.post('/api/verify', checkSponsorAuth, async (req, res) => {
    const { unique_code } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const regRes = await client.query(`
            SELECT r.user_id FROM sponsor_quest_registrations r
            JOIN quests q ON r.quest_id = q.id
            WHERE r.unique_code = $1 AND q.sponsor_name = $2 AND r.status = 'registered'
        `, [unique_code, req.sponsor.name]);
        
        if (regRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invalid or already verified code.' });
        }
        
        const { user_id } = regRes.rows[0];
        await client.query(`UPDATE sponsor_quest_registrations SET status = 'verified' WHERE unique_code = $1`, [unique_code]);
        await updateQuestProgress(user_id, QUEST_TYPES.SPONSOR_CHECKIN, 1, client, io, players);

        await client.query('COMMIT');
        res.json({ message: 'Player verified successfully!' });
    } catch(err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Server error' });
    } finally {
        client.release();
    }
});


// =======================================================================
// --- MAIN GAME LOGIC (API & SOCKETS) ---
// =======================================================================
app.get('/', (req, res) => { res.send('ClaimrunX Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

app.put('/users/me/preferences', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { identityColor } = req.body;
    if (!identityColor) { return res.status(400).json({ message: 'identityColor is required.' }); }
    try {
        await pool.query('UPDATE territories SET identity_color = $1 WHERE owner_id = $2', [identityColor, googleId]);
        res.status(200).json({ success: true, message: 'Preferences updated.' });
    } catch (err) {
        console.error('[API] Error updating user preferences:', err);
        res.status(500).json({ message: 'Server error while updating preferences.' });
    }
});

app.get('/check-profile', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required.' });
    try {
        const query = `
            SELECT 
                t.username, t.profile_image_url, t.area_sqm, t.identity_color, t.has_shield, 
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
                identityColor: row.identity_color,
                area_sqm: row.area_sqm || 0,
                has_shield: row.has_shield, 
                clan_info: null
            };
            if (row.clan_id) {
                response.clan_info = { id: row.clan_id.toString(), name: row.clan_name, tag: row.clan_tag, role: row.clan_role, base_is_set: row.base_is_set };
            }
            res.json(response);
        } else {
            res.json({ profileExists: false });
        }
    } catch (err) {
        console.error('[API] Error in /check-profile:', err);
        res.status(500).json({ error: 'Server error while checking profile.' });
    }
});

app.get('/check-username', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username query parameter is required.' });
    try {
        const result = await pool.query('SELECT 1 FROM territories WHERE username ILIKE $1', [username]);
        res.json({ isAvailable: result.rowCount === 0 });
    } catch (err) {
        res.status(500).json({ error: 'Server error while checking username.' });
    }
});

app.post('/setup-profile', async (req, res) => {
    const { googleId, username, imageUrl, displayName } = req.body;
    if (!googleId || !username || !imageUrl || !displayName) return res.status(400).json({ error: 'Missing required profile data.' });
    try {
        await pool.query(
            `INSERT INTO territories (owner_id, owner_name, username, profile_image_url, area, area_sqm, original_base_point) VALUES ($1, $2, $3, $4, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), 0, NULL)
             ON CONFLICT (owner_id) DO UPDATE SET username = $3, profile_image_url = $4, owner_name = $2;`,
            [googleId, displayName, username, imageUrl]
        );
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Username is already taken.' });
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT owner_id, username as owner_name, profile_image_url, area_sqm, RANK() OVER (ORDER BY area_sqm DESC) as rank, identity_color
            FROM territories WHERE area_sqm > 0 AND username IS NOT NULL ORDER BY area_sqm DESC LIMIT 100;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching leaderboard:', err);
        res.status(500).json({ error: 'Failed to fetch leaderboard.' });
    }
});

app.get('/leaderboard/clans', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.name, c.tag, c.clan_image_url, c.leader_id,
                COUNT(cm.user_id)::integer as member_count,
                COALESCE((SELECT area_sqm FROM clan_territories ct WHERE ct.clan_id = c.id), 0) as total_area_sqm,
                t_leader.username as leader_name
            FROM clans c
            LEFT JOIN clan_members cm ON c.id = cm.clan_id
            LEFT JOIN clan_territories ct ON c.id = ct.clan_id
            LEFT JOIN territories t_leader ON c.leader_id = t_leader.owner_id
            GROUP BY c.id, ct.area_sqm, t_leader.username
            ORDER BY total_area_sqm DESC LIMIT 100;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching clan leaderboard:', err);
        res.status(500).json({ error: 'Failed to fetch clan leaderboard.' });
    }
});

app.post('/clans', authenticate, async (req, res) => {
    const { name, tag, description } = req.body;
    const leaderId = req.user.googleId;
    if (!name || !tag || !leaderId) return res.status(400).json({ error: 'Name, tag, and leaderId are required.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const memberCheck = await client.query('SELECT 1 FROM clan_members WHERE user_id = $1', [leaderId]);
        if (memberCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'You are already in a clan.' });
        }
        const insertClanQuery = 'INSERT INTO clans(name, tag, description, leader_id) VALUES($1, $2, $3, $4) RETURNING id, name, tag';
        const clanResult = await client.query(insertClanQuery, [name, tag, description || '', leaderId]);
        const newClan = clanResult.rows[0];
        await client.query('INSERT INTO clan_members(clan_id, user_id, role) VALUES($1, $2, $3)', [newClan.id, leaderId, 'leader']);
        
        await client.query(`INSERT INTO clan_territories (clan_id, area, area_sqm) VALUES ($1, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), 0);`, [newClan.id]);

        await client.query('COMMIT');
        res.status(201).json({id: newClan.id.toString(), name: newClan.name, tag: newClan.tag, role: 'leader', base_is_set: false});
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ message: 'A clan with that name or tag already exists.' });
        console.error('[API] Error creating clan:', err);
        res.status(500).json({ message: 'Server error while creating clan.' });
    } finally {
        client.release();
    }
});

app.get('/clans', authenticate, async (req, res) => {
    const { googleId } = req.user;
    try {
        const query = `
            SELECT 
                c.id, c.name, c.tag, c.description, c.clan_image_url,
                t.username as leader_name,
                c.leader_id,
                (SELECT COUNT(*)::integer FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                COALESCE((SELECT area_sqm FROM clan_territories ct WHERE ct.clan_id = c.id), 0) as total_area_sqm,
                (SELECT status FROM clan_join_requests cjr WHERE cjr.clan_id = c.id AND cjr.user_id = $1 AND cjr.status = 'pending') as join_request_status
            FROM clans c
            JOIN territories t ON c.leader_id = t.owner_id
            ORDER BY member_count DESC;
        `;
        const result = await pool.query(query, [googleId]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching clans list:', err);
        res.status(500).json({ error: 'Failed to fetch clans.' });
    }
});

app.get('/clans/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const clanQuery = `
            SELECT 
                c.id, c.name, c.tag, c.description, c.clan_image_url,
                t.username as leader_name,
                c.leader_id,
                (SELECT COUNT(*)::integer FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                COALESCE((SELECT area_sqm FROM clan_territories WHERE clan_id = c.id), 0) as total_area_sqm,
                (c.base_location IS NOT NULL) as base_is_set 
            FROM clans c
            JOIN territories t ON c.leader_id = t.owner_id
            WHERE c.id = $1;
        `;
        const clanResult = await pool.query(clanQuery, [id]);
        if (clanResult.rowCount === 0) return res.status(404).json({ error: 'Clan not found.' });
        const clanDetails = clanResult.rows[0];
        const membersQuery = `
            SELECT t.owner_id as user_id, t.username, t.profile_image_url, cm.role, COALESCE(t.area_sqm, 0) as area_claimed_sqm
            FROM clan_members cm
            JOIN territories t ON cm.user_id = t.owner_id
            WHERE cm.clan_id = $1 ORDER BY cm.role DESC, t.area_sqm DESC;
        `;
        const membersResult = await pool.query(membersQuery, [id]);
        clanDetails.members = membersResult.rows;
        res.status(200).json(clanDetails);
    } catch (err) {
        console.error('[API] Error fetching clan details:', err);
        res.status(500).json({ error: 'Failed to fetch clan details.' });
    }
});

app.put('/clans/:id/photo', authenticate, async (req, res) => {
    const { id } = req.params;
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required.' });
    try {
        await pool.query('UPDATE clans SET clan_image_url = $1 WHERE id = $2', [imageUrl, id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('[API] Error updating clan photo:', err);
        res.status(500).json({ error: 'Failed to update clan photo.' });
    }
});

app.post('/clans/:id/set-base', authenticate, async (req, res) => {
    const { id } = req.params;
    const { baseLocation } = req.body;
    const leaderId = req.user.googleId; 
    if (!baseLocation || typeof baseLocation.lat !== 'number' || typeof baseLocation.lng !== 'number') {
        return res.status(400).json({ error: 'baseLocation with lat and lng is required.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const checkLeader = await client.query('SELECT 1 FROM clans WHERE id = $1 AND leader_id = $2', [id, leaderId]);
        if (checkLeader.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Only the clan leader can set the base.' });
        }

        const pointWKT = `POINT(${baseLocation.lng} ${baseLocation.lat})`;
        await client.query(`UPDATE clans SET base_location = ST_SetSRID(ST_GeomFromText($1), 4326) WHERE id = $2`, [pointWKT, id]);
        
        const center = [baseLocation.lng, baseLocation.lat];
        const initialBasePolygon = turf.circle(center, CLAN_BASE_RADIUS_METERS, { units: 'meters' });
        const initialBaseArea = turf.area(initialBasePolygon);
        const initialAreaGeoJSON = JSON.stringify(initialBasePolygon.geometry);

        await client.query(`
            INSERT INTO clan_territories (clan_id, area, area_sqm)
            VALUES ($1, ST_GeomFromGeoJSON($2), $3)
            ON CONFLICT (clan_id) DO UPDATE 
            SET area = ST_GeomFromGeoJSON($2), area_sqm = $3;
        `, [id, initialAreaGeoJSON, initialBaseArea]);
        console.log(`[API] Clan base for clan ${id} established. Initial territory created with area ${initialBaseArea} sqm.`);

        const clanMembers = await client.query('SELECT user_id FROM clan_members WHERE clan_id = $1', [id]);
        for (const memberRow of clanMembers.rows) {
            const memberSocketId = Object.keys(players).find(sockId => players[sockId].googleId === memberRow.user_id);
            if (memberSocketId) {
                io.to(memberSocketId).emit('clanBaseActivated', { center: baseLocation }); 
            }
        }
        await client.query('COMMIT');
        res.sendStatus(200);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[API] Error setting clan base:', err);
        res.status(500).json({ error: 'Failed to set clan base.' });
    } finally {
        client.release();
    }
});

app.delete('/clans/members/me', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const memberInfoRes = await client.query(`SELECT clan_id, role, (SELECT COUNT(*) FROM clan_members WHERE clan_id = cm.clan_id) as member_count FROM clan_members cm WHERE user_id = $1`, [googleId]);
        if (memberInfoRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "You are not in a clan." });
        }
        const { clan_id, role, member_count } = memberInfoRes.rows[0];
        if (role === 'leader' && member_count > 1) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: "A leader cannot leave a clan with members. Transfer leadership first." });
        }
        if (role === 'leader' && member_count <= 1) {
            await client.query('DELETE FROM clans WHERE id = $1', [clan_id]);
            await client.query('DELETE FROM clan_territories WHERE clan_id = $1', [clan_id]); 
        } else {
            await client.query('DELETE FROM clan_members WHERE user_id = $1', [googleId]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: "Successfully left the clan." });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[API] Error leaving clan:', err);
        res.status(500).json({ message: 'Server error while leaving clan.' });
    } finally {
        client.release();
    }
});

app.post('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { googleId } = req.user;
    try {
        const memberCheck = await pool.query('SELECT 1 FROM clan_members WHERE user_id = $1', [googleId]);
        if (memberCheck.rowCount > 0) {
            return res.status(409).json({ message: 'You are already in a clan.' });
        }
        await pool.query(`INSERT INTO clan_join_requests (clan_id, user_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (clan_id, user_id) DO NOTHING;`, [clanId, googleId]);
        res.sendStatus(201);
    } catch (err) {
        console.error('[API] Error creating join request:', err);
        res.status(500).json({ message: 'Server error while creating join request.' });
    }
});

app.get('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { googleId } = req.user;
    try {
        const leaderCheck = await pool.query('SELECT 1 FROM clans WHERE id = $1 AND leader_id = $2', [clanId, googleId]);
        if (leaderCheck.rowCount === 0) {
            return res.status(403).json({ message: 'You are not the leader of this clan.' });
        }
        const result = await pool.query(`
            SELECT cjr.id as request_id, t.owner_id as user_id, t.username, t.profile_image_url, cjr.requested_at
            FROM clan_join_requests cjr JOIN territories t ON cjr.user_id = t.owner_id
            WHERE cjr.clan_id = $1 AND cjr.status = 'pending' ORDER BY cjr.requested_at ASC;
        `, [clanId]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching join requests:', err);
        res.status(500).json({ message: 'Server error while fetching requests.' });
    }
});

app.put('/clans/requests/:requestId', authenticate, async (req, res) => {
    const { requestId } = req.params;
    const { status } = req.body;
    const { googleId } = req.user;
    if (!['approved', 'denied'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const requestResult = await client.query(`SELECT cjr.clan_id, cjr.user_id as applicant_google_id, c.leader_id FROM clan_join_requests cjr JOIN clans c ON cjr.clan_id = c.id WHERE cjr.id = $1;`, [requestId]);
        if (requestResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Request not found.' });
        }
        const { clan_id, applicant_google_id, leader_id } = requestResult.rows[0];
        if (leader_id !== googleId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'You are not authorized to manage this request.' });
        }
        if (status === 'denied') {
            await client.query('DELETE FROM clan_join_requests WHERE id = $1', [requestId]);
        }
        if (status === 'approved') {
            const memberCountRes = await client.query('SELECT COUNT(*) as count FROM clan_members WHERE clan_id = $1', [clan_id]);
            if (parseInt(memberCountRes.rows[0].count, 10) >= 20) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Clan is full.' });
            }
            await client.query('INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, $3)', [clan_id, applicant_google_id, 'member']);
            await client.query('DELETE FROM clan_join_requests WHERE id = $1', [requestId]);
            
            const newMemberSocketId = Object.keys(players).find(id => players[id].googleId === applicant_google_id);
            if (newMemberSocketId) {
                const newClanInfoRes = await client.query(`SELECT c.id, c.name, c.tag, cm.role, (c.base_location IS NOT NULL) as base_is_set FROM clans c JOIN clan_members cm ON c.id = cm.clan_id WHERE c.id = $1 AND cm.user_id = $2;`, [clan_id, applicant_google_id]);
                if (newClanInfoRes.rowCount > 0) {
                    const newClanInfo = newClanInfoRes.rows[0];
                    io.to(newMemberSocketId).emit('clanStatusUpdated', { id: newClanInfo.id.toString(), name: newClanInfo.name, tag: newClanInfo.tag, role: newClanInfo.role, base_is_set: newClanInfo.base_is_set });
                }
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ message: `Request successfully ${status}.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[API] Error managing join request:', err);
        res.status(500).json({ message: 'Server error while managing request.' });
    } finally {
        client.release();
    }
});

// --- Public Quest API ---
app.get('/api/quests/active', authenticate, async (req, res) => {
    try {
        const questsRes = await pool.query(`
            SELECT id, title, description, type, quest_type, target_value, reward_description, sponsor_name, expires_at
            FROM quests WHERE is_active = true AND expires_at > NOW()
        `);
        const progressRes = await pool.query(
            'SELECT quest_id, current_value FROM quest_progress WHERE user_id = $1',
            [req.user.googleId]
        );
        const progressMap = progressRes.rows.reduce((acc, row) => {
            acc[row.quest_id] = row.current_value;
            return acc;
        }, {});
        const questsWithProgress = questsRes.rows.map(q => ({
            ...q,
            progress: progressMap[q.id] || 0
        }));
        res.json(questsWithProgress);
    } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/quests/:id/register', authenticate, async (req, res) => {
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
        if (err.code === '23505') {
            return res.status(409).json({ message: 'You are already registered.' });
        }
        res.status(500).json({ message: 'Server error.' });
    }
});


// --- Socket.IO Logic ---
async function broadcastAllPlayers() {
    const playerIds = Object.keys(players);
    if (playerIds.length === 0) return;
    const googleIds = Object.values(players).map(p => p.googleId).filter(id => id);
    if (googleIds.length === 0) return;
    try {
        const profileQuery = await pool.query('SELECT owner_id, username, profile_image_url, identity_color FROM territories WHERE owner_id = ANY($1::varchar[])', [googleIds]);
        const profiles = profileQuery.rows.reduce((acc, row) => {
            acc[row.owner_id] = { username: row.username, imageUrl: row.profile_image_url, identityColor: row.identity_color };
            return acc;
        }, {});
        const allPlayersData = Object.values(players).map(p => {
            const profile = profiles[p.googleId] || {};
            return { 
                id: p.id,
                ownerId: p.googleId,
                name: profile.username || p.name,
                imageUrl: profile.imageUrl,
                identityColor: profile.identityColor,
                lastKnownPosition: p.lastKnownPosition
            };
        });
        io.emit('allPlayersUpdate', allPlayersData);
    } catch(e) {
        console.error("[Broadcast] Error fetching profiles for broadcast:", e);
    }
}

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  if (players[socket.id] && players[socket.id].disconnectTimer) {
      clearTimeout(players[socket.id].disconnectTimer);
      players[socket.id].disconnectTimer = null;
      console.log(`[SERVER] Cleared disconnect timer for ${socket.id} on reconnect.`);
  }

  socket.on('playerJoined', async ({ googleId, name, gameMode }) => {
    if (!googleId || !gameMode) {
        console.error(`[Socket] Invalid playerJoined event from ${socket.id}`);
        return;
    }
    console.log(`[Socket] Player ${name} (${socket.id}) joining in [${gameMode}] mode.`);
    const client = await pool.connect();
    
    try {
        const memberInfoRes = await client.query('SELECT clan_id, role FROM clan_members WHERE user_id = $1', [googleId]);
        const clanId = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].clan_id : null;
        const role = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].role : null;
        
        const playerProfileRes = await client.query('SELECT has_shield, is_shield_active, shield_activated_at, is_carve_mode_active, username IS NOT NULL as has_record FROM territories WHERE owner_id = $1', [googleId]);
        const hasShield = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].has_shield : false;
        const isShieldActive = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].is_shield_active : false;
        const shieldActivatedAt = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].shield_activated_at : null;
        const isCarveModeActive = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].is_carve_mode_active : false;
        const playerHasRecord = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].has_record : false;

        players[socket.id] = { 
            id: socket.id, name, googleId, clanId, role, gameMode, lastKnownPosition: null, isDrawing: false, activeTrail: [], hasShield, disconnectTimer: null, lastStandCharges: 1, infiltratorCharges: 1, ghostRunnerCharges: 1, isGhostRunnerActive: false, isLastStandActive: isShieldActive, isInfiltratorActive: false, isCarveModeActive,
        };
        
        if (isShieldActive && shieldActivatedAt) {
            socket.emit('initialShieldState', { isActive: true, activatedAt: shieldActivatedAt });
        }

        const geofencePolygons = await geofenceService.getGeofencePolygons();
        socket.emit('geofenceUpdate', geofencePolygons);
    
        let activeTerritories = [];
        if (gameMode === 'clan') {
            const territoryResult = await client.query(`
                SELECT ct.clan_id::text as "ownerId", c.name as "ownerName", c.clan_image_url as "profileImageUrl", '#CCCCCC' as identity_color, ST_AsGeoJSON(ct.area) as geojson, ct.area_sqm as area
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.area IS NOT NULL AND NOT ST_IsEmpty(ct.area);
            `);
            activeTerritories = territoryResult.rows.filter(row => row.geojson).map(row => ({ ...row, geojson: JSON.parse(row.geojson) }));
            if (clanId) {
                const clanBaseRes = await client.query('SELECT base_location FROM clans WHERE id = $1', [clanId]);
                if (clanBaseRes.rows.length > 0 && clanBaseRes.rows[0].base_location) {
                    const geojsonResult = await client.query(`SELECT ST_AsGeoJSON($1) as geojson`, [clanBaseRes.rows[0].base_location]);
                    const parsedBaseLoc = JSON.parse(geojsonResult.rows[0].geojson).coordinates;
                    socket.emit('clanBaseActivated', { center: { lat: parsedBaseLoc[1], lng: parsedBaseLoc[0] } });
                }
            }
        } 
        else if (gameMode === 'solo') { 
            const territoryResult = await client.query(`
                SELECT owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl", identity_color, ST_AsGeoJSON(area) as geojson, area_sqm as area
                FROM territories WHERE area IS NOT NULL AND NOT ST_IsEmpty(area);
            `);
            activeTerritories = territoryResult.rows.filter(row => row.geojson).map(row => ({ ...row, geojson: JSON.parse(row.geojson) }));
        }

        console.log(`[Socket] Found ${activeTerritories.length} [${gameMode}] territories. Sending 'existingTerritories' to ${socket.id}.`);
        socket.emit('existingTerritories', { territories: activeTerritories, playerHasRecord: playerHasRecord });

        const activeTrails = [];
        for (const playerId in players) {
          if (players[playerId].isDrawing && players[playerId].activeTrail.length > 0 && players[playerId].gameMode === gameMode) { 
            activeTrails.push({ id: playerId, trail: players[playerId].activeTrail });
          }
        }
        if (activeTrails.length > 0) {
          socket.emit('existingLiveTrails', activeTrails);
        }

    } catch (err) { 
      console.error(`[Socket] FATAL ERROR in playerJoined for ${socket.id}:`, err);
      socket.emit('error', { message: 'Failed to load game state.' });
    } finally {
        client.release();
    }
  });

  socket.on('locationUpdate', async (data) => {
    const player = players[socket.id];
    if (!player || player.gameMode === 'spectator') return; 
    player.lastKnownPosition = data;

    if (player.isDrawing) {
        player.activeTrail.push(data);

        if (!player.isGhostRunnerActive) {
          socket.broadcast.emit('trailPointAdded', { id: socket.id, point: data }); 
        }

        if (player.activeTrail.length >= 2) { 
            const lastPoint = player.activeTrail[player.activeTrail.length - 1];
            const secondLastPoint = player.activeTrail[player.activeTrail.length - 2];
            const attackerSegmentWKT = (secondLastPoint.lng === lastPoint.lng && secondLastPoint.lat === lastPoint.lat) 
                ? `POINT(${lastPoint.lng} ${lastPoint.lat})` 
                : `LINESTRING(${secondLastPoint.lng} ${secondLastPoint.lat}, ${lastPoint.lng} ${lastPoint.lat})`;
            
            const attackerSegmentGeom = `ST_SetSRID(ST_GeomFromText('${attackerSegmentWKT}'), 4326)`;

            const client = await pool.connect(); 
            try {
                for (const victimId in players) {
                    if (victimId === socket.id) continue; 
                    const victim = players[victimId];

                    if (player.gameMode === 'clan' && victim.gameMode === 'clan' && player.clanId === victim.clanId) {
                        continue; 
                    }

                    if (victim && victim.isDrawing && victim.activeTrail.length >= 2) {
                        const victimTrailWKT = 'LINESTRING(' + victim.activeTrail.map(p => `${p.lng} ${p.lat}`).join(', ') + ')';
                        const victimTrailGeom = `ST_SetSRID(ST_GeomFromText('${victimTrailWKT}'), 4326)`;
                        
                        const intersectionQuery = `SELECT ST_Intersects(${attackerSegmentGeom}, ${victimTrailGeom}) as intersects;`;
                        const result = await client.query(intersectionQuery);
                        if (result.rows[0].intersects) {
                            console.log(`[GAME] TRAIL CUT! Attacker ${player.name} cut Victim ${victim.name}`);
                            io.to(victimId).emit('runTerminated', { reason: `Your trail was cut by ${player.name}!` });
                            updateQuestProgress(player.googleId, QUEST_TYPES.CUT_TRAIL, 1, client, io, players);
                            victim.isDrawing = false;
                            victim.activeTrail = [];
                            io.emit('trailCleared', { id: victimId }); 
                        }
                    }
                }
            } catch (err) {
                console.error('[DB] Error during trail intersection check:', err);
            } finally {
                client.release(); 
            }
        }
    }
  });

  socket.on('startDrawingTrail', () => {
    const player = players[socket.id];
    if (!player || player.gameMode === 'spectator' || player.isDrawing) return;
    
    player.isDrawing = true;
    player.activeTrail = [];
    console.log(`[Socket] Player ${player.name} (${socket.id}) started drawing trail. Ghost Runner: ${player.isGhostRunnerActive}`);
    
    if (!player.isGhostRunnerActive) {
      socket.broadcast.emit('trailStarted', { id: socket.id, name: player.name });
    }
  });

  socket.on('stopDrawingTrail', async () => {
    const player = players[socket.id];
    if (!player) return;
    
    // FIX for Quest Progress: check if the player was actually drawing
    if (player.isDrawing && player.activeTrail.length > 1) {
        const trailLineString = turf.lineString(player.activeTrail.map(p => [p.lng, p.lat]));
        const distanceMeters = turf.length(trailLineString, { units: 'meters' });
        
        console.log(`[QUEST] Player ${player.name} finished a trail of ${distanceMeters.toFixed(2)} meters.`);
        
        const client = await pool.connect();
        try {
            await updateQuestProgress(player.googleId, QUEST_TYPES.MAKE_TRAIL, distanceMeters, client, io, players);
        } catch(err) {
            console.error("[QUEST] Error updating trail distance quest:", err);
        } finally {
            client.release();
        }
    }
    
    player.isDrawing = false;
    player.activeTrail = [];
    player.isGhostRunnerActive = false;
    player.isLastStandActive = false; 
    
    io.emit('trailCleared', { id: socket.id }); 
  });
  
  socket.on('activateGhostRunner', () => {
      const player = players[socket.id];
      if (player && player.ghostRunnerCharges > 0) {
          player.ghostRunnerCharges--;
          player.isGhostRunnerActive = true;
          console.log(`[GAME] ${player.name} activated GHOST RUNNER. Charges left: ${player.ghostRunnerCharges}`);
          socket.emit('superpowerAcknowledged', { power: 'ghostRunner', chargesLeft: player.ghostRunnerCharges });
      }
  });

  socket.on('activateInfiltrator', () => {
      const player = players[socket.id];
      if (player && player.infiltratorCharges > 0) {
          player.infiltratorCharges--;
          player.isInfiltratorActive = true;
          console.log(`[GAME] ${player.name} activated INFILTRATOR. Charges left: ${player.infiltratorCharges}`);
          socket.emit('superpowerAcknowledged', { power: 'infiltrator', chargesLeft: player.infiltratorCharges });
      }
  });
  
  socket.on('activateLastStand', async () => {
      const player = players[socket.id];
      if (player && player.lastStandCharges > 0) {
          player.lastStandCharges--;
          try {
              const result = await pool.query(
                  'UPDATE territories SET is_shield_active = true, shield_activated_at = CURRENT_TIMESTAMP WHERE owner_id = $1 RETURNING shield_activated_at', 
                  [player.googleId]
              );
              player.isLastStandActive = true;
              console.log(`[GAME] ${player.name} activated LAST STAND. Charges left: ${player.lastStandCharges}`);
              socket.emit('superpowerAcknowledged', { 
                  power: 'lastStand', 
                  chargesLeft: player.lastStandCharges,
                  shieldActivatedAt: result.rows[0].shield_activated_at
              });
          } catch(e) {
              console.error(`[DB] Error activating shield for ${player.googleId}`, e);
              player.lastStandCharges++;
          }
      }
  });

  socket.on('claimTerritory', async (req) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !req.gameMode) {
      return;
    }
    const { gameMode, trail, baseClaim } = req;
    if (trail.length < 1 && !baseClaim) {
      return socket.emit('claimRejected', { reason: 'Invalid trail length.' });
    }
    if (player.lastClaimAttempt && (Date.now() - player.lastClaimAttempt.timestamp < 3000)) {
      return socket.emit('claimRejected', { reason: 'Please wait a moment before claiming again.' });
    }
    player.lastClaimAttempt = { timestamp: Date.now() };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let result;
        if (gameMode === 'solo') {
            result = await handleSoloClaim(io, socket, player, players, trail, baseClaim, client);
        } else if (gameMode === 'clan') {
            result = await handleClanClaim(io, socket, player, players, trail, baseClaim, client);
        }
        
        if (!result) { 
            await client.query('ROLLBACK');
            return; 
        }
        
        const { finalTotalArea, areaClaimed, ownerIdsToUpdate } = result;
        await client.query('COMMIT');
        
        socket.emit('claimSuccessful', { newTotalArea: finalTotalArea, areaClaimed: areaClaimed });

        const soloOwnersToUpdate = [];
        const clanOwnersToUpdate = [];
        if (ownerIdsToUpdate) {
            for (const id of ownerIdsToUpdate) {
                if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) {
                    clanOwnersToUpdate.push(parseInt(id, 10));
                } else if (typeof id === 'string') {
                    soloOwnersToUpdate.push(id);
                }
            }
        }
        
        let batchUpdateData = [];
        if (soloOwnersToUpdate.length > 0) {
            const soloQueryResult = await client.query(`
                SELECT owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl", identity_color, ST_AsGeoJSON(area) as geojson, area_sqm as area 
                FROM territories WHERE owner_id = ANY($1::varchar[]);`, [soloOwnersToUpdate]);
            batchUpdateData.push(...soloQueryResult.rows.map(r => ({ ...r, geojson: r.geojson ? JSON.parse(r.geojson) : null })));
        }
        if (clanOwnersToUpdate.length > 0) {
            const clanQueryResult = await client.query(`
                SELECT ct.clan_id::text as "ownerId", c.name as "ownerName", c.clan_image_url as "profileImageUrl", '#CCCCCC' as identity_color, ST_AsGeoJSON(ct.area) as geojson, ct.area_sqm as area
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.clan_id = ANY($1::int[]);`, [clanOwnersToUpdate]);
            batchUpdateData.push(...clanQueryResult.rows.map(r => ({...r, geojson: r.geojson ? JSON.parse(r.geojson) : null })));
        }
        
        if (batchUpdateData.length > 0) {
            io.emit('batchTerritoryUpdate', batchUpdateData);
        }
        
        player.isDrawing = false;
        player.activeTrail = [];
        io.emit('trailCleared', { id: socket.id });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] FATAL Error during territory claim:', err);
        socket.emit('claimRejected', { reason: 'Server error during claim.' });
    } finally {
        client.release();
    }
  });
  
  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      console.log(`[SERVER] User ${player?.name || 'Unknown'} disconnected: ${socket.id}`);
      
      if (player.isDrawing) {
        console.log(`[SERVER] Player ${player.name}'s trail will persist for ${DISCONNECT_TRAIL_PERSIST_SECONDS} seconds.`);
        player.disconnectTimer = setTimeout(async () => {
            console.log(`[SERVER] Disconnect timer expired for ${player.name}. Clearing trail.`);
            if(players[socket.id]) {
                delete players[socket.id]; 
            }
            io.emit('trailCleared', { id: socket.id }); 
        }, DISCONNECT_TRAIL_PERSIST_SECONDS * 1000);
      } else {
        delete players[socket.id]; 
        io.emit('playerLeft', { id: socket.id });
      }
    }
  });
});

// --- Server Start ---
setInterval(broadcastAllPlayers, SERVER_TICK_RATE_MS);
const main = async () => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Listening on 0.0.0.0:${PORT}`);
    setupDatabase().catch(err => {
        console.error("[SERVER] Failed to setup database after server start:", err);
        process.exit(1); 
    });
    checkExpiredShields(); 
    setInterval(checkExpiredShields, 1000 * 60 * 60);
  });
};

main();