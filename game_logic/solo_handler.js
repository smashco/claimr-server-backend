const db = require('../db');
const geolib = require('geolib');
const { v4: uuidv4 } = require('uuid');
const playerPowers = require('./power_memory'); // Make sure this map is maintained globally

async function handleSoloClaim(socket, data, playerId, playerName) {
  const { latitude, longitude } = data;

  // DEBUG: Get active power
  const activePower = playerPowers[playerId];
  console.log(`[DEBUG] [CHECK] Player: ${playerName}, activePower BEFORE claim: ${activePower}`);

  try {
    const claimId = uuidv4();
    const claimCenter = { latitude, longitude };

    console.log(`[DEBUG] [START] Player: ${playerName}, UserID: ${playerId}, Power: ${activePower}, InitialClaim: true`);

    const radius = 30; // in meters
    const area = Math.PI * Math.pow(radius, 2);
    console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

    // Get existing solo territories
    const existing = await db.query(`
      SELECT * FROM territories 
      WHERE mode = 'solo' 
      AND owner_id != $1
    `, [playerId]);

    let intersectsEnemy = 0;

    for (const territory of existing.rows) {
      const distance = geolib.getDistance(
        { latitude, longitude },
        { latitude: territory.latitude, longitude: territory.longitude }
      );

      if (distance < territory.radius + radius) {
        intersectsEnemy++;
      }
    }

    console.log(`[DEBUG] Found ${intersectsEnemy} intersecting enemy territories`);

    // INFILTRATOR logic
    if (intersectsEnemy > 0 && activePower !== 'INFILTRATOR') {
      console.log(`[REJECTED] Cannot claim inside enemy territory without Infiltrator.`);
      socket.emit('claimFailed', { reason: 'enemyTerritory' });
      return;
    }

    // Insert into DB
    await db.query(`
      INSERT INTO territories (id, owner_id, owner_name, latitude, longitude, radius, mode, is_shield_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'solo', false)
    `, [claimId, playerId, playerName, latitude, longitude, radius]);

    console.log(`[DB] New territory inserted for ${playerName}.`);

    socket.emit('claimSuccess', { id: claimId, latitude, longitude, radius });

    // Reset power if it’s single-use
    if (activePower === 'INFILTRATOR') {
      delete playerPowers[playerId];
      console.log(`[POWER] ${playerName}'s INFILTRATOR power consumed and reset.`);
    }
  } catch (err) {
    console.error(`[DB] FATAL Error during territory claim:`, err);
    socket.emit('claimFailed', { reason: 'serverError' });
  }
}

module.exports = { handleSoloClaim };
