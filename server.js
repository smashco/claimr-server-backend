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

// This array is now our persistent "Source of Truth" for the game session.
const claimedTerritories = []; 

app.get('/', (req, res) => {
  res.send('Claimr Server v1.4 (Stateful) is running!');
});

io.on('connection', (socket) => {
  console.log(`[SERVER] User connected: ${socket.id}`);
  
  // *** THE CRITICAL FIX ***
  // When a new player connects, immediately send them all territories that already exist.
  console.log(`[SERVER] Sending ${claimedTerritories.length} existing territories to ${socket.id}.`);
  socket.emit('existingTerritories', claimedTerritories);

  socket.on('claimTerritory', (trailData) => {
    console.log(`[SERVER] Received 'claimTerritory' from ${socket.id}.`);
    
    const newTerritory = {
      ownerId: socket.id,
      polygon: trailData,
    };

    // Add the new territory to our persistent list.
    claimedTerritories.push(newTerritory);
    
    // Broadcast the NEW territory to everyone so their maps update live.
    io.emit('newTerritoryClaimed', newTerritory);
  });

  // *** NEW: The reset button functionality ***
  socket.on('resetAllTerritories', () => {
    console.log(`[SERVER] Received 'resetAllTerritories' from ${socket.id}. Clearing all data.`);
    // Clear the server's memory.
    claimedTerritories.length = 0; 
    // Tell all connected clients to clear their maps.
    io.emit('clearAllTerritories');
  });

  socket.on('disconnect', () => {
    console.log(`[SERVER] User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on *:${PORT}`);
});