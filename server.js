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

// --- THIS IS THE KEY ADDITION ---
// A "secret" admin route to clear the database.
app.get('/admin/reset-all', async (req, res) => {
  console.log('[ADMIN] Received request to /admin/reset-all. Clearing all territories.');
  try {
    // 1. Wipe the database table clean.
    await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;");
    console.log('[DB] "territories" table cleared via admin route.');
    
    // 2. Tell all connected clients to clear their maps.
    io.emit('clearAllTerritories');
    
    // 3. Send a success message back to the browser.
    res.status(200).send('SUCCESS: All claimed territories have been deleted from the database. You can now restart your app.');
  } catch (err) {
    console.error('[ADMIN] Error clearing territories table:', err);
    res.status(500).send('ERROR: An error occurred while clearing territories. Check the server logs.');
  }
});

app.get('/', (req, res) => {
  res.send('Claimr Server v2.4 (Admin Reset Added) is running!');
});

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
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

  socket.on('claimTerritory', async (data) => {
    const trailData = data.trail;
    if (!Array.isArray(trailData) || trailData.length < 3) return;
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    try {
      const query = "INSERT INTO territories (owner_id, area) VALUES ($1, ST_GeomFromText($2, 4326))";
      await pool.query(query, [socket.id, wkt]);
      const newTerritory = { ownerId: socket.id, polygon: trailData, };
      io.emit('newTerritoryClaimed', newTerritory);
    } catch (err) {
      console.error('[DB] Error inserting new territory:', err);
    }
  });

  socket.on('deleteMyTerritories', async () => {
    console.log(`[SERVER] Received 'deleteMyTerritories' from ${socket.id}.`);
    try {
      const query = "DELETE FROM territories WHERE owner_id = $1";
      await pool.query(query, [socket.id]);
      console.log(`[DB] Deleted territories for owner_id: ${socket.id}.`);
      io.emit('playerTerritoriesCleared', { ownerId: socket.id });
    } catch (err) {
      console.error('[DB] Error deleting player territories:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
  });
});

const main = async () => {
  await setupDatabase();
  server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
  });
};

main();