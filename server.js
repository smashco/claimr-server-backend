// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// In-memory store for players' locations and claimed areas
const players = {};
const claimedTerritories = []; // <-- NEW: Array to store all claimed polygons

app.get('/', (req, res) => {
  res.send('Claimr Server is running!');
});

io.on('connection', (socket) => {
  console.log(`A user connected with ID: ${socket.id}`);
  players[socket.id] = { id: socket.id, location: null };
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // <-- NEW: When a player connects, send them all existing territories
  socket.emit('existingTerritories', claimedTerritories);

  socket.on('locationUpdate', (data) => {
    if (players[socket.id]) {
      players[socket.id].location = data;
    }
    socket.broadcast.emit('playerMoved', { id: socket.id, location: data });
  });

  // <-- NEW: Listen for a 'claimTerritory' event from a client
  socket.on('claimTerritory', (trailData) => {
    console.log(`Received territory claim from ${socket.id}`);
    const newTerritory = {
      ownerId: socket.id,
      polygon: trailData, // The list of coordinates
    };
    claimedTerritories.push(newTerritory);

    // Broadcast the newly claimed territory to ALL clients
    io.emit('newTerritoryClaimed', newTerritory);
  });

  socket.on('disconnect', () => {
    console.log(`User with ID: ${socket.id} disconnected`);
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});