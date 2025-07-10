// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg'); // <-- Import the pg Pool

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION SETUP ---
// It will automatically use the DATABASE_URL environment variable on Render.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Render database connections
  }
});

// Function to create the territories table if it doesn't exist
const createTable = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS territories (
      id SERIAL PRIMARY KEY,
      owner_id VARCHAR(255) NOT NULL,
      area GEOMETRY(POLYGON, 4326) NOT NULL, -- This is the special PostGIS data type
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(query);
    console.log('[DB] "territories" table is ready.');
  } catch (err) {
    console.error('[DB] Error creating table:', err);
  }
};

app.get('/', (req, res) => {
  res.send('Claimr Server v1.5 (Database Connected) is running!');
});

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  // --- DATABASE LOGIC: Send existing territories ---
  try {
    // ST_AsGeoJSON converts the geometry data into a format we can send to the client.
    const result = await pool.query("SELECT id, owner_id, ST_AsGeoJSON(area) as geojson FROM territories");
    
    // We need to parse the geojson string back into an object
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      return {
        ownerId: row.owner_id,
        // The client expects an array of {lng, lat} objects
        polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] }))
      }
    });

    console.log(`[SERVER] Sending ${existingTerritories.length} existing territories to ${socket.id}.`);
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) {
    console.error('[DB] Error fetching existing territories:', err);
  }

  // --- DATABASE LOGIC: A player claims a new territory ---
  socket.on('claimTerritory', async (trailData) => {
    console.log(`[SERVER] Received 'claimTerritory' from ${socket.id}.`);

    // Convert the client's trail into Well-Known Text (WKT) format for PostGIS
    if (trailData.length < 3) return;
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`; // Close the loop

    try {
      // ST_GeomFromText converts the WKT string into a geometry object for storage. 4326 is the GPS coordinate system.
      const query = "INSERT INTO territories (owner_id, area) VALUES ($1, ST_GeomFromText($2, 4326))";
      await pool.query(query, [socket.id, wkt]);
      console.log(`[DB] Successfully inserted new territory for ${socket.id}.`);

      // Broadcast the new territory to all clients for live updates
      const newTerritory = {
        ownerId: socket.id,
        polygon: trailData,
      };
      io.emit('newTerritoryClaimed', newTerritory);
    } catch (err) {
      console.error('[DB] Error inserting new territory:', err);
    }
  });

  // --- DATABASE LOGIC: Reset button wipes the database table ---
  socket.on('resetAllTerritories', async () => {
    console.log(`[SERVER] Received 'resetAllTerritories' from ${socket.id}. Clearing database table.`);
    try {
      await pool.query("DELETE FROM territories");
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

// Start the server only after ensuring the table exists
server.listen(PORT, async () => {
  await createTable();
  console.log(`Server listening on *:${PORT}`);
});