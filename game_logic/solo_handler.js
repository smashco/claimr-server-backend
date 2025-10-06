// game_logic/solo_handler.js


// Import required libraries and modules
// turf.js is used for all geospatial calculations like creating circles and polygons.
const turf = require('@turf/turf');
// The quest handler is used to update player progress on quests like "claim X area".
const { updateQuestProgress } = require('./quest_handler');
// The debug library is used for namespaced logging to help with development.
const debug = require('debug')('server:game');


// Define a constant for the radius of a player's first base.
const SOLO_BASE_RADIUS_METERS = 30.0;


/**
* Handles a player's attempt to claim territory in solo mode.
* This can be an initial base claim or an expansion of existing territory.
* It now correctly handles shield interactions before applying damage to other players.
*
* @param {object} io - The Socket.IO server instance, used for emitting events to clients.
* @param {object} socket - The socket of the specific player making the claim.
* @param {object} player - The internal server state object for the attacking player.
* @param {object} players - The global object containing all currently online players.
* @param {Array<object>} trail - An array of {lat, lng} points forming the new territory boundary.
* @param {object|null} baseClaim - If this is an initial base claim, this object contains the center {lat, lng} and radius. Null otherwise.
* @param {object} client - The active PostgreSQL database client for running queries within a transaction.
* @param {object} superpowerManager - The instance of the SuperpowerManager, used to handle shield consumption.
* @returns {Promise<object|null>} Returns an object with the results of the successful claim, or null if the claim was stopped (e.g., by a shield).
*/
async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client, superpowerManager) {
   // Log the start of a new claim process for easier debugging
   debug(`\n\n[SOLO_HANDLER] =================== NEW SOLO CLAIM ===================`);
  
   // Extract key information from the player object
   const userId = player.googleId;
   const isInitialBaseClaim = !!baseClaim; // True if baseClaim object exists, false otherwise


   debug(`[SOLO_HANDLER] Claim by: ${player.name} (${userId})`);
   debug(`[SOLO_HANDLER] Claim Type: ${isInitialBaseClaim ? 'INITIAL BASE' : 'EXPANSION'}`);


   let newAreaPolygon, newAreaSqM;


   // STEP 1: Define the geometry of the new area being claimed.
   try {
       if (isInitialBaseClaim) {
           // Logic for a player's very first claim
           debug(`[SOLO_HANDLER] Processing Initial Base Claim.`);
           const center = [baseClaim.lng, baseClaim.lat];
           const radius = baseClaim.radius || SOLO_BASE_RADIUS_METERS;
          
           // Create a circular polygon using turf.js
           newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
           newAreaSqM = turf.area(newAreaPolygon);
           debug(`[SOLO_HANDLER] Base area calculated: ${newAreaSqM.toFixed(2)} sqm`);


           // Check if this new base overlaps with any existing territory
           const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
           const overlapCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
           if (overlapCheck.rowCount > 0) {
               throw new Error('Base overlaps existing territory.');
           }
       } else {
           // Logic for expanding existing territory
           debug(`[SOLO_HANDLER] Processing Expansion Claim.`);
           if (trail.length < 3) {
               throw new Error('Trail is too short to form a valid area.');
           }
           // Close the loop by adding the first point to the end of the trail array
           const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
           newAreaPolygon = turf.polygon([points]);
           newAreaSqM = turf.area(newAreaPolygon);
           debug(`[SOLO_HANDLER] Expansion Area calculated: ${newAreaSqM.toFixed(2)} sqm`);
          
           if (newAreaSqM < 100) {
               throw new Error('Claimed area is too small.');
           }
       }
   } catch (err) {
       debug(`[SOLO_HANDLER] ERROR during geometry definition: ${err.message}`);
       // Re-throw the error to be caught by the main try-catch block in server.js
       // This ensures the database transaction is properly rolled back.
       throw err;
   }


   // STEP 2: Find all other players' territories that this new area overlaps with ("victims").
   const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
   const victimsRes = await client.query(`
       SELECT owner_id, username, area, is_shield_active
       FROM territories
       WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
   `, [userId]);
   debug(`[SOLO_HANDLER] Found ${victimsRes.rowCount} overlapping enemy territories.`);


   // Keep track of all players who need their map updated after the claim.
   const affectedOwnerIds = new Set([userId]);
   let attackPolygonGeometry = newAreaPolygon.geometry;


   // STEP 3: Check for shields BEFORE calculating any territory changes.
   for (const victim of victimsRes.rows) {
       affectedOwnerIds.add(victim.owner_id);


       if (victim.is_shield_active) {
           debug(`[SOLO_HANDLER] ATTACK BLOCKED! Attacker ${player.name} hit ${victim.username}'s shield.`);
          
           // Notify the attacker that their run was stopped by a shield.
           io.to(socket.id).emit('runTerminated', { reason: `Your run was blocked by ${victim.username}'s Last Stand!` });
          
           // Notify the defender that their shield was successfully used.
           const victimSocketId = Object.keys(players).find(id => players[id].googleId === victim.owner_id);
           if (victimSocketId) {
               io.to(victimSocketId).emit('lastStandActivated', { attacker: player.name });
           }


           // IMPORTANT: Consume the 'lastStand' power from the defender's inventory.
           // This function also deactivates the shield flag in the database.
           await superpowerManager.consumePower(victim.owner_id, 'lastStand', client);


           // The attacker's run ends immediately. Clear their trail.
           player.isDrawing = false;
           player.activeTrail = [];
           io.emit('trailCleared', { id: socket.id });
          
           // Return null to signal to server.js that the claim was intentionally stopped and should be rolled back.
           return null;
       }
   }


   // STEP 4: If no shields were hit, proceed to calculate and apply damage to victims.
   for (const victim of victimsRes.rows) {
       debug(`[SOLO_HANDLER] Calculating damage for victim: ${victim.username}`);
       const victimGeomRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson FROM territories WHERE owner_id = $1`, [victim.owner_id]);
       const victimPolygon = JSON.parse(victimGeomRes.rows[0].geojson);


       // A standard "wipeout" attack. The claimed area is subtracted from the victim's territory.
       const remainingVictimArea = turf.difference(victimPolygon, attackPolygonGeometry);
      
       if (remainingVictimArea) {
           // If the victim has territory left, update their area.
           const newGeoJSON = JSON.stringify(remainingVictimArea.geometry);
           await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = ST_Area(ST_GeomFromGeoJSON($1)::geography) WHERE owner_id = $2`, [newGeoJSON, victim.owner_id]);
       } else {
           // If nothing remains, the victim's territory is completely wiped out.
           await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
       }
   }
  
   // STEP 5: Merge the successful claim area with the attacker's own existing territory.
   const userExistingRes = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
   let finalAreaGeoJSON = JSON.stringify(attackPolygonGeometry);


   if (userExistingRes.rowCount > 0 && userExistingRes.rows[0].area) {
       debug(`[SOLO_HANDLER] Merging new area with existing land for user ${userId}`);
       const unionRes = await client.query(`SELECT ST_AsGeoJSON(ST_Union(area, ST_GeomFromGeoJSON($1))) as geojson FROM territories WHERE owner_id = $2`, [finalAreaGeoJSON, userId]);
       finalAreaGeoJSON = unionRes.rows[0].geojson;
   }
  
   // Recalculate the final total area in square meters.
   const finalAreaSqMRes = await client.query(`SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) as area`, [finalAreaGeoJSON]);
   const finalAreaSqM = finalAreaSqMRes.rows[0].area || 0;
   debug(`[SOLO_HANDLER] Final total area for ${player.name}: ${finalAreaSqM.toFixed(2)} sqm`);
  
   // STEP 6: Update the attacker's final territory shape and area in the database.
   await client.query(
       `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3`,
       [finalAreaGeoJSON, finalAreaSqM, userId]
   );


   // Update quest progress for the area claim.
   await updateQuestProgress(userId, 'claim_area', Math.round(newAreaSqM), client, io, players);


   debug(`[SOLO_HANDLER] SUCCESS: Claim transaction for ${player.name} is ready to be committed.`);
  
   // Return the results to server.js
   return {
       finalTotalArea: finalAreaSqM,
       areaClaimed: newAreaSqM,
       ownerIdsToUpdate: Array.from(affectedOwnerIds)
   };
}


// Export the handler function to be used in server.js
module.exports = handleSoloClaim;