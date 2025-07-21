require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');
const turf = require('@turf/turf'); 

// --- Require the Game Logic Handlers ---
const handleSoloClaim = require('./game_logic/solo_handler');
const handleClanClaim = require('./game_logic/clan_handler');

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
        username VARCHAR(50), 
        profile_image_url TEXT,
        identity_color VARCHAR(10) DEFAULT '#39FF14',
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        original_base_point GEOMETRY(POINT, 4326), 
        has_shield BOOLEAN DEFAULT FALSE, 
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
        leader_id VARCHAR(255) NOT NULL REFERENCES territories(owner_id) ON DELETE CASCADE,
        base_location GEOMETRY(POINT, 4326), 
        has_shield BOOLEAN DEFAULT FALSE, 
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
        clan_id INTEGER NOT NULL PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,
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
app.get('/', (req, res) => { res.send('ClaimrunX Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

// ... (other API endpoints are unchanged)
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

// ... (other API endpoints are unchanged)
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

app.put('/admin/toggle-shield/:ownerId', checkAdminSecret, async (req, res) => {
    const { ownerId } = req.params;
    const { hasShield } = req.body;
    if (typeof hasShield !== 'boolean') return res.status(400).json({ message: 'hasShield (boolean) is required.' });
    try {
        await pool.query('UPDATE territories SET has_shield = $1 WHERE owner_id = $2', [hasShield, ownerId]);
        res.status(200).json({ success: true, message: `Shield for ${ownerId} set to ${hasShield}.` });
    } catch (err) {
        console.error('[API] Error toggling shield:', err);
        res.status(500).json({ message: 'Server error toggling shield.' });
    }
});

// ... (other API endpoints are unchanged)
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
            LEFT JOIN territories t_leader ON c.leader_id = t.owner_id
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

// ... (rest of API endpoints are unchanged)

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
            return { id: p.id, name: profile.username || p.name, imageUrl: profile.imageUrl, identityColor: profile.identityColor, lastKnownPosition: p.lastKnownPosition };
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
    let player; // Declare player here to ensure it's accessible consistently
    try {
        const memberInfoRes = await client.query('SELECT clan_id, role FROM clan_members WHERE user_id = $1', [googleId]);
        const clanId = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].clan_id : null;
        const role = memberInfoRes.rowCount > 0 ? memberInfoRes.rows[0].role : null;
        const playerProfileRes = await client.query('SELECT has_shield FROM territories WHERE owner_id = $1', [googleId]);
        const hasShield = playerProfileRes.rows.length > 0 ? playerProfileRes.rows[0].has_shield : false;

        player = players[socket.id] = { // Assign to the declared player variable
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
            disconnectTimer: null 
        };
    
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
                    identity_color, 
                    ST_AsGeoJSON(area) as geojson, 
                    area_sqm as area
                FROM territories
                WHERE area IS NOT NULL AND NOT ST_IsEmpty(area);
             `;
        }
        const territoryResult = await client.query(query);
        const activeTerritories = territoryResult.rows.filter(row => row.geojson).map(row => ({ ...row, geojson: JSON.parse(row.geojson) }));
        const playerProfileResult = await client.query('SELECT 1 FROM territories WHERE owner_id = $1 AND username IS NOT NULL', [googleId]);
        const playerHasRecord = playerProfileResult.rowCount > 0;
        console.log(`[Socket] Found ${activeTerritories.length} territories. Sending 'existingTerritories' to ${socket.id}.`);
        socket.emit('existingTerritories', { territories: activeTerritories, playerHasRecord: playerHasRecord });

        const activeTrails = [];
        for (const playerId in players) {
          if (players[playerId].isDrawing && players[playerId].activeTrail.length > 0) { 
            activeTrails.push({ id: playerId, trail: players[playerId].activeTrail });
          }
        }
        if (activeTrails.length > 0) {
          socket.emit('existingLiveTrails', activeTrails);
        }

        if (player.gameMode === 'clan' && player.clanId) {
            const clanBaseRes = await client.query('SELECT base_location FROM clans WHERE id = $1', [player.clanId]);
            if (clanBaseRes.rows.length > 0 && clanBaseRes.rows[0].base_location) {
                const baseLoc = clanBaseRes.rows[0].base_location;
                const parsedBaseLoc = JSON.parse(await client.query(`SELECT ST_AsGeoJSON($1) as geojson`, [baseLoc])).geojson.coordinates;
                socket.emit('clanBaseActivated', { center: { lat: parsedBaseLoc[1], lng: parsedBaseLoc[0] } });
            }
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
        socket.broadcast.emit('trailPointAdded', { id: socket.id, point: data }); 

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
    if (!player || player.gameMode === 'spectator') return;
    if (player.isDrawing) {
      console.warn(`[Socket] Player ${player.name} sent startDrawingTrail but was already drawing.`);
      return;
    }
    player.isDrawing = true;
    player.activeTrail = [];
    console.log(`[Socket] Player ${player.name} (${socket.id}) started drawing trail.`);
    socket.broadcast.emit('trailStarted', { id: socket.id, name: player.name }); 
  });

  socket.on('stopDrawingTrail', () => {
    const player = players[socket.id];
    if (!player) return;
    console.log(`[Socket] Player ${player.name} (${socket.id}) stopped drawing trail.`);
    player.isDrawing = false;
    player.activeTrail = [];
    io.emit('trailCleared', { id: socket.id }); 
  });

  socket.on('claimTerritory', async (req) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !req.gameMode) {
      console.warn(`[Claim] Invalid claimTerritory request from ${socket.id}`);
      return;
    }

    const { gameMode, trail, baseClaim } = req; 
    
    if (trail.length < 1 || (!baseClaim && trail.length < 3)) { 
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
            result = await handleSoloClaim(io, socket, player, trail, baseClaim, client); 
        } else if (gameMode === 'clan') {
            result = await handleClanClaim(io, socket, player, trail, baseClaim, client); 
        } else {
            throw new Error('Invalid game mode specified.');
        }

        if (!result) { 
            await client.query('ROLLBACK');
            return; 
        }

        const { finalTotalArea, areaClaimed, ownerIdsToUpdate } = result;
        await client.query('COMMIT'); 

        console.log(`[Claim] Player ${player.name} claimed ${areaClaimed} sqm. Total: ${finalTotalArea}. Owners updated: ${ownerIdsToUpdate}`);
        
        socket.emit('claimSuccessful', { newTotalArea: finalTotalArea, areaClaimed: areaClaimed });
        
        // --- FIX FOR INTEGER OUT OF RANGE ERROR ---
        const soloOwnersToUpdate = [];
        const clanOwnersToUpdate = [];

        for (const id of ownerIdsToUpdate) {
            // Google IDs are long strings that should not be parsed as integers.
            // Clan IDs are simple integers, and can be safely parsed.
            if (typeof id === 'string' && /^\d+$/.test(id) && id.length < 10) { // Regex for digits only, and a length check for sanity
                clanOwnersToUpdate.push(parseInt(id, 10)); // Convert to integer
            } else if (typeof id === 'string') { // Assume any other string is a Google ID
                soloOwnersToUpdate.push(id);
            } else {
                console.warn(`[Claim] Skipping unrecognized ownerId type/format in batch update: ${id}`);
            }
        }

        let batchUpdateData = [];
        if (soloOwnersToUpdate.length > 0) {
            const soloQueryResult = await client.query(`
                SELECT owner_id as "ownerId", username as "ownerName", profile_image_url as "profileImageUrl", identity_color, ST_AsGeoJSON(area) as geojson, area_sqm as area 
                FROM territories WHERE owner_id = ANY($1::varchar[]);`, [soloOwnersToUpdate]);
            batchUpdateData = batchUpdateData.concat(soloQueryResult.rows.filter(r => r.geojson).map(r => ({ 
                ownerId: r.ownerId, ownerName: r.ownerName, profileImageUrl: r.profileImageUrl, 
                identityColor: r.identity_color, geojson: JSON.parse(r.geojson), area: r.area 
            })));
        }
        if (clanOwnersToUpdate.length > 0) {
            const clanQueryResult = await client.query(`
                SELECT ct.clan_id::text as "ownerId", c.name as "ownerName", c.clan_image_url as "profileImageUrl", ST_AsGeoJSON(ct.area) as geojson, ct.area_sqm as area
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.clan_id = ANY($1::int[]);`, [clanOwnersToUpdate]);
            batchUpdateData = batchUpdateData.concat(clanQueryResult.rows.filter(r => r.geojson).map(r => ({ 
                ownerId: r.ownerId, ownerName: r.ownerName, profileImageUrl: r.profileImageUrl, 
                identityColor: null, 
                geojson: JSON.parse(r.geojson), area: r.area 
            })));
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
        let reason = 'Server error during claim.';
        if (err && err.message && typeof err.message === 'string' && (err.message.startsWith('Area is too small') || err.message.startsWith('Invalid loop geometry') || err.message.includes('Shield activated') || err.message.includes('Clan base is not active') || err.message.includes('must start closer to the clan base'))) {
            reason = err.message;
        }
        socket.emit('claimRejected', { reason });
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
        player.disconnectTimer = setTimeout(() => {
            console.log(`[SERVER] Disconnect timer expired for ${player.name}. Clearing trail.`);
            player.isDrawing = false; 
            player.activeTrail = []; 
            io.emit('trailCleared', { id: socket.id }); 
            delete players[socket.id]; 
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
  server.listen(PORT, () => {
    console.log(`[SERVER] Listening on *:${PORT}`);
    setupDatabase().catch(err => {
        console.error("[SERVER] Failed to setup database after server start:", err);
        process.exit(1); 
    });
  });
};

main();