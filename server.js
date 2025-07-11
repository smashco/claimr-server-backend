// claimr_server/server.js

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS territories (
        id SERIAL PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL,
        owner_name VARCHAR(255), 
        area GEOMETRY(POLYGON, 4326) NOT NULL,
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
        io.emit('clearAllTerritories');
        res.status(200).send('SUCCESS: All claimed territories have been deleted.');
    } catch (err) {
        res.status(500).send('ERROR clearing territories.');
    }
});

app.get('/', (req, res) => { res.send('Claimr Server - Final Stable Version is running!'); });

io.on('connection', async (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  socket.on('playerJoined', (data) => {
    players[socket.id] = { id: socket.id, name: data.name || 'Anonymous', activeTrail: [] };
  });

  try {
    const result = await pool.query("SELECT owner_id, owner_name, ST_AsGeoJSON(area) as geojson, area_sqm FROM territories");
    const existingTerritories = result.rows.map(row => {
      const polygonData = JSON.parse(row.geojson);
      return { ownerId: row.owner_id, ownerName: row.owner_name, polygon: polygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })), area: row.area_sqm };
    });
    socket.emit('existingTerritories', existingTerritories);
  } catch (err) { console.error('[DB] ERROR fetching territories:', err); }

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player && player.activeTrail) {
      player.activeTrail.push(data);
      socket.broadcast.emit('trailUpdated', { id: socket.id, name: player.name, trail: player.activeTrail });
    }
  });

  socket.on('claimTerritory', async (data) => {
    const player = players[socket.id];
    const trailData = data ? data.trail : undefined;
    if (!player || !Array.isArray(trailData) || trailData.length < 3) return;
    
    const coordinatesString = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
    const wkt = `POLYGON((${coordinatesString}, ${trailData[0].lng} ${trailData[0].lat}))`;
    
    try {
      const query = `
        INSERT INTO territories (owner_id, owner_name, area, area_sqm)
        VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography))
        RETURNING area_sqm;
      `;
      const result = await pool.query(query, [socket.id, player.name, wkt]);
      const calculatedArea = result.rows[0].area_sqm;
      
      const newTerritory = { 
        ownerId: socket.id, 
        ownerName: player.name,
        polygon: trailData, 
        area: calculatedArea
      };
      io.emit('newTerritoryClaimed', newTerritory);

      player.activeTrail = [];
      io.emit('trailCleared', { id: socket.id });

    } catch (err) {
      console.error('[DB] Error inserting territory:', err);
    }
  });

  socket.on('deleteMyTerritories', async () => { /* same as before */ });
  socket.on('disconnect', () => { /* same as before */ });
});

const main = async () => { 
  await setupDatabase(); 
  server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); 
};
main();