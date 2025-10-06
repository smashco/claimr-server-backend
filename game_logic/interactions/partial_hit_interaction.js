/**
* @file partial_hit_interaction.js
* @description Handles the partial territorial loss of an unshielded victim.
*/


/**
* Calculates the portion of the victim's territory that overlaps with the
* attacker's claim, subtracts it from the victim, and updates their record
* in the database. Unlike a wipeout, this only removes the contested area.
*
* @param {object} victim - The victim player's data from the database { owner_id, username, area }.
* @param {string} attackerClaimGeom - The WKT representation of the attacker's new claim geometry.
* @param {object} client - The PostgreSQL database client.
* @returns {Promise<void>} This function does not return a value; it modifies the victim's state directly.
*/
async function handlePartialHit(victim, attackerClaimGeom, client) {
    console.log(`[PARTIAL HIT] Calculating territory loss for ${victim.username}.`);
 
 
    // Calculate the victim's remaining territory by subtracting the attacker's claim area.
    const differenceResult = await client.query(
        `SELECT ST_Difference($1::geometry, $2::geometry) AS remaining_geom`,
        [victim.area, attackerClaimGeom]
    );
    const remainingGeom = differenceResult.rows[0].remaining_geom;
 
 
    // Calculate the new, smaller area in square meters.
    const newAreaResult = await client.query(
        `SELECT ST_Area($1::geography) as area_sqm`,
        [remainingGeom]
    );
    const newAreaSqM = newAreaResult.rows[0].area_sqm || 0;
 
 
    // Update the victim's territory in the database with the new geometry and area.
    await client.query(
        `UPDATE territories SET area = $1, area_sqm = $2 WHERE owner_id = $3`,
        [remainingGeom, newAreaSqM, victim.owner_id]
    );
 
 
    console.log(`[PARTIAL HIT] ${victim.username}'s territory has been reduced to ${newAreaSqM.toFixed(2)} sqm.`);
 }
 
 
 module.exports = { handlePartialHit };