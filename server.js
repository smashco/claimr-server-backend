require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require("socket.io");
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const admin = require('firebase-admin');
const turf = require('@turf/turf');
const multer = require('multer');

// --- Require the Game and Service Logic Handlers ---
const handleSoloClaim = require('./game_logic/solo_handler');
const handleClanClaim = require('./game_logic/clan_handler');
const GeofenceService = require('./geofence_service');

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
        is_carve_mode_active BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "territories" table is ready.');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_shield_active BOOLEAN DEFAULT FALSE;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_carve_mode_active BOOLEAN DEFAULT FALSE;');

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_members (
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE, user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL DEFAULT 'member', joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_members" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_join_requests (
        id SERIAL PRIMARY KEY, clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE, user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending', requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, UNIQUE(clan_id, user_id)
      );
    `);
    console.log('[DB] "clan_join_requests" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_territories (
        clan_id INTEGER NOT NULL PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE, area GEOMETRY(GEOMETRY, 4326), area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "clan_territories" table is ready.');

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
    console.log('[DB] Spatial index for "geofence_zones" is ensured.');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        login_id VARCHAR(50) NOT NULL UNIQUE,
        passcode_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "sponsors" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS quests (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        description TEXT,
        quest_type VARCHAR(20) NOT NULL DEFAULT 'admin',
        sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL,
        google_form_url TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        winner_user_id VARCHAR(255) REFERENCES territories(owner_id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "quests" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS quest_entries (
        id SERIAL PRIMARY KEY,
        quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        submission_details TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'submitted',
        submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(quest_id, user_id)
      );
    `);
    console.log('[DB] "quest_entries" table is ready.');

  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err;
  } finally {
    client.release();
  }
};

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
    } else {
        req.user.googleId = decodedToken.uid;
    }
    next();
  } catch (error) {
    console.error("Auth Error:", error);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// =======================================================================
// --- ADMIN PANEL LOGIC ---
// =======================================================================
const adminRouter = express.Router();

const checkAdminAuth = (req, res, next) => {
    console.log(`[DEBUG: AUTH] checkAdminAuth triggered for URL: ${req.originalUrl}`);
    console.log(`[DEBUG: AUTH] Cookies received:`, req.cookies);

    if (req.cookies.admin_session === process.env.ADMIN_SECRET_KEY) {
        console.log(`[DEBUG: AUTH] Authentication successful. Proceeding...`);
        return next();
    }
    
    console.log(`[DEBUG: AUTH] Authentication failed.`);
    if (req.originalUrl.startsWith('/admin/api')) {
        console.log(`[DEBUG: AUTH] API request unauthorized. Sending 401 JSON response.`);
        return res.status(401).json({ message: 'Unauthorized: Please log in.' });
    }
    
    console.log(`[DEBUG: AUTH] Page request unauthorized. Redirecting to /admin/login.`);
    res.redirect('/admin/login');
};

// --- PUBLIC ADMIN ROUTES (NO AUTH) ---
app.get('/admin/login', (req, res) => {
    console.log('[DEBUG: ROUTE] Serving /admin/login page.');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
    console.log('[DEBUG: ROUTE] POST to /admin/login received.');
    const { password } = req.body;
    if (password === process.env.ADMIN_SECRET_KEY) {
        console.log('[DEBUG: ROUTE] Correct password. Setting cookie and redirecting to dashboard.');
        res.cookie('admin_session', password, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/admin'
        });
        res.redirect('/admin/dashboard');
    } else {
        console.log('[DEBUG: ROUTE] Incorrect password.');
        res.status(401).send('Invalid Password. <a href="/admin/login">Try again</a>');
    }
});

// --- PROTECTED ADMIN ROUTES (AUTH REQUIRED) ---
app.get('/admin/dashboard', checkAdminAuth, (req, res) => {
    console.log('[DEBUG: ROUTE] Serving protected /admin/dashboard page.');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Use the adminRouter for all /admin/api routes, and protect them
app.use('/admin/api', checkAdminAuth, adminRouter);

// The main /admin root path should redirect to login
app.get('/admin', (req, res) => {
    console.log('[DEBUG: ROUTE] Redirecting from /admin to /admin/login.');
    res.redirect('/admin/login');
});

// --- Player Admin API ---
adminRouter.get('/players', async (req, res) => {
    try {
        const result = await pool.query('SELECT owner_id, username, area_sqm, is_carve_mode_active FROM territories ORDER BY username');
        res.json(result.rows);
    } catch (err) {
        console.error('[ADMIN] Error fetching players:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.post('/player/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    const playerSocket = Object.values(players).find(p => p.googleId === id);
    try {
        switch (action) {
            case 'reset-territory':
                await pool.query("UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0, original_base_point = NULL, is_carve_mode_active = false WHERE owner_id = $1", [id]);
                if (playerSocket) {
                    playerSocket.isCarveModeActive = false;
                    io.to(playerSocket.id).emit('allTerritoriesCleared');
                }
                io.emit('batchTerritoryUpdate', [{ ownerId: id, area: 0, geojson: null }]);
                return res.json({ message: `Territory for player ${id} has been reset.` });
            case 'give-shield':
                 await pool.query("UPDATE territories SET has_shield = true WHERE owner_id = $1", [id]);
                 if (playerSocket) playerSocket.hasShield = true;
                 return res.json({ message: `Shield given to player ${id}.` });
            case 'give-infiltrator':
                if (playerSocket) {
                    playerSocket.infiltratorCharges = (playerSocket.infiltratorCharges || 0) + 1;
                    return res.json({ message: `Infiltrator charge given to player ${id}.` });
                }
                return res.status(404).json({ message: 'Player is not online to receive charge.' });
            case 'kick':
                if (playerSocket) {
                    io.to(playerSocket.id).disconnect(true);
                    return res.json({ message: `Player ${id} has been kicked.` });
                }
                return res.status(404).json({ message: 'Player is not online.' });
            default:
                return res.status(400).json({ message: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[ADMIN] Error performing action '${action}' on player ${id}:`, err);
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.delete('/player/:id/delete', async (req, res) => {
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

// --- Geofence Admin API ---
adminRouter.get('/geofence-zones', async (req, res) => {
    try {
        const zones = await geofenceService.getGeofencePolygons();
        res.json(zones);
    } catch (err) {
        console.error('[ADMIN] Error fetching geofence zones:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.post('/geofence-zones/upload', upload.single('kmlFile'), async (req, res) => {
    try {
        const { name, zoneType } = req.body;
        const kmlFile = req.file;

        if (!name || !zoneType || !kmlFile) {
            return res.status(400).json({ message: 'Name, Zone Type, and KML file are required.' });
        }
        const kmlString = kmlFile.buffer.toString('utf8');
        await geofenceService.addZoneFromKML(kmlString, name, zoneType);
        const updatedZones = await geofenceService.getGeofencePolygons();
        io.emit('geofenceUpdate', updatedZones);
        res.json({ message: 'Geofence zone uploaded successfully!' });

    } catch (err) {
        console.error('[ADMIN] Error uploading KML:', err);
        res.status(500).json({ message: err.message || 'Failed to process KML file.' });
    }
});

adminRouter.delete('/geofence-zones/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await geofenceService.deleteZone(id);
        const updatedZones = await geofenceService.getGeofencePolygons();
        io.emit('geofenceUpdate', updatedZones);
        res.json({ message: 'Zone deleted successfully.' });
    } catch (err) {
        console.error('[ADMIN] Error deleting zone:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Sponsor Account Management ---
adminRouter.post('/sponsors', async (req, res) => {
    const { name, login_id, passcode } = req.body;
    if (!name || !login_id || !passcode) {
        return res.status(400).json({ message: 'Name, Login ID, and Passcode are required.' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const passcode_hash = await bcrypt.hash(passcode, salt);
        await pool.query(
            'INSERT INTO sponsors (name, login_id, passcode_hash) VALUES ($1, $2, $3)',
            [name, login_id, passcode_hash]
        );
        res.status(201).json({ message: 'Sponsor account created successfully.' });
    } catch (err) {
        if (err.code === '23505') { 
            return res.status(409).json({ message: 'Sponsor Login ID already exists.' });
        }
        console.error('[ADMIN] Error creating sponsor:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Quest Management ---
adminRouter.get('/quests', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT q.id, q.title, q.status, q.quest_type, s.name as sponsor_name
             FROM quests q
             LEFT JOIN sponsors s ON q.sponsor_id = s.id
             ORDER BY q.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[ADMIN] Error fetching quests:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.put('/quests/:id/approve', async (req, res) => {
    const { id: questId } = req.params;
    try {
        const result = await pool.query(
            "UPDATE quests SET status = 'active' WHERE id = $1 AND status = 'pending' RETURNING id, title",
            [questId]
        );
        
        if (result.rowCount > 0) {
            io.emit('newQuestLaunched', {
                id: result.rows[0].id,
                title: result.rows[0].title
            });
            console.log(`[QUESTS] Quest ${questId} approved and launched.`);
            res.json({ message: 'Quest approved and launched successfully.' });
        } else {
            res.status(404).json({ message: 'Quest not found or already approved.' });
        }
    } catch (err) {
        console.error('[ADMIN] Error approving quest:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

adminRouter.put('/quests/:questId/winner/approve', async (req, res) => {
    const { questId } = req.params;
    const { entryId } = req.body; 

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const entryRes = await client.query("SELECT user_id FROM quest_entries WHERE id = $1 AND quest_id = $2 AND status = 'winner_selected'", [entryId, questId]);
        if (entryRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Winning entry not found or not in correct status.' });
        }
        const winnerUserId = entryRes.rows[0].user_id;

        await client.query("UPDATE quests SET status = 'completed', winner_user_id = $1 WHERE id = $2", [winnerUserId, questId]);
        await client.query("UPDATE quest_entries SET status = 'winner_confirmed' WHERE id = $1", [entryId]);
        await client.query('COMMIT');
        
        const winnerSocket = Object.values(players).find(p => p.googleId === winnerUserId);
        if (winnerSocket) {
            io.to(winnerSocket.id).emit('questWinner', { message: 'Congratulations! You have won a quest!' });
        }
        
        res.json({ message: `Winner approved for quest ${questId}.`});
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[ADMIN] Error approving winner:', err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        client.release();
    }
});

// =======================================================================
// --- SPONSOR PANEL LOGIC ---
// =======================================================================
// ... (Your sponsor panel logic remains unchanged) ...
const sponsorRouter = express.Router();

const checkSponsorAuth = (req, res, next) => {
    if (req.cookies.sponsor_session) {
        return next();
    }
    if (req.originalUrl.startsWith('/sponsor/api')) {
        return res.status(401).json({ message: 'Unauthorized: Please log in.' });
    }
    res.redirect('/sponsor/login');
};

app.use('/sponsor', sponsorRouter);

sponsorRouter.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sponsor.html')));

sponsorRouter.post('/login', async (req, res) => {
    const { login_id, passcode } = req.body;
    if (!login_id || !passcode) {
        return res.status(400).send('Sponsor ID and Passcode are required.');
    }

    try {
        const result = await pool.query('SELECT id, name, passcode_hash FROM sponsors WHERE login_id = $1', [login_id]);
        if (result.rowCount === 0) {
            return res.status(401).send('Invalid Sponsor ID or Passcode. <a href="/sponsor/login">Try again</a>');
        }

        const sponsor = result.rows[0];
        const isMatch = await bcrypt.compare(passcode, sponsor.passcode_hash);

        if (isMatch) {
            res.cookie('sponsor_session', sponsor.id, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 24 * 60 * 60 * 1000, 
                path: '/sponsor'
            });
            res.redirect('/sponsor/dashboard');
        } else {
            res.status(401).send('Invalid Sponsor ID or Passcode. <a href="/sponsor/login">Try again</a>');
        }
    } catch (err) {
        console.error('[SPONSOR] Login error:', err);
        res.status(500).send('Server error during login.');
    }
});

sponsorRouter.get('/dashboard', checkSponsorAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sponsor_dashboard.html'));
});

sponsorRouter.get('/api/quests', checkSponsorAuth, async (req, res) => {
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

sponsorRouter.post('/api/quests', checkSponsorAuth, async (req, res) => {
    const sponsorId = req.cookies.sponsor_session;
    const { title, description, google_form_url } = req.body;

    if (!title || !description || !google_form_url) {
        return res.status(400).json({ message: 'Title, Description, and Google Form URL are required.' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO quests (title, description, quest_type, sponsor_id, google_form_url, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [title, description, 'sponsor', sponsorId, google_form_url, 'pending']
        );
        res.status(201).json({ message: 'Quest submitted for admin approval.', questId: result.rows[0].id });
    } catch (err) {
        console.error('[SPONSOR] Error creating quest:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

sponsorRouter.get('/api/quests/:id/entries', checkSponsorAuth, async (req, res) => {
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

sponsorRouter.put('/api/quests/entries/:entryId/select-winner', checkSponsorAuth, async (req, res) => {
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

app.get('/sponsor', (req, res) => res.redirect('/sponsor/login'));


// --- The rest of your file from MAIN GAME LOGIC to the end remains the same ---
// =======================================================================
// --- MAIN GAME LOGIC (API & SOCKETS) ---
// =======================================================================
app.get('/', (req, res) => { res.send('Claimr Server is running!'); });
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
            `INSERT INTO territories (owner_id, owner_name, username, profile_image_url, area, area_sqm, original_base_point) VALUES ($1, $2, $3, $4, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), 0, NULL)
             ON CONFLICT (owner_id) DO UPDATE SET username = $3, profile_image_url = $4, owner_name = $2;`,
            [googleId, displayName, username, imageUrl]
        );
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Username is already taken.' });
        console.error('[API] Error setting up profile:', err);
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

app.get('/api/quests/active', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT q.id, q.title, q.description, q.quest_type, q.google_form_url, s.name as sponsor_name
             FROM quests q
             LEFT JOIN sponsors s ON q.sponsor_id = s.id
             WHERE q.status = 'active'
             ORDER BY q.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching active quests:', err);
        res.status(500).json({ error: 'Failed to fetch active quests.' });
    }
});

app.post('/api/quests/:id/register', authenticate, async (req, res) => {
    const { id: questId } = req.params;
    const { googleId: userId } = req.user;

    try {
        await pool.query(
            `INSERT INTO quest_entries (quest_id, user_id) VALUES ($1, $2)
             ON CONFLICT (quest_id, user_id) DO NOTHING`,
            [questId, userId]
        );
        res.status(200).json({ message: 'Successfully registered for quest.' });
    } catch (err) {
        console.error('[API] Error registering for quest:', err);
        res.status(500).json({ message: 'Server error while registering for quest.' });
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

        const playerProfileRes = await client.query('SELECT has_shield, is_carve_mode_active, username IS NOT NULL as has_record FROM territories WHERE owner_id = $1', [googleId]);
        const hasShield = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].has_shield : false;
        const isCarveModeActive = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].is_carve_mode_active : false;
        const playerHasRecord = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].has_record : false;

        players[socket.id] = {
            id: socket.id,
            name,
            googleId,
            clanId,
            role,
            gameMode,
            lastKnownPosition: null,
            isDrawing: false,
            activeTrail: [],
            hasShield: hasShield,
            disconnectTimer: null,
            lastStandCharges: 1,
            infiltratorCharges: 1,
            ghostRunnerCharges: 1,
            isGhostRunnerActive: false,
            isLastStandActive: false,
            isInfiltratorActive: false,
            isCarveModeActive: isCarveModeActive,
        };

        const geofencePolygons = await geofenceService.getGeofencePolygons();
        socket.emit('geofenceUpdate', geofencePolygons);
        console.log(`[Socket] Sent ${geofencePolygons.length} geofence zones to ${socket.id}`);

        let activeTerritories = [];

        if (gameMode === 'clan') {
            const query = `
                SELECT
                    ct.clan_id::text as "ownerId",
                    c.name as "ownerName",
                    c.clan_image_url as "profileImageUrl",
                    '#CCCCCC' as identity_color,
                    ST_AsGeoJSON(ct.area) as geojson,
                    ct.area_sqm as area
                FROM clan_territories ct
                JOIN clans c ON ct.clan_id = c.id
                WHERE ct.area IS NOT NULL AND NOT ST_IsEmpty(ct.area);
            `;
            const territoryResult = await client.query(query);
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
            const query = `
                SELECT
                    owner_id as "ownerId",
                    username as "ownerName",
                    profile_image_url as "profileImageUrl",
                    identity_color,
                    ST_AsGeoJSON(area) as geojson,
                    area_sqm as area
                FROM territories
                WHERE area IS NOT NULL AND NOT ST_IsEmpty(area);
            `;
            const territoryResult = await client.query(query);
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
    console.log(`[Socket] Player ${player.name} (${socket.id}) stopped drawing trail (run ended).`);

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
          player.isLastStandActive = true;

          try {
              await pool.query('UPDATE territories SET is_shield_active = true WHERE owner_id = $1', [player.googleId]);
              console.log(`[GAME] ${player.name} activated LAST STAND. Charges left: ${player.lastStandCharges}`);
              socket.emit('superpowerAcknowledged', { power: 'lastStand', chargesLeft: player.lastStandCharges });
          } catch(e) {
              console.error(`[DB] Error activating shield for ${player.googleId}`, e);
              player.lastStandCharges++;
              player.isLastStandActive = false;
          }
      }
  });

  socket.on('claimTerritory', async (req) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !req.gameMode) {
      console.warn(`[Claim] Invalid claimTerritory request from ${socket.id}`);
      return;
    }

    const { gameMode, trail, baseClaim } = req;

    let locationToCheck;
    if (baseClaim) {
        locationToCheck = { lat: baseClaim.lat, lng: baseClaim.lng };
    } else if (trail && trail.length > 0) {
        locationToCheck = trail[0];
    }

    if (!locationToCheck || !(await geofenceService.isLocationValid(locationToCheck.lat, locationToCheck.lng))) {
        console.warn(`[Claim Rejected] Player ${player.name} sent a claim from an invalid location.`);
        socket.emit('claimRejected', { reason: 'You are outside the playable area.' });
        return;
    }

    if (trail.length < 1 && !baseClaim) {
        console.warn(`[Claim] Invalid trail length for claim by ${player.name}. Trail length: ${trail.length}, BaseClaim: ${!!baseClaim}`);
        socket.emit('claimRejected', { reason: 'Invalid trail length.' });
        return;
    }

    if (player.lastClaimAttempt && (Date.now() - player.lastClaimAttempt.timestamp < 3000)) {
        console.warn(`[Claim] Player ${player.name} attempting claims too fast.`);
        socket.emit('claimRejected', { reason: 'Please wait a moment before claiming again.' });
        return;
    }
    player.lastClaimAttempt = { timestamp: Date.now(), type: baseClaim ? 'base' : 'expansion' };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let result;
        if (gameMode === 'solo') {
            result = await handleSoloClaim(io, socket, player, players, trail, baseClaim, client);
        } else if (gameMode === 'clan') {
            result = await handleClanClaim(io, socket, player, players, trail, baseClaim, client);
        } else {
            throw new Error('Invalid game mode specified.');
        }

        if (!result) {
            await client.query('ROLLBACK');
            return;
        }

        const { finalTotalArea, areaClaimed, ownerIdsToUpdate } = result;
        await client.query('COMMIT');

        console.log(`[Claim] Player ${player.name} claimed ${areaClaimed.toFixed(2)} sqm. Total: ${finalTotalArea.toFixed(2)}. Owners updated: ${[...ownerIdsToUpdate]}`);

        socket.emit('claimSuccessful', { newTotalArea: finalTotalArea, areaClaimed: areaClaimed });

        const soloOwnersToUpdate = [];
        const clanOwnersToUpdate = [];

        if (ownerIdsToUpdate && ownerIdsToUpdate.length > 0) {
            for (const id of ownerIdsToUpdate) {
                if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id) && id.length < 10)) {
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
            batchUpdateData = batchUpdateData.concat(soloQueryResult.rows.map(r => ({ ...r, geojson: r.geojson ? JSON.parse(r.geojson) : null })));
        }
        if (clanOwnersToUpdate.length > 0) {
            const clanQueryResult = await client.query(`
                SELECT ct.clan_id::text as "ownerId", c.name as "ownerName", c.clan_image_url as "profileImageUrl", '#CCCCCC' as identity_color, ST_AsGeoJSON(ct.area) as geojson, ct.area_sqm as area
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.clan_id = ANY($1::int[]);`, [clanOwnersToUpdate]);
            batchUpdateData = batchUpdateData.concat(clanQueryResult.rows.map(r => ({...r, geojson: r.geojson ? JSON.parse(r.geojson) : null })));
        }

        if (batchUpdateData.length > 0) {
            console.log(`[GAME] Broadcasting territory updates for ${batchUpdateData.length} entities.`);
            io.emit('batchTerritoryUpdate', batchUpdateData);
        }

        player.isDrawing = false;
        player.activeTrail = [];
        io.emit('trailCleared', { id: socket.id });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] FATAL Error during territory claim:', err);
        socket.emit('claimRejected', { reason: err.message || 'Server error during claim.' });
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
                players[socket.id].isDrawing = false;
                players[socket.id].activeTrail = [];
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
  });
};
//sass
main();