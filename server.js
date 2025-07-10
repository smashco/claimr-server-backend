// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

const players = {};
const claimedTerritories = []; 

app.get('/', (req, res) => {
  res.send('Claimr Server v1.3 (Debug Logging) is running!');
});

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  players[socket.id] = { id: socket.id, location: null };
  socket.emit('existingTerritories', claimedTerritories);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('locationUpdate', (data) => {
    // We can quiet this log for now to reduce noise
    // console.log(`[SERVER] Location update from ${socket.id}`);
    const player = players[socket.id];
    if (player) {
      player.location = data;
    }
    socket.broadcast.emit('playerMoved', { id: socket.id, location: data });
  });

  // --- DEBUG-ENHANCED CLAIM LOGIC ---
  socket.on('claimTerritory', (trailData) => {
    console.log(`--- [SERVER] Received 'claimTerritory' from ${socket.id} ---`);
    
    const newTerritory = {
      ownerId: socket.id,
      polygon: trailData,
    };
    claimedTerritories.push(newTerritory);
    
    // Log exactly what we are about to broadcast
    console.log(`[SERVER] Broadcasting 'newTerritoryClaimed'. Owner: ${socket.id}. Polygon points: ${trailData.length}`);
    console.log(`[SERVER] Full data: ${JSON.stringify(newTerritory)}`);

    io.emit('newTerritoryClaimed', newTerritory);
    console.log('--- [SERVER] Broadcast sent. ---');
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});