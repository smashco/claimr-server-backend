// claimr_server/server.js

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 10000;
const SERVER_TICK_RATE_MS = 100;
const MINIMUM_CLAIM_AREA_SQM = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// In-memory object to track live player data by their temporary socket.id
const players = {}; 

// --- INTERSECTION HELPER FUNCTIONS (No changes needed) ---
function onSegment(p, q, r) { if (q.lat <= Math.max(p.lat, r.lat) && q.lat >= Math.min(p.lat, r.lat) && q.lng <= Math.max(p.lng, r.lng) && q.lng >= Math.min(p.lng, r.lng)) { return true; } return false; } 
function orientation(p, q, r) { const val = (q.lng - p.lng) * (r.lat - q.lat) - (q.lat - p.lat) * (r.lng - q.lng); if (val == 0) return 0; return (val > 0) ? 1 : 2;} 
function linesIntersect(p1, q1, p2, q2) { const o1 = orientation(p1, q1, p2); const o2 = orientation(p1, q1, q2); const o3 = orientation(p2, q2, p1); const o4 = orientation(p2, q2, q1); if (o1 != o2 && o3 != o4) return true; if (o1 == 0 && onSegment(p1, p2, q1)) return true; if (o2 == 0 && onSegment(p1, q2, q1)) return true; if (o3 == 0 && onSegment(p2, p1, q2)) return true; if (o4 == 0 && onSegment(p2, q1, q2)) return true; return false; }
// --- END HELPER FUNCTIONS ---

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    // For development: drop the table to ensure the schema is up-to-date.
    // In production, you would use migration scripts.
    await client.query('DROP TABLE IF EXISTS territories;');
    console.log('[DB] Dropped old "territories" table for schema update.');

    // Area is NULLABLE to allow for players who exist but have no land.
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE, 
        owner_name VARCHAR(255), 
        area GEOMETRY(GEOMETRY, 4326),
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready.');
  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

// --- HTTP Routes (Unchanged) ---
app.get('/leaderboard', async (req, res) => { try { const query = `SELECT owner_name, area_sqm, RANK() OVER (ORDER BY area_sqm DESC) as rank FROM territories WHERE area_sqm > 0 ORDER BY area_sqm DESC LIMIT 100;`; const result = await pool.query(query); res.status(200).json(result.rows); } catch (err) { console.error('[API] Error fetching leaderboard:', err); res.status(500).json({ error: 'Failed to fetch leaderboard' }); }});
app.get('/admin/reset-all', async (req, res) => { try { await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;"); io.emit('allTerritoriesCleared'); console.log('[ADMIN] All territories have been reset.'); res.status(200).send('SUCCESS: All claimed territories have been deleted.'); } catch (err) { console.error('[ADMIN] Error clearing territories:', err); res.status(500).send('ERROR clearing territories.'); }});
app.get('/', (req, res) => { res.send('Claimr Server - STABLE is running!'); });

function broadcastAllPlayers() {
    const allPlayersData = Object.values(players).map(p => ({
        id: p.id, // The temporary socket.id for visuals
        name: p.name,
        lastKnownPosition: p.lastKnownPosition
    }));
    io.emit('allPlayersUpdate', allPlayersData);
}

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  // CRITICAL: Player identity is now established here using a persistent ID.
  socket.on('playerJoined', async (data) => {
    if (!data || !data.googleId) {
      console.error(`[ERROR] Player ${socket.id} joined without a Google ID.`);
      return;
    }
    
    players[socket.id] = { 
        id: socket.id, 
        name: data.name || 'Anonymous', 
        googleId: data.googleId, // Store the stable Google ID.
        activeTrail: [], 
        lastKnownPosition: null, 
        isDrawing: false 
    };
    console.log(`[SERVER] Player ${socket.id} (${data.googleId}) has joined as "${players[socket.id].name}".`);

    // The initial state check is now done *after* we know the player's real identity.
    try {
        const result = await pool.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
        
        const activeTerritories = result.rows
            .filter(row => row.geojson) // Only include territories with a valid area.
            .map(row => ({ 
                ownerId: row.owner_id, 
                ownerName: row.owner_name, 
                geojson: JSON.parse(row.geojson),
                area: row.area_sqm 
            }));

        // Use the correct, stable Google ID to check if a record exists.
        const playerHasRecord = result.rows.some(row => row.owner_id === data.googleId);

        socket.emit('existingTerritories', {
            territories: activeTerritories,
            playerHasRecord: playerHasRecord
        });
    } catch (err) { console.error('[DB] ERROR fetching initial territories:', err); }
  });

  socket.on('locationUpdate', (data) => {
    const currentPlayer = players[socket.id];
    if (!currentPlayer) return;
    const lastPoint = currentPlayer.lastKnownPosition;
    currentPlayer.lastKnownPosition = data;
    if (currentPlayer.isDrawing) {
        currentPlayer.activeTrail.push(data);
        socket.broadcast.emit('trailPointAdded', { id: socket.id, point: data });
    }
    if (lastPoint && currentPlayer.isDrawing) {
        for (const targetPlayerId in players) {
            if (targetPlayerId === socket.id) continue;
            const targetPlayer = players[targetPlayerId];
            if (!targetPlayer || !targetPlayer.isDrawing || targetPlayer.activeTrail.length < 2) continue;
            for (let i = 0; i < targetPlayer.activeTrail.length - 1; i++) {
                if (linesIntersect(lastPoint, data, targetPlayer.activeTrail[i], targetPlayer.activeTrail[i+1])) {
                    console.log(`[COMBAT] ${currentPlayer.name} CUT ${targetPlayer.name}!`);
                    io.to(targetPlayerId).emit('youWereCut', { by: currentPlayer.name });
                    socket.emit('youCutPlayer', { name: targetPlayer.name });
                    io.emit('trailCleared', { id: targetPlayerId });
                    targetPlayer.activeTrail = [];
                    targetPlayer.isDrawing = false;
                    return; 
                }
            }
        }
    }
  });

  socket.on('startDrawingTrail', () => { if(players[socket.id]) { players[socket.id].isDrawing = true; players[socket.id].activeTrail = []; socket.broadcast.emit('trailStarted', { id: socket.id }); }});
  socket.on('stopDrawingTrail', () => { if(players[socket.id]) { players[socket.id].isDrawing = false; players[socket.id].activeTrail = []; io.emit('trailCleared', { id: socket.id }); }});

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    if (!player || !player.googleId) return; // Must have Google ID to claim.

    const trailData = data ? data.trail : undefined;
    if (!Array.isArray(trailData) || trailData.length < 3) return;
    
    player.isDrawing = false;
    player.activeTrail = [];

    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newClaimWKT = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    const client = await pool.connect();
    try {
      const areaResult = await client.query(`SELECT ST_Area(ST_GeomFromText($1, 4326)::geography) as area;`, [newClaimWKT]);
      const newArea = areaResult.rows[0].area;
      
      if (newArea < MINIMUM_CLAIM_AREA_SQM) {
        socket.emit('claimRejected', { reason: 'Area is too small. Think bigger!' });
        return;
      }
      
      await client.query('BEGIN');

      // Use the stable Google ID to find victims.
      const victimsResult = await client.query("SELECT owner_id FROM territories WHERE owner_id != $1 AND area IS NOT NULL AND ST_Intersects(area, ST_GeomFromText($2, 4326))", [player.googleId, newClaimWKT]);
      const victimIds = victimsResult.rows.map(r => r.owner_id);
      let updatedOwnerIds = [player.googleId, ...victimIds];

      for (const victimId of victimIds) {
        const smartCutQuery = `WITH rem AS (SELECT (ST_Dump(ST_CollectionExtract(ST_Difference((SELECT area FROM territories WHERE owner_id = $2),ST_GeomFromText($1, 4326)), 3))).geom AS p), lg AS (SELECT p FROM rem ORDER BY ST_Area(p) DESC NULLS LAST LIMIT 1) UPDATE territories SET area = (SELECT p FROM lg), area_sqm = ST_Area((SELECT p FROM lg)::geography) WHERE owner_id = $2 RETURNING area;`;
        const cutResult = await client.query(smartCutQuery, [newClaimWKT, victimId]);
        
        if (cutResult.rowCount === 0 || cutResult.rows[0].area === null) {
            console.log(`[COMBAT] ${victimId} lost all territory. Inactivating.`);
            await client.query('UPDATE territories SET area = NULL, area_sqm = NULL WHERE owner_id = $1', [victimId]);
            io.emit('playerTerritoriesCleared', { ownerId: victimId });
        }
      }

      // Use a single, atomic UPSERT query with the stable Google ID.
      const upsertQuery = `INSERT INTO territories (owner_id, owner_name, area, area_sqm) VALUES ($1, $2, ST_GeomFromText($3, 4326), $4) ON CONFLICT (owner_id) DO UPDATE SET area = ST_CollectionExtract(ST_Union(territories.area, ST_GeomFromText($3, 4326)), 3), area_sqm = ST_Area(ST_CollectionExtract(ST_Union(territories.area, ST_GeomFromText($3, 4326)), 3)::geography), owner_name = $2;`;
      await client.query(upsertQuery, [player.googleId, player.name, newClaimWKT, newArea]);
      
      const finalResult = await client.query(`SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories WHERE owner_id = ANY($1::varchar[])`, [updatedOwnerIds]);
      const batchUpdateData = finalResult.rows.map(row => ({ ownerId: row.owner_id, ownerName: row.owner_name, geojson: JSON.parse(row.geojson), area: row.area_sqm })).filter(d => d.geojson != null);

      await client.query('COMMIT');
      
      if(batchUpdateData.length > 0) io.emit('batchTerritoryUpdate', batchUpdateData);
      io.emit('trailCleared', { id: socket.id });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[DB] FATAL Error during territory cut/claim:', err);
    } finally {
        client.release();
    }
  });

  // Use the stable Google ID to inactivate the player's territory.
  socket.on('deleteMyTerritories', async () => {
    const player = players[socket.id];
    if (!player || !player.googleId) return;

    console.log(`[SERVER] Received 'deleteMyTerritories' from ${player.googleId}.`);
    try {
      await pool.query("UPDATE territories SET area = NULL, area_sqm = NULL WHERE owner_id = $1", [player.googleId]);
      console.log(`[DB] Inactivated territories for owner_id: ${player.googleId}.`);
      io.emit('playerTerritoriesCleared', { ownerId: player.googleId });
    } catch (err) {
      console.error('[DB] Error inactivating player territories:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    io.emit('playerLeft', { id: socket.id });
    if(players[socket.id]) {
        delete players[socket.id];
    }
  });
});

setInterval(() => {
    broadcastAllPlayers();
}, SERVER_TICK_RATE_MS);

const main = async () => { 
  await setupDatabase(); 
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); 
};
main();