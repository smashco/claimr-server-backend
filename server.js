require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');

const app = express();
app.use(express.json()); // Enable JSON body parsing for POST requests
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 100;
const MINIMUM_CLAIM_AREA_SQM = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// In-memory object to track LIVE player data by their temporary socket.id
const players = {}; 

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    // For development, we drop the table to apply schema changes.
    // In production, you would use migration scripts.
    // await client.query('DROP TABLE IF EXISTS territories;');
    // console.log('[DB] Dropped old "territories" table for schema update.');
    
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE, -- Stable Google User ID
        owner_name VARCHAR(255),               -- Google Display Name
        username VARCHAR(50) UNIQUE,           -- Unique In-Game Name
        profile_image_url TEXT,                -- URL to profile image
        area GEOMETRY(GEOMETRY, 4326),         -- Can be NULL if no territory
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready with new profile columns.');
  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

// --- API ENDPOINTS ---

app.get('/', (req, res) => { res.send('Claimr Server - PROFILE UPDATE is running!'); });

// NEW: Endpoint for the Login Screen to check if a profile has been set up.
app.get('/check-profile', async (req, res) => {
    const { googleId } = req.query;
    if (!googleId) return res.status(400).json({ error: 'googleId is required.' });
    try {
        const result = await pool.query('SELECT username FROM territories WHERE owner_id = $1', [googleId]);
        // Profile exists if a row is found AND the username has been set.
        const profileExists = result.rowCount > 0 && result.rows[0].username;
        res.json({ profileExists: !!profileExists });
    } catch (err) {
        console.error('[API] Error checking profile:', err);
        res.status(500).json({ error: 'Server error while checking profile.' });
    }
});

// NEW: Endpoint for the Profile Setup Screen to check username availability.
app.get('/check-username', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'Username query parameter is required.' });
    try {
        const result = await pool.query('SELECT 1 FROM territories WHERE username = $1', [username.toLowerCase()]);
        res.json({ isAvailable: result.rowCount === 0 });
    } catch (err) {
        console.error('[API] Error checking username:', err);
        res.status(500).json({ error: 'Server error while checking username.' });
    }
});

// NEW: Endpoint for the Profile Setup Screen to save the new profile.
app.post('/setup-profile', async (req, res) => {
    const { googleId, username, imageUrl, displayName } = req.body;
    if (!googleId || !username || !imageUrl || !displayName) return res.status(400).json({ error: 'Missing required profile data.' });
    try {
        const upsertQuery = `
            INSERT INTO territories (owner_id, owner_name, username, profile_image_url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (owner_id) DO UPDATE SET
                username = $3,
                profile_image_url = $4,
                owner_name = $2;
        `;
        await pool.query(upsertQuery, [googleId, displayName, username.toLowerCase(), imageUrl]);
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        console.error('[API] Error setting up profile:', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Username is already taken.' });
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

app.get('/leaderboard', async (req, res) => {
    try {
        // Returns the unique `username` for display.
        const query = `
            SELECT 
                owner_id,
                username as owner_name, 
                area_sqm,
                RANK() OVER (ORDER BY area_sqm DESC) as rank
            FROM territories
            WHERE area_sqm > 0 AND username IS NOT NULL
            ORDER BY area_sqm DESC
            LIMIT 100;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching leaderboard:', err);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

app.get('/admin/reset-all', async (req, res) => { try { await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;"); io.emit('allTerritoriesCleared'); console.log('[ADMIN] All territories have been reset.'); res.status(200).send('SUCCESS: All claimed territories have been deleted.'); } catch (err) { console.error('[ADMIN] Error clearing territories:', err); res.status(500).send('ERROR clearing territories.'); }});

// --- REAL-TIME GAME LOGIC ---
function onSegment(p, q, r) { if (q.lat <= Math.max(p.lat, r.lat) && q.lat >= Math.min(p.lat, r.lat) && q.lng <= Math.max(p.lng, r.lng) && q.lng >= Math.min(p.lng, r.lng)) { return true; } return false; } 
function orientation(p, q, r) { const val = (q.lng - p.lng) * (r.lat - q.lat) - (q.lat - p.lat) * (r.lng - q.lng); if (val == 0) return 0; return (val > 0) ? 1 : 2;} 
function linesIntersect(p1, q1, p2, q2) { const o1 = orientation(p1, q1, p2); const o2 = orientation(p1, q1, q2); const o3 = orientation(p2, q2, p1); const o4 = orientation(p2, q2, q1); if (o1 != o2 && o3 != o4) return true; if (o1 == 0 && onSegment(p1, p2, q1)) return true; if (o2 == 0 && onSegment(p1, q2, q1)) return true; if (o3 == 0 && onSegment(p2, p1, q2)) return true; if (o4 == 0 && onSegment(p2, q1, q2)) return true; return false; }

async function broadcastAllPlayers() {
    const playerIds = Object.keys(players);
    if (playerIds.length === 0) return;

    // Fetch profile info for all currently connected players in one go
    const googleIds = Object.values(players).map(p => p.googleId).filter(id => id);
    if (googleIds.length === 0) return; // No players with googleId to look up

    const profileQuery = await pool.query(
        'SELECT owner_id, username, profile_image_url FROM territories WHERE owner_id = ANY($1::varchar[])',
        [googleIds]
    );

    const profiles = profileQuery.rows.reduce((acc, row) => {
        acc[row.owner_id] = { username: row.username, imageUrl: row.profile_image_url };
        return acc;
    }, {});

    const allPlayersData = Object.values(players).map(p => {
        const profile = profiles[p.googleId] || {};
        return {
            id: p.id,
            name: profile.username || p.name, // Fallback to original name
            imageUrl: profile.imageUrl,
            lastKnownPosition: p.lastKnownPosition
        };
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
        
        const activeTerritories = result.rows.filter(row => row.geojson).map(row => ({ 
            ownerId: row.owner_id,
            ownerName: row.username, // Use the unique username
            profileImageUrl: row.profile_image_url, // Add the image URL
            geojson: JSON.parse(row.geojson), 
            area: row.area_sqm 
        }));
        
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
    // Cutting logic would go here in a real implementation
  });

  socket.on('startDrawingTrail', () => {
    const player = players[socket.id];
    if (!player) return;
    player.isDrawing = true;
    player.activeTrail = [];
    io.emit('trailStarted', { id: socket.id, name: player.name });
  });

  socket.on('stopDrawingTrail', () => {
    const player = players[socket.id];
    if (!player) return;
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
      
      const batchUpdateData = finalResult.rows.map(row => ({ 
          ownerId: row.owner_id, 
          ownerName: row.username, // Use the unique username
          profileImageUrl: row.profile_image_url, // Add the image URL
          geojson: JSON.parse(row.geojson), 
          area: row.area_sqm 
      })).filter(d => d.geojson != null);
      
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

setInterval(async () => { 
  await broadcastAllPlayers(); 
}, SERVER_TICK_RATE_MS);

const main = async () => { await setupDatabase(); server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); };
main();