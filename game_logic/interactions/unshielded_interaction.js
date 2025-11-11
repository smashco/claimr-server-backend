// game_logic/interactions/unshielded_interaction.js

const turf = require('@turf/turf');
const { updateQuestProgress } = require('../quest_handler');
const debug = require('debug')('server:game');

const SOLO_BASE_RADIUS_METERS = 30.0;

async function getFullTerritoryDetails(ownerIds, client) {
    if (!ownerIds || ownerIds.length === 0) return [];
    
    const query = `
        SELECT
            id,
            owner_id as "ownerId",
            owner_name as "ownerName",
            profile_image_url as "profileImageUrl",
            identity_color,
            ST_AsGeoJSON(area) as geojson,
            area_sqm as area,
            laps_required,
            brand_wrapper
        FROM territories
        WHERE owner_id = ANY($1::varchar[]) AND area IS NOT NULL;
    `;
    const result = await client.query(query, [ownerIds]);
    return result.rows.map(row => ({
        ...row,
        geojson: JSON.parse(row.geojson)
    }));
}


async function handleSoloLap(io, socket, player, players, data, client) {
    debug(`[INTERACTION] Processing unshielded interaction for ${player.name}`);
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
        const points = conquerAttempt.path.map(p => [p.lng, p.lat]);
        newAreaPolygon = turf.polygon([points]);
    } else {
        throw new Error("Invalid claim data: No trail, base, or conquer info provided.");
    }
    
    newAreaSqM = turf.area(newAreaPolygon);
    debug(`[INTERACTION] Type: ${interactionType}, Area: ${newAreaSqM.toFixed(2)} sqm`);

    if (interactionType === 'EXPANSION' && newAreaSqM < 100) {
        throw new Error('Claimed area is too small.');
    }

    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    
    // Find all territories that are touched by this new polygon
    const victimsRes = await client.query(`
        SELECT id, owner_id
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);
    
    const affectedOwnerIds = new Set([userId]);
    const affectedTerritoryIds = new Set();
    victimsRes.rows.forEach(v => {
        affectedOwnerIds.add(v.owner_id);
        affectedTerritoryIds.add(v.id);
    });

    // For a conquer, we also need to delete the original territory being conquered
    if (interactionType === 'CONQUER') {
        affectedTerritoryIds.add(conquerAttempt.territoryId);
    }
    
    // Delete all affected victim territories. This simplifies the logic immensely.
    // The attacker claims the new shape, and whatever part of the victim's land was outside that shape is gone.
    if (affectedTerritoryIds.size > 0) {
        await client.query('DELETE FROM territories WHERE id = ANY($1::int[])', [Array.from(affectedTerritoryIds)]);
        debug(`[INTERACTION] Wiped out ${affectedTerritoryIds.size} conflicting territories.`);
    }

    // Now, insert the new territory for the attacker
    const lapsForNewArea = interactionType === 'CONQUER' ? (conquerAttempt.lapsRequired + 1) : 1;
    
    const insertRes = await client.query(
       `INSERT INTO territories (owner_id, owner_name, username, profile_image_url, identity_color, area, area_sqm, laps_required)
        SELECT $1, owner_name, username, profile_image_url, identity_color, ${newAreaWKT}, $2, $3
        FROM territories WHERE owner_id = $1 LIMIT 1
        RETURNING id`,
       [userId, newAreaSqM, lapsForNewArea]
    );
    const newTerritoryId = insertRes.rows[0].id;
    
    // Store the path for future lapping
    const borderPath = (interactionType === 'EXPANSION') 
        ? trail 
        : newAreaPolygon.geometry.coordinates[0].map(p => ({ lat: p[1], lng: p[0] }));

    await client.query(
        'INSERT INTO captured_area_paths (territory_id, path) VALUES ($1, $2)',
        [newTerritoryId, JSON.stringify(borderPath)]
    );

    // Update quest progress
    await updateQuestProgress(userId, 'cover_area', newAreaSqM, client, io, players);
    if (trail) {
        const trailLineString = turf.lineString(trail.map(p => [p.lng, p.lat]));
        const trailLengthKm = turf.length(trailLineString, { units: 'kilometers' });
        await updateQuestProgress(userId, 'run_trail', trailLengthKm, client, io, players);
    }

    const finalTerritories = await getFullTerritoryDetails(Array.from(affectedOwnerIds), client);

    debug(`[INTERACTION] SUCCESS: Interaction for ${player.name} is ready for commit.`);
    return {
        areaClaimed: newAreaSqM,
        newTerritoryId: newTerritoryId,
        updatedTerritories: finalTerritories
    };
}

module.exports = handleSoloLap;