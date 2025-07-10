// claimr_server/server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// NEW: A simple in-memory store for players' locations
// In a real game, this would be more complex and possibly backed by a database
const players = {};

app.get('/', (req, res) => {
  res.send('Claimr Server is running!');
});

// This is where all our real-time game logic will go
io.on('connection', (socket) => {
  console.log(`A user connected with ID: ${socket.id}`);

  // Add the new player to our list
  players[socket.id] = { id: socket.id, location: null };
  
  // Welcome message to the new user
  socket.emit('welcome', `Welcome, you are connected! Your ID is ${socket.id}`);
  
  // Send the list of existing players to the new player
  socket.emit('currentPlayers', players);

  // Announce the new player to all other players
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Listen for a 'locationUpdate' event from a client
  socket.on('locationUpdate', (data) => {
    // For now, just log the data and broadcast it to everyone else
    console.log(`Received location update from ${socket.id}:`, data);
    
    // Update this player's location in our server-side store
    if (players[socket.id]) {
      players[socket.id].location = data;
    }

    // This broadcasts the location to all OTHER connected clients
    socket.broadcast.emit('playerMoved', { id: socket.id, location: data });
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