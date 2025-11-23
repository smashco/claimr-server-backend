/*
================================================================================
DEBUGGING GUIDE:
- See ALL messages: DEBUG=server:* node server.js
- See specific messages: DEBUG=server:socket,server:game node server.js
- Namespaces: lifecycle, db, auth, api, admin, payment, socket, game, superpower
================================================================================
*/

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');
const turf = require('@turf/turf');
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
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

// Import managers and handlers
const SuperpowerManager = require('./superpower_manager');
const handleSoloClaim = require('./game_logic/solo_handler');
const handleClanClaim = require('./game_logic/clan_handler');
const GeofenceService = require('./geofence_service');
const { updateQuestProgress } = require('./game_logic/quest_handler');
const RaceHandler = require('./game_logic/race_handler');
const ConquestHandler = require('./game_logic/conquest_handler');

// Import routers
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

const multer = require('multer');
const fs = require('fs');
const cors = require('cors');

// AWS S3 Configuration
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET_NAME,
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'uploads/' + uniqueSuffix + path.extname(file.originalname));
        }
    })
});

const app = express();
app.use(cors());
app.use(express.json());

// Middleware to strip trailing slashes
app.use((req, res, next) => {
    if (req.path.substr(-1) === '/' && req.path.length > 1) {
        const query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

app.use('/uploads', express.static('uploads')); // Serve uploaded files statically
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Explicitly serve Brand Portal HTML files to avoid directory conflicts
['dashboard', 'design', 'login', 'register', 'map'].forEach(page => {
    app.get(`/brand/${page}`, (req, res) => {
        res.sendFile(path.join(__dirname, 'public/brand', `${page}.html`));
    });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], redirect: false }));

// Redirect legacy /design to /brand/design
app.get('/design', (req, res) => {
    const query = req.url.split('?')[1];
    res.redirect('/brand/design' + (query ? '?' + query : ''));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] } });

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        logLifecycle('Firebase Admin initialized successfully.');
    } else {
        logLifecycle('Firebase Admin skipping initialization (FIREBASE_SERVICE_ACCOUNT env var not set).');
    }
} catch (error) {
    console.error('[Firebase Admin] FATAL: Failed to initialize Firebase Admin.', error.message);
}

let razorpay;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
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

const superpowerManager = new SuperpowerManager(pool, razorpay, io, () => players);
const geofenceService = new GeofenceService(pool);
const players = {};
const raceHandler = new RaceHandler(io, players);
const conquestHandler = new ConquestHandler(pool, io, players);

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
        laps_required INTEGER DEFAULT 1,
        brand_wrapper VARCHAR(100),
        has_shield BOOLEAN DEFAULT FALSE,
        is_shield_active BOOLEAN DEFAULT FALSE,
        is_carve_mode_active BOOLEAN DEFAULT FALSE,
        is_paid BOOLEAN DEFAULT FALSE,
        banned_until TIMESTAMP WITH TIME ZONE,
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

        await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS laps_required INTEGER DEFAULT 1;');
        await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS brand_wrapper VARCHAR(100);');
        await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS brand_url TEXT;');
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
        await client.query('ALTER TABLE territories ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP WITH TIME ZONE;');
        await client.query('ALTER TABLE territories DROP COLUMN IF EXISTS is_banned;');
        logDb('Ensured all columns exist on "territories" table.');

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
            reward_description TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            is_first_come_first_served BOOLEAN DEFAULT FALSE,
            sponsor_id INTEGER REFERENCES sponsors(id) ON DELETE SET NULL,
            google_form_url TEXT,
            requires_qr_validation BOOLEAN DEFAULT FALSE,
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

        await client.query(`
      CREATE TABLE IF NOT EXISTS daily_logins (
        user_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        login_date DATE NOT NULL,
        PRIMARY KEY (user_id, login_date)
      );
    `);
        logDb('"daily_logins" table is ready.');

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

        const banCheck = await pool.query('SELECT banned_until FROM territories WHERE owner_id = $1 LIMIT 1', [req.user.googleId]);
        if (banCheck.rowCount > 0 && banCheck.rows[0].banned_until && new Date(banCheck.rows[0].banned_until) > new Date()) {
            logAuth(`Authentication failed for user ${req.user.googleId}: Account is banned until ${banCheck.rows[0].banned_until}.`);
            return res.status(403).send('Forbidden: Your account has been temporarily suspended.');
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

// --- BRAND PORTAL API ---

app.get('/api/brands/territories', async (req, res) => {
    try {
        // Fetch territories with area, laps, and current owner info
        // We need to join with territory_conquest_stats if available, or just use territories table
        // Assuming laps are stored in territories or we calculate them. 
        // For now, let's assume 'conquer_laps_completed' is in territories or we default to 1.
        // Actually, laps are per conquest attempt. 
        // Let's add a 'total_laps' column to territories later if needed, or just use a random number for "premium" feel for now if data missing.
        // Wait, the user said "lap counter of that area". 
        // I'll use a placeholder for laps for now or count from history if I had a history table. 
        // Let's just return basic info + a mock lap count if not present.

        const result = await pool.query(`
            SELECT id, username as name, area_sqm, owner_id, ST_X(ST_Centroid(area)) as center_lng, ST_Y(ST_Centroid(area)) as center_lat, identity_color,
                   ST_AsGeoJSON(area) as geometry,
                   laps_required,
                   owner_name
            FROM territories
            WHERE area_sqm > 0
        `);

        // Transform for frontend
        const territories = result.rows.map(row => ({
            id: row.id,
            name: row.name || `Territory ${row.id}`,
            center: { lat: row.center_lat, lng: row.center_lng },
            geometry: JSON.parse(row.geometry),
            areaSqFt: row.area_sqm ? (row.area_sqm * 10.764) : 0, // Convert sqm to sqft
            laps: row.laps_required || 1,
            ownerName: row.owner_name || 'Unclaimed',
            identityColor: row.identity_color,
            rentPrice: Math.ceil(row.area_sqm * 10.764 * 0.005 * 3) // 3 days default at 0.005/sqft/day
        }));

        console.log(`[API] Fetched ${territories.length} territories. Sample lap count (ID 166):`, territories.find(t => t.id === 166)?.laps);

        res.json(territories);
    } catch (err) {
        console.error('Error fetching brand territories:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/brands/calculate-price', (req, res) => {
    const { areaSqFt, laps } = req.body;
    if (!areaSqFt) return res.status(400).json({ error: 'Missing areaSqFt' });

    // Formula: (Area * 20) + (Laps * multiplier)
    // Multiplier increases with laps? 
    // User said: "rate is 20 if lap counter goes 2 rate goes to 25"
    // So base rate per sqft increases?
    // Let's say Base Rate = 20 + (Laps * 5)
    // Total Price = Area * Base Rate

    const { durationDays = 1 } = req.body;
    const ratePerSqFtPerDay = 0.005;
    const totalPrice = areaSqFt * ratePerSqFtPerDay * durationDays;

    res.json({
        price: Math.ceil(totalPrice),
        ratePerSqFt: ratePerSqFtPerDay,
        currency: 'INR'
    });
});

app.post('/api/brands/create-ad', upload.fields([{ name: 'adContent', maxCount: 1 }, { name: 'overlayContent', maxCount: 1 }]), async (req, res) => {
    const client = await pool.connect();
    try {
        const { territoryId, brandName, durationDays, amountPaid, backgroundColor } = req.body;

        if (!req.files || !req.files['adContent'] || !req.files['overlayContent']) {
            return res.status(400).json({ error: 'Missing required files' });
        }

        const adContentUrl = req.files['adContent'][0].location;
        const overlayUrl = req.files['overlayContent'][0].location;

        // Calculate start and end times
        const startTime = new Date();
        const endTime = new Date();
        endTime.setDate(endTime.getDate() + parseInt(durationDays));

        // Create Ad (Pending Payment)
        const result = await client.query(`
            INSERT INTO ads (territory_id, brand_name, ad_content_url, background_color, overlay_url, ad_type, start_time, end_time, payment_status, amount_paid)
            VALUES ($1, $2, $3, $4, $5, 'IMAGE', $6, $7, 'PENDING', $8)
            RETURNING id`,
            [territoryId, brandName, adContentUrl, backgroundColor, overlayUrl, startTime, endTime, amountPaid]
        ); res.json({
            success: true,
            adId: result.rows[0].id,
            message: 'Ad created, pending payment'
        });
    } catch (err) {
        console.error('Error creating ad:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

app.delete('/api/brands/ads/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("UPDATE ads SET status = 'DELETED' WHERE id = $1", [id]);
        res.json({ success: true, message: 'Ad deleted successfully' });
    } catch (err) {
        console.error('Error deleting ad:', err);
        res.status(500).json({ error: 'Failed to delete ad' });
    }
});

app.get('/api/brands/dashboard-stats', async (req, res) => {
    const { brandName } = req.query;
    if (!brandName) {
        return res.status(400).json({ error: 'Missing brandName' });
    }

    console.log(`[API] Fetching dashboard stats for brand: '${brandName}'`);

    try {
        // Fetch latest ad per territory for this brand (case-insensitive)
        const adsResult = await pool.query(`
            SELECT DISTINCT ON (a.territory_id) a.id, a.brand_name, a.ad_content_url, a.status, a.approval_status, a.payment_status, a.amount_paid, a.start_time, a.end_time,
                   t.id as territory_id, t.username as territory_name, t.area_sqm, ST_AsGeoJSON(t.area) as geojson
            FROM ads a
            JOIN territories t ON a.territory_id = t.id
            WHERE LOWER(a.brand_name) = LOWER($1) AND a.status != 'DELETED'
            ORDER BY a.territory_id, a.created_at DESC
        `, [brandName]);

        console.log(`[API] Found ${adsResult.rowCount} unique active campaigns for brand '${brandName}'`);

        const campaigns = adsResult.rows.map(row => {
            const now = new Date();
            const end = new Date(row.end_time);
            const timeLeft = end.getTime() - now.getTime();

            // Calculate mock views based on area and time active
            const hoursActive = (now.getTime() - new Date(row.start_time).getTime()) / (1000 * 60 * 60);
            const views = Math.floor((row.area_sqm || 100) * (hoursActive > 0 ? hoursActive : 0) * 0.5);

            let status = 'Active';

            if (row.approval_status === 'REJECTED') {
                status = 'Rejected';
            } else if (row.approval_status === 'PENDING') {
                status = 'Pending Approval';
            } else if (row.payment_status !== 'PAID') {
                status = 'Pending Payment';
            } else if (timeLeft < 0) {
                status = 'Expired';
            } else if (timeLeft < 3600000) {
                status = 'Ending Soon'; // < 1 hour
            }

            return {
                id: row.id,
                name: row.territory_name || 'Unknown Territory',
                territory_name: row.territory_name,
                territory_id: row.territory_id,
                status: status,
                views: views,
                area_sqm: row.area_sqm,
                geojson: row.geojson,
                end_time: row.end_time,
                expires: timeLeft > 0 ? `${Math.ceil(timeLeft / (1000 * 60 * 60))}h` : 'Expired',
                amountPaid: row.amount_paid || 0
            };
        });

        // Calculate totals
        const totalAds = campaigns.filter(c => c.status === 'Active' || c.status === 'Ending Soon').length;
        const totalViews = campaigns.reduce((acc, curr) => acc + curr.views, 0);
        const totalSpend = campaigns.reduce((acc, curr) => acc + parseFloat(curr.amountPaid), 0);

        res.json({
            stats: {
                activeAds: totalAds,
                totalViews: totalViews,
                totalSpend: totalSpend
            },
            campaigns: campaigns
        });
    } catch (err) {
        console.error('Error fetching dashboard stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/brands/available-territories', async (req, res) => {
    try {
        // Fetch DISTINCT territories to avoid duplicates
        const result = await pool.query(`
            SELECT DISTINCT ON (id) id, username, area_sqm, ST_AsGeoJSON(area) as geojson, 
                   ST_Y(ST_Centroid(area)) as lat, ST_X(ST_Centroid(area)) as lng, identity_color
            FROM territories
            WHERE owner_id IS NOT NULL AND area_sqm > 0
            ORDER BY id, area_sqm DESC
            LIMIT 50
        `);

        // Helper function for reverse geocoding (simplified - using Nominatim)
        const getLocationName = async (lat, lng) => {
            try {
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`,
                    { headers: { 'User-Agent': 'ClaimrBrandPortal/1.0' } }
                );
                const data = await response.json();
                const city = data.address?.city || data.address?.town || data.address?.village || 'Unknown';
                const country = data.address?.country || 'Unknown';
                return { city, country };
            } catch (err) {
                console.error('Geocoding error:', err);
                return { city: 'Unknown', country: 'Unknown' };
            }
        };

        // Process territories with location data
        const territoriesWithLocation = await Promise.all(
            result.rows.map(async (row) => {
                const geojson = JSON.parse(row.geojson);
                const location = await getLocationName(row.lat, row.lng);

                return {
                    id: row.id,
                    name: row.username,
                    areaSqFt: row.area_sqm,
                    price: Math.floor(row.area_sqm * 0.015),
                    geojson: geojson,
                    identityColor: row.identity_color,
                    city: location.city,
                    country: location.country,
                    center: { lat: row.lat, lng: row.lng }
                };
            })
        );

        res.json(territoriesWithLocation);
    } catch (err) {
        console.error('Error fetching available territories:', err);
        res.status(500).json({ error: 'Failed to fetch territories' });
    }
});

// --- MOBILE APP API ---

app.get('/api/ads', async (req, res) => {
    console.log('[API] /api/ads called');
    try {
        // Debug: fetch all ads to see what's going on
        const allAds = await pool.query('SELECT id, payment_status, approval_status, status, end_time FROM ads');
        console.log('[API] All ads in DB:', allAds.rows);

        const result = await pool.query(`
            SELECT a.id, a.territory_id, a.brand_name, a.ad_content_url, a.overlay_url, a.ad_type, 
                   t.area as territory_geometry
            FROM ads a
            JOIN territories t ON a.territory_id = t.id
            WHERE a.payment_status = 'PAID' 
              AND a.approval_status = 'APPROVED' 
              AND a.status = 'ACTIVE'
              AND a.end_time > NOW()
        `);

        const ads = result.rows.map(row => ({
            id: row.id,
            territoryId: row.territory_id,
            brandName: row.brand_name,
            contentUrl: row.ad_content_url,
            overlayUrl: row.overlay_url,
            type: row.ad_type,
            geometry: row.territory_geometry // PostGIS geometry
        }));

        console.log(`[API] /api/ads returning ${ads.length} ads`);
        res.json(ads);
    } catch (err) {
        console.error('Error fetching ads:', err);
        res.status(500).json({ error: 'Failed to fetch ads' });
    }
});

// Get rent earnings for a player
app.get('/api/player/rent-earnings', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        // Get all active ads on player's territories
        const result = await pool.query(`
            SELECT 
                a.id as ad_id,
                a.brand_name,
                a.amount_paid,
                a.start_time,
                a.end_time,
                t.id as territory_id,
                t.area_sqm,
                a.created_at
            FROM ads a
            JOIN territories t ON a.territory_id = t.id
            WHERE t.owner_id = $1
              AND a.payment_status = 'PAID'
              AND a.end_time >= NOW()
            ORDER BY a.created_at DESC
        `, [userId]);

        const totalEarnings = result.rows.reduce((sum, row) => sum + parseFloat(row.amount_paid || 0), 0);
        const activeAds = result.rows.length;

        res.json({
            totalEarnings: totalEarnings.toFixed(2),
            activeAds,
            rentals: result.rows.map(row => ({
                adId: row.ad_id,
                brandName: row.brand_name,
                amount: parseFloat(row.amount_paid).toFixed(2),
                territoryId: row.territory_id,
                areaSqm: row.area_sqm,
                startTime: row.start_time,
                endTime: row.end_time,
                daysRemaining: Math.ceil((new Date(row.end_time) - new Date()) / (1000 * 60 * 60 * 24))
            }))
        });
    } catch (err) {
        console.error('Error fetching rent earnings:', err);
        res.status(500).json({ error: 'Failed to fetch rent earnings' });
    }
});

// --- RAZORPAY INTEGRATION ---



app.post('/api/brands/create-order', async (req, res) => {
    const { amount, currency = 'INR', receipt } = req.body;
    try {
        const options = {
            amount: amount * 100, // Amount in paise
            currency,
            receipt,
        };
        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (error) {
        console.error('Razorpay Order Error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

app.post('/api/brands/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, adId } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest('hex');

    if (expectedSignature === razorpay_signature) {
        // Payment successful, update ad status
        if (adId) {
            try {
                await pool.query(
                    "UPDATE ads SET payment_status = 'PAID', payment_id = $1 WHERE id = $2",
                    [razorpay_payment_id, adId]
                );
                console.log(`Ad ${adId} marked as PAID.`);

                // Send notification to territory owner
                try {
                    const adInfo = await pool.query(`
                        SELECT a.brand_name, a.amount_paid, t.owner_id, t.username
                        FROM ads a
                        JOIN territories t ON a.territory_id = t.id
                        WHERE a.id = $1
                    `, [adId]);

                    if (adInfo.rows.length > 0) {
                        const { brand_name, amount_paid, owner_id, username } = adInfo.rows[0];

                        // Send notification via WebSocket to the territory owner
                        const ownerSocket = Array.from(io.sockets.sockets.values())
                            .find(s => s.handshake.query.userId === owner_id);

                        if (ownerSocket) {
                            ownerSocket.emit('adRented', {
                                brandName: brand_name,
                                amount: amount_paid,
                                message: `${brand_name} has rented your territory for ₹${amount_paid}! View your earnings in the Rent Screen.`
                            });
                            console.log(`Notification sent to ${username} about ad rental`);
                        } else {
                            console.log(`User ${username} not connected, notification not sent`);
                        }
                    }
                } catch (notifErr) {
                    console.error('Error sending notification:', notifErr);
                    // Don't fail the payment verification if notification fails
                }
            } catch (err) {
                console.error('Error updating ad status:', err);
            }
        }
        res.json({ success: true, message: "Payment verified" });
    } else {
        res.status(400).json({ success: false, error: "Invalid signature" });
    }
});


// --- ROUTES ---
app.get('/', (req, res) => { res.send('Claimr Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

// Admin Routes
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

// Sponsor & Quest Routes
app.use('/sponsor', sponsorPortalRouter(pool, io, players));
app.use('/api/quests', questsApiRouter(pool, authenticate));

// User Profile & Data Routes
app.get('/check-profile', authenticate, async (req, res) => {
    const { googleId } = req.user;
    logApi(`Checking profile for authenticated user: ${googleId}`);

    const client = await pool.connect();

    try {
        const userCheckResult = await client.query('SELECT username FROM territories WHERE owner_id = $1', [googleId]);

        if (userCheckResult.rowCount > 0) {

            await client.query('BEGIN');

            await client.query(
                `INSERT INTO daily_logins (user_id, login_date) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING;`,
                [googleId]
            );

            const loginDatesResult = await client.query(
                `SELECT login_date FROM daily_logins 
                 WHERE user_id = $1 AND DATE_TRUNC('month', login_date) = DATE_TRUNC('month', CURRENT_DATE);`,
                [googleId]
            );
            const dailyLogins = loginDatesResult.rows.map(r => r.login_date);

            const profileQuery = `
                SELECT
                    t.username, t.profile_image_url, t.area_sqm, t.identity_color, t.has_shield, t.is_paid,
                    t.banned_until, t.razorpay_subscription_id, t.subscription_status, t.trail_effect, t.superpowers,
                    t.total_distance_km, c.id as clan_id, c.name as clan_name, c.tag as clan_tag, cm.role as clan_role,
                    (c.base_location IS NOT NULL) as base_is_set,
                    (SELECT r.rank FROM (
                        SELECT owner_id, RANK() OVER (ORDER BY area_sqm DESC) as rank
                        FROM territories WHERE area_sqm > 0 AND username IS NOT NULL
                    ) r WHERE r.owner_id = t.owner_id) as rank
                FROM territories t
                LEFT JOIN clan_members cm ON t.owner_id = cm.user_id
                LEFT JOIN clans c ON cm.clan_id = c.id
                WHERE t.owner_id = $1;
            `;

            const profileResult = await client.query(profileQuery, [googleId]);
            const row = profileResult.rows[0];

            await client.query('COMMIT');

            const response = {
                profileExists: true,
                isPaid: row.is_paid,
                username: row.username,
                profileImageUrl: row.profile_image_url,
                identityColor: row.identity_color,
                area_sqm: row.area_sqm || 0,
                has_shield: row.has_shield,
                banned_until: row.banned_until,
                razorpaySubscriptionId: row.razorpay_subscription_id,
                subscriptionStatus: row.subscription_status,
                trailEffect: row.trail_effect || 'default',
                superpowers: row.superpowers || { owned: [] },
                rank: row.rank,
                total_distance_km: row.total_distance_km || 0,
                dailyLogins: dailyLogins,
                clan_info: row.clan_id ? { id: row.clan_id.toString(), name: row.clan_name, tag: row.clan_tag, role: row.clan_role, base_is_set: row.base_is_set } : null
            };

            return res.json(response);

        } else {
            logApi(`No profile found for new user ${googleId}.`);
            return res.json({ profileExists: false });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        logApi(`Error in /check-profile for ${googleId}: %O`, err);
        return res.status(500).json({ error: 'Server error while checking profile.' });
    } finally {
        client.release();
    }
});

app.post('/setup-profile', authenticate, async (req, res) => {
    const { googleId } = req.user;
    const { username, imageUrl, displayName, phoneNumber, instagramId } = req.body;
    logApi(`Setting up profile for user ${googleId} with username ${username}.`);

    if (!username || !imageUrl || !displayName) {
        return res.status(400).json({ error: 'Missing required profile data.' });
    }

    try {
        // Manual username uniqueness check (since constraint was dropped)
        const usernameCheck = await pool.query(
            'SELECT id FROM territories WHERE username = $1 AND owner_id != $2 LIMIT 1',
            [username, googleId]
        );
        if (usernameCheck.rows.length > 0) {
            return res.status(409).json({ message: 'Username is already taken.' });
        }

        // Check if user already has any territories
        const existing = await pool.query('SELECT id FROM territories WHERE owner_id = $1 LIMIT 1', [googleId]);

        if (existing.rows.length > 0) {
            // Update existing territories with new profile info
            await pool.query(
                `UPDATE territories 
                 SET owner_name = $2, username = $3, profile_image_url = $4, phone_number = $5, instagram_id = $6
                 WHERE owner_id = $1`,
                [googleId, displayName, username, imageUrl, phoneNumber || null, instagramId || null]
            );
        } else {
            // Insert new profile territory
            await pool.query(
                `INSERT INTO territories (owner_id, owner_name, username, profile_image_url, phone_number, instagram_id, area, area_sqm, is_paid)
                 VALUES ($1, $2, $3, $4, $5, $6, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), 0, FALSE)`,
                [googleId, displayName, username, imageUrl, phoneNumber || null, instagramId || null]
            );
        }

        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        logApi(`Error setting up profile for ${googleId}: %O`, err);
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

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


// Shop, Payment, Brand, and Mega Prize Routes
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

    logPayment(`[START] Received payment verification request for user: ${googleId}`);
    logPayment(`  - Type: ${purchaseType}`);
    logPayment(`  - Item ID: ${itemId}`);
    logPayment(`  - Order ID: ${razorpay_order_id}`);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !googleId) {
        logPayment(`[FAIL] Payment verification for ${googleId} failed: Missing required data.`);
        return res.status(400).json({ error: 'Missing required payment verification data.' });
    }

    try {
        let newInventory;
        if (purchaseType === 'superpower' && itemId) {
            logPayment(`Calling SuperpowerManager.verifyAndGrantPower for user ${googleId}, item ${itemId}.`);
            newInventory = await superpowerManager.verifyAndGrantPower(googleId, itemId, { razorpay_order_id, razorpay_payment_id, razorpay_signature });
            logPayment(`[SUCCESS] SuperpowerManager.verifyAndGrantPower completed for user ${googleId}.`);

            const playerSocketId = Object.keys(players).find(id => players[id].googleId === googleId);
            if (playerSocketId) {
                const onlinePlayer = players[playerSocketId];
                const ownedList = newInventory.owned || [];

                onlinePlayer.hasLastStand = ownedList.includes('lastStand');
                onlinePlayer.hasInfiltrator = ownedList.includes('infiltrator');
                onlinePlayer.hasGhostRunner = ownedList.includes('ghostRunner');
                onlinePlayer.hasTrailDefense = ownedList.includes('trailDefense');

                io.to(playerSocketId).emit('superpowerInventoryUpdated', newInventory);
                logSocket(`[NOTIFIED] Sent 'superpowerInventoryUpdated' to player ${googleId} (${playerSocketId}) after purchase.`);
            } else {
                logSocket(`[INFO] Player ${googleId} is not online. Could not send real-time inventory update after purchase.`);
            }

        } else if (purchaseType === 'subscription') {
            logPayment(`Processing subscription logic for ${googleId}.`);
            await pool.query("UPDATE territories SET is_paid = TRUE, subscription_status = 'active' WHERE owner_id = $1", [googleId]);
            logPayment(`[SUCCESS] Subscription activated for ${googleId} in DB.`);
        } else {
            throw new Error("Invalid purchase type specified: " + purchaseType);
        }

        logPayment(`[END] Successfully verified payment for user ${googleId}. Sending 200 OK.`);
        res.status(200).json({ success: true, message: 'Payment verified successfully.' });

    } catch (err) {
        logPayment(`[ERROR] Payment verification failed for ${googleId}. Error: %O`, err);
        res.status(500).json({ error: err.message || 'Server error while verifying payment.' });
    }
});

app.post('/api/territory/:id/brand', authenticate, async (req, res) => {
    const { id: territoryId } = req.params;
    const { brand } = req.body;
    const { googleId } = req.user;

    logApi(`User ${googleId} setting brand '${brand}' for territory ID ${territoryId}.`);

    if (!brand) {
        return res.status(400).json({ message: 'Brand name is required.' });
    }

    try {
        const updateResult = await pool.query(
            'UPDATE territories SET brand_wrapper = $1 WHERE id = $2 AND owner_id = $3 RETURNING owner_id',
            [brand, territoryId, googleId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({ message: 'Territory not found or you do not own it.' });
        }

        const territoryUpdate = await pool.query(`
            SELECT
                id, owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl",
                identity_color, ST_AsGeoJSON(area) as geojson, area_sqm as area, laps_required, brand_wrapper
            FROM territories WHERE id = $1
        `, [territoryId]);

        if (territoryUpdate.rowCount > 0) {
            const updatedData = territoryUpdate.rows.map(row => ({
                ...row,
                geojson: row.geojson ? JSON.parse(row.geojson) : null
            }));
            io.emit('batchTerritoryUpdate', updatedData);
        }

        res.status(200).json({ success: true, message: 'Brand applied successfully.' });
    } catch (err) {
        logApi(`Error setting brand for user ${googleId}: %O`, err);
        res.status(500).json({ message: 'Server error while setting brand.' });
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


// Leaderboard & Clan Routes
app.get('/leaderboard', async (req, res) => {
    logApi('Fetching player leaderboard with full stats.');
    try {
        const query = `
            SELECT
                t.owner_id,
                t.username as owner_name,
                t.profile_image_url,
                t.area_sqm,
                t.identity_color,
                t.total_distance_km,
                RANK() OVER (ORDER BY t.area_sqm DESC) as rank
            FROM
                territories t
            WHERE
                t.area_sqm > 0 AND t.username IS NOT NULL
            ORDER BY
                t.area_sqm DESC
            LIMIT 100;
        `;
        const result = await pool.query(query);
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
        res.status(201).json({ id: newClan.id.toString(), name: newClan.name, tag: newClan.tag, role: 'leader', base_is_set: false });
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
                (SELECT username FROM territories WHERE owner_id = c.leader_id LIMIT 1) as leader_name,
                c.leader_id,
                (SELECT COUNT(*)::integer FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                COALESCE((SELECT area_sqm FROM clan_territories ct WHERE ct.clan_id = c.id), 0) as total_area_sqm,
                (SELECT status FROM clan_join_requests cjr WHERE cjr.clan_id = c.id AND cjr.user_id = $1 AND cjr.status = 'pending') as join_request_status
            FROM clans c
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
                (SELECT username FROM territories WHERE owner_id = c.leader_id LIMIT 1) as leader_name,
                c.leader_id,
                (SELECT COUNT(*)::integer FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                COALESCE((SELECT area_sqm FROM clan_territories WHERE clan_id = c.id), 0) as total_area_sqm,
                (c.base_location IS NOT NULL) as base_is_set
            FROM clans c
            WHERE c.id = $1;
        `;
        const clanResult = await pool.query(clanQuery, [id]);
        if (clanResult.rowCount === 0) return res.status(404).json({ error: 'Clan not found.' });
        const clanDetails = clanResult.rows[0];
        const membersQuery = `
            SELECT t.owner_id as user_id, t.username, t.profile_image_url, cm.role, COALESCE(t.area_sqm, 0) as area_claimed_sqm
            FROM clan_members cm
            JOIN (SELECT DISTINCT ON (owner_id) * FROM territories) t ON cm.user_id = t.owner_id
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


// --- SOCKET.IO LOGIC ---
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

            const playerProfileRes = await client.query('SELECT has_shield, is_carve_mode_active, username IS NOT NULL as has_record, superpowers, identity_color, profile_image_url FROM territories WHERE owner_id = $1 LIMIT 1', [googleId]);

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
                // CONQUER STATE
                isConquering: false,
                conquerTargetId: null,
                conquerLapsCompleted: 0,
                identityColor: playerRecord ? playerRecord.identity_color : null,
                profileImageUrl: playerRecord ? playerRecord.profile_image_url : null
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
            else {
                const query = `
                SELECT
                    t.id,
                    t.owner_id as "ownerId",
                    t.username as "ownerName",
                    t.profile_image_url as "profileImageUrl",
                    t.identity_color,
                    ST_AsGeoJSON(t.area) as geojson,
                    t.area_sqm as area,
                    t.laps_required,
                    t.brand_wrapper,
                    t.brand_url,
                    a.background_color as "adBackgroundColor",
                    a.overlay_url as "adOverlayUrl",
                    a.ad_content_url as "adContentUrl",
                    a.brand_name as "adBrandName",
                    a.id as "adId",
                    a.status as "adStatus"
                FROM territories t
                LEFT JOIN ads a ON t.id = a.territory_id 
                    AND a.payment_status = 'PAID' 
                    AND (a.status IS NULL OR a.status != 'DELETED') 
                    AND a.start_time <= NOW() 
                    AND a.end_time >= NOW()
                    AND a.overlay_url != 'https://runerrxadsstoragesmith.s3.ap-south-1.amazonaws.com/uploads/1763880012208-292432749.png'
                WHERE t.area IS NOT NULL AND NOT ST_IsEmpty(t.area);
            `;
                const territoryResult = await client.query(query);
                activeTerritories = territoryResult.rows.filter(row => row.geojson).map(row => ({ ...row, geojson: JSON.parse(row.geojson) }));

                // Debug: Log active ads found
                const territoriesWithAds = activeTerritories.filter(t => t.adBackgroundColor);
                if (territoriesWithAds.length > 0) {
                    console.log(`[DEBUG] Found ${territoriesWithAds.length} territories with active ads for player ${socket.id}`);
                    territoriesWithAds.forEach(t => {
                        console.log(`[DEBUG] Territory ${t.id} has ad: ${t.adBrandName} (ID: ${t.adId}, Status: ${t.adStatus}, Bg: ${t.adBackgroundColor})`);
                    });
                }
            }

            logSocket(`Found ${activeTerritories.length} [${gameMode}] territories. Sending 'existingTerritories' to ${socket.id}.`);
            socket.emit('existingTerritories', { territories: activeTerritories, playerHasRecord: playerHasRecord });

        } catch (err) {
            logSocket(`FATAL ERROR in playerJoined for ${socket.id}: %O`, err);
            socket.emit('error', { message: 'Failed to load game state.' });
        } finally {
            client.release();
        }
    });

    // =========================================================
    // >>> CONQUER MODE HANDLERS (MISSING IN YOUR SCRIPT) <<<
    // =========================================================

    // --- RACE MODE HANDLERS ---
    socket.on('challengePlayer', ({ opponentId }) => {
        try {
            raceHandler.createChallenge(socket.id, opponentId);
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });

    socket.on('acceptChallenge', ({ challengeId }) => {
        try {
            raceHandler.acceptChallenge(challengeId, socket.id);
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });

    socket.on('rejectChallenge', ({ challengeId }) => {
        raceHandler.rejectChallenge(challengeId, socket.id);
    });

    // --- CONQUEST MODE HANDLERS (Free-Form Arena System) ---
    socket.on('createConquestArena', async ({ territoryId }) => {
        try {
            await conquestHandler.createConquestArena(socket.id, territoryId);
        } catch (err) {
            socket.emit('arenaCreationFailed', { reason: err.message });
        }
    });

    socket.on('startConquest', () => {
        try {
            conquestHandler.startConquest(socket.id);
        } catch (err) {
            socket.emit('conquestStartFailed', { reason: err.message });
        }
    });

    socket.on('lapCompleted', ({ lapPath }) => {
        const result = conquestHandler.recordLap(socket.id, lapPath);
        if (result) {
            socket.emit('lapResult', result);
        }
    });

    socket.on('linkBases', async ({ baseA_Id, baseB_Id }) => {
        try {
            const linkId = await conquestHandler.startBaseLink(socket.id, baseA_Id, baseB_Id);
            socket.emit('baseLinkStarted', { linkId });
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });
    socket.on('finalizeBaseLink', async () => {
        try {
            await conquestHandler.finalizeBaseLink(socket.id);
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });
    // =========================================================

    socket.on('locationUpdate', async (data) => {
        const player = players[socket.id];
        if (!player || !player.googleId) return;

        player.lastKnownPosition = data;

        // Check if player entered conquest arena
        conquestHandler.checkArenaEntry(socket.id, { lat: data.lat, lng: data.lng });

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

            if ((player.gameMode === 'territoryWar' || player.gameMode === 'clan') && player.activeTrail.length > 0) {
                const lastPoint = player.activeTrail[player.activeTrail.length - 1];
                const attackerSegmentWKT = (lastPoint.lng === data.lng && lastPoint.lat === data.lat)
                    ? `POINT(${data.lng} ${data.lat})`
                    : `LINESTRING(${lastPoint.lng} ${lastPoint.lat}, ${data.lng} ${data.lat})`;

                const attackerSegmentGeom = `ST_SetSRID(ST_GeomFromText('${attackerSegmentWKT}'), 4326)`;

                for (const victimId in players) {
                    if (victimId === socket.id) continue;
                    const victim = players[victimId];
                    if (victim && (victim.gameMode === 'territoryWar' || victim.gameMode === 'clan') && victim.isDrawing && victim.activeTrail.length >= 2) {
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

                                const client = await pool.connect();
                                try {
                                    await client.query('BEGIN');
                                    await updateQuestProgress(player.googleId, 'trail_cut', 1, client, io, players);
                                    await client.query('COMMIT');
                                } catch (questErr) {
                                    await client.query('ROLLBACK');
                                    logGame(`Error updating trail_cut quest progress for ${player.name}: %O`, questErr);
                                } finally {
                                    client.release();
                                }

                                victim.isDrawing = false;
                                victim.activeTrail = [];
                                victim.cooldownUntil = Date.now() + 30000; // 30s cooldown
                                io.emit('trailCleared', { id: victimId });
                            }
                        } catch (err) {
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

        if (player.cooldownUntil && Date.now() < player.cooldownUntil) {
            const remaining = Math.ceil((player.cooldownUntil - Date.now()) / 1000);
            socket.emit('error', { message: `Cooldown active! Wait ${remaining}s.` });
            return;
        }

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
            } catch (err) {
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
            } catch (err) {
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
            } catch (err) {
                logGame(`Failed to use Last Stand for ${player.name}: %O`, err);
                player.hasLastStand = true;
            }
        }
    });

    socket.on('claimTerritory', async (req) => {
        const player = players[socket.id];
        if (!player || !player.googleId || !req.gameMode) {
            logSocket(`Invalid claimTerritory request from ${socket.id}`);
            return socket.emit('claimRejected', { reason: 'Invalid player data.' });
        }
        logGame(`Player ${player.name} (${socket.id}) is attempting to claim territory in mode [${req.gameMode}].`);

        const { gameMode } = req;
        const client = await pool.connect();

        try {
            await client.query('BEGIN');
            let result;
            if (gameMode === 'singleRun' || gameMode === 'areaCapture' || gameMode === 'territoryWar') {
                result = await handleSoloClaim(io, socket, player, players, req, client, superpowerManager);
            } else if (gameMode === 'clan') {
                result = await handleClanClaim(io, socket, player, players, req, client, superpowerManager);
            }

            if (!result) {
                await client.query('ROLLBACK');
                logDb(`ROLLBACK transaction for claim by ${player.name}, handler returned a nullish result.`);
                return;
            }

            const { finalTotalArea, areaClaimed, updatedTerritories, newTerritoryId } = result;
            await client.query('COMMIT');
            logDb(`COMMIT transaction for claim by ${player.name}.`);

            socket.emit('claimSuccessful', {
                newTotalArea: finalTotalArea,
                areaClaimed: areaClaimed,
                newTerritoryId: newTerritoryId,
                newTerritoryData: updatedTerritories.find(t => t.ownerId === player.googleId)
            });

            io.emit('batchTerritoryUpdate', updatedTerritories);

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
                    if (players[socket.id]) {
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

// --- HELPER FUNCTIONS & INTERVALS ---
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
                lastKnownPosition: p.lastKnownPosition,
                isDrawing: p.isDrawing,
                activeTrail: p.activeTrail
            };
        });
        io.emit('allPlayersUpdate', allPlayersData);
    } catch (e) {
        logSocket('Error during broadcastAllPlayers: %O', e);
    }
}

async function checkForScheduledReset() {
    logLifecycle('Checking for scheduled game reset...');
    const client = await pool.connect();
    try {
        const res = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'game_reset_time'");
        if (res.rowCount > 0 && res.rows[0].setting_value) {
            const scheduledTime = new Date(res.rows[0].setting_value);
            if (new Date() > scheduledTime) {
                logLifecycle(`Scheduled reset time ${scheduledTime.toISOString()} has passed. Initiating game reset.`);

                await client.query('BEGIN');

                const topPlayerRes = await client.query('SELECT owner_id, area_sqm FROM territories ORDER BY area_sqm DESC LIMIT 1');
                if (topPlayerRes.rowCount > 0) {
                    const topPlayer = topPlayerRes.rows[0];
                    await client.query(
                        'INSERT INTO season_winners (winner_user_id, area_sqm, win_date) VALUES ($1, $2, $3)',
                        [topPlayer.owner_id, topPlayer.area_sqm, scheduledTime]
                    );
                    logLifecycle(`Season winner ${topPlayer.owner_id} recorded with area ${topPlayer.area_sqm}.`);
                }

                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0`);
                logLifecycle('All player territories have been reset.');

                await client.query("DELETE FROM system_settings WHERE setting_key = 'game_reset_time'");
                logLifecycle('Scheduled reset time has been cleared.');

                await client.query('COMMIT');

                io.emit('gameReset', { message: 'A new season has begun! All territories have been reset.' });
                io.emit('allTerritoriesCleared');
            }
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[SERVER] CRITICAL: Error during scheduled game reset check:', err);
    } finally {
        client.release();
    }
}

// Check for expired ads and merge territories
async function checkExpiredAds() {
    const client = await pool.connect();
    try {
        // Find users who had active ads that just expired
        const expiredAdsRes = await client.query(`
            SELECT DISTINCT t.owner_id
            FROM ads a
            JOIN territories t ON a.territory_id = t.id
            WHERE a.payment_status = 'PAID'
              AND a.end_time < NOW()
              AND a.end_time > NOW() - INTERVAL '5 minutes'
        `);

        for (const row of expiredAdsRes.rows) {
            const ownerId = row.owner_id;

            // Check if this user still has any active ads
            const activeAdsCheck = await client.query(`
                SELECT COUNT(*) as count
                FROM ads a
                JOIN territories t ON a.territory_id = t.id
                WHERE t.owner_id = $1
                  AND a.payment_status = 'PAID'
                  AND (a.status IS NULL OR a.status != 'DELETED')
                  AND a.start_time <= NOW()
                  AND a.end_time >= NOW()
            `, [ownerId]);

            const hasActiveAds = parseInt(activeAdsCheck.rows[0].count) > 0;

            // If no more active ads, merge all territories for this user
            if (!hasActiveAds) {
                console.log(`[AD_EXPIRATION] User ${ownerId} has no more active ads. Merging territories...`);

                // Get all territories for this user
                const territoriesRes = await client.query(`
                    SELECT id, area
                    FROM territories
                    WHERE owner_id = $1
                `, [ownerId]);

                if (territoriesRes.rows.length > 1) {
                    // Merge all territories into one
                    const mergedAreaRes = await client.query(`
                        SELECT ST_AsGeoJSON(ST_Union(area)) as merged_geojson
                        FROM territories
                        WHERE owner_id = $1
                    `, [ownerId]);

                    const mergedGeoJSON = mergedAreaRes.rows[0].merged_geojson;

                    // Calculate total area
                    const areaRes = await client.query(`
                        SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) as total_area
                    `, [mergedGeoJSON]);

                    const totalArea = areaRes.rows[0].total_area;

                    // Update the first territory with merged area
                    const firstTerritoryId = territoriesRes.rows[0].id;
                    await client.query(`
                        UPDATE territories
                        SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                        WHERE id = $3
                    `, [mergedGeoJSON, totalArea, firstTerritoryId]);

                    // Delete other territories
                    const otherTerritoryIds = territoriesRes.rows.slice(1).map(t => t.id);
                    if (otherTerritoryIds.length > 0) {
                        await client.query(`
                            DELETE FROM territories
                            WHERE id = ANY($1::int[])
                        `, [otherTerritoryIds]);
                    }

                    console.log(`[AD_EXPIRATION] Merged ${territoriesRes.rows.length} territories for user ${ownerId}`);

                    // Broadcast territory update
                    io.emit('batchTerritoryUpdate', {
                        updatedTerritories: [{
                            id: firstTerritoryId,
                            ownerId: ownerId,
                            geojson: JSON.parse(mergedGeoJSON),
                            area: totalArea
                        }],
                        deletedTerritoryIds: otherTerritoryIds
                    });
                }
            }
        }
    } catch (err) {
        console.error('[AD_EXPIRATION] Error checking expired ads:', err);
    } finally {
        client.release();
    }
}

const main = async () => {
    server.listen(PORT, '0.0.0.0', () => {
        logLifecycle(`Server listening on 0.0.0.0:${PORT}`);
        setupDatabase().catch(err => {
            console.error("[SERVER] FATAL: Failed to setup database after server start:", err);
            process.exit(1);
        });
        setInterval(checkForScheduledReset, 60 * 1000); // Check every minute
        setInterval(checkExpiredAds, 5 * 60 * 1000); // Check every 5 minutes
    });
};

setInterval(broadcastAllPlayers, SERVER_TICK_RATE_MS);
main();