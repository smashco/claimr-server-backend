// game_logic/solo_handler.js

const turf = require('@turf/turf');
const { updateQuestProgress } = require('./quest_handler');
const debug = require('debug')('server:game');

const SOLO_BASE_RADIUS_METERS = 30.0;

async function handleSoloClaim(io, socket, player, players, req, client, superpowerManager) {
   debug(`\n\n[SOLO_HANDLER] =================== NEW SOLO CLAIM ===================`);
  
   const { trail, baseClaim } = req;
   const userId = player.googleId;
   const isInitialBaseClaim = !!baseClaim;

   debug(`[SOLO_HANDLER] Claim by: ${player.name} (${userId})`);
   debug(`[SOLO_HANDLER] Claim Type: ${isInitialBaseClaim ? 'INITIAL BASE' : 'EXPANSION'}`);

   let newAreaPolygon, newAreaSqM;

   try {
       if (isInitialBaseClaim) {
           debug(`[SOLO_HANDLER] Processing Initial Base Claim. Received baseClaim object:`, baseClaim);
           
           if (typeof baseClaim.lng !== 'number' || typeof baseClaim.lat !== 'number') {
               throw new Error('Invalid coordinates in baseClaim object. `lat` and `lng` must be numbers.');
           }
           const center = [baseClaim.lng, baseClaim.lat];
           const radius = baseClaim.radius || SOLO_BASE_RADIUS_METERS;
          
           newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
           newAreaSqM = turf.area(newAreaPolygon);
           debug(`[SOLO_HANDLER] Base area calculated: ${newAreaSqM.toFixed(2)} sqm`);

           const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
           const overlapCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
           if (overlapCheck.rowCount > 0) {
               // This is a normal overlap, not necessarily a shield block.
               // It's still a reason to reject the claim.
               throw new Error('Base overlaps existing territory.');
           }
       } else {
           debug(`[SOLO_HANDLER] Processing Expansion Claim.`);
           if (trail.length < 3) {
               throw new Error('Trail is too short to form a valid area.');
           }
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
       throw err; // Propagate the error up to be caught in server.js
   }

   const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
   const victimsRes = await client.query(`
       SELECT owner_id, username, is_shield_active
       FROM territories
       WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
   `, [userId]);
   debug(`[SOLO_HANDLER] Found ${victimsRes.rowCount} overlapping enemy territories.`);

   const affectedOwnerIds = new Set([userId]);
   let attackPolygonGeometry = newAreaPolygon.geometry;

   // <<< SOLUTION START: Handle shield block by throwing an error >>>
   for (const victim of victimsRes.rows) {
       affectedOwnerIds.add(victim.owner_id);

       if (victim.is_shield_active) {
           debug(`[SOLO_HANDLER] ATTACK BLOCKED! Attacker ${player.name} hit ${victim.username}'s shield.`);
          
           // We can still emit events here before throwing
           io.to(socket.id).emit('runTerminated', { reason: `Your run was blocked by ${victim.username}'s Last Stand!` });
          
           const victimSocketId = Object.keys(players).find(id => players[id].googleId === victim.owner_id);
           if (victimSocketId) {
               io.to(victimSocketId).emit('lastStandActivated', { attacker: player.name });
           }

           await superpowerManager.consumePower(victim.owner_id, 'lastStand', client);

           player.isDrawing = false;
           player.activeTrail = [];
           io.emit('trailCleared', { id: socket.id });
          
           // Instead of returning null, throw an error that will be sent to the user.
           throw new Error(`Your claim was blocked by ${victim.username}'s Last Stand!`);
       }
   }
   // <<< SOLUTION END >>>

   for (const victim of victimsRes.rows) {
       debug(`[SOLO_HANDLER] Calculating damage for victim: ${victim.username}`);
       const victimGeomRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson FROM territories WHERE owner_id = $1`, [victim.owner_id]);
       const victimPolygon = JSON.parse(victimGeomRes.rows[0].geojson);

       const remainingVictimArea = turf.difference(victimPolygon, attackPolygonGeometry);
      
       if (remainingVictimArea) {
           const newGeoJSON = JSON.stringify(remainingVictimArea.geometry);
           await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = ST_Area(ST_GeomFromGeoJSON($1)::geography) WHERE owner_id = $2`, [newGeoJSON, victim.owner_id]);
       } else {
           await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
       }
   }
  
   const userExistingRes = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
   let finalAreaGeoJSON = JSON.stringify(attackPolygonGeometry);

   if (userExistingRes.rowCount > 0 && userExistingRes.rows[0].area) {
       debug(`[SOLO_HANDLER] Merging new area with existing land for user ${userId}`);
       const unionRes = await client.query(`SELECT ST_AsGeoJSON(ST_Union(area, ST_GeomFromGeoJSON($1))) as geojson FROM territories WHERE owner_id = $2`, [finalAreaGeoJSON, userId]);
       finalAreaGeoJSON = unionRes.rows[0].geojson;
   }
  
   const finalAreaSqMRes = await client.query(`SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) as area`, [finalAreaGeoJSON]);
   const finalAreaSqM = finalAreaSqMRes.rows[0].area || 0;
   debug(`[SOLO_HANDLER] Final total area for ${player.name}: ${finalAreaSqM.toFixed(2)} sqm`);
  
   // Use INSERT ... ON CONFLICT DO UPDATE to handle both new and existing user records gracefully
   await client.query(
       `INSERT INTO territories (owner_id, area, area_sqm) 
        VALUES ($3, ST_GeomFromGeoJSON($1), $2)
        ON CONFLICT (owner_id) DO UPDATE 
        SET area = ST_GeomFromGeoJSON($1), area_sqm = $2;`,
       [finalAreaGeoJSON, finalAreaSqM, userId]
   );

   await updateQuestProgress(userId, 'cover_area', Math.round(newAreaSqM), client, io, players);

   if (!isInitialBaseClaim && trail.length > 0) {
       const trailLineString = turf.lineString(trail.map(p => [p.lng, p.lat]));
       const trailLengthKm = turf.length(trailLineString, { units: 'kilometers' });
       debug(`[SOLO_HANDLER] Trail length for this claim was ${trailLengthKm.toFixed(3)} km.`);
       await updateQuestProgress(userId, 'run_trail', trailLengthKm, client, io, players);
   }

   debug(`[SOLO_HANDLER] SUCCESS: Claim transaction for ${player.name} is ready to be committed.`);
  
   return {
       finalTotalArea: finalAreaSqM,
       areaClaimed: newAreaSqM,
       ownerIdsToUpdate: Array.from(affectedOwnerIds)
   };
}

module.exports = handleSoloClaim;