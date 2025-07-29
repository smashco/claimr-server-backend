/**
 * @file unshielded_interaction.js
 * @description Handles interactions with unshielded victims, including encirclement and partial hits.
 */

const turf = require('@turf/turf');

/**
 * Processes an attack on an unshielded victim. It checks if the victim is fully
 * encircled for a wipeout or just partially hit.
 *
 * @param {object} victim - The victim player's data { owner_id, username, area }.
 * @param {string} newAreaWKT - The WKT of the attacker's new claim polygon.
 * @param {string} attackerNetGainGeom - The current geometry of the attacker's net gain.
 * @param {string} attackerInfluenceZone - The geometry representing the attacker's full area post-claim.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<string>} The updated WKT geometry for the attacker's claim.
 */
async function handleUnshieldedInteraction(victim, newAreaWKT, attackerNetGainGeom, attackerInfluenceZone, client) {
    const encirclementCheck = await client.query("SELECT ST_Relate($1::geometry, $2::geometry, 'T*F**F***') as is_encircled", [victim.area, attackerInfluenceZone]);

    if (encirclementCheck.rows[0].is_encircled) {
        // Total Wipeout: Victim is encircled and their land is absorbed.
        console.log(`[WIPEOUT] Absorbing ENCIRCLED unshielded victim: ${victim.username}.`);
        const absorptionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) as final_geom;`, [attackerNetGainGeom, victim.area]);
        await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
        return absorptionResult.rows[0].final_geom;
    } else {
        // Partial Hit: Only the newly claimed area is removed from the victim.
        console.log(`[PARTIAL HIT] Calculating damage on unshielded victim: ${victim.username}.`);
        const remainingResult = await client.query(`SELECT ST_AsGeoJSON(ST_MakeValid(ST_Difference($1::geometry, ${newAreaWKT}))) as remaining_geojson;`, [victim.area]);
        const remainingGeoJSON = remainingResult.rows[0].remaining_geojson;
        const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;
        
        if (remainingSqM < 1) {
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
        } else {
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
        }
        // For a partial hit, the attacker's gain geometry is not increased by the victim's land.
        return attackerNetGainGeom;
    }
}

module.exports = { handleUnshieldedInteraction };