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

// --- *** NEW: INTERSECTION HELPER FUNCTIONS *** ---

// Given three collinear points p, q, r, the function checks if 
// point q lies on line segment 'pr' 
function onSegment(p, q, r) { 
	if (q.lat <= Math.max(p.lat, r.lat) && q.lat >= Math.min(p.lat, r.lat) && 
		q.lng <= Math.max(p.lng, r.lng) && q.lng >= Math.min(p.lng, r.lng)) 
	{ 
		return true; 
	} 
	return false; 
} 

// To find orientation of ordered triplet (p, q, r). 
// 0 --> p, q and r are collinear 
// 1 --> Clockwise 
// 2 --> Counterclockwise 
function orientation(p, q, r) { 
	const val = (q.lng - p.lng) * (r.lat - q.lat) - (q.lat - p.lat) * (r.lng - q.lng); 
	if (val == 0) return 0; // Collinear 
	return (val > 0) ? 1 : 2; // Clock or Counterclock wise 
} 

// The main function that returns true if line segment 'p1q1' 
// and 'p2q2' intersect. 
function linesIntersect(p1, q1, p2, q2) { 
	const o1 = orientation(p1, q1, p2); 
	const o2 = orientation(p1, q1, q2); 
	const o3 = orientation(p2, q2, p1); 
	const o4 = orientation(p2, q2, q1); 

	if (o1 != o2 && o3 != o4) return true; 

	// Special Cases for collinear points
	if (o1 == 0 && onSegment(p1, p2, q1)) return true; 
	if (o2 == 0 && onSegment(p1, q2, q1)) return true; 
	if (o3 == 0 && onSegment(p2, p1, q2)) return true; 
	if (o4 == 0 && onSegment(p2, q1, q2)) return true; 

	return false; 
}

// --- *** END NEW HELPER FUNCTIONS *** ---


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
        owner_id VARCHAR(255) NOT NULL UNIQUE, -- Ensures one territory row per player
        owner_name VARCHAR(255), 
        area GEOMETRY(POLYGON, 4326) NOT NULL,
        area_sqm REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready with UNIQUE owner_id constraint.');
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

app.get('/', (req, res) => { res.send('Claimr Server - Combat & Merge Logic is running!'); });

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    players[socket.id] = { id: socket.id, name: data.name || 'Anonymous', activeTrail: [] };
    console.log(`[SERVER] Player ${socket.id} has joined as "${players[socket.id].name}".`);
  });

  try {
    const result = await pool.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      return { ownerId: row.owner_id, ownerName: row.owner_name, polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })), area: row.area_sqm };
    });
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) { console.error('[DB] ERROR fetching territories:', err); }

  // --- *** MODIFIED locationUpdate to handle combat *** ---
  socket.on('locationUpdate', (data) => {
    const currentPlayer = players[socket.id];
    if (!currentPlayer) return;

    const newPoint = data;
    const lastPoint = currentPlayer.activeTrail.length > 0 
        ? currentPlayer.activeTrail[currentPlayer.activeTrail.length - 1] 
        : null;

    // Add new point to the current player's trail on the server
    currentPlayer.activeTrail.push(newPoint);

    // Broadcast the updated trail for drawing on other clients
    socket.broadcast.emit('trailUpdated', { id: socket.id, name: currentPlayer.name, trail: currentPlayer.activeTrail });

    // --- COMBAT LOGIC ---
    if (lastPoint) {
        // Iterate over all players to check for intersections
        for (const targetPlayerId in players) {
            // Don't check against self
            if (targetPlayerId === socket.id) continue;

            const targetPlayer = players[targetPlayerId];
            if (!targetPlayer) continue;

            // Target must have a trail of at least 2 points to form a line segment
            if (targetPlayer.activeTrail.length < 2) continue;

            // Check against each segment of the target's trail
            for (let i = 0; i < targetPlayer.activeTrail.length - 1; i++) {
                const p1 = targetPlayer.activeTrail[i];
                const p2 = targetPlayer.activeTrail[i+1];

                if (linesIntersect(lastPoint, newPoint, p1, p2)) {
                    console.log(`[COMBAT] ${currentPlayer.name} CUT ${targetPlayer.name}!`);

                    // Notify the player who was cut
                    io.to(targetPlayerId).emit('youWereCut', { by: currentPlayer.name });
                    
                    // Notify the player who did the cutting
                    socket.emit('youCutPlayer', { name: targetPlayer.name });

                    // Clear the target's trail for everyone
                    io.emit('trailCleared', { id: targetPlayerId });

                    // Reset the target's trail on the server
                    targetPlayer.activeTrail = [];

                    // Stop checking once a cut is found
                    return; 
                }
            }
        }
    }
  });

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    const trailData = data ? data.trail : undefined;
    if (!player || !Array.isArray(trailData) || trailData.length < 3) {
        return;
    }
    
    // After a claim, the trail is no longer active for combat
    player.activeTrail = [];
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newPolygonWKT = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingTerritoryResult = await client.query("SELECT area FROM territories WHERE owner_id = $1", [socket.id]);
      
      if (existingTerritoryResult.rows.length > 0) {
        console.log(`[DB] Merging territory for ${socket.id}`);
        const updateQuery = `
          UPDATE territories
          SET 
            area = ST_MakeValid(ST_Union(area, ST_GeomFromText($1, 4326))),
            area_sqm = ST_Area(ST_MakeValid(ST_Union(area, ST_GeomFromText($1, 4326)))::geography)
          WHERE owner_id = $2;
        `;
        await client.query(updateQuery, [newPolygonWKT, socket.id]);
      } else {
        console.log(`[DB] Inserting new territory for ${socket.id}`);
        const insertQuery = `
          INSERT INTO territories (owner_id, owner_name, area, area_sqm)
          VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography))
        `;
        await client.query(insertQuery, [socket.id, player.name, newPolygonWKT]);
      }
      
      const finalResult = await client.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories WHERE owner_id = $1", [socket.id]);
      await client.query('COMMIT');

      const row = finalResult.rows[0];
      const polygonData = JSON.parse(row.geojson);
      const updatedTerritoryData = { 
        ownerId: row.owner_id, 
        ownerName: row.owner_name,
        polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })), 
        area: row.area_sqm
      };

      io.emit('territoryUpdated', { ownerId: socket.id, territoryData: updatedTerritoryData });
      io.emit('trailCleared', { id: socket.id });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[DB] FATAL Error claiming/merging territory:', err);
    } finally {
        client.release();
    }
  });

  socket.on('deleteMyTerritories', async () => {
    console.log(`[SERVER] Received 'deleteMyTerritories' from ${socket.id}.`);
    try {
      await pool.query("DELETE FROM territories WHERE owner_id = $1", [socket.id]);
      console.log(`[DB] Deleted territories for owner_id: ${socket.id}.`);
      io.emit('playerTerritoriesCleared', { ownerId: socket.id });
    } catch (err) {
      console.error('[DB] Error deleting player territories:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    io.emit('playerLeft', { id: socket.id });
    if(players[socket.id]) {
        // Ensure their trail is removed for everyone
        io.emit('trailCleared', { id: socket.id });
        delete players[socket.id];
    }
  });
});

const main = async () => { 
  await setupDatabase(); 
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); 
};
main();