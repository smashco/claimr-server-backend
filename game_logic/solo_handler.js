// game_logic/solo_handler.js
const turf = require('@turf/turf');
const { updateQuestProgress, QUEST_TYPES } = require('./quest_handler');

/**
 * Handles solo player's territory claim logic.
 * @param {object} interactions - An object containing all required interaction handlers.
 * @param {object} context - An object containing server context like io, socket, players, etc.
 * @param {Array} trail - The player's trail.
 * @param {object} baseClaim - The initial base claim data, if any.
 * @param {object} client - The PostgreSQL database client.
 * @param {object} geofenceService - The geofence service instance.
 */
async function handleSoloClaim(interactions, context, trail, baseClaim, client, geofenceService) {
    const { io, socket, player, players } = context;
    const { handleShieldHit, handlePartialTakeover, handleInfiltratorClaim, handleCarveOut } = interactions;

    const { isInfiltratorActive, isCarveModeActive } = player;
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    // ============================
    // Handle Infiltrator Claim
    // ============================
    if (isInfiltratorActive) {
        console.log('[DEBUG] Infiltrator mode active. Delegating...');
        // Note: We pass all necessary context down to the sub-handler.
        return await handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client);
    }

    console.log(`\n[DEBUG] =================== NEW STANDARD CLAIM ===================`);
    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

    // ============================
    // Geofence Validation
    // ============================
    const validationPoint = baseClaim ? baseClaim : (trail.length > 0 ? trail[0] : null);
    if (!validationPoint) {
        socket.emit('claimRejected', { reason: 'Invalid claim data. No starting point.' });
        return null;
    }

    const isLocationValid = await geofenceService.isLocationValid(validationPoint.lat, validationPoint.lng);
    if (!isLocationValid) {
        socket.emit('claimRejected', { reason: 'You are outside the designated playable area.' });
        return null;
    }

    let newAreaPolygon, newAreaSqM;

    // ============================
    // Base Claim
    // ============================
    if (isInitialBaseClaim) {
        console.log(`[DEBUG] Processing Initial Base Claim`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;

        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (err) {
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;

        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
        if (check.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
            return null;
        }

    } else {
        // ============================
        // Expansion Claim
        // ============================
        console.log(`[DEBUG] Processing Expansion Claim`);
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Need at least 3 points.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch (err) {
            socket.emit('claimRejected', { reason: 'Invalid polygon geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) {
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0 || !existingRes.rows[0].geojson_area) {
            socket.emit('claimRejected', { reason: 'You must claim a base before expanding.' });
            return null;
        }

        let existingArea;
        try {
            existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        } catch (e) {
            socket.emit('claimRejected', { reason: 'Server error: Corrupted territory data.' });
            return null;
        }

        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing land.' });
            return null;
        }
    }

    // ============================
    // Overlap Handling
    // ============================
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    let basesAttackedCount = 0;

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);
        basesAttackedCount++;

        if (victim.is_shield_active) {
            // Pass the attacker's 'player' object to handleShieldHit
            attackerNetGainGeom = await handleShieldHit(player, victim, attackerNetGainGeom, client, io, players);
        } else {
            if (isCarveModeActive) {
                await handleCarveOut(victim, attackerNetGainGeom, client);
            } else {
                // FIXED: Assign the return value and pass the correct geometry variable.
                attackerNetGainGeom = await handlePartialTakeover(victim, attackerNetGainGeom, client);
            }
        }
    }

    // ============================
    // Quest Update for Attack
    // ============================
    if (basesAttackedCount > 0) {
        await updateQuestProgress(userId, QUEST_TYPES.ATTACK_BASE, basesAttackedCount, client, io, players);
    }

    // ============================
    // Carve Mode Deactivation
    // ============================
    if (isCarveModeActive) {
        await client.query('UPDATE territories SET is_carve_mode_active = false WHERE owner_id = $1', [userId]);
        player.isCarveModeActive = false;
    }

    // ============================
    // Final Area Calculation
    // ============================
    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const patched = await client.query(`
        SELECT
            ST_AsGeoJSON(ST_CollectionExtract(ST_Multi(ST_RemoveRepeatedPoints(ST_MakeValid($1))), 3)) AS geojson,
            ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
    `, [finalArea]);

    const finalAreaGeoJSON = patched.rows[0].geojson;
    const finalAreaSqM = patched.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Final area is invalid.' });
        return null;
    }

    // ============================
    // Save to DB
    // ============================
    await client.query(`
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
            CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE
        SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
            original_base_point = CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326)
                                       ELSE territories.original_base_point END;
    `, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, isInitialBaseClaim, baseClaim?.lng, baseClaim?.lat]);

    // ============================
    // Quest Update for Successful Run
    // ============================
    if (!isInitialBaseClaim) {
        await updateQuestProgress(userId, QUEST_TYPES.COMPLETE_RUN, 1, client, io, players);
    }

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm by ${player.name}`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;