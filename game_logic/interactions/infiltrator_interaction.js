/**
 * @file infiltrator_interaction.js
 * @description Handles the special claim logic for the Infiltrator role.
 */

const turf = require('@turf/turf');

/**
 * Handles an Infiltrator's attempt to establish a base inside enemy territory.
 * This function is self-contained: it validates the claim, checks for shields,
 * carves the new base out of the victim's land, and saves the new territory.
 *
 * @param {object} io - The Socket.IO server instance.
 * @param {object} socket - The player's socket connection.
 * @param {object} player - The player object, including state like `isInfiltratorActive`.
 * @param {object} players - The server's map of all active players.
 * @param {object} baseClaim - The data for the base claim { lng, lat, radius }.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<object|null>} A result object on success, or null on failure.
 */
async function handleInfiltratorBaseClaim(io, socket, player, players, baseClaim, client) {
    console.log(`[INFILTRATOR] Processing Infiltrator Base Claim for ${player.name}.`);
    const userId = player.googleId;

    // Always reset the player's special ability state after an attempt.
    player.isInfiltratorActive = false;

    // 1. Generate the proposed base geometry
    const center = [baseClaim.lng, baseClaim.lat];
    const radius = baseClaim.radius || 30;
    let newAreaPolygon;
    try {
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
    } catch (e) {
        socket.emit('claimRejected', { reason: 'Invalid infiltrator base location.' });
        return null;
    }

    const newAreaSqM = turf.area(newAreaPolygon);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;

    // 2. Find if the base is inside a valid target's territory
    const infiltrateQuery = `
        SELECT owner_id, username, is_shield_active, area
        FROM territories
        WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1
        LIMIT 1;
    `;
    const result = await client.query(infiltrateQuery, [userId]);

    if (result.rowCount === 0) {
        console.log(`[INFILTRATOR] REJECTED: Base was not placed inside enemy territory.`);
        socket.emit('claimRejected', { reason: 'Infiltrator base must be inside enemy territory.' });
        return null;
    }

    const victim = result.rows[0];
    const victimId = victim.owner_id;

    // 3. Check if the target is shielded
    if (victim.is_shield_active) {
        console.log(`[INFILTRATOR] FAILED: Target ${victim.username} is shielded.`);
        // Break the shield
        await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
        socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator base.` });

        // Notify the victim their shield was broken
        const victimSocketId = Object.keys(players).find(id => players[id]?.googleId === victimId);
        if (victimSocketId) {
            io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });
        }
        return null;
    }

    // 4. Carve a hole in the victim's territory
    console.log(`[INFILTRATOR] SUCCESS: Carving new base from unshielded victim: ${victim.username}.`);
    await client.query(`
        UPDATE territories
        SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})),
            area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography)
        WHERE owner_id = $1;
    `, [victimId]);

    // 5. Create the new territory for the infiltrator
    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ${newAreaWKT}, $3, ST_SetSRID(ST_Point($4, $5), 4326))
        ON CONFLICT (owner_id) DO UPDATE
        SET area = ${newAreaWKT},
            area_sqm = $3,
            original_base_point = ST_SetSRID(ST_Point($4, $5), 4326);
    `;
    await client.query(saveQuery, [userId, player.name, newAreaSqM, baseClaim.lng, baseClaim.lat]);

    // 6. Return a successful result object for the server to broadcast updates
    console.log(`[INFILTRATOR] Claim committed for ${player.name}.`);
    return {
        finalTotalArea: newAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: [victimId, userId]
    };
}

module.exports = { handleInfiltratorBaseClaim };