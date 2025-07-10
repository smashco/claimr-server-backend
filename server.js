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
        owner_name VARCHAR(255), 
        area GEOMETRY(POLYGON, 4326) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);
    console.log('[DB] "territories" table is ready with owner_name column.');
  } catch (err) {
    console.error('[DB] Error during database setup:', err);
    process.exit(1);
  } finally {
    client.release();
  }
};

app.get('/admin/reset-all', async (req, res) => {
  console.log('[ADMIN] Received request to /admin/reset-all. Clearing all territories.');
  try {
    await pool.query("TRUNCATE TABLE territories RESTART IDENTITY;");
    console.log('[DB] "territories" table cleared via admin route.');
    io.emit('clearAllTerritories');
    res.status(200).send('SUCCESS: All claimed territories have been deleted.');
  } catch (err) {
    console.error('[ADMIN] Error clearing territories table:', err);
    res.status(500).send('ERROR: An error occurred while clearing territories.');
  }
});

app.get('/', (req, res) => {
  res.send('Claimr Server v2.5 (Usernames & Ownership) is running!');
});

const players = {};

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    const playerName = data.name || 'Anonymous';
    players[socket.id] = { 
      id: socket.id, 
      name: playerName,
      location: null, 
      activeTrail: [] 
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
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) {
    console.error('[DB] Error fetching existing territories:', err);
  }

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player) {
      player.location = data;
      player.activeTrail.push(data);
      socket.broadcast.emit('trailUpdated', { 
        id: socket.id, 
        name: player.name,
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
      const query = "INSERT INTO territories (owner_id, owner_name, area) VALUES ($1, $2, ST_GeomFromText($3, 4326))";
      await pool.query(query, [socket.id, player.name, wkt]);
      
      const newTerritory = { 
        ownerId: socket.id, 
        ownerName: player.name,
        polygon: trailData, 
      };
      io.emit('newTerritoryClaimed', newTerritory);
      
      const lastPoint = player.activeTrail.length > 0 ? player.activeTrail[player.activeTrail.length - 1] : null;
      player.activeTrail = lastPoint ? [lastPoint] : [];
      io.emit('trailCleared', { id: socket.id });
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
    io.emit('trailCleared', { id: socket.id });
    delete players[socket.id];
  });
});

const main = async () => {
  await setupDatabase();
  server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
  });
};

main();