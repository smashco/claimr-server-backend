// game_logic/solo_handler.js
const { createPolygonGeom } = require('./utils');
const MINIMUM_CLAIM_AREA_SQM = 100;

/**
 * Handles a territory claim for a player in Solo Mode.
 * @param {object} socket - The socket.io socket of the player.
 * @param {object} player - The player object from the server's state.
 * @param {Array<Object>} trail - The array of LatLng points for the new trail.
 * @param {object|null} baseClaim - Data for the initial small circle on a player's first run.
 * @param {object} client - The PostgreSQL client for database transactions.
 * @returns {Promise<object|undefined>} An object with finalTotalArea and ownerIdsToUpdate, or undefined if rejected.
 */
async function handleSoloClaim(socket, player, trail, baseClaim, client) {
    const attackerId = player.googleId;
    let newClaimGeom;

    const trailGeom = createPolygonGeom(trail);
    if (!trailGeom) {
        return socket.emit('claimRejected', { reason: 'Invalid trail for solo claim.' });
    }

    // If a baseClaim exists, it means this is the player's very first run.
    // Merge their trail with the small starting circle.
    if (baseClaim) {
        const { center, radius } = baseClaim;
        if (!center || !radius) {
            return socket.emit('claimRejected', { reason: 'Invalid base data for merge.' });
        }
        const circleGeom = `ST_Buffer(ST_SetSRID(ST_MakePoint(${center.lng}, ${center.lat}), 4326)::geography, ${radius})::geometry`;
        newClaimGeom = `ST_Union(${trailGeom}, ${circleGeom})`;
    } 
    // Otherwise, it's a standard expansion.
    else {
        newClaimGeom = trailGeom;
    }
    
    // Check if the newly formed area is large enough.
    const areaResult = await client.query(`SELECT ST_Area(${newClaimGeom}::geography) as area;`);
    const newArea = areaResult.rows[0].area;
    if (newArea < MINIMUM_CLAIM_AREA_SQM) {
        throw new Error(`Area is too small (${Math.round(newArea)}m²).`);
    }

    // --- Area Steal Logic ---
    // Find all other players whose territory intersects with the new claim.
    const victimsResult = await client.query(
        `SELECT owner_id FROM territories WHERE owner_id != $1 AND area IS NOT NULL AND ST_Intersects(area, ${newClaimGeom})`, 
        [attackerId]
    );
    const victimIds = victimsResult.rows.map(r => r.owner_id);
    const ownerIdsToUpdate = [attackerId, ...victimIds];

    for (const victimId of victimIds) {
        console.log(`[GAME] Attacker ${attackerId} is cutting territory from victim ${victimId}`);
        // This query subtracts the new claim from the victim's territory.
        // It then takes the largest remaining piece to prevent creating tiny, disconnected fragments.
        const smartCutQuery = `
            WITH new_geom AS (SELECT ST_Difference(t.area, ${newClaimGeom}) as geom FROM territories t WHERE t.owner_id = $1),
            dumped AS (SELECT (ST_Dump(geom)).geom as single_geom FROM new_geom),
            largest_piece AS (SELECT single_geom FROM dumped ORDER BY ST_Area(single_geom) DESC LIMIT 1)
            UPDATE territories SET 
                area = (SELECT single_geom FROM largest_piece),
                area_sqm = ST_Area(((SELECT single_geom FROM largest_piece))::geography)
            WHERE owner_id = $1;
        `;
        await client.query(smartCutQuery, [victimId]);
    }

    // --- Add/Update the Attacker's Territory ---
    // Upsert the attacker's territory. If it doesn't exist, create it.
    // If it does, merge the new geometry with the old one.
    const upsertQuery = `
        INSERT INTO territories (owner_id, area, area_sqm) VALUES ($1, ${newClaimGeom}, $2)
        ON CONFLICT (owner_id) DO UPDATE SET 
            area = ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3),
            area_sqm = ST_Area((ST_CollectionExtract(ST_Union(COALESCE(territories.area, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)), ${newClaimGeom}), 3))::geography)
        RETURNING area_sqm;
    `;
    const result = await client.query(upsertQuery, [attackerId, newArea]);
    const finalTotalArea = result.rows[0].area_sqm;

    return { finalTotalArea, ownerIdsToUpdate };
}

module.exports = handleSoloClaim;