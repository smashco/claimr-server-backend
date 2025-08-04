// game_logic/solo_handler.js
const turf = require('@turf/turf');
const { handleShieldHit } = require('./interactions/shield_interaction');
const { handleWipeout } = require('./interactions/unshielded_interaction');
const { handleInfiltratorClaim } = require('./interactions/infiltrator_interaction');
const { handleCarveOut } = require('./interactions/carve_interaction');
const { updateQuestProgress, QUEST_TYPES } = require('./quest_handler');

/**
 * Handles all logic for a solo player's territory claim, including geofence checks and quest updates.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} socket - The player's socket.
 * @param {object} player - The player's in-memory data.
 * @param {object} players - The map of all online players.
 * @param {Array<object>} trail - The array of LatLng points for the claim.
 * @param {object|null} baseClaim - Data for an initial base claim.
 * @param {object} client - The PostgreSQL database client.
 * @param {object} geofenceService - The geofence service instance for validation.
 * @returns {Promise<object|null>} The result of the claim or null if failed.
 */
async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client, geofenceService) {
    const { isInfiltratorActive, isCarveModeActive } = player;

    // --- GEOFENCE VALIDATION ---
    const validationPoint = baseClaim ? baseClaim : (trail.length > 0 ? trail[0] : null);
    if (!validationPoint) {
        socket.emit('claimRejected', { reason: 'Invalid claim data. No starting point.' });
        return null;
    }

    const isLocationValid = await geofenceService.isLocationValid(validationPoint.lat, validationPoint.lng);
    if (!isLocationValid) {
        console.log(`[REJECTED] Claim by ${player.name} at (${validationPoint.lat}, ${validationPoint.lng}) is outside playable area.`);
        socket.emit('claimRejected', { reason: 'You are outside the designated playable area.' });
        return null;
    }
    // --- END GEOFENCE VALIDATION ---

    if (isInfiltratorActive) {
        console.log('[DEBUG] Delegating to Infiltrator handler for base claim.');
        return await handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client);
    }
    
    console.log(`\n\n[DEBUG] =================== NEW STANDARD CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

    let newAreaPolygon, newAreaSqM;

    if (isInitialBaseClaim) {
        console.log(`[DEBUG] Processing Initial Base Claim`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;

        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (err) {
            console.log(`[ERROR] Failed to generate base circle: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG] Base circle area: ${newAreaSqM.toFixed(2)} sqm`);

        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
        if (check.rowCount > 0) {
            console.log(`[REJECTED] Base overlaps existing territory`);
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
            return null;
        }
    } else {
        console.log(`[DEBUG] Processing Expansion Claim`);
        if (trail.length < 3) {
            console.log(`[REJECTED] Trail too short`);
            socket.emit('claimRejected', { reason: 'Need at least 3 points.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch (err) {
            console.log(`[ERROR] Invalid polygon: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid polygon geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG] Expansion Area: ${newAreaSqM.toFixed(2)} sqm`);

        if (newAreaSqM < 100) {
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'You must claim a base before expanding.' });
            return null;
        }
        
        const geojsonString = existingRes.rows[0].geojson_area;
        if (!geojsonString) {
            socket.emit('claimRejected', { reason: 'Cannot expand from a non-existent territory.' });
            return null;
        }
        
        let existingArea;
        try {
            existingArea = JSON.parse(geojsonString);
        } catch (e) {
            console.error('[ERROR] Failed to parse existing area GeoJSON:', e);
            socket.emit('claimRejected', { reason: 'Server error: Corrupted territory data.' });
            return null;
        }
        
        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            console.log(`[REJECTED] Expansion does not connect`);
            socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing land.' });
            return null;
        }
    }

    console.log(`[DEBUG] Calculating geometry overlaps and adjustments...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    console.log(`[DEBUG] Overlapping enemies found: ${victims.rowCount}`);

    let basesAttackedCount = 0;

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);
        basesAttackedCount++;

        if (victim.is_shield_active) {
            attackerNetGainGeom = await handleShieldHit(victim, attackerNetGainGeom, client, io, players);
        } else {
            if (isCarveModeActive) {
                console.log('[DEBUG] Carve Mode is active. Calling handleCarveOut.');
                await handleCarveOut(victim, attackerNetGainGeom, client);
            } else {
                console.log('[DEBUG] Standard mode. Calling handleWipeout.');
                attackerNetGainGeom = await handleWipeout(victim, attackerNetGainGeom, client);
            }
        }
    }
    
    if (basesAttackedCount > 0) {
        await updateQuestProgress(userId, QUEST_TYPES.ATTACK_BASE, basesAttackedCount, client, io, players);
    }

    if (isCarveModeActive) {
        console.log('[DEBUG] Carve mode expansion complete. Deactivating carve mode in DB.');
        await client.query('UPDATE territories SET is_carve_mode_active = false WHERE owner_id = $1', [userId]);
        player.isCarveModeActive = false;
    }

    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        console.log(`[DEBUG] Merging with existing area`);
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const patched = await client.query(`
        SELECT
            ST_AsGeoJSON(
                ST_CollectionExtract(ST_Multi(ST_RemoveRepeatedPoints(ST_MakeValid($1))), 3)
            ) AS geojson,
            ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
    `, [finalArea]);

    const finalAreaGeoJSON = patched.rows[0].geojson;
    const finalAreaSqM = patched.rows[0].area_sqm || 0;
    console.log(`[DEBUG] Final total area: ${finalAreaSqM.toFixed(2)} sqm`);

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Final area is invalid.' });
        return null;
    }

    await client.query(`
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
            CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE
        SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
            original_base_point = CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326)
                                       ELSE territories.original_base_point END;
    `, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, isInitialBaseClaim, baseClaim?.lng, baseClaim?.lat]);

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm for player ${player.name}`);

    // --- NEW: QUEST HOOK FOR COMPLETING A RUN ---
    // This is only triggered on a successful expansion claim, not the initial base.
    if (!isInitialBaseClaim) {
        await updateQuestProgress(userId, QUEST_TYPES.COMPLETE_RUN, 1, client, io, players);
    }
    // --- END NEW QUEST HOOK ---

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;