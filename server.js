/*
================================================================================
HOW TO USE DEBUGGING:
--------------------------------------------------------------------------------
This server now uses the 'debug' library for namespaced logging. To see the
logs, you must start the server with the DEBUG environment variable.

Examples (run these in your terminal):

1. See ALL debug messages:
   DEBUG=server:* node server.js

2. See only socket and payment messages:
   DEBUG=server:socket,server:payment node server.js

3. See all messages EXCEPT database logs:
   DEBUG=server:*,-server:db node server.js

Available Namespaces:
- server:lifecycle (Server start, stop, major events)
- server:db         (Database setup, transactions, critical queries)
- server:auth       (Authentication middleware, token verification)
- server:api        (User-facing API endpoints)
- server:admin      (Admin portal API endpoints)
- server:payment    (Razorpay and payment verification logic)
- server:socket     (Socket.IO connection, disconnects, and events)
- server:game       (Core game logic like claims, trail cuts, etc.)
- server:superpower (All logic within the superpower_manager)
================================================================================
*/

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
const debug = require('debug');

// Initialize namespaced debuggers
const logLifecycle = debug('server:lifecycle');
const logDb = debug('server:db');
const logAuth = debug('server:auth');
const logApi = debug('server:api');
const logAdmin = debug('server:admin');
const logPayment = debug('server:payment');
const logSocket = debug('server:socket');
const logGame = debug('server:game');

const Razorpay = require('razorpay');
const crypto = require('crypto');

// Import the new manager
const SuperpowerManager = require('./superpower_manager');

const handleSoloClaim = require('./game_logic/solo_handler');
const handleClanClaim = require('./game_logic/clan_handler');
const GeofenceService = require('./geofence_service');
const { updateQuestProgress } = require('./game_logic/quest_handler');

const adminApiRouter = require('./routes/admin_api');
const sponsorPortalRouter = require('./routes/sponsor_portal');
const questsApiRouter = require('./routes/quests_api');

process.on('unhandledRejection', (reason, promise) => {
  console.error('SERVER CRITICAL ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('SERVER CRITICAL ERROR: Uncaught Exception:', error);
  process.exit(1);
});

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

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: 'claimr-6464.firebasestorage.app'
    });
    logLifecycle('Firebase Admin initialized successfully.');
  } else {
    logLifecycle('Firebase Admin skipping initialization (FIREBASE_SERVICE_ACCOUNT env var not set).');
  }
} catch (error) {
  console.error('[Firebase Admin] FATAL: Failed to initialize Firebase Admin.', error.message);
}

let razorpay;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  logLifecycle('Razorpay initialized successfully.');
} else {
  console.warn('[Razorpay] Skipping initialization (RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in env).');
}

const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 500;
const DISCONNECT_TRAIL_PERSIST_SECONDS = 60;
const CLAN_BASE_RADIUS_METERS = 56.42;
const CHEST_RADIUS_METERS = 20;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Instantiate the manager
const superpowerManager = new SuperpowerManager(pool, razorpay);

const geofenceService = new GeofenceService(pool);
const players = {};

const setupDatabase = async () => {
  const client = await pool.connect();
  logDb('Connected to database for setup.');
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    logDb('PostGIS extension is enabled.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE,
        unique_player_id VARCHAR(10) UNIQUE,
        phone_number VARCHAR(20),
        instagram_id VARCHAR(100),
        gender VARCHAR(50),
        age INTEGER,
        height_cm REAL,
        weight_kg REAL,
        owner_name VARCHAR(255),
        username VARCHAR(50) UNIQUE,
        profile_image_url TEXT,
        identity_color VARCHAR(10) DEFAULT '#39FF14',
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        original_base_point GEOMETRY(POINT, 4326),
        has_shield BOOLEAN DEFAULT FALSE,
        is_shield_active BOOLEAN DEFAULT FALSE,
        is_carve_mode_active BOOLEAN DEFAULT FALSE,
        is_paid BOOLEAN DEFAULT FALSE,
        razorpay_subscription_id VARCHAR(100),
        subscription_status VARCHAR(50),
        total_distance_km REAL DEFAULT 0,
        total_duration_minutes INTEGER DEFAULT 0,
        superpowers JSONB DEFAULT '{"owned": []}'::jsonb,
        trail_effect VARCHAR(50) DEFAULT 'default',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"territories" table is ready.');
    
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS unique_player_id VARCHAR(10) UNIQUE;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS instagram_id VARCHAR(100);');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS gender VARCHAR(50);');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS age INTEGER;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS height_cm REAL;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS weight_kg REAL;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_shield_active BOOLEAN DEFAULT FALSE;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_carve_mode_active BOOLEAN DEFAULT FALSE;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT FALSE;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS razorpay_subscription_id VARCHAR(100);');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50);');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS total_distance_km REAL DEFAULT 0;');
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS total_duration_minutes INTEGER DEFAULT 0;');
    await client.query(`ALTER TABLE territories ADD COLUMN IF NOT EXISTS superpowers JSONB DEFAULT '{"owned": []}'::jsonb;`);
    await client.query(`ALTER TABLE territories ALTER COLUMN superpowers SET DEFAULT '{"owned": []}'::jsonb;`);
    await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS trail_effect VARCHAR(50) DEFAULT \'default\';');
    
    const usernameConstraint = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'territories_username_key'`);
    if(usernameConstraint.rowCount === 0) {
        await client.query('ALTER TABLE territories ADD CONSTRAINT territories_username_key UNIQUE (username);');
    }
    
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
    logDb('"clans" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_members (
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (clan_id, user_id)
      );
    `);
    logDb('"clan_members" table is ready.');

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
    logDb('"clan_join_requests" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_territories (
        clan_id INTEGER NOT NULL PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"clan_territories" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS geofence_zones (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        zone_type VARCHAR(10) NOT NULL CHECK (zone_type IN ('allowed', 'blocked')),
        geom GEOMETRY(GEOMETRY, 4326) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"geofence_zones" table is ready.');

    await client.query('CREATE INDEX IF NOT EXISTS geofence_geom_idx ON geofence_zones USING GIST (geom);');
    logDb('Spatial index for "geofence_zones" is ensured.');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        login_id VARCHAR(50) NOT NULL UNIQUE,
        passcode_hash TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"sponsors" table is ready.');

    await client.query(`
        CREATE TABLE IF NOT EXISTS quests (
            id SERIAL PRIMARY KEY,
            title VARCHAR(150) NOT NULL,
            description TEXT NOT NULL,
            type VARCHAR(20) NOT NULL,
            objective_type VARCHAR(50),
            objective_value INT,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            is_first_come_first_served BOOLEAN DEFAULT FALSE,
            sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL,
            google_form_url TEXT,
            winner_user_id VARCHAR(255) REFERENCES territories(owner_id),
            launch_time TIMESTAMP WITH TIME ZONE,
            expiry_time TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);
    logDb('"quests" table is ready.');

    await client.query(`
        CREATE TABLE IF NOT EXISTS quest_progress (
            id SERIAL PRIMARY KEY,
            quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
            user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
            progress INT NOT NULL DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(quest_id, user_id)
        );
    `);
    logDb('"quest_progress" table is ready.');

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
    logDb('"quest_entries" table is ready.');

    await client.query(`
        CREATE TABLE IF NOT EXISTS superpower_chests (
            id SERIAL PRIMARY KEY,
            location GEOMETRY(POINT, 4326) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);
    logDb('"superpower_chests" table is ready.');

    await client.query('CREATE INDEX IF NOT EXISTS superpower_chests_location_idx ON superpower_chests USING GIST (location);');
    logDb('Spatial index for "superpower_chests" is ensured.');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        item_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        price INTEGER NOT NULL,
        item_type VARCHAR(50) NOT NULL DEFAULT 'superpower'
      );
    `);
    logDb('"shop_items" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mega_prize_candidates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        brand VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    logDb('"mega_prize_candidates" table is ready.');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS mega_prize_votes (
        user_id VARCHAR(255) PRIMARY KEY REFERENCES territories(owner_id) ON DELETE CASCADE,
        candidate_id INTEGER NOT NULL REFERENCES mega_prize_candidates(id) ON DELETE CASCADE,
        voted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"mega_prize_votes" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS mega_prize_winners (
        id SERIAL PRIMARY KEY,
        prize_name VARCHAR(255) NOT NULL,
        winner_user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        win_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logDb('"mega_prize_winners" table is ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(50) PRIMARY KEY,
        setting_value TEXT
      );
    `);
    logDb('"system_settings" table is ready.');

    const superpowerItems = [
      { id: 'lastStand', name: 'Last Stand', description: 'Protects your territory from the next attack.', price: 29 },
      { id: 'infiltrator', name: 'Infiltrator', description: 'Start a run from deep within enemy territory.', price: 29 },
      { id: 'ghostRunner', name: 'Ghost Runner', description: 'Your trail is hidden from rivals for one run.', price: 29 },
      { id: 'trailDefense', name: 'Trail Defense', description: 'Your trail cannot be cut by rivals.', price: 29 },
    ];
    for (const item of superpowerItems) {
      await client.query(
        `INSERT INTO shop_items (item_id, name, description, price, item_type) VALUES ($1, $2, $3, $4, 'superpower') ON CONFLICT (item_id) DO UPDATE SET name = $2, description = $3, price = $4;`,
        [item.id, item.name, item.description, item.price]
      );
    }
    logDb('Seeded superpower items.');

    await client.query(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('mega_prize_voting_active', 'true') ON CONFLICT (setting_key) DO NOTHING;`);
    logDb('Seeded system settings.');

  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err;
  } finally {
    client.release();
    logDb('Database connection released after setup.');
  }
};

const authenticate = async (req, res, next) => {
  logAuth('Attempting to authenticate request for:', req.originalUrl);
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logAuth('Authentication failed: No token provided.');
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
    logAuth('Authentication successful for user:', req.user.googleId);
    next();
  } catch (error) {
    logAuth('Authentication error: Invalid token.', error.message);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

const checkAdminAuth = (req, res, next) => {
    logAdmin('Checking admin authentication for route:', req.originalUrl);
    if (req.cookies.admin_session === process.env.ADMIN_SECRET_KEY) {
        logAdmin('Admin authentication successful.');
        return next();
    }
    logAdmin('Admin authentication failed.');
    if (req.originalUrl.startsWith('/admin/api')) {
        return res.status(401).json({ message: 'Unauthorized: Please log in.' });
    }
    res.redirect('/admin/login');
};

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.post('/admin/login', (req, res) => {
    logAdmin('Admin login attempt.');
    const { password } = req.body;
    if (password === process.env.ADMIN_SECRET_KEY) {
        logAdmin('Admin login successful.');
        res.cookie('admin_session', password, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, path: '/admin' });
        res.redirect('/admin/dashboard');
    } else {
        logAdmin('Admin login failed: Invalid password.');
        res.status(401).send('Invalid Password. <a href="/admin/login">Try again</a>');
    }
});
app.get('/admin/dashboard', checkAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin/player_details.html', checkAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'player_details.html')));
app.get('/admin', (req, res) => res.redirect('/admin/login'));
app.use('/admin/api', checkAdminAuth, adminApiRouter(pool, io, geofenceService, players));

app.post('/admin/api/players/:googleId/manage-superpower', checkAdminAuth, async (req, res) => {
    const { googleId } = req.params;
    const { powerId, action } = req.body; 

    try {
        let newInventory;
        if (action === 'grant') {
            newInventory = await superpowerManager.grantPower(googleId, powerId);
        } else if (action === 'revoke') {
            newInventory = await superpowerManager.revokePower(googleId, powerId);
        } else {
            return res.status(400).json({ message: "Invalid action." });
        }
        
        const playerSocketId = Object.keys(players).find(id => players[id].googleId === googleId);
        if (playerSocketId) {
            const onlinePlayer = players[playerSocketId];
            const ownedList = newInventory.owned || [];
            onlinePlayer.hasLastStand = ownedList.includes('lastStand');
            onlinePlayer.hasInfiltrator = ownedList.includes('infiltrator');
            onlinePlayer.hasGhostRunner = ownedList.includes('ghostRunner');
            onlinePlayer.hasTrailDefense = ownedList.includes('trailDefense');
            
            io.to(playerSocketId).emit('superpowerInventoryUpdated', newInventory);
            logSocket(`Notified player ${googleId} of superpower update from admin in real-time.`);
        }

        res.status(200).json({
            success: true,
            message: `Successfully ${action === 'grant' ? 'granted' : 'revoked'} '${powerId}'.`,
            newInventory
        });
    } catch (err) {
        logAdmin(`Error managing superpower for ${googleId}: %O`, err);
        res.status(500).json({ message: err.message || 'Server error while managing superpower.' });
    }
});

app.use('/sponsor', sponsorPortalRouter(pool, io, players));
app.use('/api/quests', questsApiRouter(pool, authenticate));

app.get('/', (req, res) => { res.send('Claimr Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

app.put('/users/me/preferences', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { identityColor } = req.body;
    logApi(`User ${googleId} updating identityColor to ${identityColor}`);
    if (!identityColor) { return res.status(400).json({ message: 'identityColor is required.' }); }
    try {
        await pool.query('UPDATE territories SET identity_color = $1 WHERE owner_id = $2', [identityColor, googleId]);
        res.status(200).json({ success: true, message: 'Preferences updated.' });
    } catch (err) {
        logApi(`Error updating preferences for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while updating preferences.' });
    }
});

app.post('/users/me/health-profile', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { gender, age, height_cm, weight_kg } = req.body;
    logApi(`User ${googleId} updating health profile.`);
    try {
        await pool.query(
            'UPDATE territories SET gender = $1, age = $2, height_cm = $3, weight_kg = $4 WHERE owner_id = $5',
            [gender, age, height_cm, weight_kg, googleId]
        );
        res.status(200).json({ success: true, message: 'Health profile updated.' });
    } catch (err) {
        logApi(`Error updating health profile for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while updating health profile.' });
    }
});

app.post('/users/me/log-run', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { distance, durationSeconds } = req.body;
    logApi(`User ${googleId} logging run: ${distance}km in ${durationSeconds}s.`);

    if (typeof distance !== 'number' || typeof durationSeconds !== 'number') {
        return res.status(400).json({ message: 'Invalid distance or duration provided.' });
    }

    try {
        const durationMinutes = Math.floor(durationSeconds / 60);
        await pool.query(
            `UPDATE territories 
             SET total_distance_km = total_distance_km + $1, total_duration_minutes = total_duration_minutes + $2
             WHERE owner_id = $3`,
            [distance, durationMinutes, googleId]
        );
        res.status(200).json({ success: true, message: 'Run logged successfully.' });
    } catch (err) {
        logApi(`Error logging run for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while logging run.' });
    }
});

app.get('/users/me/stats', authenticate, async (req, res) => {
    const { googleId } = req.user;
    logApi(`Fetching stats for user ${googleId}.`);
    try {
        const result = await pool.query(
            'SELECT total_distance_km, total_duration_minutes FROM territories WHERE owner_id = $1',
            [googleId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        
        const totalDistance = result.rows[0].total_distance_km || 0;
        const totalDuration = result.rows[0].total_duration_minutes || 0;
        const estimatedCalories = totalDistance * 65; 
        const weeklyActivity = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]; 

        res.status(200).json({
            totalDistance: totalDistance,
            totalActiveTimeMinutes: totalDuration,
            totalCaloriesBurned: estimatedCalories,
            weeklyActivity: weeklyActivity
        });

    } catch (err) {
        logApi(`Error fetching stats for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while fetching stats.' });
    }
});

app.get('/check-profile', async (req, res) => {
    const { googleId } = req.query;
    logApi(`Checking profile for googleId: ${googleId}`);
    if (!googleId) return res.status(400).json({ error: 'googleId is required.' });
    try {
        const query = `
            SELECT
                t.username, t.profile_image_url, t.area_sqm, t.identity_color, t.has_shield, t.is_paid,
                t.razorpay_subscription_id, t.subscription_status, t.trail_effect, t.superpowers,
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
            logApi(`Profile found for ${googleId}. Superpowers: %O`, row.superpowers);
            const response = {
                profileExists: true,
                isPaid: row.is_paid,
                username: row.username,
                profileImageUrl: row.profile_image_url,
                identityColor: row.identity_color,
                area_sqm: row.area_sqm || 0,
                has_shield: row.has_shield,
                razorpaySubscriptionId: row.razorpay_subscription_id,
                subscriptionStatus: row.subscription_status,
                trailEffect: row.trail_effect || 'default',
                superpowers: row.superpowers || { owned: [] },
                clan_info: null
            };
            if (row.clan_id) {
                response.clan_info = { id: row.clan_id.toString(), name: row.clan_name, tag: row.clan_tag, role: row.clan_role, base_is_set: row.base_is_set };
            }
            res.json(response);
        } else {
            logApi(`No profile found for ${googleId}.`);
            res.json({ profileExists: false });
        }
    } catch (err) {
        logApi(`Error in /check-profile for ${googleId}: %O`, err);
        res.status(500).json({ error: 'Server error while checking profile.' });
    }
});

app.get('/users/check-username', async (req, res) => {
    const { username } = req.query;
    logApi(`Checking username availability for: ${username}`);
    if (!username) {
      return res.status(400).json({ error: 'Username query parameter is required.' });
    }
    try {
        const result = await pool.query('SELECT 1 FROM territories WHERE username ILIKE $1', [username]);
        const isAvailable = result.rowCount === 0;
        logApi(`Username '${username}' is available: ${isAvailable}`);
        res.json({ available: isAvailable }); 
    } catch (err) {
        logApi(`Error in /users/check-username for ${username}: %O`, err);
        res.status(500).json({ error: 'Server error while checking username.' });
    }
});

app.post('/setup-profile', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { username, imageUrl, displayName, phoneNumber, instagramId } = req.body;
    logApi(`Setting up profile for user ${googleId} with username ${username}.`);
    if (!username || !imageUrl || !displayName || !phoneNumber) {
        return res.status(400).json({ error: 'Missing required profile data.' });
    }
    let uniqueId, isUnique = false;
    while (!isUnique) {
        uniqueId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const check = await pool.query('SELECT 1 FROM territories WHERE unique_player_id = $1', [uniqueId]);
        if (check.rowCount === 0) isUnique = true;
    }
    try {
        await pool.query(
            `INSERT INTO territories (owner_id, unique_player_id, phone_number, instagram_id, owner_name, username, profile_image_url, area, area_sqm, is_paid)
             VALUES ($1, $2, $3, $4, $5, $6, $7, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), 0, FALSE)
             ON CONFLICT (owner_id) DO UPDATE SET
                username = $6, profile_image_url = $7, owner_name = $5, phone_number = $3, instagram_id = $4;`,
            [googleId, uniqueId, phoneNumber, instagramId || null, displayName, username, imageUrl]
        );
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'territories_username_key') return res.status(409).json({ message: 'Username is already taken.' });
        if (err.code === '23505' && err.constraint === 'territories_unique_player_id_key') return res.status(500).json({ message: 'Failed to generate a unique player ID. Please try again.'});
        logApi(`Error setting up profile for ${googleId}: %O`, err);
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

app.put('/users/me/trail-effect', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { trailEffect } = req.body;
    logApi(`User ${googleId} updating trail effect to ${trailEffect}`);
    if (!trailEffect) { 
        return res.status(400).json({ message: 'trailEffect is required.' }); 
    }
    try {
        await pool.query('UPDATE territories SET trail_effect = $1 WHERE owner_id = $2', [trailEffect, googleId]);
        res.status(200).json({ success: true, message: 'Trail effect updated.' });
    } catch (err) {
        logApi(`Error updating trail effect for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while updating trail effect.' });
    }
});

app.get('/shop/mega-prize', authenticate, async (req, res) => {
    const { googleId } = req.user;
    logApi(`Fetching mega prize data for user ${googleId}`);
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

        const userVoteRes = await pool.query('SELECT candidate_id FROM mega_prize_votes WHERE user_id = $1', [googleId]);

        res.json({
            voting_active,
            candidates: candidatesRes.rows,
            winners: winnersRes.rows,
            user_vote_id: userVoteRes.rowCount > 0 ? userVoteRes.rows[0].candidate_id : null,
        });

    } catch (err) {
        logApi(`Error fetching mega prize data for user ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while fetching mega prize data.' });
    }
});

app.post('/shop/mega-prize/vote', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { candidateId } = req.body;
    logApi(`User ${googleId} voting for mega prize candidate ${candidateId}`);
    if (!candidateId) {
        return res.status(400).json({ message: 'Candidate ID is required.' });
    }
    try {
        const settingsRes = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mega_prize_voting_active'");
        if (!(settingsRes.rowCount > 0 && settingsRes.rows[0].setting_value === 'true')) {
            return res.status(403).json({ message: 'Voting is not currently active.' });
        }
        await pool.query(
            `INSERT INTO mega_prize_votes (user_id, candidate_id) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET candidate_id = $2, voted_at = CURRENT_TIMESTAMP;`,
            [googleId, candidateId]
        );
        res.status(200).json({ success: true, message: 'Vote cast successfully.' });
    } catch (err) {
        logApi(`Error casting vote for user ${googleId}: %O`, err);
        if (err.code === '23503') { 
            return res.status(404).json({ message: 'Invalid prize candidate.' });
        }
        res.status(500).json({ message: 'Server error while casting vote.' });
    }
});

app.get('/shop/items', authenticate, async (req, res) => {
    logApi(`Fetching shop items for user ${req.user.googleId}`);
    try {
        const itemsResult = await pool.query(
          `SELECT item_id as id, name, description, price FROM shop_items WHERE item_type = 'superpower' ORDER BY price ASC;`
        );
        
        res.json({
            superpowers: itemsResult.rows,
        });
    } catch (err) {
        logApi(`Error fetching shop data for user ${req.user.googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while fetching shop data.' });
    }
});

app.post('/shop/create-order', authenticate, async (req, res) => {
    const { itemId } = req.body;
    const { googleId } = req.user;
    logPayment(`User ${googleId} requesting to create order for item '${itemId}'.`);
    try {
        const orderDetails = await superpowerManager.createPurchaseOrder(googleId, itemId);
        res.json(orderDetails);
    } catch (err) {
        logPayment(`Order creation failed for ${googleId}: %O`, err);
        res.status(err.message.includes('already own') ? 409 : 500).json({ message: err.message });
    }
});
  
app.post('/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, googleId, purchaseType, itemId } = req.body;
    logPayment(`Verifying payment for user ${googleId}, type: ${purchaseType}, item: ${itemId}, order: ${razorpay_order_id}`);
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !googleId) {
        logPayment(`Payment verification failed for ${googleId}: Missing required data.`);
        return res.status(400).json({ error: 'Missing required payment verification data.' });
    }
    
    try {
        if (purchaseType === 'superpower' && itemId) {
            await superpowerManager.verifyAndGrantPower(googleId, itemId, { razorpay_order_id, razorpay_payment_id, razorpay_signature });
        } else if (purchaseType === 'subscription') {
            logPayment(`Subscription logic for ${googleId}.`);
            await pool.query("UPDATE territories SET is_paid = TRUE, subscription_status = 'active' WHERE owner_id = $1", [googleId]);
        } else {
             throw new Error("Invalid purchase type");
        }
        res.status(200).json({ success: true, message: 'Payment verified successfully.' });
    } catch (err) {
        logPayment(`Payment verification failed for ${googleId}: %O`, err);
        res.status(500).json({ error: err.message || 'Server error while verifying payment.' });
    }
});

app.get('/subscription/status', authenticate, async (req, res) => {
    logPayment(`Fetching subscription status for user ${req.user.googleId}`);
    try {
        const result = await pool.query('SELECT razorpay_subscription_id, subscription_status FROM territories WHERE owner_id = $1', [req.user.googleId]);
        if (result.rowCount === 0 || !result.rows[0].razorpay_subscription_id) {
            return res.status(404).json({ message: 'No active subscription found.' });
        }
        
        const subscription = await razorpay.subscriptions.fetch(result.rows[0].razorpay_subscription_id);
        res.json({
            status: subscription.status,
            current_start: new Date(subscription.current_start * 1000),
            current_end: new Date(subscription.current_end * 1000),
            charge_at: new Date(subscription.charge_at * 1000),
        });
    } catch (err) {
        logPayment(`Error fetching subscription status for ${req.user.googleId}: %O`, err);
        res.status(500).json({ error: 'Server error while fetching status.' });
    }
});

app.post('/subscription/cancel', authenticate, async (req, res) => {
    logPayment(`Attempting to cancel subscription for user ${req.user.googleId}`);
    try {
        const result = await pool.query('SELECT razorpay_subscription_id FROM territories WHERE owner_id = $1', [req.user.googleId]);
        if (result.rowCount === 0 || !result.rows[0].razorpay_subscription_id) {
            return res.status(404).json({ message: 'No active subscription found.' });
        }
        
        await razorpay.subscriptions.cancel(result.rows[0].razorpay_subscription_id, { cancel_at_cycle_end: false });
        
        await pool.query("UPDATE territories SET subscription_status = 'cancelled' WHERE owner_id = $1", [req.user.googleId]);

        res.json({ success: true, message: 'Your subscription has been cancelled.' });
    } catch (err) {
        logPayment(`Error cancelling subscription for ${req.user.googleId}: %O`, err);
        res.status(500).json({ error: 'Server error while cancelling.' });
    }
});

app.get('/leaderboard', async (req, res) => {
    logApi('Fetching player leaderboard.');
    try {
        const result = await pool.query(`
            SELECT owner_id, username as owner_name, profile_image_url, area_sqm, RANK() OVER (ORDER BY area_sqm DESC) as rank, identity_color
            FROM territories WHERE area_sqm > 0 AND username IS NOT NULL ORDER BY area_sqm DESC LIMIT 100;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        logApi('Error fetching leaderboard: %O', err);
        res.status(500).json({ error: 'Failed to fetch leaderboard.' });
    }
});

app.get('/leaderboard/clans', async (req, res) => {
    logApi('Fetching clan leaderboard.');
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
        logApi('Error fetching clan leaderboard: %O', err);
        res.status(500).json({ error: 'Failed to fetch clan leaderboard.' });
    }
});

app.post('/clans', authenticate, async (req, res) => {
    const { name, tag, description } = req.body;
    const leaderId = req.user.googleId;
    logApi(`User ${leaderId} attempting to create clan '${name}' with tag '${tag}'`);
    if (!name || !tag || !leaderId) return res.status(400).json({ error: 'Name, tag, and leaderId are required.' });
    const client = await pool.connect();
    try {
        logDb(`BEGIN transaction for creating clan by ${leaderId}`);
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
        await client.query(`INSERT INTO clan_territories (clan_id, area, area_sqm) VALUES ($1, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), 0);`, [newClan.id]);
        await client.query('COMMIT');
        logDb(`COMMIT transaction for creating clan by ${leaderId}`);
        res.status(201).json({id: newClan.id.toString(), name: newClan.name, tag: newClan.tag, role: 'leader', base_is_set: false});
    } catch (err) {
        await client.query('ROLLBACK');
        logDb(`ROLLBACK transaction for creating clan due to error: ${err.message}`);
        if (err.code === '23505') return res.status(409).json({ message: 'A clan with that name or tag already exists.' });
        logApi(`Error creating clan for ${leaderId}: %O`, err);
        res.status(500).json({ message: 'Server error while creating clan.' });
    } finally {
        client.release();
    }
});

app.get('/clans', authenticate, async (req, res) => {
    const { googleId } = req.user;
    logApi(`Fetching all clans for user ${googleId}`);
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
        logApi(`Error fetching clans list for ${googleId}: %O`, err);
        res.status(500).json({ error: 'Failed to fetch clans.' });
    }
});

app.get('/clans/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    logApi(`Fetching details for clan ${id}`);
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
        logApi(`Error fetching details for clan ${id}: %O`, err);
        res.status(500).json({ error: 'Failed to fetch clan details.' });
    }
});

app.put('/clans/:id/photo', authenticate, async (req, res) => {
    const { id } = req.params;
    const { imageUrl } = req.body;
    logApi(`Updating photo for clan ${id}`);
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required.' });
    try {
        await pool.query('UPDATE clans SET clan_image_url = $1 WHERE id = $2', [imageUrl, id]);
        res.sendStatus(200);
    } catch (err) {
        logApi(`Error updating photo for clan ${id}: %O`, err);
        res.status(500).json({ error: 'Failed to update clan photo.' });
    }
});

app.post('/clans/:id/set-base', authenticate, async (req, res) => {
    const { id } = req.params;
    const { baseLocation } = req.body;
    const leaderId = req.user.googleId;
    logApi(`User ${leaderId} attempting to set base for clan ${id}`);
    if (!baseLocation || typeof baseLocation.lat !== 'number' || typeof baseLocation.lng !== 'number') {
        return res.status(400).json({ error: 'baseLocation with lat and lng is required.' });
    }

    const client = await pool.connect();
    try {
        logDb(`BEGIN transaction for setting clan base by ${leaderId}`);
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
        logApi(`Clan base for clan ${id} established. Initial territory created with area ${initialBaseArea} sqm.`);

        const clanMembers = await client.query('SELECT user_id FROM clan_members WHERE clan_id = $1', [id]);
        for (const memberRow of clanMembers.rows) {
            const memberSocketId = Object.keys(players).find(sockId => players[sockId].googleId === memberRow.user_id);
            if (memberSocketId) {
                io.to(memberSocketId).emit('clanBaseActivated', { center: baseLocation });
            }
        }
        await client.query('COMMIT');
        logDb(`COMMIT transaction for setting clan base.`);
        res.sendStatus(200);
    } catch (err) {
        await client.query('ROLLBACK');
        logDb(`ROLLBACK transaction for setting clan base due to error: ${err.message}`);
        logApi(`Error setting clan base for clan ${id}: %O`, err);
        res.status(500).json({ error: 'Failed to set clan base.' });
    } finally {
        client.release();
    }
});

app.delete('/clans/members/me', authenticate, async (req, res) => {
    const { googleId } = req.user;
    logApi(`User ${googleId} attempting to leave their clan.`);
    const client = await pool.connect();
    try {
        logDb(`BEGIN transaction for leaving clan by ${googleId}`);
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
        logDb(`COMMIT transaction for leaving clan.`);
        res.status(200).json({ message: "Successfully left the clan." });
    } catch (err) {
        await client.query('ROLLBACK');
        logDb(`ROLLBACK transaction for leaving clan due to error: ${err.message}`);
        logApi(`Error leaving clan for ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while leaving clan.' });
    } finally {
        client.release();
    }
});

app.post('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { googleId } = req.user;
    logApi(`User ${googleId} requesting to join clan ${clanId}`);
    try {
        const memberCheck = await pool.query('SELECT 1 FROM clan_members WHERE user_id = $1', [googleId]);
        if (memberCheck.rowCount > 0) {
            return res.status(409).json({ message: 'You are already in a clan.' });
        }
        await pool.query(`INSERT INTO clan_join_requests (clan_id, user_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (clan_id, user_id) DO NOTHING;`, [clanId, googleId]);
        res.sendStatus(201);
    } catch (err) {
        logApi(`Error creating join request for ${googleId} to clan ${clanId}: %O`, err);
        res.status(500).json({ message: 'Server error while creating join request.' });
    }
});

app.get('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { googleId } = req.user;
    logApi(`Leader ${googleId} fetching join requests for clan ${clanId}`);
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
        logApi(`Error fetching join requests for clan ${clanId}: %O`, err);
        res.status(500).json({ message: 'Server error while fetching requests.' });
    }
});

app.put('/clans/requests/:requestId', authenticate, async (req, res) => {
    const { requestId } = req.params;
    const { status } = req.body;
    const { googleId } = req.user;
    logApi(`Leader ${googleId} managing join request ${requestId} with status '${status}'`);
    if (!['approved', 'denied'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }
    const client = await pool.connect();
    try {
        logDb(`BEGIN transaction for managing join request ${requestId}`);
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
        logDb(`COMMIT transaction for managing join request.`);
        res.status(200).json({ message: `Request successfully ${status}.` });
    } catch (err) {
        await client.query('ROLLBACK');
        logDb(`ROLLBACK transaction for managing join request due to error: ${err.message}`);
        logApi(`Error managing join request ${requestId}: %O`, err);
        res.status(500).json({ message: 'Server error while managing request.' });
    } finally {
        client.release();
    }
});

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
        logSocket('Error during broadcastAllPlayers: %O', e);
    }
}

io.on('connection', (socket) => {
  logSocket(`User connected: ${socket.id}`);

  if (players[socket.id] && players[socket.id].disconnectTimer) {
      clearTimeout(players[socket.id].disconnectTimer);
      players[socket.id].disconnectTimer = null;
      logSocket(`Cleared disconnect timer for ${socket.id} on reconnect.`);
  }

  socket.on('playerJoined', async ({ googleId, name, gameMode }) => {
    if (!googleId || !gameMode) {
        logSocket(`Invalid playerJoined event from ${socket.id}. Missing googleId or gameMode.`);
        return;
    }
    logSocket(`Player ${name} (${googleId}) with socket ${socket.id} joining in [${gameMode}] mode.`);
    const client = await pool.connect();
    try {
        const memberInfoRes = await client.query('SELECT clan_id, role FROM clan_members WHERE user_id = $1', [googleId]);
        const clanId = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].clan_id : null;
        const role = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].role : null;

        const playerProfileRes = await client.query('SELECT has_shield, is_carve_mode_active, username IS NOT NULL as has_record, superpowers FROM territories WHERE owner_id = $1', [googleId]);
        
        const playerRecord = playerProfileRes.rows[0];
        const hasShield = playerRecord ? playerRecord.has_shield : false;
        const isCarveModeActive = playerRecord ? playerRecord.is_carve_mode_active : false;
        const playerHasRecord = !!playerRecord;
        const ownedPowers = playerRecord?.superpowers?.owned || [];
        logSocket(`Player ${name} has superpowers: %O`, ownedPowers);

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
            hasLastStand: ownedPowers.includes('lastStand'),
            hasInfiltrator: ownedPowers.includes('infiltrator'),
            hasGhostRunner: ownedPowers.includes('ghostRunner'),
            hasTrailDefense: ownedPowers.includes('trailDefense'),
            isGhostRunnerActive: false,
            isLastStandActive: false,
            isInfiltratorActive: false,
            isTrailDefenseActive: false,
            isCarveModeActive: isCarveModeActive,
        };

        const geofencePolygons = await geofenceService.getGeofencePolygons();
        socket.emit('geofenceUpdate', geofencePolygons);
        
        const chests = await client.query(`SELECT id, ST_AsGeoJSON(location) as location FROM superpower_chests WHERE is_active = TRUE`);
        socket.emit('activeChests', chests.rows.map(c => ({ id: c.id, location: JSON.parse(c.location).coordinates.reverse() })));

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

        logSocket(`Found ${activeTerritories.length} [${gameMode}] territories. Sending 'existingTerritories' to ${socket.id}.`);
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
      logSocket(`FATAL ERROR in playerJoined for ${socket.id}: %O`, err);
      socket.emit('error', { message: 'Failed to load game state.' });
    } finally {
        client.release();
    }
  });

  socket.on('locationUpdate', async (data) => {
    const player = players[socket.id];
    if (!player || !player.googleId) return;

    player.lastKnownPosition = data;

    if (player.isDrawing) {
        const playerPointWKT = `ST_SetSRID(ST_Point(${data.lng}, ${data.lat}), 4326)`;
        try {
            const result = await pool.query(`
                SELECT id FROM superpower_chests
                WHERE is_active = TRUE AND ST_DWithin(location, ${playerPointWKT}::geography, ${CHEST_RADIUS_METERS})
                LIMIT 1;
            `);
            if (result.rowCount > 0) {
                const chestId = result.rows[0].id;
                await pool.query('UPDATE superpower_chests SET is_active = FALSE WHERE id = $1', [chestId]);
                
                const availablePowers = ['lastStand', 'infiltrator', 'ghostRunner', 'trailDefense'];
                const powersToGrant = [];
                const numToGrant = Math.floor(Math.random() * 2) + 1;

                for (let i = 0; i < numToGrant; i++) {
                    if (availablePowers.length === 0) break;
                    const randomIndex = Math.floor(Math.random() * availablePowers.length);
                    const power = availablePowers.splice(randomIndex, 1)[0];
                    powersToGrant.push(power);
                    await superpowerManager.grantPower(player.googleId, power);
                }

                socket.emit('superpowersGranted', { powers: powersToGrant });
                io.emit('chestClaimed', { chestId: chestId });
                logGame(`Player ${player.name} claimed chest ${chestId} and got powers: ${powersToGrant.join(', ')}`);
            }
        } catch (err) {
            logGame(`Error checking for chest collision for player ${player.name}: %O`, err);
        }

        if (player.activeTrail.length > 0) {
            const lastPoint = player.activeTrail[player.activeTrail.length - 1];
            const attackerSegmentWKT = (lastPoint.lng === data.lng && lastPoint.lat === data.lat)
                ? `POINT(${data.lng} ${data.lat})`
                : `LINESTRING(${lastPoint.lng} ${lastPoint.lat}, ${data.lng} ${data.lat})`;

            const attackerSegmentGeom = `ST_SetSRID(ST_GeomFromText('${attackerSegmentWKT}'), 4326)`;

            for (const victimId in players) {
                if (victimId === socket.id) continue;
                const victim = players[victimId];
                if (victim && victim.isDrawing && victim.activeTrail.length >= 2) {
                    const victimTrailWKT = 'LINESTRING(' + victim.activeTrail.map(p => `${p.lng} ${p.lat}`).join(', ') + ')';
                    const victimTrailGeom = `ST_SetSRID(ST_GeomFromText('${victimTrailWKT}'), 4326)`;
                    try {
                        const res = await pool.query(`SELECT ST_Intersects(${attackerSegmentGeom}, ${victimTrailGeom}) as intersects;`);
                        if (res.rows[0].intersects) {
                            if (victim.isTrailDefenseActive) {
                                logGame(`TRAIL DEFLECTED! Attacker ${player.name} hit Victim ${victim.name}'s defense.`);
                                io.to(socket.id).emit('runTerminated', { reason: `Your run was deflected by an opponent's Trail Defense!` });
                                
                                player.isDrawing = false;
                                player.activeTrail = [];
                                io.emit('trailCleared', { id: socket.id });
                                return; 
                            }
                            
                            logGame(`TRAIL CUT! Attacker ${player.name} cut Victim ${victim.name}`);
                            io.to(victimId).emit('runTerminated', { reason: `Your trail was cut by ${player.name}!` });
                            
                            await updateQuestProgress(pool, io, player.googleId, 'trail_cut', 1);

                            victim.isDrawing = false;
                            victim.activeTrail = [];
                            io.emit('trailCleared', { id: victimId });
                        }
                    } catch(err) {
                        logGame(`Error checking trail intersection: %O`, err);
                    }
                }
            }
        }
        player.activeTrail.push(data);
        if (!player.isGhostRunnerActive) {
            socket.broadcast.emit('trailPointAdded', { id: socket.id, point: data });
        }
    }
  });

  socket.on('startDrawingTrail', async () => {
    const player = players[socket.id];
    if (!player || player.gameMode === 'spectator' || player.isDrawing) return;
    
    player.isDrawing = true;
    player.activeTrail = [];
    logGame(`Player ${player.name} (${socket.id}) started drawing trail. Ghost Runner: ${player.isGhostRunnerActive}`);
    if (!player.isGhostRunnerActive) {
      socket.broadcast.emit('trailStarted', { id: socket.id, name: player.name });
    }
  });

  socket.on('stopDrawingTrail', async () => {
    const player = players[socket.id];
    if (!player) return;
    logGame(`Player ${player.name} (${socket.id}) stopped drawing trail (run ended).`);
    player.isDrawing = false;
    player.activeTrail = [];
    player.isGhostRunnerActive = false;
    player.isLastStandActive = false;
    player.isTrailDefenseActive = false;
    io.emit('trailCleared', { id: socket.id });
  });

  socket.on('activateTrailDefense', async () => {
    const player = players[socket.id];
    if (player && player.hasTrailDefense) {
        player.isTrailDefenseActive = true;
        player.hasTrailDefense = false;
        logGame(`Player ${player.name} activating Trail Defense.`);
        try {
            await superpowerManager.usePower(player.googleId, 'trailDefense');
            socket.emit('superpowerAcknowledged', { power: 'trailDefense' });
        } catch (err) {
            logGame(`Failed to use Trail Defense for ${player.name}: %O`, err);
            player.hasTrailDefense = true;
        }
    }
  });

  socket.on('activateGhostRunner', async () => {
      const player = players[socket.id];
      if (player && player.hasGhostRunner) {
          player.isGhostRunnerActive = true;
          player.hasGhostRunner = false;
          logGame(`Player ${player.name} activating Ghost Runner.`);
          try {
            await superpowerManager.usePower(player.googleId, 'ghostRunner');
            socket.emit('superpowerAcknowledged', { power: 'ghostRunner' });
          } catch(err) {
            logGame(`Failed to use Ghost Runner for ${player.name}: %O`, err);
            player.hasGhostRunner = true;
          }
      }
  });

  socket.on('activateInfiltrator', async () => {
      const player = players[socket.id];
      if (player && player.hasInfiltrator) {
          player.isInfiltratorActive = true;
          player.hasInfiltrator = false;
          logGame(`Player ${player.name} activating Infiltrator.`);
          try {
            await superpowerManager.usePower(player.googleId, 'infiltrator');
            socket.emit('superpowerAcknowledged', { power: 'infiltrator' });
          } catch(err) {
            logGame(`Failed to use Infiltrator for ${player.name}: %O`, err);
            player.hasInfiltrator = true;
          }
      }
  });

  socket.on('activateLastStand', async () => {
      const player = players[socket.id];
      if (player && player.hasLastStand) {
          player.isLastStandActive = true;
          player.hasLastStand = false;
          logGame(`Player ${player.name} activating Last Stand.`);
          try {
            await superpowerManager.usePower(player.googleId, 'lastStand');
            await pool.query('UPDATE territories SET is_shield_active = true WHERE owner_id = $1', [player.googleId]);
            socket.emit('superpowerAcknowledged', { power: 'lastStand' });
          } catch(err) {
            logGame(`Failed to use Last Stand for ${player.name}: %O`, err);
            player.hasLastStand = true;
          }
      }
  });

  socket.on('claimTerritory', async (req) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !req.gameMode) {
      logSocket(`Invalid claimTerritory request from ${socket.id}`);
      return;
    }
    logGame(`Player ${player.name} (${socket.id}) is attempting to claim territory.`);
    const { gameMode, trail, baseClaim } = req;
    const client = await pool.connect();
    try {
        logDb(`BEGIN transaction for claim by ${player.name}.`);
        await client.query('BEGIN');
        let result;
        if (gameMode === 'solo') {
            result = await handleSoloClaim(io, socket, player, players, trail, baseClaim, client);
        } else if (gameMode === 'clan') {
            result = await handleClanClaim(io, socket, player, players, trail, baseClaim, client);
        }
        if (!result) {
            await client.query('ROLLBACK');
            logDb(`ROLLBACK transaction for claim by ${player.name}, handler returned no result.`);
            return;
        }
        const { finalTotalArea, areaClaimed, ownerIdsToUpdate } = result;
        await client.query('COMMIT');
        logDb(`COMMIT transaction for claim by ${player.name}.`);
        socket.emit('claimSuccessful', { newTotalArea: finalTotalArea, areaClaimed: areaClaimed });
        
        const soloOwnersToUpdate = ownerIdsToUpdate.filter(id => typeof id === 'string');
        let batchUpdateData = [];
        if (soloOwnersToUpdate.length > 0) {
            const soloQueryResult = await client.query(`SELECT owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl", identity_color, ST_AsGeoJSON(area) as geojson, area_sqm as area FROM territories WHERE owner_id = ANY($1::varchar[]);`, [soloOwnersToUpdate]);
            batchUpdateData = batchUpdateData.concat(soloQueryResult.rows.map(r => ({ ...r, geojson: r.geojson ? JSON.parse(r.geojson) : null })));
        }
        if (batchUpdateData.length > 0) {
            io.emit('batchTerritoryUpdate', batchUpdateData);
        }

        player.isDrawing = false;
        player.activeTrail = [];
        io.emit('trailCleared', { id: socket.id });
    } catch (err) {
        await client.query('ROLLBACK');
        logDb(`ROLLBACK transaction for claim by ${player.name} due to error: ${err.message}`);
        logGame(`Error during territory claim for ${player.name}: %O`, err);
        socket.emit('claimRejected', { reason: err.message || 'Server error during claim.' });
    } finally {
        client.release();
    }
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      logSocket(`User ${player?.name || 'Unknown'} disconnected: ${socket.id}. Was drawing: ${player.isDrawing}`);
      if (player.isDrawing) {
        player.disconnectTimer = setTimeout(() => {
            logSocket(`Disconnect timer expired for ${player.name}. Clearing trail and player data.`);
            if(players[socket.id]) {
                delete players[socket.id];
            }
            io.emit('trailCleared', { id: socket.id });
            io.emit('playerLeft', { id: socket.id });
        }, DISCONNECT_TRAIL_PERSIST_SECONDS * 1000);
      } else {
        delete players[socket.id];
        io.emit('playerLeft', { id: socket.id });
      }
    } else {
        logSocket(`Unknown user disconnected: ${socket.id}`);
    }
  });
});

const main = async () => {
  server.listen(PORT, '0.0.0.0', () => {
    logLifecycle(`Server listening on 0.0.0.0:${PORT}`);
    setupDatabase().catch(err => {
        console.error("[SERVER] FATAL: Failed to setup database after server start:", err);
        process.exit(1);
    });
  });
};

setInterval(broadcastAllPlayers, SERVER_TICK_RATE_MS);
main();```