// game_logic/solo_handler.js

const turf = require('@turf/turf');
const { handleShieldHit } = require('./interactions/shield_interaction');
const { handleWipeout } = require('./interactions/unshielded_interaction');
const { handleInfiltratorClaim } = require('./interactions/infiltrator_interaction');
const { handleCarveOut } = require('./interactions/carve_interaction');
const { updateQuestProgress } = require('./quest_handler'); 
const debug = require('debug')('server:game');

const SOLO_BASE_RADIUS_METERS = 30.0;

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const { isInfiltratorActive, isCarveModeActive } = player;

    if (isInfiltratorActive) {
        debug(`[SOLO_HANDLER] Delegating to Infiltrator handler for base claim for player ${player.name}.`);
        return await handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client);
    }
    
    debug(`\n\n[SOLO_HANDLER] =================== NEW STANDARD CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    debug(`[SOLO_HANDLER] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

    let newAreaPolygon, newAreaSqM;

    if (isInitialBaseClaim) {
        debug(`[SOLO_HANDLER] Processing Initial Base Claim for player ${player.name}`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || SOLO_BASE_RADIUS_METERS;

        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (err) {
            debug(`[SOLO_HANDLER] ERROR: Failed to generate base circle: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        debug(`[SOLO_HANDLER] Base circle area calculated: ${newAreaSqM.toFixed(2)} sqm`);

        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
        if (check.rowCount > 0) {
            debug(`[SOLO_HANDLER] REJECTED: Base overlaps existing territory.`);
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
            return null;
        }
    } else {
        debug(`[SOLO_HANDLER] Processing Expansion Claim for player ${player.name}`);
        if (trail.length < 3) {
            debug(`[SOLO_HANDLER] REJECTED: Trail too short, length is ${trail.length}`);
            socket.emit('claimRejected', { reason: 'Need at least 3 points.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch (err) {
            debug(`[SOLO_HANDLER] ERROR: Invalid polygon geometry from trail: ${err.message}`);
            socket.emit('claimRejected', { reason: 'Invalid polygon geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        debug(`[SOLO_HANDLER] Expansion Area calculated: ${newAreaSqM.toFixed(2)} sqm`);

        if (newAreaSqM < 100) {
            debug(`[SOLO_HANDLER] REJECTED: Area too small (${newAreaSqM.toFixed(2)} sqm).`);
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0) {
            debug(`[SOLO_HANDLER] REJECTED: User ${userId} must claim a base before expanding.`);
            socket.emit('claimRejected', { reason: 'You must claim a base before expanding.' });
            return null;
        }

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            debug(`[SOLO_HANDLER] REJECTED: Expansion does not connect to existing land.`);
            socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing land.' });
            return null;
        }
    }

    debug(`[SOLO_HANDLER] Calculating geometry overlaps and adjustments...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    debug(`[SOLO_HANDLER] Overlapping enemies found: ${victims.rowCount}`);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            attackerNetGainGeom = await handleShieldHit(victim, attackerNetGainGeom, client, io, players);
        } else {
            if (isCarveModeActive) {
                debug('[SOLO_HANDLER] Carve Mode is active. Calling handleCarveOut.');
                await handleCarveOut(victim, attackerNetGainGeom, client);
            } else {
                debug('[SOLO_HANDLER] Standard mode. Calling handleWipeout.');
                attackerNetGainGeom = await handleWipeout(victim, attackerNetGainGeom, client);
            }
        }
    }

    if (isCarveModeActive) {
        debug('[SOLO_HANDLER] Carve mode expansion complete. Deactivating carve mode in DB.');
        await client.query('UPDATE territories SET is_carve_mode_active = false WHERE owner_id = $1', [userId]);
        player.isCarveModeActive = false;
    }

    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        debug(`[SOLO_HANDLER] Merging with existing area for user ${userId}`);
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
    debug(`[SOLO_HANDLER] Final total area calculated: ${finalAreaSqM.toFixed(2)} sqm`);

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        debug(`[SOLO_HANDLER] REJECTED: Final area is invalid or too small.`);
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

    debug(`[SOLO_HANDLER] SUCCESS: Claim committed for ${player.name}: +${newAreaSqM.toFixed(2)} sqm`);

    // Pass the transactional client to the quest handler
    await updateQuestProgress(userId, 'claim_area', Math.round(newAreaSqM), client, io, players);

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;