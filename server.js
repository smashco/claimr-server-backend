require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');

// ✅ ADDED: Global error handlers for better debugging on Render
process.on('unhandledRejection', (reason, promise) => {
  console.error('SERVER ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('SERVER ERROR: Uncaught Exception:', error);
  process.exit(1); // Exit on critical errors so the service can restart
});

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- Initialize Firebase Admin SDK ---
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: 'claimr-6464.firebasestorage.app'
    });
    console.log('[Firebase Admin] Initialized successfully.');
  } else {
    console.log('[Firebase Admin] Skipping initialization: FIREBASE_SERVICE_ACCOUNT env var not set.');
  }
} catch (error) {
  console.error('[Firebase Admin] FATAL: Failed to initialize.', error.message);
}

const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 100;
const MINIMUM_CLAIM_AREA_SQM = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const players = {}; 

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    const createTableQuery = `
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
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready.');
  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err; // Re-throw the error to be caught by the caller
  } finally {
    client.release();
  }
};

// --- Middleware for protecting admin routes ---
const checkAdminSecret = (req, res, next) => {
    const { secret } = req.query;
    if (!process.env.ADMIN_SECRET_KEY || secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).send('Forbidden: Invalid or missing secret key.');
    }
    next();
};

// --- Middleware for authenticating user tokens ---
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized: No token provided.');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// --- API ENDPOINTS ---

app.get('/', (req, res) => { res.send('Claimr Server is running!'); });

app.get('/check-profile', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required.' });
    try {
        const result = await pool.query('SELECT username, profile_image_url FROM territories WHERE owner_id = $1', [googleId]);
        if (result.rowCount > 0 && result.rows[0].username) {
            res.json({ profileExists: true, username: result.rows[0].username, profileImageUrl: result.rows[0].profile_image_url });
        } else {
            res.json({ profileExists: false });
        }
    } catch (err) {
        console.error('[API] Error checking profile:', err);
        res.status(500).json({ error: 'Server error while checking profile.' });
    }
});

app.get('/check-username', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username query parameter is required.' });
    try {
        const result = await pool.query('SELECT 1 FROM territories WHERE username = $1', [username.toLowerCase()]);
        res.json({ isAvailable: result.rowCount === 0 });
    } catch (err) {
        res.status(500).json({ error: 'Server error while checking username.' });
    }
});

app.post('/setup-profile', async (req, res) => {
    const { googleId, username, imageUrl, displayName } = req.body;
    if (!googleId || !username || !imageUrl || !displayName) return res.status(400).json({ error: 'Missing required profile data.' });
    try {
        const upsertQuery = `
            INSERT INTO territories (owner_id, owner_name, username, profile_image_url) VALUES ($1, $2, $3, $4)
            ON CONFLICT (owner_id) DO UPDATE SET username = $3, profile_image_url = $4, owner_name = $2;
        `;
        await pool.query(upsertQuery, [googleId, displayName, username.toLowerCase(), imageUrl]);
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username is already taken.' });
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT owner_id, username as owner_name, area_sqm, RANK() OVER (ORDER BY area_sqm DESC) as rank
            FROM territories WHERE area_sqm > 0 AND username IS NOT NULL ORDER BY area_sqm DESC LIMIT 100;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

// --- ADMIN & DEV ENDPOINTS ---

app.post('/dev/reset-user', authenticate, async (req, res) => {
    const { googleId } = req.body; const firebaseUid = req.user.uid;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM territories WHERE owner_id = $1', [googleId]);
        if (admin.apps.length > 0) {
            const bucket = admin.storage().bucket();
            const fileExtensions = ['jpg', 'png', 'jpeg', 'webp'];
            for (const ext of fileExtensions) {
                const file = bucket.file(`profile_images/${firebaseUid}.${ext}`);
                const [exists] = await file.exists();
                if (exists) { await file.delete(); break; }
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'User reset successfully.' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to reset user data.' });
    } finally { client.release(); }
});

app.get('/admin/factory-reset', checkAdminSecret, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("TRUNCATE TABLE territories RESTART IDENTITY;");
        if (admin.apps.length > 0) {
            const bucket = admin.storage().bucket();
            const [files] = await bucket.getFiles({ prefix: 'profile_images/' });
            if (files.length > 0) {
                await Promise.all(files.map(file => file.delete()));
            }
        }
        io.emit('allTerritoriesCleared');
        res.status(200).send('SUCCESS: Factory reset complete.');
    } catch (err) {
        res.status(500).send(`ERROR during factory reset: ${err.message}`);
    } finally { client.release(); }
});

app.get('/admin/reset-all-territories', checkAdminSecret, async (req, res) => {
    try {
        await pool.query("UPDATE territories SET area = NULL, area_sqm = NULL;");
        io.emit('allTerritoriesCleared');
        res.status(200).send('SUCCESS: All claimed territories deleted.');
    } catch (err) {
        res.status(500).send('ERROR clearing territories.');
    }
});


// --- REAL-TIME GAME LOGIC ---

async function broadcastAllPlayers() {
    const playerIds = Object.keys(players);
    if (playerIds.length === 0) return;
    const googleIds = Object.values(players).map(p => p.googleId).filter(id => id);
    if (googleIds.length === 0) return;
    const profileQuery = await pool.query('SELECT owner_id, username, profile_image_url FROM territories WHERE owner_id = ANY($1::varchar[])', [googleIds]);
    const profiles = profileQuery.rows.reduce((acc, row) => {
        acc[row.owner_id] = { username: row.username, imageUrl: row.profile_image_url };
        return acc;
    }, {});
    const allPlayersData = Object.values(players).map(p => {
        const profile = profiles[p.googleId] || {};
        return { id: p.id, name: profile.username || p.name, imageUrl: profile.imageUrl, lastKnownPosition: p.lastKnownPosition };
    });
    io.emit('allPlayersUpdate', allPlayersData);
}

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', async (data) => {
    if (!data || !data.googleId) return;
    players[socket.id] = { id: socket.id, name: data.name, googleId: data.googleId, activeTrail: [], lastKnownPosition: null, isDrawing: false };
    console.log(`[SERVER] Player ${socket.id} (${data.googleId}) has joined as "${players[socket.id].name}".`);

    try {
        const result = await pool.query("SELECT owner_id, username, profile_image_url, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
        const activeTerritories = result.rows.filter(row => row.geojson).map(row => ({ ownerId: row.owner_id, ownerName: row.username, profileImageUrl: row.profile_image_url, geojson: JSON.parse(row.geojson), area: row.area_sqm }));
        const playerHasRecord = result.rows.some(row => row.owner_id === data.googleId && row.username);
        socket.emit('existingTerritories', { territories: activeTerritories, playerHasRecord: playerHasRecord });
    } catch (err) { console.error('[DB] ERROR fetching initial territories:', err); }
  });

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (!player) return;
    player.lastKnownPosition = data;
    if (player.isDrawing && Array.isArray(player.activeTrail)) {
        player.activeTrail.push(data);
        io.emit('trailPointAdded', { id: socket.id, point: data });
    }
  });

  socket.on('startDrawingTrail', () => {
    const player = players[socket.id]; if (!player) return;
    player.isDrawing = true; player.activeTrail = [];
    io.emit('trailStarted', { id: socket.id, name: player.name });
  });

  socket.on('stopDrawingTrail', () => {
    const player = players[socket.id]; if (!player) return;
    player.isDrawing = false;
    io.emit('trailCleared', { id: socket.id });
  });

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id]; if (!player || !player.googleId) return;
    const trailData = data ? data.trail : undefined; if (!Array.isArray(trailData) || trailData.length < 3) return;
    player.isDrawing = false; player.activeTrail = [];
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newClaimWKT = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    const client = await pool.connect();
    try {
      const areaResult = await client.query(`SELECT ST_Area(ST_GeomFromText($1, 4326)::geography) as area;`, [newClaimWKT]);
      const newArea = areaResult.rows[0].area;
      if (newArea < MINIMUM_CLAIM_AREA_SQM) { socket.emit('claimRejected', { reason: 'Area is too small!' }); return; }
      
      await client.query('BEGIN');
      const victimsResult = await client.query("SELECT owner_id FROM territories WHERE owner_id != $1 AND area IS NOT NULL AND ST_Intersects(area, ST_GeomFromText($2, 4326))", [player.googleId, newClaimWKT]);
      const victimIds = victimsResult.rows.map(r => r.owner_id);
      let updatedOwnerIds = [player.googleId, ...victimIds];

      for (const victimId of victimIds) {
        const smartCutQuery = `WITH rem AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference((SELECT area FROM territories WHERE owner_id = $2),ST_GeomFromText($1, 4326)), 3))).geom AS p), lg AS (SELECT p FROM rem ORDER BY ST_Area(p) DESC NULLS LAST LIMIT 1) UPDATE territories SET area = (SELECT p FROM lg), area_sqm = ST_Area((SELECT p FROM lg)::geography) WHERE owner_id = $2 RETURNING area;`;
        const cutResult = await client.query(smartCutQuery, [newClaimWKT, victimId]);
        if (cutResult.rowCount === 0 || cutResult.rows[0].area === null) { await client.query('UPDATE territories SET area = NULL, area_sqm = NULL WHERE owner_id = $1', [victimId]); io.emit('playerTerritoriesCleared', { ownerId: victimId }); }
      }

      const playerInfoRes = await client.query('SELECT username FROM territories WHERE owner_id = $1', [player.googleId]);
      const currentUsername = playerInfoRes.rows[0]?.username || player.name;

      const upsertQuery = `INSERT INTO territories (owner_id, username, area, area_sqm) VALUES ($1, $2, ST_GeomFromText($3, 4326), $4) ON CONFLICT (owner_id) DO UPDATE SET area = ST_CollectionExtract(ST_Union(territories.area, ST_GeomFromText($3, 4326)), 3), area_sqm = ST_Area(ST_CollectionExtract(ST_Union(territories.area, ST_GeomFromText($3, 4326)), 3)::geography), username = $2;`;
      await client.query(upsertQuery, [player.googleId, currentUsername, newClaimWKT, newArea]);
      
      const finalResult = await client.query(`SELECT owner_id, username, profile_image_url, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories WHERE owner_id = ANY($1::varchar[])`, [updatedOwnerIds]);
      const batchUpdateData = finalResult.rows.map(row => ({ ownerId: row.owner_id, ownerName: row.username, profileImageUrl: row.profile_image_url, geojson: JSON.parse(row.geojson), area: row.area_sqm })).filter(d => d.geojson != null);
      
      await client.query('COMMIT');
      if(batchUpdateData.length > 0) io.emit('batchTerritoryUpdate', batchUpdateData);
      io.emit('trailCleared', { id: socket.id });
    } catch (err) { await client.query('ROLLBACK'); console.error('[DB] FATAL Error during territory cut/claim:', err); } finally { client.release(); }
  });

  socket.on('deleteMyTerritories', async () => {
    const player = players[socket.id]; if (!player || !player.googleId) return;
    try {
      await pool.query("UPDATE territories SET area = NULL, area_sqm = NULL WHERE owner_id = $1", [player.googleId]);
      console.log(`[DB] Inactivated territories for owner_id: ${player.googleId}.`);
      io.emit('playerTerritoriesCleared', { ownerId: player.googleId });
    } catch (err) { console.error('[DB] Error inactivating player territories:', err); }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    io.emit('playerLeft', { id: socket.id });
    if(players[socket.id]) { delete players[socket.id]; }
  });
});

setInterval(async () => { await broadcastAllPlayers(); }, SERVER_TICK_RATE_MS);

// ✅ MODIFIED: The robust startup sequence
const main = async () => {
  server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
    
    // Connect to and set up the database after the server is live
    setupDatabase().catch(err => {
        console.error("Failed to setup database after server start:", err);
        process.exit(1); 
    });
  });
};

main();