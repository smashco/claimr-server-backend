// claimr_server/game_logic/clan_handler.js

const turf = require('@turf/turf');

async function handleClanClaim(io, socket, player, trail, baseClaim, client) {
    const clanId = player.clanId;
    const userId = player.googleId;

    // --- STANDARD CLAN EXPANSION CLAIM ---
    const clanInfoResult = await client.query('SELECT base_location, has_shield FROM clans WHERE id = $1', [clanId]);
    if (clanInfoResult.rows.length === 0) {
        socket.emit('claimRejected', { reason: 'Clan not found.' });
        return null;
    }
    const baseLocation = clanInfoResult.rows[0].base_location;
    const clanHasShield = clanInfoResult.rows[0].has_shield;

    if (!baseLocation) {
        socket.emit('claimRejected', { reason: 'Clan base must be established before expansion.' });
        return null;
    }
    if (trail.length < 3) {
        socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' });
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

    const existingClanAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM clan_territories WHERE clan_id = $1', [clanId]);
    const existingClanAreaGeoJSON = existingClanAreaRes.rows.length > 0 ? existingClanAreaRes.rows[0].geojson_area : null;
    const existingClanAreaTurf = existingClanAreaGeoJSON ? JSON.parse(existingClanAreaGeoJSON) : null;

    if (!existingClanAreaTurf || turf.area(existingClanAreaTurf) === 0) {
        console.warn(`[ClanClaim] Player ${userId} attempting expansion for clan ${clanId} but clan has no territory.`);
        socket.emit('claimRejected', { reason: 'Clan base must be established before expansion.' });
        return null;
    }

    const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingClanAreaGeoJSON]);
    if (!intersectsExisting.rows[0].intersects) {
        console.log(`[ClanClaim] Expansion claim for clan ${clanId} does not connect to existing territory.`);
        socket.emit('claimRejected', { reason: 'Expansion must connect to your clan\'s existing territory.' });
        return null;
    }
    
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set();
    affectedOwnerIds.add(clanId.toString());

    // Area Steal logic for clans can be added here in the future if needed

    const unionResult = await client.query(`
        SELECT ST_AsGeoJSON(ST_Union(ST_GeomFromGeoJSON($1), ${newAreaWKT})) AS united_area;
    `, [existingClanAreaGeoJSON]);
    
    const finalClanAreaGeoJSON = unionResult.rows[0].united_area;
    const finalClanAreaSqM = turf.area(JSON.parse(finalClanAreaGeoJSON));
    console.log(`[ClanClaim] Unioned new area for clan ${clanId}. Total: ${finalClanAreaSqM}`);
    
    await client.query(`
        UPDATE clan_territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
        WHERE clan_id = $3;
    `, [finalClanAreaGeoJSON, finalClanAreaSqM, clanId]);

    return {
        finalTotalArea: finalClanAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleClanClaim;