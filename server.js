// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for simplicity during development
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// In-memory store for players and territories
const players = {};
const claimedTerritories = []; 

app.get('/', (req, res) => {
  res.send('Claimr Server v1.1 is running!');
});

io.on('connection', (socket) => {
  console.log(`A user connected with ID: ${socket.id}`);
  
  // MODIFIED: Player object now includes an activeTrail array
  players[socket.id] = { 
    id: socket.id, 
    location: null, 
    activeTrail: [] 
  };

  // When a player connects, send them all existing territories
  socket.emit('existingTerritories', claimedTerritories);
  
  // Let other players know about the new player
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player) {
      player.location = data;
      // NEW: Store the trail on the server as the player moves
      player.activeTrail.push(data);
    }
    // Broadcast movement to other players
    socket.broadcast.emit('playerMoved', { id: socket.id, location: data });
  });

  // --- NEW AUTHORITATIVE CLAIM LOGIC ---
  // Replaces the old 'claimTerritory' listener
  socket.on('requestClaim', () => {
    const player = players[socket.id];

    // 1. Validation: Ensure the player exists and their trail is long enough
    if (!player || player.activeTrail.length < 3) {
      console.log(`Invalid claim request from ${socket.id}: Trail too short.`);
      // Optionally, you could emit a 'claimFailed' event here
      return; 
    }
    
    console.log(`Processing valid claim request from ${socket.id} with ${player.activeTrail.length} points.`);
    
    // 2. Create territory object using SERVER-SIDE trail data
    const newTerritory = {
      ownerId: socket.id,
      polygon: player.activeTrail,
    };
    claimedTerritories.push(newTerritory);

    // 3. Broadcast the new territory to ALL clients so they can draw it
    io.emit('newTerritoryClaimed', newTerritory);

    // 4. CRITICAL: Send a specific confirmation ONLY to the player who made the claim
    socket.emit('claimSuccessful');

    // 5. Reset the player's server-side trail, keeping the last point as the start of the new one
    player.activeTrail = [player.activeTrail[player.activeTrail.length - 1]];
  });


  socket.on('disconnect', () => {
    console.log(`User with ID: ${socket.id} disconnected`);
    // Remove the player from our list
    delete players[socket.id];
    // Broadcast that this player has disconnected
    io.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});