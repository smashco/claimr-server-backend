const turf = require('@turf/turf');

/**
 * @file infiltrator_interaction.js
 * @description Handles the special claim logic for an Infiltrator's base.
 * This function creates a permanent base for the Infiltrator inside enemy territory
 * and activates "Carve Mode" for their next expansion by setting a persistent DB flag.
 */
async function handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;

    if (!baseClaim) {
        socket.emit('claimRejected', { reason: 'Infiltrator power can only be used to claim a new base.' });
        player.isInfiltratorActive = false;
        return null;
    }

    console.log('[INFILTRATOR] Processing Infiltrator Base Claim.');
    const center = [baseClaim.lng, baseClaim.lat];
    const radius = baseClaim.radius || 30;
    const newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
    const newAreaSqM = turf.area(newAreaPolygon);
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

    console.log(`[INFILTRATOR] Carving out base hole from ${victim.username}'s land.`);
    await client.query(
        `UPDATE territories
         SET area = ST_MakeValid(ST_Difference(area, ST_MakeValid(ST_GeomFromGeoJSON($1)))),
             area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ST_MakeValid(ST_GeomFromGeoJSON($1))))::geography)
         WHERE owner_id = $2`,
        [newAreaGeoJSON, victim.owner_id]
    );

    await client.query(
        `INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
         VALUES ($1, $2, $2, ST_MakeValid(ST_GeomFromGeoJSON($3)), $4, ST_SetSRID(ST_Point($5, $6), 4326))
         ON CONFLICT (owner_id) DO UPDATE
         SET area = ST_MakeValid(ST_GeomFromGeoJSON($3)),
             area_sqm = $4,
             original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);`,
        [userId, player.name, newAreaGeoJSON, newAreaSqM, baseClaim.lng, baseClaim.lat]
    );

    player.isInfiltratorActive = false;
    
    // --- UPDATED: Set the persistent flag in the database ---
    await client.query('UPDATE territories SET is_carve_mode_active = true WHERE owner_id = $1', [userId]);
    // Also update the current in-memory object so the state is consistent for this session
    player.isCarveModeActive = true; 

    console.log(`[SUCCESS] Infiltrator base placed successfully. Carve mode activated for next run.`);
    return {
        finalTotalArea: newAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: [victim.owner_id, userId]
    };
}

module.exports = { handleInfiltratorClaim };