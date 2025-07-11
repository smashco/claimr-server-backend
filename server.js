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

// In-memory store for LIVE player data
const players = {}; 

const setupDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    console.log('[DB] PostGIS extension is enabled.');
    
    // This is the "safe" version that won't drop your table on every restart.
    // Use the /admin/reset-all route if you need to force a schema update.
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
        console.error('[ADMIN] Error clearing territories table:', err);
        res.status(500).send('ERROR clearing territories.');
    }
});

app.get('/', (req, res) => { res.send('Claimr Server v7.0 (True Merge) is running!'); });

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

    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // Start a database transaction

      const trailCoords = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
      const newClaimPolygonWkt = `POLYGON((${trailCoords}, ${trailData[0].lng} ${trailData[0].lat}))`;
      const newClaimGeom = `ST_GeomFromText('${newClaimPolygonWkt}', 4326)`;

      const intersectingTerritoriesResult = await client.query(
        `SELECT id, area FROM territories WHERE owner_id = $1 AND ST_Intersects(area, ${newClaimGeom})`,
        [socket.id]
      );
      
      let finalMergedGeom = newClaimGeom;
      const idsToDelete = [];

      if (intersectingTerritoriesResult.rows.length > 0) {
        console.log(`[SERVER] Merging new claim with ${intersectingTerritoriesResult.rows.length} existing territories.`);
        
        const geomsToMerge = intersectingTerritoriesResult.rows.map(row => {
          idsToDelete.push(row.id);
          return row.area;
        });
        
        // This is a robust way to union multiple geometries with the new one
        const unionQuery = `SELECT ST_Union(ARRAY[ST_GeomFromText('${newClaimPolygonWkt}', 4326)] || ARRAY(SELECT area FROM territories WHERE id = ANY($1::int[]))) as merged_area`;
        const unionResult = await client.query(unionQuery, [idsToDelete]);
        finalMergedGeom = unionResult.rows[0].merged_area;

        if (idsToDelete.length > 0) {
          await client.query("DELETE FROM territories WHERE id = ANY($1::int[])", [idsToDelete]);
        }
      }

      const wktResult = await client.query("SELECT ST_AsText($1) as wkt", [finalMergedGeom]);
      const finalWkt = wktResult.rows[0].wkt;

      const insertResult = await client.query(
        `INSERT INTO territories (owner_id, owner_name, area, area_sqm)
         VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography))
         RETURNING area_sqm, ST_AsGeoJSON(area) as geojson;`,
        [socket.id, player.name, finalWkt]
      );
      
      await client.query('COMMIT'); // Commit all changes if successful
      
      const finalAreaSqm = insertResult.rows[0].area_sqm;
      const finalGeoJson = insertResult.rows[0].geojson;
      const finalPolygonData = JSON.parse(finalGeoJson);

      // Tell clients to clear the old shapes first
      if (idsToDelete.length > 0) {
        io.emit('playerTerritoriesCleared', { ownerId: socket.id });
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay for clients to process
      }
      
      // Then send the new, unified shape
      const updatedTerritory = {
        ownerId: socket.id,
        ownerName: player.name,
        polygon: finalPolygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })),
        area: finalAreaSqm,
      };
      io.emit('newTerritoryClaimed', updatedTerritory);
      
      player.activeTrail = [];

    } catch (err) {
      await client.query('ROLLBACK'); // Abort all changes if any error occurred
      console.error('[DB] Error during territory expansion, transaction rolled back:', err);
    } finally {
      client.release();
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