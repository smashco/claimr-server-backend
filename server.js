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
        clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
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
    next();
  } catch (error) {
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// --- API Endpoints ---
app.get('/', (req, res) => { res.send('Claimr Server is running!'); });
app.get('/ping', (req, res) => { res.status(200).json({ success: true, message: 'pong' }); });

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
                area_sqm: row.area_sqm || 0,
                clan_info: null
            };
            if (row.clan_id) {
                response.clan_info = {
                    id: row.clan_id.toString(),
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
        const upsertQuery = `
            INSERT INTO territories (owner_id, owner_name, username, profile_image_url) VALUES ($1, $2, $3, $4)
            ON CONFLICT (owner_id) DO UPDATE SET username = $3, profile_image_url = $4, owner_name = $2;
        `;
        await pool.query(upsertQuery, [googleId, displayName, username, imageUrl]);
        res.status(200).json({ success: true, message: 'Profile set up successfully.' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username is already taken.' });
        res.status(500).json({ error: 'Failed to set up profile.' });
    }
});

app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT owner_id, username as owner_name, profile_image_url, area_sqm, RANK() OVER (ORDER BY area_sqm DESC) as rank
            FROM territories WHERE area_sqm > 0 AND username IS NOT NULL ORDER BY area_sqm DESC LIMIT 100;
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

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
        res.status(200).json({ rank: result.rowCount > 0 ? result.rows[0].rank : 'N/A' });
    } catch (err) {
        console.error('[API] Error fetching user rank:', err);
        res.status(500).json({ error: 'Failed to fetch user rank' });
    }
});

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

app.post('/clans', authenticate, async (req, res) => {
    const { name, tag, description } = req.body;
    const leaderId = req.user.user_id;
    if (!name || !tag) return res.status(400).json({ error: 'Name and tag are required' });

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
        await client.query('COMMIT');

        res.status(201).json({
            id: newClan.id.toString(),
            name: newClan.name,
            tag: newClan.tag,
            role: 'leader',
            base_is_set: false
        });
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
    const { user_id } = req.user;
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
        const result = await pool.query(query, [user_id]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching clans list:', err);
        res.status(500).json({ error: 'Failed to fetch clans' });
    }
});

app.get('/clans/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const clanQuery = `
            SELECT 
                c.id, c.name, c.tag, c.description, c.clan_image_url,
                t.username as leader_name,
                (SELECT COUNT(*) FROM clan_members cm WHERE cm.clan_id = c.id) as member_count,
                (SELECT COALESCE(SUM(area_sqm), 0) FROM clan_territories WHERE clan_id = c.id) as total_area_sqm
            FROM clans c
            JOIN territories t ON c.leader_id = t.owner_id
            WHERE c.id = $1;
        `;
        const clanResult = await pool.query(clanQuery, [id]);
        if (clanResult.rowCount === 0) return res.status(404).json({ error: 'Clan not found' });
        
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
        res.status(500).json({ error: 'Failed to fetch clan details' });
    }
});

app.put('/clans/:id/photo', authenticate, async (req, res) => {
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

app.post('/clans/:id/set-base', authenticate, async (req, res) => {
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

app.delete('/clans/members/me', authenticate, async (req, res) => {
    const { user_id } = req.user;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const memberInfoQuery = `
            SELECT clan_id, role, (SELECT COUNT(*) FROM clan_members WHERE clan_id = cm.clan_id) as member_count
            FROM clan_members cm WHERE user_id = $1
        `;
        const memberInfoRes = await client.query(memberInfoQuery, [user_id]);

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
        } else {
            await client.query('DELETE FROM clan_members WHERE user_id = $1', [user_id]);
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

// --- NEW ENDPOINTS FOR JOIN REQUESTS ---
app.post('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { user_id } = req.user;

    try {
        const memberCheck = await pool.query('SELECT 1 FROM clan_members WHERE user_id = $1', [user_id]);
        if (memberCheck.rowCount > 0) {
            return res.status(409).json({ message: 'You are already in a clan.' });
        }
        
        const query = `
            INSERT INTO clan_join_requests (clan_id, user_id, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (clan_id, user_id) DO NOTHING;
        `;
        await pool.query(query, [clanId, user_id]);
        res.sendStatus(201);
    } catch (err) {
        console.error('[API] Error creating join request:', err);
        res.status(500).json({ message: 'Server error while creating join request.' });
    }
});

app.get('/clans/:id/requests', authenticate, async (req, res) => {
    const { id: clanId } = req.params;
    const { user_id } = req.user;

    try {
        const leaderCheck = await pool.query('SELECT 1 FROM clans WHERE id = $1 AND leader_id = $2', [clanId, user_id]);
        if (leaderCheck.rowCount === 0) {
            return res.status(403).json({ message: 'You are not the leader of this clan.' });
        }

        const query = `
            SELECT
                cjr.id as request_id,
                t.owner_id as user_id,
                t.username,
                t.profile_image_url,
                cjr.requested_at
            FROM clan_join_requests cjr
            JOIN territories t ON cjr.user_id = t.owner_id
            WHERE cjr.clan_id = $1 AND cjr.status = 'pending'
            ORDER BY cjr.requested_at ASC;
        `;
        const result = await pool.query(query, [clanId]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API] Error fetching join requests:', err);
        res.status(500).json({ message: 'Server error while fetching requests.' });
    }
});

app.put('/clans/requests/:requestId', authenticate, async (req, res) => {
    const { requestId } = req.params;
    const { status } = req.body;
    const { user_id: leaderId } = req.user;

    if (!['approved', 'denied'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const requestQuery = `
            SELECT cjr.clan_id, cjr.user_id, c.leader_id
            FROM clan_join_requests cjr
            JOIN clans c ON cjr.clan_id = c.id
            WHERE cjr.id = $1;
        `;
        const requestResult = await client.query(requestQuery, [requestId]);
        if (requestResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Request not found.' });
        }

        const { clan_id, user_id, leader_id } = requestResult.rows[0];
        if (leader_id !== leaderId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'You are not authorized to manage this request.' });
        }

        if (status === 'denied') {
            await client.query('DELETE FROM clan_join_requests WHERE id = $1', [requestId]);
        }
        
        if (status === 'approved') {
            const memberCountRes = await client.query('SELECT COUNT(*) as count FROM clan_members WHERE clan_id = $1', [clan_id]);
            const memberCount = parseInt(memberCountRes.rows[0].count, 10);
            if (memberCount >= 20) {
                 await client.query('ROLLBACK');
                 return res.status(409).json({ message: 'Clan is full.' });
            }
            
            await client.query('INSERT INTO clan_members (clan_id, user_id, role) VALUES ($1, $2, $3)', [clan_id, user_id, 'member']);
            await client.query('DELETE FROM clan_join_requests WHERE id = $1', [requestId]);
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
  
  socket.on('playerJoined', async ({ googleId, name, gameMode }) => {
    if (!googleId || !gameMode) return;
    
    players[socket.id] = { id: socket.id, name, googleId, gameMode, activeTrail: [], lastKnownPosition: null, isDrawing: false };
    console.log(`[SERVER] Player ${socket.id} (${googleId}) joined in [${gameMode}] mode.`);

    try {
        let query;
        if (gameMode === 'clan') {
            query = `
                SELECT 
                    ct.clan_id::text as owner_id,
                    c.name as owner_name,
                    c.clan_image_url as profile_image_url,
                    ST_AsGeoJSON(ct.area) as geojson, 
                    ct.area_sqm 
                FROM clan_territories ct
                JOIN clans c ON ct.clan_id = c.id;
            `;
        } else {
             query = `
                SELECT 
                    owner_id, 
                    username as owner_name, 
                    profile_image_url, 
                    ST_AsGeoJSON(area) as geojson, 
                    area_sqm 
                FROM territories;
             `;
        }

        const result = await pool.query(query);
        const activeTerritories = result.rows
            .filter(row => row.geojson)
            .map(row => ({ 
                ownerId: row.owner_id.toString(), 
                ownerName: row.owner_name, 
                profileImageUrl: row.profile_image_url, 
                geojson: JSON.parse(row.geojson), 
                area: row.area_sqm 
            }));
            
        const playerProfileResult = await pool.query('SELECT 1 FROM territories WHERE owner_id = $1 AND username IS NOT NULL', [googleId]);
        const playerHasRecord = playerProfileResult.rowCount > 0;

        socket.emit('existingTerritories', { 
            territories: activeTerritories, 
            playerHasRecord: playerHasRecord 
        });

    } catch (err) { 
      console.error('[DB] ERROR fetching initial territories:', err);
      socket.emit('existingTerritories', { territories: [], playerHasRecord: false });
    }
  });

  socket.on('claimTerritory', async ({ trail, gameMode }) => {
    const player = players[socket.id];
    if (!player || !player.googleId || !gameMode) return;
    if (!Array.isArray(trail) || trail.length < 3) return;

    player.isDrawing = false;
    player.activeTrail = [];

    const coordinatesString = trail.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newClaimWKT = `POLYGON((${coordinatesString}, ${trail[0].lng} ${trail[0].lat}))`;
    const newClaimGeom = `ST_SetSRID(ST_GeomFromText('${newClaimWKT}'), 4326)`;
    
    const client = await pool.connect();
    try {
        const areaResult = await client.query(`SELECT ST_Area(${newClaimGeom}::geography) as area;`);
        const newArea = areaResult.rows[0].area;
        if (newArea < MINIMUM_CLAIM_AREA_SQM) {
            socket.emit('claimRejected', { reason: 'Area is too small!' });
            return;
        }

        await client.query('BEGIN');
        
        let finalResultQuery, finalResultQueryParams;

        if (gameMode === 'clan') {
            const memberInfo = await client.query('SELECT clan_id FROM clan_members WHERE user_id = $1', [player.googleId]);
            if (memberInfo.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'You are not in a clan.' });
                await client.query('ROLLBACK');
                client.release();
                return;
            }
            const clanId = memberInfo.rows[0].clan_id;

            const upsertQuery = `
                INSERT INTO clan_territories (clan_id, owner_id, area, area_sqm)
                VALUES ($1, $2, ${newClaimGeom}, $3);
            `;
            await client.query(upsertQuery, [clanId, player.googleId, newArea]);

            finalResultQuery = `
                SELECT clan_id::text as owner_id, c.name as owner_name, c.clan_image_url as profile_image_url, ST_AsGeoJSON(area) as geojson, area_sqm 
                FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id WHERE ct.clan_id = $1;
            `;
            finalResultQueryParams = [clanId];
        } else { // Solo mode
            const playerInfoRes = await client.query('SELECT username FROM territories WHERE owner_id = $1', [player.googleId]);
            const currentUsername = playerInfoRes.rows[0]?.username || player.name;
            
            const victimsResult = await client.query(`SELECT owner_id FROM territories WHERE owner_id != $1 AND area IS NOT NULL AND ST_Intersects(area, ${newClaimGeom})`, [player.googleId]);
            const victimIds = victimsResult.rows.map(r => r.owner_id);
            for (const victimId of victimIds) {
                 const smartCutQuery = `
                    WITH rem AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference((SELECT area FROM territories WHERE owner_id = $1), ${newClaimGeom}), 3))).geom AS p), 
                        lg AS (SELECT p FROM rem ORDER BY ST_Area(p) DESC NULLS LAST LIMIT 1) 
                    UPDATE territories SET area = (SELECT p FROM lg), area_sqm = ST_Area((SELECT p FROM lg)::geography) WHERE owner_id = $1 RETURNING area;
                `;
                await client.query(smartCutQuery, [victimId]);
            }

            const upsertQuery = `
                INSERT INTO territories (owner_id, username, area, area_sqm) VALUES ($1, $2, ${newClaimGeom}, $3)
                ON CONFLICT (owner_id) DO UPDATE SET 
                    area = ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3),
                    area_sqm = ST_Area((ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3))::geography);
            `;
            await client.query(upsertQuery, [player.googleId, currentUsername, newArea]);
            
            const updatedOwnerIds = [player.googleId, ...victimIds];
            finalResultQuery = `SELECT owner_id, username as owner_name, profile_image_url, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories WHERE owner_id = ANY($1::varchar[])`;
            finalResultQueryParams = [updatedOwnerIds];
        }
        
        const finalResult = await client.query(finalResultQuery, finalResultQueryParams);
        const batchUpdateData = finalResult.rows
            .map(row => ({ ownerId: row.owner_id.toString(), ownerName: row.owner_name, profileImageUrl: row.profile_image_url, geojson: JSON.parse(row.geojson), area: row.area_sqm }))
            .filter(d => d.geojson != null);

        await client.query('COMMIT');
        if (batchUpdateData.length > 0) io.emit('batchTerritoryUpdate', batchUpdateData);
        io.emit('trailCleared', { id: socket.id });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[DB] FATAL Error during territory claim:', err);
    } finally {
        client.release();
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    io.emit('playerLeft', { id: socket.id });
    if(players[socket.id]) { delete players[socket.id]; }
  });
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