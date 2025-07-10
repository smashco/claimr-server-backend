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

// In-memory store for players and territories
const players = {};
const claimedTerritories = []; 

app.get('/', (req, res) => {
  res.send('Claimr Server v1.2 is running!'); // Version bump for clarity
});

io.on('connection', (socket) => {
  console.log(`A user connected with ID: ${socket.id}`);
  
  players[socket.id] = { id: socket.id, location: null };

  // When a player connects, send them all existing territories
  socket.emit('existingTerritories', claimedTerritories);
  
  // Let other players know about the new player
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('locationUpdate', (data) => {
    const player = players[socket.id];
    if (player) {
      player.location = data;
    }
    socket.broadcast.emit('playerMoved', { id: socket.id, location: data });
  });

  // --- THIS IS THE MISSING PIECE OF LOGIC ---
  // Listens for a claim from a client and relays it to everyone else.
  socket.on('claimTerritory', (trailData) => {
    console.log(`Received territory claim from ${socket.id}. Broadcasting to all clients.`);
    
    // Create the territory object, making sure to include the owner's ID
    const newTerritory = {
      ownerId: socket.id,
      polygon: trailData,
    };

    // Store it so new players who join later will see it
    claimedTerritories.push(newTerritory);
    
    // Broadcast the newly claimed territory to EVERYONE
    io.emit('newTerritoryClaimed', newTerritory);
  });
  // --- END OF NEW LOGIC ---

  socket.on('disconnect', () => {
    console.log(`User with ID: ${socket.id} disconnected`);
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});