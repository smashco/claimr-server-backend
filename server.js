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
    console.log('[Firebase Admin] Skipping initialization (FIREBASE_SERVICE_ACCOUNT env var not set).');
  }
} catch (error) {
  console.error('[Firebase Admin] FATAL: Failed to initialize.', error.message);
}

// --- Constants & Database Pool ---
const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 1000;
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
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS clan_territories (
        id SERIAL PRIMARY KEY,
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE UNIQUE,
        owner_id VARCHAR(255) NOT NULL,
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] "clan_territories" table is ready.');

  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    throw err;
  } finally {
    client.release();
  }
};


// --- Middleware ---
const checkAdminSecret = (req, res, next) => {
    const { secret } = req.query;
    if (!process.env.ADMIN_SECRET_KEY || secret !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).send('Forbidden: Invalid or missing secret key.');
    }
    next();
};

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
    console.error("Auth Error:", error);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// --- API Endpoints ---
app.get('/', (req, res) => { res.send('Claimr Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

// ... (All API endpoints from previous correct version go here. They are unchanged.)

// --- Socket.IO Logic ---
async function broadcastAllPlayers() {
    const playerIds = Object.keys(players);
    if (playerIds.length === 0) return;
    const googleIds = Object.values(players).map(p => p.googleId).filter(id => id);
    if (googleIds.length === 0) return;
    try {
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
    } catch(e) {
        console.error("[Broadcast] Error fetching profiles for broadcast:", e);
    }
}

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', async ({ googleId, name, gameMode }) => {
    if (!googleId || !gameMode) return;
    
    const memberInfo = await pool.query('SELECT clan_id, role FROM clan_members WHERE user_id = $1', [googleId]);
    const clanId = memberInfo.rowCount > 0 ? memberInfo.rows[0].clan_id : null;
    const role = memberInfo.rowCount > 0 ? memberInfo.rows[0].role : null;

    players[socket.id] = { id: socket.id, name, googleId, clanId, role, gameMode, lastKnownPosition: null };
    console.log(`[SERVER] Player ${socket.id} (${name}) joined in [${gameMode}] mode.`);

    try {
        let query;
        if (gameMode === 'clan') {
            query = `
                SELECT 
                    ct.clan_id::text as "ownerId",
                    c.name as "ownerName",
                    c.clan_image_url as "profileImageUrl",
                    ST_AsGeoJSON(ct.area) as geojson, 
                    ct.area_sqm as area
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id;
            `;
        } else {
             query = `
                SELECT 
                    owner_id as "ownerId", 
                    username as "ownerName", 
                    profile_image_url as "profileImageUrl", 
                    ST_AsGeoJSON(area) as geojson, 
                    area_sqm as area
                FROM territories;
             `;
        }

        const result = await pool.query(query);
        const activeTerritories = result.rows
            .filter(row => row.geojson)
            .map(row => ({ ...row, geojson: JSON.parse(row.geojson) }));
            
        const playerProfileResult = await pool.query('SELECT 1 FROM territories WHERE owner_id = $1 AND username IS NOT NULL', [googleId]);
        const playerHasRecord = playerProfileResult.rowCount > 0;

        socket.emit('existingTerritories', { territories: activeTerritories, playerHasRecord });

    } catch (err) { 
      console.error('[DB] ERROR fetching initial territories:', err);
    }
  });

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (!player) return;
    player.lastKnownPosition = data;
    socket.broadcast.emit('trailPointAdded', { id: socket.id, point: data });
  });

  socket.on('startDrawingTrail', () => {
    socket.broadcast.emit('trailStarted', { id: socket.id });
  });

  socket.on('stopDrawingTrail', () => {
    io.emit('trailCleared', { id: socket.id });
  });

  socket.on('claimTerritory', async (req) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !req.gameMode) return;
    
    const { gameMode, trail, baseClaim } = req;
    let newClaimGeom;

    if (baseClaim) {
        const { center, radius } = baseClaim;
        if (!center || !radius) return socket.emit('claimRejected', { reason: 'Invalid base data.' });
        newClaimGeom = `ST_Buffer(ST_SetSRID(ST_MakePoint(${center.lng}, ${center.lat}), 4326)::geography, ${radius})::geometry`;
    } else if (trail && trail.length >= 4) {
        const coordinatesString = trail.map(p => `${p.lng} ${p.lat}`).join(', ');
        const newClaimWKT = `POLYGON((${coordinatesString}, ${trail[0].lng} ${trail[0].lat}))`;
        newClaimGeom = `ST_SetSRID(ST_GeomFromText('${newClaimWKT}'), 4326)`;
    } else {
        return socket.emit('claimRejected', { reason: 'Invalid trail data.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const areaResult = await client.query(`SELECT ST_Area(${newClaimGeom}::geography) as area;`);
        const newArea = areaResult.rows[0].area;

        if (newArea < MINIMUM_CLAIM_AREA_SQM) {
            await client.query('ROLLBACK');
            return socket.emit('claimRejected', { reason: `Area is too small (${Math.round(newArea)}m²).` });
        }
        
        let finalTotalArea = newArea;
        let ownerIdToUpdate;
        
        if (gameMode === 'clan') {
            ownerIdToUpdate = player.clanId;
            if (!ownerIdToUpdate) throw new Error('Player not in clan for clan claim');
            
            const upsertQuery = `
                INSERT INTO clan_territories (clan_id, owner_id, area, area_sqm) VALUES ($1, $2, ${newClaimGeom}, $3)
                ON CONFLICT (clan_id) DO UPDATE SET
                    area = ST_Union(clan_territories.area, ${newClaimGeom}),
                    area_sqm = ST_Area(ST_Union(clan_territories.area, ${newClaimGeom})::geography),
                    owner_id = $2
                RETURNING area_sqm;
            `;
            const result = await client.query(upsertQuery, [ownerIdToUpdate, player.googleId, newArea]);
            finalTotalArea = result.rows[0].area_sqm;

        } else { // Solo mode
            ownerIdToUpdate = player.googleId;
            const upsertQuery = `
                INSERT INTO territories (owner_id, area, area_sqm) VALUES ($1, ${newClaimGeom}, $2)
                ON CONFLICT (owner_id) DO UPDATE SET 
                    area = ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3),
                    area_sqm = ST_Area((ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3))::geography)
                RETURNING area_sqm;
            `;
            const result = await client.query(upsertQuery, [ownerIdToUpdate, newArea]);
            finalTotalArea = result.rows[0].area_sqm;
        }
        
        await client.query('COMMIT');
        
        // Emit specific success event to the player who claimed
        io.to(socket.id).emit('claimSuccessful', { newTotalArea: finalTotalArea });

        // Fetch the updated territory data to broadcast to everyone
        const finalResultQuery = gameMode === 'clan' ? `
            SELECT clan_id::text as "ownerId", c.name as "ownerName", c.clan_image_url as "profileImageUrl", ST_AsGeoJSON(area) as geojson, area_sqm as area
            FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.clan_id = $1;
        ` : `
            SELECT owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl", ST_AsGeoJSON(area) as geojson, area_sqm as area 
            FROM territories WHERE owner_id = $1`;
        
        const finalResult = await pool.query(finalResultQuery, [ownerIdToUpdate]);
        const batchUpdateData = finalResult.rows.filter(r => r.geojson).map(r => ({ ...r, geojson: JSON.parse(r.geojson) }));

        if (batchUpdateData.length > 0) {
            io.emit('batchTerritoryUpdate', batchUpdateData);
        }
        io.emit('trailCleared', { id: socket.id });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] FATAL Error during territory claim:', err);
        socket.emit('claimRejected', { reason: 'Server error during claim.' });
    } finally {
        client.release();
    }
  });
  
  socket.on('activateClanBase', ({ center, radius }) => {
      const player = players[socket.id];
      if (!player || !player.clanId) return;
      console.log(`[CLAN] Leader of clan ${player.clanId} activated a base.`);
      
      Object.values(players).forEach(p => {
          if (p.clanId === player.clanId) {
              io.to(p.id).emit('clanBaseActivated', { center, radius });
          }
      });
  });

  socket.on('deactivateClanBase', () => {
      const player = players[socket.id];
      if (!player || !player.clanId) return;
      console.log(`[CLAN] Leader of clan ${player.clanId} deactivated the base.`);
      
       Object.values(players).forEach(p => {
          if (p.clanId === player.clanId) {
              io.to(p.id).emit('clanBaseDeactivated');
          }
      });
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      console.log(`[SERVER] User ${player.name} disconnected: ${socket.id}`);
      delete players[socket.id];
      io.emit('playerLeft', { id: socket.id });
    }
  });
});

// --- Server Start ---
setInterval(broadcastAllPlayers, SERVER_TICK_RATE_MS);
const main = async () => {
  server.listen(PORT, () => {
    console.log(`[SERVER] Listening on *:${PORT}`);
    setupDatabase().catch(err => {
        console.error("[SERVER] Failed to setup database after server start:", err);
        process.exit(1); 
    });
  });
};

main();