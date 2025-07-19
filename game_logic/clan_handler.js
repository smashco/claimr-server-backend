// game_logic/clan_handler.js
const { createPolygonGeom } = require('./utils');
const MINIMUM_CLAIM_AREA_SQM = 100;

/**
 * Handles a territory claim for a player in Clan Mode.
 * @param {object} socket - The socket.io socket of the player.
 * @param {object} player - The player object from the server's state.
 * @param {Array<Object>} trail - The array of LatLng points for the new trail.
 * @param {object|null} baseClaim - Data for the base circle if it's the first claim from it.
 * @param {object} client - The PostgreSQL client for database transactions.
 * @returns {Promise<object|undefined>} An object with finalTotalArea and ownerIdsToUpdate, or undefined if rejected.
 */
async function handleClanClaim(socket, player, trail, baseClaim, client) {
    const clanId = player.clanId;
    if (!clanId) {
        throw new Error('Player not in a clan for a clan claim.');
    }

    let newClaimGeom;
    const trailGeom = createPolygonGeom(trail);
    if (!trailGeom) {
        return socket.emit('claimRejected', { reason: 'Invalid trail for clan claim.' });
    }

    // If a baseClaim exists, it means the player is starting a new territory
    // by merging their trail with the large clan base circle.
    if (baseClaim) {
        const { center, radius } = baseClaim;
        if (!center || !radius) {
            return socket.emit('claimRejected', { reason: 'Invalid clan base data for merge.' });
        }
        const circleGeom = `ST_Buffer(ST_SetSRID(ST_MakePoint(${center.lng}, ${center.lat}), 4326)::geography, ${radius})::geometry`;
        newClaimGeom = `ST_Union(${trailGeom}, ${circleGeom})`;
    } 
    // Otherwise, it's a standard expansion from existing territory.
    else {
        newClaimGeom = trailGeom;
    }

    // Check if the newly formed area is large enough.
    const areaResult = await client.query(`SELECT ST_Area(${newClaimGeom}::geography) as area;`);
    const newArea = areaResult.rows[0].area;
    if (newArea < MINIMUM_CLAIM_AREA_SQM) {
        throw new Error(`Area is too small (${Math.round(newArea)}m²).`);
    }
    
    // In clan mode, the only owner ID that needs updating is the clan's ID.
    const ownerIdsToUpdate = [clanId.toString()];

    // Upsert the clan's territory. If it doesn't exist, create it.
    // If it does, merge the new geometry with the old one.
    const upsertQuery = `
        INSERT INTO clan_territories (clan_id, owner_id, area, area_sqm) VALUES ($1, $2, ${newClaimGeom}, $3)
        ON CONFLICT (clan_id) DO UPDATE SET
            area = ST_Union(clan_territories.area, ${newClaimGeom}),
            area_sqm = ST_Area(ST_Union(clan_territories.area, ${newClaimGeom})::geography),
            owner_id = $2
        RETURNING area_sqm;
    `;
    const result = await client.query(upsertQuery, [clanId, player.googleId, newArea]);
    const finalTotalArea = result.rows[0].area_sqm;

    return { finalTotalArea, ownerIdsToUpdate };
}

module.exports = handleClanClaim;