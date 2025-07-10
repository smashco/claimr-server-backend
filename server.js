// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Function to set up the database
const setupDatabase = async () => {
  const client = await pool.connect(); // Get a client from the pool
  try {
    // *** THE CRITICAL FIX: ENABLE THE POSTGIS EXTENSION ***
    // This command activates all the special mapping functions like GEOMETRY and ST_GeomFromText.
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');

    // Now, create the table
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
  } finally {
    client.release(); // IMPORTANT: Release the client back to the pool
  }
};

app.get('/', (req, res) => {
  res.send('Claimr Server v1.6 (PostGIS Enabled) is running!');
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

  socket.on('claimTerritory', async (trailData) => {
    if (!trailData || trailData.length < 3) return;
    
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
      // It's safer to use TRUNCATE to reset the table and its primary key sequence
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

server.listen(PORT, async () => {
  // Run the setup function when the server starts.
  await setupDatabase();
  console.log(`Server listening on *:${PORT}`);
});