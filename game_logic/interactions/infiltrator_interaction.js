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

        // --- NEW DEFENSIVE FIX ---

        const polygonsToUnion = [player.infiltratorInitialBasePolygon];
        let expansionPolygon;
        
        try {
            const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
            expansionPolygon = turf.polygon([points]);
        } catch (err) {
            console.warn(`[INFILTRATOR] Warning: turf.polygon threw an error on trail data: ${err.message}.`);
        }
        
        // Explicitly check if the created polygon is valid before adding it to our list for union.
        // This prevents null or malformed geometries from causing a crash.
        if (expansionPolygon && expansionPolygon.geometry && expansionPolygon.geometry.coordinates.length > 0) {
            polygonsToUnion.push(expansionPolygon);
            console.log('[INFILTRATOR] Expansion trail formed a valid polygon.');
        } else {
            console.warn('[INFILTRATOR] Warning: Expansion trail did not produce a valid polygon. Proceeding with base stake only.');
        }

        let finalCarvePolygon;
        if (polygonsToUnion.length >= 2) {
            finalCarvePolygon = turf.union(...polygonsToUnion);
        } else {
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