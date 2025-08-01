const turf = require('@turf/turf');

/**
 * @file infiltrator_interaction.js
 * @description Handles the special two-phase claim logic for the Infiltrator role.
 */

/**
 * Manages the Infiltrator's ability to place a "stake" in enemy territory
 * and then carve out an area, creating a hole.
 *
 * @param {object} io - The Socket.IO server instance.
 * @param {object} socket - The player's socket object.
 * @param {object} player - The player object from the server's state.
 * @param {object} players - The map of all active players.
 * @param {Array<object>} trail - The list of coordinates for an expansion claim.
 * @param {object} baseClaim - The data for an initial base claim.
 * @param {object} client - The PostgreSQL database client.
 * @returns {Promise<object|null>} An object with claim results or null on failure.
 */
async function handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    // =======================================================================
    // PHASE 1: Placing the "Stake" (Initial Base inside enemy territory)
    // =======================================================================
    if (isInitialBaseClaim) {
        console.log(`[INFILTRATOR] Phase 1: Placing stake.`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        const newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        const newAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);

        // Find which enemy territory the stake is being placed in.
        const result = await client.query(`
            SELECT owner_id, username, is_shield_active, area
            FROM territories
            WHERE ST_Contains(area, ST_MakeValid(ST_GeomFromGeoJSON($1))) AND owner_id != $2
            LIMIT 1;
        `, [newAreaGeoJSON, userId]);

        if (result.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'Infiltrator base must be placed inside enemy territory.' });
            return null;
        }

        const victim = result.rows[0];
        console.log(`[INFILTRATOR] Target: ${victim.username}, Shield: ${victim.is_shield_active}`);

        // Check if the target is shielded.
        if (victim.is_shield_active) {
            console.log(`[INFILTRATOR] Blocked by shield of ${victim.username}. Power used up.`);
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            player.isInfiltratorActive = false; // Power is consumed
            socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator power.` });
            return null;
        }

        // Temporarily store the stake polygon on the player object for Phase 2.
        player.infiltratorInitialBasePolygon = newAreaPolygon;
        console.log(`[INFILTRATOR] Stake placed successfully. Awaiting Phase 2 carve-out.`);

        // Notify the client that the stake is set and they can start drawing.
        socket.emit('infiltratorBaseSet', { message: 'Base set. Expand to carve out territory.' });

        // Phase 1 is complete, but no territory has changed hands yet.
        // We return a specific status so the server knows not to update maps.
        return { status: 'infiltratorBaseSet' };
    }

    // =======================================================================
    // PHASE 2: The Carve-out (Expansion and creating the hole)
    // =======================================================================
    else {
        console.log(`[INFILTRATOR] Phase 2: Performing carve-out.`);

        // Validate that Phase 1 was completed.
        if (!player.infiltratorInitialBasePolygon) {
            socket.emit('claimRejected', { reason: 'Infiltrator expansion requires a base to be set first.' });
            return null;
        }
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Trail is too short.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        const expansionPolygon = turf.polygon([points]);

        // Merge the initial stake with the new expansion area to form the final "cookie-cutter" shape.
        const finalCarvePolygon = turf.union(player.infiltratorInitialBasePolygon, expansionPolygon);
        const finalCarveWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(finalCarvePolygon.geometry)}'))`;
        const affectedOwnerIds = new Set();

        console.log(`[INFILTRATOR] Finding victims for carve-out...`);
        const victims = await client.query(`
            SELECT owner_id, username, area FROM territories
            WHERE ST_Intersects(area, ${finalCarveWKT});
        `);

        if (victims.rowCount === 0) {
             console.log(`[INFILTRATOR] Carve shape did not intersect any territory. No action taken.`);
             // Cleanup state and finish
             player.isInfiltratorActive = false;
             player.infiltratorInitialBasePolygon = null;
             return { finalTotalArea: 0, areaClaimed: 0, ownerIdsToUpdate: [] };
        }

        for (const victim of victims.rows) {
            if (victim.owner_id === userId) continue; // Don't carve from self
            
            console.log(`[INFILTRATOR] Carving a hole in ${victim.username}'s territory.`);
            affectedOwnerIds.add(victim.owner_id);
            
            // Use ST_Difference to subtract the carve shape from the victim's territory.
            await client.query(`
                UPDATE territories
                SET
                    area = ST_CollectionExtract(ST_MakeValid(ST_Difference(area, ${finalCarveWKT})), 3),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${finalCarveWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);
        }

        // Cleanup and reset the player's infiltrator state.
        player.isInfiltratorActive = false;
        player.infiltratorInitialBasePolygon = null;
        console.log(`[INFILTRATOR] Carve-out complete. Power deactivated.`);

        // The infiltrator doesn't gain any land, they just destroy it.
        // Return the list of players whose maps need updating.
        return {
            finalTotalArea: 0, // No area gained for the attacker
            areaClaimed: turf.area(finalCarvePolygon), // For stats/display purposes
            ownerIdsToUpdate: Array.from(affectedOwnerIds),
            isInfiltratorCarve: true // Custom flag to differentiate on the client if needed
        };
    }
}

module.exports = { handleInfiltratorClaim };