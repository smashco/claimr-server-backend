/**
 * @file unshielded_interaction.js
 * @description Handles interactions with unshielded victims, supporting partial takeovers.
 */

/**
 * Completely removes a victim's territory from the database.
 * This is a helper function called only when a victim's land is fully absorbed or becomes invalid.
 * @param {object} victim - The victim player's data { owner_id, username }.
 * @param {object} client - The PostgreSQL database client.
 */
async function wipeVictim(victim, client) {
    console.log(`[WIPEOUT] ${victim.username}'s territory has been wiped completely.`);
    await client.query('DELETE FROM territories WHERE owner_id = $1', [victim.owner_id]);
}

/**
 * Handles a partial takeover of an unshielded player's territory.
 * It subtracts the attacker's claim from the victim's land using the PostGIS ST_Difference function.
 * If the victim's remaining land becomes empty or invalid, it triggers a full wipeout.
 *
 * @param {object} victim - The victim player's data from the database.
 * @param {string} attackerClaimWKT - The WKT representation of the attacker's new claim polygon.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<void>} This function modifies the database directly and does not return a value.
 */
async function handlePartialTakeover(victim, attackerClaimWKT, client) {
    console.log(`[TAKEOVER] Attacker is carving a piece from ${victim.username}'s unshielded territory.`);

    // This query attempts to subtract the attacker's claim from the victim's area.
    // - WITH updated_geom: A Common Table Expression (CTE) to calculate the new geometry once.
    // - ST_Difference: The core operation. Subtracts the attacker's geometry from the victim's.
    // - ST_CollectionExtract(..., 3): Ensures the result is a (Multi)Polygon, discarding any lines or points.
    // - RETURNING area_sqm: Allows us to check if any meaningful territory remains.
    const updateQuery = `
        WITH updated_geom AS (
            SELECT ST_CollectionExtract(ST_Difference(area, ${attackerClaimWKT}), 3) AS new_geom
            FROM territories
            WHERE owner_id = $1
        )
        UPDATE territories
        SET
            area = (SELECT new_geom FROM updated_geom),
            area_sqm = ST_Area((SELECT new_geom FROM updated_geom)::geography)
        WHERE owner_id = $1
        RETURNING area_sqm;
    `;

    try {
        const result = await client.query(updateQuery, [victim.owner_id]);

        // Check if the victim has any meaningful territory left after the subtraction.
        if (result.rowCount === 0 || !result.rows[0].area_sqm || result.rows[0].area_sqm < 1) {
            // The difference resulted in an empty or negligibly small geometry, so the victim is wiped out.
            console.log(`[TAKEOVER] Victim ${victim.username} has no territory left after the attack.`);
            await wipeVictim(victim, client);
        } else {
            console.log(`[TAKEOVER] ${victim.username} now has ${result.rows[0].area_sqm.toFixed(2)} sqm remaining.`);
        }
    } catch (error) {
        console.error(`[ERROR] Failed to process partial takeover for victim ${victim.username}:`, error);
        // As a fallback, if the geometry operation fails (e.g., results in an invalid shape),
        // we will wipe the victim to prevent a corrupted state in the database.
        console.error(`[FALLBACK] Wiping victim ${victim.username} due to a geometry processing error.`);
        await wipeVictim(victim, client);
    }
}

// Export the new function. The old handleWipeout is no longer needed in this context.
module.exports = { handlePartialTakeover };