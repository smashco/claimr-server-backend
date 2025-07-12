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

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    // Drop the old table to add the UNIQUE constraint. This will wipe existing data.
    // For production, a more careful ALTER TABLE would be used.
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
        // Use a more specific event for client-side clearing
        io.emit('allTerritoriesCleared'); 
        console.log('[ADMIN] All territories have been reset.');
        res.status(200).send('SUCCESS: All claimed territories have been deleted.');
    } catch (err) {
        console.error('[ADMIN] Error clearing territories:', err);
        res.status(500).send('ERROR clearing territories.');
    }
});

app.get('/', (req, res) => { res.send('Claimr Server - Expansion/Merge Logic is running!'); });

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    players[socket.id] = { id: socket.id, name: data.name || 'Anonymous', activeTrail: [] };
    console.log(`[SERVER] Player ${socket.id} has joined as "${players[socket.id].name}".`);
  });

  // Send all territories to the newly connected player
  try {
    const result = await pool.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      // PostGIS polygons have an outer ring and inner rings (for holes). We only need the outer one.
      return { ownerId: row.owner_id, ownerName: row.owner_name, polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })), area: row.area_sqm };
    });
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) { console.error('[DB] ERROR fetching territories:', err); }

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player) {
      // Broadcast trail updates for other players to see
      socket.broadcast.emit('trailUpdated', { id: socket.id, name: player.name, trail: [data] });
    }
  });

  // --- *** REWRITTEN 'claimTerritory' with MERGE LOGIC *** ---
  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    const trailData = data ? data.trail : undefined;
    if (!player || !Array.isArray(trailData) || trailData.length < 3) {
        console.log('[SERVER] Invalid claim attempt received.');
        return;
    }
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const newPolygonWKT = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingTerritoryResult = await client.query("SELECT area FROM territories WHERE owner_id = $1", [socket.id]);
      
      if (existingTerritoryResult.rows.length > 0) {
        // --- MERGE LOGIC (UPDATE) ---
        console.log(`[DB] Merging territory for ${socket.id}`);
        const updateQuery = `
          UPDATE territories
          SET 
            area = ST_Union(area, ST_GeomFromText($1, 4326)),
            area_sqm = ST_Area(ST_Union(area, ST_GeomFromText($1, 4326))::geography)
          WHERE owner_id = $2;
        `;
        await client.query(updateQuery, [newPolygonWKT, socket.id]);
      } else {
        // --- NEW CLAIM LOGIC (INSERT) ---
        console.log(`[DB] Inserting new territory for ${socket.id}`);
        const insertQuery = `
          INSERT INTO territories (owner_id, owner_name, area, area_sqm)
          VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography))
        `;
        await client.query(insertQuery, [socket.id, player.name, newPolygonWKT]);
      }
      
      // After insert or update, fetch the final territory to send to all clients
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

      // *** THIS IS THE CRUCIAL EVENT THE CLIENT IS WAITING FOR ***
      io.emit('territoryUpdated', { ownerId: socket.id, territoryData: updatedTerritoryData });
      console.log(`[SERVER] Sent 'territoryUpdated' for ${socket.id}. Area: ${updatedTerritoryData.area} sqm.`);

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
        delete players[socket.id];
    }
  });
});

const main = async () => { 
  await setupDatabase(); 
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); 
};
main();