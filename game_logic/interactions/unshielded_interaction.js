/**
 * @file unshielded_interaction.js
 * @description Handles the complete wipeout of an unshielded victim.
 */

/**
 * Merges the victim's territory into the attacker's claim and then
 * erases the victim's territory from the database. This is used when an
 * attacker's claim completely envelops the victim's land.
 *
 * @param {object} victim - The victim player's data from the database { owner_id, username, area }.
 * @param {string} attackerNetGainGeom - The WKT representation of the attacker's claim geometry.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<string>} The updated WKT geometry for the attacker's claim after absorbing the victim's land.
 */
async function handleWipeout(victim, attackerNetGainGeom, client) {
    console.log(`[WIPEOUT] Absorbing territory from ${victim.username}.`);

    // Merge the victim's area into the attacker's gain
    const mergeResult = await client.query(
        `SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`,
        [attackerNetGainGeom, victim.area]
    );

    // Erase the victim's territory by setting it to an empty geometry
    await client.query(
        `UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326), area_sqm = 0 WHERE owner_id = $1`,
        [victim.owner_id]
    );
    console.log(`[WIPEOUT] ${victim.username}'s territory has been wiped.`);

    // Return the new, larger geometry
    return mergeResult.rows[0].final_geom;
}

module.exports = { handleWipeout };