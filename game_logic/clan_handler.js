// claimr_server/game_logic/clan_handler.js

const turf = require('@turf/turf');

async function handleClanClaim(socket, player, trail, baseClaim, client) {
    if (!player.googleId || !player.clanId || trail.length < 3) {
        socket.emit('claimRejected', { reason: 'Invalid claim data for clan mode.' });
        return null;
    }

    const clanId = player.clanId;
    const userId = player.googleId;
    
    // Clan base validation
    if (!baseClaim) {
        socket.emit('claimRejected', { reason: 'Clan claims must start from an active clan base.' });
        return null;
    }

    // Ensure the trail starts from within the clan's active base location
    const clanBaseResult = await client.query('SELECT base_location FROM clans WHERE id = $1', [clanId]);
    if (clanBaseResult.rows.length === 0 || !clanBaseResult.rows[0].base_location) {
        socket.emit('claimRejected', { reason: 'Clan base is not active.' });
        return null;
    }
    
    const baseLocationWKT = clanBaseResult.rows[0].base_location;
    // Check if the start of the trail (first point) is within a reasonable distance of the base
    const startPoint = trail[0];
    const distanceThreshold = 70; // meters - adjusted slightly larger than base radius for tolerance
    const distanceCheckResult = await client.query(`
        SELECT ST_Distance(
            ST_Transform(ST_SetSRID(ST_GeomFromText('POINT(${startPoint.lng} ${startPoint.lat})'), 4326), 28355),
            ST_Transform($1, 28355)
        ) AS distance_meters;
    `, [baseLocationWKT]);

    if (distanceCheckResult.rows[0].distance_meters > distanceThreshold) {
        socket.emit('claimRejected', { reason: 'Trail must start closer to the clan base.' });
        return null;
    }

    const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
    let newAreaPolygon;
    try {
        newAreaPolygon = turf.polygon([pointsForPolygon]);
    } catch (e) {
        console.error(`[ClanClaim] Error creating polygon from trail for clan ${clanId}:`, e.message);
        socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
        return null;
    }

    const newAreaSqM = turf.area(newAreaPolygon);
    if (newAreaSqM < 100) {
        socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
        return null;
    }

    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;

    // --- Clan Area Claim (Union with existing clan territory) ---
    let finalClanAreaSqM;
    let finalClanAreaGeoJSON;

    const existingClanAreaResult = await client.query('SELECT area FROM clan_territories WHERE clan_id = $1', [clanId]);
    if (existingClanAreaResult.rows.length > 0 && existingClanAreaResult.rows[0].area) {
        // Union with existing clan territory
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(area, ${newAreaWKT})) AS united_area;
        `, [existingClanAreaResult.rows[0].area]);
        finalClanAreaGeoJSON = unionResult.rows[0].united_area;
        finalClanAreaSqM = turf.area(JSON.parse(finalClanAreaGeoJSON));
        console.log(`[ClanClaim] Unioned new area for clan ${clanId}. Total: ${finalClanAreaSqM}`);
        await client.query(`
            UPDATE clan_territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
            WHERE clan_id = $3;
        `, [finalClanAreaGeoJSON, finalClanAreaSqM, clanId]);
    } else {
        // First claim for this clan
        finalClanAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        finalClanAreaSqM = newAreaSqM;
        console.log(`[ClanClaim] First claim for clan ${clanId}. Total: ${finalClanAreaSqM}`);
        await client.query(`
            INSERT INTO clan_territories (clan_id, owner_id, area, area_sqm)
            VALUES ($1, $2, ST_GeomFromGeoJSON($3), $4);
        `, [clanId, userId, finalClanAreaGeoJSON, finalClanAreaSqM]);
    }
    
    // Clan claims do not steal from solo players directly via this handler.
    // Solo players can't steal from clan territories.

    // Return the total area claimed by this clan and the clan's ID for batch update
    return {
        finalTotalArea: finalClanAreaSqM,
        areaClaimed: newAreaSqM, // For AAR screen
        ownerIdsToUpdate: [clanId] // Only the clan's territory needs to be updated
    };
}

module.exports = handleClanClaim;