// game_logic/solo_handler.js

const turf = require('@turf/turf');
const { updateQuestProgress } = require('./quest_handler');
const debug = require('debug')('server:game');

const SOLO_BASE_RADIUS_METERS = 30.0;

/**
 * Handles all solo player claims, differentiating logic based on the game mode.
 * - 'territoryWar' & 'areaCapture': Enables area stealing, shield checks, and island creation.
 * - 'singleRun': A simple, non-destructive area claim.
 */
async function handleSoloClaim(io, socket, player, players, req, client, superpowerManager) {
    debug(`\n\n[SOLO_HANDLER] =================== NEW SOLO CLAIM ===================`);

    const { trail, baseClaim } = req;
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    debug(`[SOLO_HANDLER] Claim by: ${player.name} (${userId}) in mode [${player.gameMode}]`);
    debug(`[SOLO_HANDLER] Claim Type: ${isInitialBaseClaim ? 'INITIAL BASE' : 'EXPANSION'}`);

    let newAreaPolygon, newAreaSqM;
    let newTerritoryId = null;

    try {
        if (isInitialBaseClaim) {
            debug(`[SOLO_HANDLER] Processing Initial Base Claim.`);
            if (!baseClaim || typeof baseClaim.lng !== 'number' || typeof baseClaim.lat !== 'number') {
                throw new Error('Invalid coordinates in baseClaim object. `lat` and `lng` must be numbers.');
            }
            const center = [baseClaim.lng, baseClaim.lat];
            const radius = baseClaim.radius || SOLO_BASE_RADIUS_METERS;

            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
            newAreaSqM = turf.area(newAreaPolygon);
            debug(`[SOLO_HANDLER] Base area calculated: ${newAreaSqM.toFixed(2)} sqm`);

            const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
            const overlapCheck = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
            if (overlapCheck.rowCount > 0) {
                throw new Error('Base overlaps existing territory.');
            }
        } else {
            debug(`[SOLO_HANDLER] Processing Expansion Claim.`);
            if (!trail || trail.length < 3) {
                throw new Error('Trail is too short to form a valid area.');
            }
            const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
            newAreaPolygon = turf.polygon([points]);
            newAreaSqM = turf.area(newAreaPolygon);
            debug(`[SOLO_HANDLER] Expansion Area calculated: ${newAreaSqM.toFixed(2)} sqm`);

            if (newAreaSqM < 100) {
                throw new Error('Claimed area is too small.');
            }
        }
    } catch (err) {
        debug(`[SOLO_HANDLER] ERROR during geometry definition: ${err.message}`);
        throw err;
    }

    let newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);
    // --- COMPETITIVE LOGIC FOR TERRITORY WAR & AREA CAPTURE ---
    if (player.gameMode === 'territoryWar' || player.gameMode === 'areaCapture') {
        debug(`[SOLO_HANDLER][COMPETITIVE] Running Shield logic for mode: ${player.gameMode}`);

        // Find overlapping territories
        const victimsRes = await client.query(`
            SELECT owner_id, username
            FROM territories
            WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
        `, [userId]);

        if (victimsRes.rowCount > 0) {
            debug(`[SOLO_HANDLER][COMPETITIVE] Found ${victimsRes.rowCount} overlapping territories. Applying Shield.`);

            const victimIds = victimsRes.rows.map(v => v.owner_id);
            victimIds.forEach(id => affectedOwnerIds.add(id));

            // Subtract ALL overlapping victim areas from the new area (Shield behavior)
            // We clip the NEW area so it fits around existing territories.
            const diffQuery = `
                SELECT ST_AsGeoJSON(
                    ST_Multi(
                        ST_Difference(
                            ${newAreaWKT},
                            (SELECT ST_Union(area) FROM territories WHERE owner_id = ANY($1::varchar[]))
                        )
                    )
                ) as geojson
            `;

            const diffRes = await client.query(diffQuery, [victimIds]);

            if (diffRes.rows.length > 0 && diffRes.rows[0].geojson) {
                const clippedGeoJSON = JSON.parse(diffRes.rows[0].geojson);

                // Check if the resulting geometry is empty (fully blocked)
                if (!clippedGeoJSON.coordinates || clippedGeoJSON.coordinates.length === 0) {
                    throw new Error(`Claim blocked! You cannot claim land inside another player's territory.`);
                }

                // Update newAreaPolygon to the clipped geometry
                // This ensures the subsequent merge step uses the clipped area.
                newAreaPolygon = turf.feature(clippedGeoJSON);

                // Recalculate area size for the clipped area
                newAreaSqM = turf.area(newAreaPolygon);
                debug(`[SOLO_HANDLER][COMPETITIVE] New area clipped by shield. Remaining size: ${newAreaSqM.toFixed(2)} sqm`);

                if (newAreaSqM < 1) { // Minimal threshold
                    throw new Error(`Claim blocked! Overlap left too little area.`);
                }
                // Update newAreaWKT for subsequent use
                newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;

            } else {
                // Result is empty/null -> Fully blocked
                throw new Error(`Claim blocked! You cannot claim land inside another player's territory.`);
            }
        }
    }
    // --- END OF COMPETITIVE LOGIC ---

    const userExistingRes = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);

    if (userExistingRes.rowCount > 0 && userExistingRes.rows[0].area) {
        debug(`[SOLO_HANDLER] Merging new area with existing land for user ${userId}`);
        const unionRes = await client.query(`SELECT ST_AsGeoJSON(ST_Union(area, ST_GeomFromGeoJSON($1))) as geojson FROM territories WHERE owner_id = $2`, [finalAreaGeoJSON, userId]);
        finalAreaGeoJSON = unionRes.rows[0].geojson;
    }

    const finalAreaSqMRes = await client.query(`SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) as area`, [finalAreaGeoJSON]);
    const finalAreaSqM = finalAreaSqMRes.rows[0].area || 0;
    debug(`[SOLO_HANDLER] Final total area for ${player.name}: ${finalAreaSqM.toFixed(2)} sqm`);

    const updateResult = await client.query(
        `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3 RETURNING id`,
        [finalAreaGeoJSON, finalAreaSqM, userId]
    );

    if (updateResult.rowCount > 0) {
        newTerritoryId = updateResult.rows[0].id;
    }

    await updateQuestProgress(userId, 'cover_area', Math.round(newAreaSqM), client, io, players);

    if (!isInitialBaseClaim && trail && trail.length > 0) {
        const trailLineString = turf.lineString(trail.map(p => [p.lng, p.lat]));
        const trailLengthKm = turf.length(trailLineString, { units: 'kilometers' });
        debug(`[SOLO_HANDLER] Trail length for this claim was ${trailLengthKm.toFixed(3)} km.`);
        await updateQuestProgress(userId, 'run_trail', trailLengthKm, client, io, players);
    }

    // Fetch all affected territory data to broadcast back to all clients
    const updatedTerritories = [];
    const allAffectedIds = Array.from(affectedOwnerIds);
    if (allAffectedIds.length > 0) {
        const queryResult = await client.query(`
            SELECT 
                id,
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
            [allAffectedIds]
        );
        queryResult.rows.forEach(r => {
            updatedTerritories.push({ ...r, geojson: r.geojson ? JSON.parse(r.geojson) : null });
        });
    }

    debug(`[SOLO_HANDLER] SUCCESS: Claim transaction for ${player.name} is ready to be committed.`);

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        newTerritoryId: newTerritoryId,
        updatedTerritories: updatedTerritories
    };
}

module.exports = handleSoloClaim;