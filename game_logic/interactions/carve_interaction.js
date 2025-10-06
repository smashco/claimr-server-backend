/**
* @file carve_interaction.js
* @description Handles the interaction where an attacker carves out a piece of a victim's territory.
*/


/**
* Subtracts the attacker's claim area from the victim's territory, creating a hole or "island".
* The attacker's claim is then merged with their own existing territory.
*
* @param {object} victim - The victim player's data from the database { owner_id, username, area }.
* @param {string} attackerNetGainGeom - The WKT representation of the attacker's claim geometry.
* @param {object} client - The PostgreSQL database client.
* @returns {Promise<void>} This function modifies the victim's territory directly and doesn't need to return a new geometry for the attacker.
*/
async function handleCarveOut(victim, attackerNetGainGeom, client) {
    console.log(`[CARVE] Carving expansion area from ${victim.username}.`);
 
 
    // Use ST_Difference to subtract the attacker's new polygon from the victim's area.
    await client.query(
        `UPDATE territories
         SET
             area = ST_CollectionExtract(ST_MakeValid(ST_Difference(area, $1::geometry)), 3),
             area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, $1::geometry))::geography)
         WHERE owner_id = $2;`,
        [attackerNetGainGeom, victim.owner_id]
    );
 
 
    console.log(`[CARVE] ${victim.username}'s territory has been carved.`);
    // The attacker's geometry is NOT modified by the victim's shape in a carve-out.
    // It remains what they drew. The solo_handler will then merge this shape with their existing base.
 }
 
 
 module.exports = { handleCarveOut };