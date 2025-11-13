const turf = require('@turf/turf');
const { updateQuestProgress } = require('../quest_handler');
const debug = require('debug')('server:game');

const SOLO_BASE_RADIUS_METERS = 30.0;

/**
 * Handles a player's attempt to claim territory in solo mode.
 * This version is designed for a schema where each user has ONE row and their 'area' is a MultiPolygon/GeometryCollection.
 */
async function handleSoloClaim(io, socket, player, players, data, client) {
    debug(`[SOLO_HANDLER_V2] Processing claim for ${player.name}`);
    const userId = player.googleId;
    const { trail, baseClaim, conquerAttempt } = data;

    let newAreaPolygon, newAreaSqM, interactionType;

    if (baseClaim) {
        interactionType = 'INITIAL_BASE';
        const center = [baseClaim.lng, baseClaim.lat];
        newAreaPolygon = turf.circle(center, baseClaim.radius || SOLO_BASE_RADIUS_METERS, { units: 'meters' });
    } else if (trail) {
        interactionType = 'EXPANSION';
        if (trail.length < 3) throw new Error('Trail is too short to form a valid area.');
        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        newAreaPolygon = turf.polygon([points]);
    } else if (conquerAttempt) {
        interactionType = 'CONQUER';
        // In a conquer, the new polygon IS the path of the area being conquered
        const points = conquerAttempt.path.map(p => [p.lng, p.lat]);
        newAreaPolygon = turf.polygon([points]);
    } else {
        throw new Error("Invalid claim data: No trail, base, or conquer info provided.");
    }
    
    newAreaSqM = turf.area(newAreaPolygon);
    if (newAreaSqM < 100 && !baseClaim) {
        throw new Error('Claimed area is too small.');
    }

    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    
    // Find all territories that are touched by this new polygon
    const victimsRes = await client.query(`
        SELECT owner_id, username, is_shield_active
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);
    
    const affectedOwnerIds = new Set([userId]);
    
    // First, check for any active shields before proceeding
    for (const victim of victimsRes.rows) {
        if (victim.is_shield_active) {
            debug(`[SOLO_HANDLER_V2] ATTACK BLOCKED by ${victim.username}'s shield.`);
            throw new Error(`Your run was blocked by ${victim.username}'s Last Stand!`);
        }
    }

    // If no shields, apply damage to all victims
    for (const victim of victimsRes.rows) {
        affectedOwnerIds.add(victim.owner_id);
        debug(`[SOLO_HANDLER_V2] Calculating damage for victim: ${victim.username}`);
        const remainingVictimAreaWKT = `ST_Multi(ST_Difference(area, ${newAreaWKT}))`;
        await client.query(
            `UPDATE territories SET area = ${remainingVictimAreaWKT}, area_sqm = ST_Area((${remainingVictimAreaWKT})::geography) WHERE owner_id = $1`, 
            [victim.owner_id]
        );
    }

    // Add the new area to the attacker's existing territory
    const attackerTerritoryWKT = `ST_Union(COALESCE(area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newAreaWKT})`;
    const result = await client.query(
        `UPDATE territories 
         SET area = ${attackerTerritoryWKT}, area_sqm = ST_Area((${attackerTerritoryWKT})::geography) 
         WHERE owner_id = $1
         RETURNING area_sqm`,
        [userId]
    );
    
    if (result.rowCount === 0) {
        throw new Error("Attacker's profile not found in territories table.");
    }
    const finalTotalArea = result.rows[0].area_sqm;

    // Update quest progress
    await updateQuestProgress(userId, 'cover_area', newAreaSqM, client, io, players);
    
    if (trail && trail.length >= 2) {
        const trailLineString = turf.lineString(trail.map(p => [p.lng, p.lat]));
        const trailLengthKm = turf.length(trailLineString, { units: 'kilometers' });
        await updateQuestProgress(userId, 'run_trail', trailLengthKm, client, io, players);
    }

    // Fetch all updated territory data to broadcast back to all clients
    const updatedTerritories = [];
    if (affectedOwnerIds.size > 0) {
        const queryResult = await client.query(`
            SELECT 
                owner_id as "ownerId", 
                username as "ownerName", 
                profile_image_url as "profileImageUrl", 
                identity_color, 
                ST_AsGeoJSON(area) as geojson, 
                area_sqm as area,
                laps_required,
                brand_wrapper
            FROM territories 
            WHERE owner_id = ANY($1::varchar[])`, 
            [Array.from(affectedOwnerIds)]
        );
        queryResult.rows.forEach(r => {
            updatedTerritories.push({...r, id: r.ownerId, geojson: r.geojson ? JSON.parse(r.geojson) : null });
        });
    }
    
    debug(`[SOLO_HANDLER_V2] Claim successful for ${player.name}. New total area: ${finalTotalArea.toFixed(2)}`);
    return {
        finalTotalArea: finalTotalArea,
        areaClaimed: newAreaSqM,
        updatedTerritories: updatedTerritories,
        // ===== FIX START: Always return the user's string ID =====
        newTerritoryId: userId
        // ===== FIX END =====
    };
}

module.exports = handleSoloClaim;
//zsvsz/sss