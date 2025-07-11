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
app.get('/', (req, res) => { res.send('Claimr Server v6.0 (Territory Expansion) is running!'); });

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

    const client = await pool.connect();
    try {
      const trailCoords = trailData.map(p => `${p.lng} ${p.lat}`).join(', ');
      const trailWkt = `LINESTRING(${trailCoords})`;
      
      const existingTerritoriesResult = await client.query("SELECT id, area FROM territories WHERE owner_id = $1", [socket.id]);

      let territoryToExpandId = null;
      let newClaimPolygonWkt = `POLYGON((${trailCoords}, ${trailData[0].lng} ${trailData[0].lat}))`;

      if (existingTerritoriesResult.rows.length > 0) {
        // Find if the trail intersects ANY of the player's territories
        const checkPromises = existingTerritoriesResult.rows.map(territory => 
            client.query("SELECT ST_Intersects(ST_GeomFromText($1, 4326), $2) as intersects", [trailWkt, territory.area])
        );
        const intersectionResults = await Promise.all(checkPromises);
        
        const intersectingTerritoryIndex = intersectionResults.findIndex(res => res.rows[0].intersects);

        if (intersectingTerritoryIndex !== -1) {
          const territoryToExpand = existingTerritoriesResult.rows[intersectingTerritoryIndex];
          territoryToExpandId = territoryToExpand.id;
          
          // Merge the new area with the existing territory
          const unionResult = await client.query(
            "SELECT ST_Union(ST_GeomFromText($1, 4326), $2) as new_area",
            [newClaimPolygonWkt, territoryToExpand.area]
          );
          // PostGIS returns geometry in a specific format, we need to convert it back to WKT for the next query
          const mergedGeom = unionResult.rows[0].new_area;
          const wktResult = await client.query("SELECT ST_AsText($1) as wkt", [mergedGeom]);
          newClaimPolygonWkt = wktResult.rows[0].wkt;
        }
      }

      let finalAreaSqm, finalGeoJson;
      
      if (territoryToExpandId !== null) {
        const updateResult = await client.query(
          `UPDATE territories SET area = ST_GeomFromText($1, 4326), area_sqm = ST_Area(ST_GeomFromText($1, 4326)::geography) WHERE id = $2 RETURNING area_sqm, ST_AsGeoJSON(area) as geojson;`,
          [newClaimPolygonWkt, territoryToExpandId]
        );
        finalAreaSqm = updateResult.rows[0].area_sqm;
        finalGeoJson = updateResult.rows[0].geojson;
      } else {
        const insertResult = await client.query(
          `INSERT INTO territories (owner_id, owner_name, area, area_sqm) VALUES ($1, $2, ST_GeomFromText($3, 4326), ST_Area(ST_GeomFromText($3, 4326)::geography)) RETURNING area_sqm, ST_AsGeoJSON(area) as geojson;`,
          [socket.id, player.name, newClaimPolygonWkt]
        );
        finalAreaSqm = insertResult.rows[0].area_sqm;
        finalGeoJson = insertResult.rows[0].geojson;
      }
      
      const finalPolygonData = JSON.parse(finalGeoJson);

      io.emit('playerTerritoriesCleared', { ownerId: socket.id });

      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay

      const updatedTerritory = {
        ownerId: socket.id,
        ownerName: player.name,
        polygon: finalPolygonData.coordinates[0].map(coord => ({ lng: coord[0], lat: coord[1] })),
        area: finalAreaSqm,
      };
      io.emit('newTerritoryClaimed', updatedTerritory);
      
      player.activeTrail = [];

    } catch (err) {
      console.error('[DB] Error during territory claim/expansion:', err);
    } finally {
      client.release();
    }
  });

  socket.on('deleteMyTerritories', async () => { /* ... same as before ... */ });
  socket.on('disconnect', () => { /* ... same as before ... */ });
});

const main = async () => { await setupDatabase(); server.listen(PORT, () => console.log(`Server listening on *:${PORT}`)); };
main();