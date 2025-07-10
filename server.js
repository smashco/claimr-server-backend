// claimr_server/server.js - NUKE AND PAVE VERSION

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
  ssl: {
    rejectUnauthorized: false
  }
});

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    // --- THIS IS THE NUKE AND PAVE FIX ---
    // 1. Drop the old, incorrect table. This will run ONCE.
    await client.query('DROP TABLE IF EXISTS territories;');
    console.log('[DB] Dropped old "territories" table to ensure clean schema.');
    
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    // 2. Create the new, correct table with the owner_name column.
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL,
        owner_name VARCHAR(255), 
        area GEOMETRY(POLYGON, 4326) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready with CORRECT schema.');
  } catch (err) {
    console.error('[DB] FATAL ERROR during database setup:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

// ... All other code (app.get, io.on, etc.) remains the same as my previous "Maximum Debugging" version.
// Just copy the whole setupDatabase function above. The rest of the file is fine.
app.get('/', (req, res) => {
  res.send('Claimr Server v4.0 (Nuked and Paved) is running!');
});

const players = {};

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    const playerName = data.name || 'Anonymous';
    players[socket.id] = { 
      id: socket.id, 
      name: playerName,
    };
    console.log(`[SERVER] Player ${socket.id} has joined as "${playerName}".`);
  });

  try {
    const result = await pool.query("SELECT id, owner_id, owner_name, ST_AsGeoJSON(area) as geojson FROM territories");
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      return {
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] }))
      }
    });
    console.log(`[SERVER] Sending ${existingTerritories.length} existing territories to ${socket.id}.`);
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) {
    console.error('[DB] ERROR fetching existing territories:', err);
  }

  socket.on('claimTerritory', async (data) => {
    console.log(`\n--- [DEBUG] Received 'claimTerritory' from ${socket.id} ---`);
    
    const player = players[socket.id];
    const trailData = data ? data.trail : undefined;
    
    if (!player) {
      console.error('[DEBUG] FAILED: Player object not found for this socket ID.');
      return;
    }
    if (!Array.isArray(trailData) || trailData.length < 3) {
      console.error('[DEBUG] FAILED: Received data is not a valid trail array. Data received:', data);
      return;
    }
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    console.log(`[DEBUG] Generated WKT for database: ${wkt}`);

    try {
      const query = "INSERT INTO territories (owner_id, owner_name, area) VALUES ($1, $2, ST_GeomFromText($3, 4326))";
      const values = [socket.id, player.name, wkt];
      
      console.log('[DEBUG] Attempting to execute INSERT query...');
      await pool.query(query, values);
      console.log('[DEBUG] SUCCESS: Database INSERT completed.');
      
      const newTerritory = { 
        ownerId: socket.id, 
        ownerName: player.name,
        polygon: trailData, 
      };
      io.emit('newTerritoryClaimed', newTerritory);
      console.log('[DEBUG] Broadcast "newTerritoryClaimed" to all clients.');

    } catch (err) {
      console.error('--- [DEBUG] DATABASE INSERT FAILED! ---');
      console.error('The error is:', err);
      console.error('--- END OF DATABASE ERROR ---');
    }
    console.log('--- [DEBUG] Finished processing "claimTerritory" ---\n');
  });

  socket.on('deleteMyTerritories', async () => { /* no changes here */ });
  socket.on('disconnect', () => { /* no changes here */ });
});

const main = async () => {
  await setupDatabase();
  server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
  });
};

main();