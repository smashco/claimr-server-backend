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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const players = {}; 

// --- INTERSECTION HELPER FUNCTIONS (Unchanged) ---
function onSegment(p, q, r) { 
	if (q.lat <= Math.max(p.lat, r.lat) && q.lat >= Math.min(p.lat, r.lat) && 
		q.lng <= Math.max(p.lng, r.lng) && q.lng >= Math.min(p.lng, r.lng)) 
	{ 
		return true; 
	} 
	return false; 
} 
function orientation(p, q, r) { 
	const val = (q.lng - p.lng) * (r.lat - q.lat) - (q.lat - p.lat) * (r.lng - q.lng); 
	if (val == 0) return 0;
	return (val > 0) ? 1 : 2;
} 
function linesIntersect(p1, q1, p2, q2) { 
	const o1 = orientation(p1, q1, p2); 
	const o2 = orientation(p1, q1, q2); 
	const o3 = orientation(p2, q2, p1); 
	const o4 = orientation(p2, q2, q1); 
	if (o1 != o2 && o3 != o4) return true; 
	if (o1 == 0 && onSegment(p1, p2, q1)) return true; 
	if (o2 == 0 && onSegment(p1, q2, q1)) return true; 
	if (o3 == 0 && onSegment(p2, p1, q2)) return true; 
	if (o4 == 0 && onSegment(p2, q1, q2)) return true; 
	return false; 
}
// --- END HELPER FUNCTIONS ---

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    await client.query('DROP TABLE IF EXISTS territories;');
    console.log('[DB] Dropped old "territories" table for schema update.');

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL UNIQUE, 
        owner_name VARCHAR(255), 
        area GEOMETRY(GEOMETRY, 4326) NOT NULL, -- Use GEOMETRY to allow for MultiPolygons
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

app.get('/admin/reset-all', async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;");
        io.emit('allTerritoriesCleared'); 
        console.log('[ADMIN] All territories have been reset.');
        res.status(200).send('SUCCESS: All claimed territories have been deleted.');
    } catch (err) {
        console.error('[ADMIN] Error clearing territories:', err);
        res.status(500).send('ERROR clearing territories.');
    }
});

app.get('/', (req, res) => { res.send('Claimr Server - Full Gameplay Logic is running!'); });

// --- *** NEW: Function to broadcast all player data *** ---
function broadcastAllPlayers() {
    const allPlayersData = Object.values(players).map(p => ({
        id: p.id,
        name: p.name,
        lastKnownPosition: p.lastKnownPosition
    }));
    io.emit('allPlayersUpdate', allPlayersData);
}

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    players[socket.id] = { id: socket.id, name: data.name || 'Anonymous', activeTrail: [], lastKnownPosition: null };
    console.log(`[SERVER] Player ${socket.id} has joined as "${players[socket.id].name}".`);
    // Tell everyone a new player has joined (including sending their own info back)
    broadcastAllPlayers();
  });

  try {
    const result = await pool.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
    const existingTerritories = result.rows.map(row => {
      return { 
        ownerId: row.owner_id, 
        ownerName: row.owner_name, 
        geojson: JSON.parse(row.geojson), // Send full GeoJSON
        area: row.area_sqm 
      };
    });
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) { console.error('[DB] ERROR fetching territories:', err); }

  socket.on('locationUpdate', (data) => {
    const currentPlayer = players[socket.id];
    if (!currentPlayer) return;

    // --- *** MODIFIED: Update position and broadcast *** ---
    currentPlayer.lastKnownPosition = data;
    broadcastAllPlayers(); // Let everyone know the new position

    const lastPoint = currentPlayer.activeTrail.length > 0 ? currentPlayer.activeTrail[currentPlayer.activeTrail.length - 1] : null;

    // Only add to trail if drawing, otherwise it's just a position update
    if (currentPlayer.isDrawing) {
        currentPlayer.activeTrail.push(data);
        socket.broadcast.emit('trailUpdated', { id: socket.id, name: currentPlayer.name, trail: currentPlayer.activeTrail });
    }
    
    // Trail-cutting combat logic
    if (lastPoint && currentPlayer.isDrawing) {
        for (const targetPlayerId in players) {
            if (targetPlayerId === socket.id) continue;
            const targetPlayer = players[targetPlayerId];
            if (!targetPlayer || !targetPlayer.isDrawing || targetPlayer.activeTrail.length < 2) continue;
            for (let i = 0; i < targetPlayer.activeTrail.length - 1; i++) {
                const p1 = targetPlayer.activeTrail[i];
                const p2 = targetPlayer.activeTrail[i+1];
                if (linesIntersect(lastPoint, data, p1, p2)) {
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

  // New events to manage when a trail starts and stops
  socket.on('startDrawingTrail', () => {
    if(players[socket.id]) {
      players[socket.id].isDrawing = true;
      players[socket.id].activeTrail = []; // Reset trail on start
    }
  });

  socket.on('stopDrawingTrail', () => {
    if(players[socket.id]) {
      players[socket.id].isDrawing = false;
      players[socket.id].activeTrail = [];
      io.emit('trailCleared', { id: socket.id });
    }
  });

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    const trailData = data ? data.trail : undefined;
    if (!player || !Array.isArray(trailData) || trailData.length < 3) return;
    
    player.isDrawing = false;
    player.activeTrail = [];

    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newClaimWKT = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const victimsResult = await client.query(
        "SELECT owner_id FROM territories WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromText($2, 4326))",
        [socket.id, newClaimWKT]
      );
      const victimIds = victimsResult.rows.map(r => r.owner_id);
      let updatedOwnerIds = [socket.id, ...victimIds];

      for (const victimId of victimIds) {
        console.log(`[COMBAT] Claim by ${socket.id} is cutting territory of ${victimId}`);
        const cutQuery = `
            UPDATE territories
            SET 
              area = ST_CollectionExtract(ST_Difference(area, ST_GeomFromText($1, 4326)), 3),
              area_sqm = ST_Area(ST_CollectionExtract(ST_Difference(area, ST_GeomFromText($1, 4326)), 3)::geography)
            WHERE owner_id = $2;
        `;
        await client.query(cutQuery, [newClaimWKT, victimId]);
      }

      const unionQuery = `
        UPDATE territories
        SET 
          area = ST_CollectionExtract(ST_Union(area, ST_GeomFromText($1, 4326)), 3),
          area_sqm = ST_Area(ST_CollectionExtract(ST_Union(area, ST_GeomFromText($1, 4326)), 3)::geography)
        WHERE owner_id = $2
        RETURNING id;
      `;
      const unionResult = await client.query(unionQuery, [newClaimWKT, socket.id]);

      if (unionResult.rowCount === 0) {
        const insertQuery = `
          INSERT INTO territories (owner_id, owner_name, area, area_sqm)
          VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography))
        `;
        await client.query(insertQuery, [socket.id, player.name, newClaimWKT]);
      }
      
      const finalResultQuery = `
        SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm 
        FROM territories 
        WHERE owner_id = ANY($1::varchar[])
      `;
      const finalResult = await client.query(finalResultQuery, [updatedOwnerIds]);
      
      // --- *** MODIFIED: Send full GeoJSON for MultiPolygon support *** ---
      const batchUpdateData = finalResult.rows.map(row => {
          return {
              ownerId: row.owner_id, 
              ownerName: row.owner_name,
              geojson: JSON.parse(row.geojson),
              area: row.area_sqm
          };
      }).filter(d => d.geojson != null);

      await client.query('COMMIT');
      
      io.emit('batchTerritoryUpdate', batchUpdateData);
      console.log(`[SERVER] Sent 'batchTerritoryUpdate' for players: ${updatedOwnerIds.join(', ')}`);
      io.emit('trailCleared', { id: socket.id });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[DB] FATAL Error during territory cut/claim:', err);
    } finally {
        client.release();
    }
  });

  socket.on('deleteMyTerritories', async () => {
    // unchanged
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    io.emit('playerLeft', { id: socket.id });
    if(players[socket.id]) {
        delete players[socket.id];
    }
    // Tell everyone the player has left
    broadcastAllPlayers();
  });
});

const main = async () => { 
  await setupDatabase(); 
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); 
};
main();