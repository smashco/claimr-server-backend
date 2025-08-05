/**
 * @file unshielded_interaction.js
 * @description Handles the partial takeover of an unshielded victim's territory by slicing.
 */

/**
 * Slices the portion of the victim's territory that intersects with the attacker's claim.
 * This function modifies the victim's territory in the database directly by calculating the
 * geometric difference.
 *
 * @param {object} victim - The victim player's data from the database { owner_id, username, area }.
 * @param {string} attackerClaimGeom - The WKT representation of the attacker's effective claim geometry. This is the shape that will be "cut out" from the victim's land.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<void>} This function does not return a value. Its sole purpose is to update the victim's territory in the database.
 */
async function handlePartialTakeover(victim, attackerClaimGeom, client) {
    console.log(`[PARTIAL TAKEOVER] Slicing territory from ${victim.username}.`);

    // The core of the partial takeover:
    // 1. We start with the victim's current 'area'.
    // 2. We use ST_Difference to subtract the 'attackerClaimGeom' from the victim's 'area'.
    // 3. The result is the new, smaller shape of the victim's territory.
    // 4. We also recalculate 'area_sqm' based on this new geometry to keep the data consistent.
    await client.query(
        `
        UPDATE territories
        SET
            area = ST_Difference(area, $1::geometry),
            area_sqm = ST_Area(ST_Difference(area, $1::geometry)::geography)
        WHERE owner_id = $2;
        `,
        [attackerClaimGeom, victim.owner_id]
    );

    console.log(`[PARTIAL TAKEOVER] ${victim.username}'s territory has been sliced.`);
}

module.exports = { handlePartialTakeover };