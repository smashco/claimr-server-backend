const turf = require('@turf/turf');
const { handleShieldHit } = require('./interactions/shield_interaction');
const { handleWipeout } = require('./interactions/unshielded_interaction');
const { handleInfiltratorClaim } = require('./interactions/infiltrator_interaction');
const { handleCarveOut } = require('./interactions/carve_interaction');
// Add the import for the new interaction handler
const { handlePartialWipeout } = require('./interactions/partial_wipeout_interaction');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const { isInfiltratorActive, isCarveModeActive } = player;

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

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
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

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            attackerNetGainGeom = await handleShieldHit(victim, attackerNetGainGeom, client, io, players);
        } else { // This is the unshielded case
            if (isCarveModeActive) {
                console.log('[DEBUG] Carve Mode is active. Calling handleCarveOut.');
                await handleCarveOut(victim, attackerNetGainGeom, client);
            } else {
                // === MODIFICATION START ===
                // This is the new logic for standard (non-carve) unshielded interactions
                console.log(`[DEBUG] Standard interaction with ${victim.username}. Checking for full vs. partial wipeout.`);

                // Check if the attacker's new claim polygon COMPLETELY CONTAINS the victim's territory
                const containmentCheck = await client.query(
                    `SELECT ST_Contains($1::geometry, $2::geometry) as contains`,
                    [attackerNetGainGeom, victim.area]
                );

                if (containmentCheck.rows[0].contains) {
                    // If the victim is fully inside the new claim, it's a full wipeout.
                    console.log(`[DEBUG] Attacker's claim fully contains ${victim.username}. Calling handleWipeout.`);
                    attackerNetGainGeom = await handleWipeout(victim, attackerNetGainGeom, client);
                } else {
                    // If it's just an intersection, it's a partial wipeout.
                    // The victim loses the intersected area and any smaller, disconnected pieces.
                    console.log(`[DEBUG] Attacker's claim partially intersects ${victim.username}. Calling handlePartialWipeout.`);
                    await handlePartialWipeout(victim, attackerNetGainGeom, client);
                }
                // === MODIFICATION END ===
            }
        }
    }

    // --- UPDATED: Reset the Carve Mode flag in the database ---
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

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;