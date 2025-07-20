// claimr_server/game_logic/solo_handler.js

const turf = require('@turf/turf');

async function handleSoloClaim(socket, player, trail, baseClaim, client) {
    if (!player.googleId || trail.length < 3) {
        socket.emit('claimRejected', { reason: 'Invalid trail for claim.' });
        return null;
    }

    const userId = player.googleId;
    const trailLine = turf.lineString(trail.map(p => [p.lng, p.lat]));

    // Close the loop to form a polygon
    const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
    let newAreaPolygon;
    try {
        newAreaPolygon = turf.polygon([pointsForPolygon]);
    } catch (e) {
        console.error(`[SoloClaim] Error creating polygon from trail for ${userId}:`, e.message);
        socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
        return null;
    }

    // Check minimum area
    const newAreaSqM = turf.area(newAreaPolygon);
    if (newAreaSqM < 100) { // Minimum 100 square meters for a valid claim
        socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
        return null;
    }

    // Convert newAreaPolygon to WKT for PostGIS
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;

    // --- Step 1: Handle Area Steal (if new area intersects existing territories) ---
    const territoriesToUpdate = new Set(); // Track all owner_ids affected by this claim
    territoriesToUpdate.add(userId);

    const intersectingTerritoriesQuery = `
        SELECT owner_id, area FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;

        // Perform difference operation to cut out the stolen area
        const diffGeomResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
        `, [victimCurrentArea]);

        const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;

        if (remainingAreaGeoJSON) {
            const remainingAreaTurf = JSON.parse(remainingAreaGeoJSON);
            const remainingAreaSqM = turf.area(remainingAreaTurf);
            
            await client.query(`
                UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                WHERE owner_id = $3;
            `, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
            console.log(`[SoloClaim] Stolen from ${victimId}. Remaining area: ${remainingAreaSqM}`);
            territoriesToUpdate.add(victimId);
        } else {
            // Entire territory was stolen or fragmented into nothing
            await client.query(`
                UPDATE territories SET area = NULL, area_sqm = 0
                WHERE owner_id = $1;
            `, [victimId]);
            console.log(`[SoloClaim] Entire territory stolen from ${victimId}.`);
            territoriesToUpdate.add(victimId);
        }
    }

    // --- Step 2: Add / Union New Area to Player's Territory ---
    let finalAreaSqM;
    let finalAreaGeoJSON;

    const existingUserAreaResult = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (existingUserAreaResult.rows.length > 0 && existingUserAreaResult.rows[0].area) {
        // Union with existing area
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(area, ${newAreaWKT})) AS united_area;
        `, [existingUserAreaResult.rows[0].area]);
        finalAreaGeoJSON = unionResult.rows[0].united_area;
        finalAreaSqM = turf.area(JSON.parse(finalAreaGeoJSON));
        console.log(`[SoloClaim] Unioned new area for ${userId}. Total: ${finalAreaSqM}`);
    } else {
        // First claim
        finalAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        finalAreaSqM = newAreaSqM;
        console.log(`[SoloClaim] First claim for ${userId}. Total: ${finalAreaSqM}`);
    }

    await client.query(`
        UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
        WHERE owner_id = $3;
    `, [finalAreaGeoJSON, finalAreaSqM, userId]);

    // Return the total area claimed by this user/clan and all affected owner_ids for batch update
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, // For AAR screen
        ownerIdsToUpdate: Array.from(territoriesToUpdate) // Convert Set to Array
    };
}

module.exports = handleSoloClaim;