// claimr_server/game_logic/solo_handler.js

const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, trail, baseClaim, client) { // Added 'io' parameter
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const playerHasShield = player.hasShield; // Get shield status from player object

    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        // For initial base claim, create a circle polygon
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; // Default to 30m if not specified
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (e) {
            console.error(`[SoloClaim] Error creating initial base circle for ${userId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[SoloClaim] Initial base claim attempt for ${userId}. Area: ${newAreaSqM} sqm.`);

        // Check if player already has an initial base point (prevent re-claiming first base)
        const existingBaseCheck = await client.query('SELECT original_base_point FROM territories WHERE owner_id = $1', [userId]);
        if (existingBaseCheck.rows.length > 0 && existingBaseCheck.rows[0].original_base_point) {
            socket.emit('claimRejected', { reason: 'You already have an initial base.' });
            return null;
        }

    } else {
        // For expansion claims, process the trail
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points to form a polygon.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try {
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        } catch (e) {
            console.error(`[SoloClaim] Error creating polygon from trail for ${userId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }

        // Check if the new expansion claim connects to existing territory (must overlap)
        const existingUserAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
        const existingArea = existingUserAreaRes.rows.length > 0 ? existingUserAreaRes.rows[0].area : null;

        // If no existing area AND it's not an initial base claim, then this is an invalid expansion attempt
        if (!existingArea || turf.area(JSON.parse(JSON.stringify(existingArea))) === 0) { // Also check if existing area is empty geometry
            console.warn(`[SoloClaim] Player ${userId} attempting expansion claim but has no existing territory.`);
            socket.emit('claimRejected', { reason: 'You must claim an initial base first or connect to existing territory.' });
            return null;
        }

        // If there's an existing area, check if the new polygon intersects it
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), $2) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingArea]);
        if (!intersectsExisting.rows[0].intersects) {
            console.log(`[SoloClaim] Expansion claim for ${userId} does not connect to existing territory.`);
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }

    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set(); 
    affectedOwnerIds.add(userId); 

    // --- Area Steal Mechanism ---
    const intersectingTerritoriesQuery = `
        SELECT owner_id, username, area, has_shield, ST_AsText(original_base_point) as original_base_point_wkt
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        const victimUsername = row.username;
        const victimHasShield = row.has_shield;
        const victimOriginalBasePointWKT = row.original_base_point_wkt;

        // Calculate the intersection area
        // Use ST_Intersection to get the actual geometry of the overlap
        const intersectionGeomResult = await client.query(`SELECT ST_AsGeoJSON(ST_Intersection(ST_GeomFromGeoJSON($1), $2)) AS intersected_geom;`, [JSON.stringify(newAreaPolygon.geometry), victimCurrentArea]);
        const intersectedGeomGeoJSON = intersectionGeomResult.rows[0].intersected_geom;
        const intersectedSqM = intersectedGeomGeoJSON ? turf.area(JSON.parse(intersectedGeomGeoJSON)) : 0;

        if (intersectedSqM > 0) {
            console.log(`[SoloClaim] ${player.name} intersects ${victimUsername}'s territory. Intersected area: ${intersectedSqM} sqm`);

            // Shield logic: If victim has shield, and the intersection includes their original base point
            let shieldActivated = false;
            if (victimHasShield && victimOriginalBasePointWKT) {
                // Check if the actual intersection geometry overlaps the original base point
                const basePointIntersectsClaim = await client.query(`SELECT ST_Intersects(ST_GeomFromText($1), ST_GeomFromGeoJSON($2)) AS intersects_base_point;`, [victimOriginalBasePointWKT, intersectedGeomGeoJSON]);
                if (basePointIntersectsClaim.rows[0].intersects_base_point) {
                    shieldActivated = true;
                    console.log(`[SoloClaim] Shield activated for ${victimUsername}'s base point! Claim Rejected.`);
                    socket.emit('claimRejected', { reason: `Shield activated for ${victimUsername}'s base! Cannot steal this area.` });
                    return null; // Reject the entire claim if it attempts to steal a shielded base point
                }
            }
            
            // If shield not activated, proceed with subtraction
            const diffGeomResult = await client.query(`
                SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
            `, [victimCurrentArea]);

            const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;

            if (remainingAreaGeoJSON && JSON.parse(remainingAreaGeoJSON).coordinates.length > 0) { 
                const remainingAreaTurf = JSON.parse(remainingAreaGeoJSON);
                const remainingAreaSqM = turf.area(remainingAreaTurf);
                
                await client.query(`
                    UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                    WHERE owner_id = $3;
                `, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
                console.log(`[SoloClaim] Stolen from ${victimId}. Remaining area: ${remainingAreaSqM}`);
                affectedOwnerIds.add(victimId);

                // Notify victim of area steal
                const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                if (victimSocket) {
                  victimSocket.emit('runTerminated', { reason: `${player.name} has stolen some of your territory!` }); 
                }
            } else {
                // Entire territory was stolen or fragmented into nothing
                await client.query(`
                    UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0
                    WHERE owner_id = $1;
                `, [victimId]);
                console.log(`[SoloClaim] Entire territory stolen from ${victimId}.`);
                affectedOwnerIds.add(victimId);
                 const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                 if (victimSocket) {
                   victimSocket.emit('runTerminated', { reason: `${player.name} has acquired your entire area!` });
                 }
            }
        }
    }

    // --- Add / Union New Area to Player's Territory ---
    let finalAreaSqM;
    let finalAreaGeoJSON;

    const existingUserAreaResult = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const existingUserArea = existingUserAreaResult.rows.length > 0 ? existingUserAreaResult.rows[0].area : null;

    if (existingUserArea && turf.area(JSON.parse(JSON.stringify(existingUserArea))) > 0) { 
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union($1, ${newAreaWKT})) AS united_area;
        `, [existingUserArea]);
        finalAreaGeoJSON = unionResult.rows[0].united_area;
        finalAreaSqM = turf.area(JSON.parse(finalAreaGeoJSON));
        console.log(`[SoloClaim] Unioned new area for ${userId}. Total: ${finalAreaSqM}`);
    } else {
        // First claim (initial base) or reclaiming after all area lost
        finalAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        finalAreaSqM = newAreaSqM;
        console.log(`[SoloClaim] Initial/reclaim area for ${userId}. Total: ${finalAreaSqM}`);
    }

    await client.query(`
        UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 ${isInitialBaseClaim ? ', original_base_point = ST_SetSRID(ST_Point($4, $5), 4326)' : ''}
        WHERE owner_id = $3;
    `, [finalAreaGeoJSON, finalAreaSqM, userId, isInitialBaseClaim ? baseClaim.lng : null, isInitialBaseClaim ? baseClaim.lat : null]);

    // Return results and affected owner IDs for batch update
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;