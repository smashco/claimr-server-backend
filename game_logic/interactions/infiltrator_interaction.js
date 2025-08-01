const turf = require('@turf/turf');

/**
 * @file infiltrator_interaction.js
 * @description Handles the special two-phase claim logic for the Infiltrator role.
 */

async function handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    // =======================================================================
    // PHASE 1: Placing the "Stake"
    // =======================================================================
    if (isInitialBaseClaim) {
        console.log(`[INFILTRATOR] Phase 1: Placing stake.`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        const newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        const newAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);

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

        if (victim.is_shield_active) {
            console.log(`[INFILTRATOR] Blocked by shield of ${victim.username}. Power used up.`);
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            player.isInfiltratorActive = false;
            socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator power.` });
            return null;
        }

        player.infiltratorInitialBasePolygon = newAreaPolygon;
        console.log(`[INFILTRATOR] Stake placed successfully. Awaiting Phase 2 carve-out.`);
        socket.emit('infiltratorBaseSet', { message: 'Base set. Expand to carve out territory.' });
        return { status: 'infiltratorBaseSet' };
    }

    // =======================================================================
    // PHASE 2: The Carve-out
    // =======================================================================
    else {
        console.log(`[INFILTRATOR] Phase 2: Performing carve-out.`);

        if (!player.infiltratorInitialBasePolygon) {
            socket.emit('claimRejected', { reason: 'Infiltrator expansion requires a base to be set first.' });
            return null;
        }
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Trail is too short.' });
            return null;
        }

        // --- FIX: Robustly create and union polygons ---
        
        // 1. Create a list of polygons to be unioned, starting with the guaranteed valid one.
        const polygonsToUnion = [player.infiltratorInitialBasePolygon];

        // 2. Safely create the expansion polygon from the client's trail.
        try {
            const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
            const expansionPolygon = turf.polygon([points]);
            // If creation is successful, add it to our list.
            polygonsToUnion.push(expansionPolygon);
        } catch (err) {
            // If turf.polygon fails (e.g., self-intersecting trail), log it but don't crash.
            // The claim will proceed using only the initial base stake.
            console.warn(`[INFILTRATOR] Warning: Could not create a valid expansion polygon from trail. Error: ${err.message}`);
        }

        // 3. Decide how to create the final shape based on how many valid polygons we have.
        let finalCarvePolygon;
        if (polygonsToUnion.length >= 2) {
            // If we have both the stake and a valid expansion, union them.
            finalCarvePolygon = turf.union(...polygonsToUnion);
        } else {
            // Otherwise, use the only valid polygon we have (the initial stake).
            finalCarvePolygon = polygonsToUnion[0];
        }

        if (!finalCarvePolygon) {
            socket.emit('claimRejected', { reason: 'Could not create a valid shape for carving.' });
            return null;
        }
        // --- END FIX ---

        const finalCarveWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(finalCarvePolygon.geometry)}'))`;
        const affectedOwnerIds = new Set();

        console.log(`[INFILTRATOR] Finding victims for carve-out...`);
        const victims = await client.query(`
            SELECT owner_id, username, area FROM territories
            WHERE ST_Intersects(area, ${finalCarveWKT});
        `);

        if (victims.rowCount === 0) {
             console.log(`[INFILTRATOR] Carve shape did not intersect any territory. No action taken.`);
             player.isInfiltratorActive = false;
             player.infiltratorInitialBasePolygon = null;
             return { finalTotalArea: 0, areaClaimed: 0, ownerIdsToUpdate: [] };
        }

        for (const victim of victims.rows) {
            if (victim.owner_id === userId) continue;
            
            console.log(`[INFILTRATOR] Carving a hole in ${victim.username}'s territory.`);
            affectedOwnerIds.add(victim.owner_id);
            
            await client.query(`
                UPDATE territories
                SET
                    area = ST_CollectionExtract(ST_MakeValid(ST_Difference(area, ${finalCarveWKT})), 3),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${finalCarveWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);
        }

        player.isInfiltratorActive = false;
        player.infiltratorInitialBasePolygon = null;
        console.log(`[INFILTRATOR] Carve-out complete. Power deactivated.`);

        return {
            finalTotalArea: 0,
            areaClaimed: turf.area(finalCarvePolygon),
            ownerIdsToUpdate: Array.from(affectedOwnerIds),
            isInfiltratorCarve: true
        };
    }
}

module.exports = { handleInfiltratorClaim };