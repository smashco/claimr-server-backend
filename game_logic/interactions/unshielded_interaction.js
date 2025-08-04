/**
 * @file unshielded_interaction.js
 * @description Handles the interaction when an attacker hits an unshielded victim.
 *              This is a "carve" operation, not a "wipeout".
 */

/**
 * Calculates the victim's remaining territory after the attacker's claim is subtracted from it.
 * This function DOES NOT modify the attacker's geometry.
 *
 * @param {object} victim - The victim player's data from the database { owner_id, username, area }.
 * @param {string} attackerNetGainGeom - The WKT representation of the attacker's claim geometry.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<void>}
 */
async function handleWipeout(victim, attackerNetGainGeom, client) {
    console.log(`[CARVE] Carving out territory from ${victim.username}.`);

    // Calculate the victim's remaining area by subtracting the attacker's claim.
    const diffResult = await client.query(
        `SELECT ST_Difference($1::geometry, $2::geometry) AS remaining_geom`,
        [victim.area, attackerNetGainGeom]
    );

    const remainingGeom = diffResult.rows[0].remaining_geom;

    // Update the victim's territory with the new, smaller geometry.
    // We also need to recalculate their total area.
    const updateResult = await client.query(
        `UPDATE territories 
         SET 
            area = ST_CollectionExtract(ST_Multi(ST_MakeValid($1)), 3), 
            area_sqm = ST_Area(ST_MakeValid($1)::geography)
         WHERE owner_id = $2`,
        [remainingGeom, victim.owner_id]
    );
    
    console.log(`[CARVE] ${victim.username}'s territory has been reduced.`);

    // This function no longer returns a value because it doesn't add the victim's land to the attacker.
    // The attacker just gets what they originally drew.
}

module.exports = { handleWipeout };