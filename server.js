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
  ssl: {
    rejectUnauthorized: false
  }
});

const players = {}; // In-memory store for LIVE player data

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL,
        area GEOMETRY(POLYGON, 4326) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready.');
  } catch (err) {
    console.error('[DB] Error during database setup:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

app.get('/', (req, res) => {
  res.send('Claimr Server v2.1 (Live Trails) is running!');
});

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  // Player object now needs a place to store their active trail
  players[socket.id] = { id: socket.id, location: null, activeTrail: [] };

  try {
    const result = await pool.query("SELECT id, owner_id, ST_AsGeoJSON(area) as geojson FROM territories");
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      return {
        ownerId: row.owner_id,
        polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] }))
      }
    });
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) {
    console.error('[DB] Error fetching existing territories:', err);
  }

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player) {
      player.location = data;
      player.activeTrail.push(data);

      // --- THE KEY CHANGE ---
      // Instead of just 'playerMoved', we send 'trailUpdated'.
      // It includes the player's ID and their ENTIRE current trail.
      socket.broadcast.emit('trailUpdated', { 
        id: socket.id, 
        trail: player.activeTrail 
      });
    }
  });

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    const trailData = data.trail;
    
    if (!player || !Array.isArray(trailData) || trailData.length < 3) return;
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;

    try {
      const query = "INSERT INTO territories (owner_id, area) VALUES ($1, ST_GeomFromText($2, 4326))";
      await pool.query(query, [socket.id, wkt]);
      
      const newTerritory = { ownerId: socket.id, polygon: trailData };
      io.emit('newTerritoryClaimed', newTerritory);

      // After a successful claim, clear the player's trail on the server.
      const lastPoint = player.activeTrail.length > 0 ? player.activeTrail[player.activeTrail.length - 1] : null;
      player.activeTrail = lastPoint ? [lastPoint] : [];
      
      // Tell other clients to clear THIS player's trail from their screens
      io.emit('trailCleared', { id: socket.id });

    } catch (err) {
      console.error('[DB] Error inserting new territory:', err);
    }
  });

  socket.on('resetAllTerritories', async () => { /* ... */ });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    // Tell other clients to remove this player's trail when they disconnect
    io.emit('trailCleared', { id: socket.id });
    delete players[socket.id];
  });
});

const main = async () => {
  await setupDatabase();
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`));
};
main();