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

app.get('/', (req, res) => {
  res.send('Claimr Server v1.8 (Argument Fix) is running!');
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
    console.log(`[SERVER] Sending ${existingTerritories.length} existing territories to ${socket.id}.`);
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) {
    console.error('[DB] Error fetching existing territories:', err);
  }

  // --- FIX: ROBUST ARGUMENT HANDLING FOR THE 'claimTerritory' EVENT ---
  socket.on('claimTerritory', async (...args) => {
    // Socket.IO events can sometimes wrap arguments. We find the array.
    const trailData = args.find(arg => Array.isArray(arg));

    console.log(`[SERVER] Received 'claimTerritory' from ${socket.id}.`);
    
    // Check if we successfully found an array.
    if (!trailData || trailData.length < 3) {
      console.error('[SERVER] ERROR: Invalid or empty trailData received.', args);
      return;
    }
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;

    try {
      const query = "INSERT INTO territories (owner_id, area) VALUES ($1, ST_GeomFromText($2, 4326))";
      await pool.query(query, [socket.id, wkt]);
      console.log(`[DB] Successfully inserted new territory for ${socket.id}.`);
      
      const newTerritory = {
        ownerId: socket.id,
        polygon: trailData,
      };
      io.emit('newTerritoryClaimed', newTerritory);
    } catch (err) {
      console.error('[DB] Error inserting new territory:', err);
    }
  });

  socket.on('resetAllTerritories', async () => {
    console.log(`[SERVER] Received 'resetAllTerritories'. Clearing database table.`);
    try {
      await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;");
      console.log('[DB] "territories" table cleared.');
      io.emit('clearAllTerritories');
    } catch (err) {
      console.error('[DB] Error clearing territories table:', err);
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