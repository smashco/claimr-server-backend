// game_logic/solo_handler.js
const turf = require('@turf/turf');
// We require the specific interaction handlers we need directly inside this file.
const { handleShieldHit } = require('./interactions/shield_interaction');
const { handleWipeout } = require('./interactions/unshielded_interaction');
const { handleInfiltratorClaim } = require('./interactions/infiltrator_interaction');
const { handleCarveOut } = require('./interactions/carve_interaction');

/**
 * Handles solo player's territory claim logic.
 * This function now uses the simpler, direct argument passing.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} socket - The player's socket connection.
 * @param {object} player - The player object from the server's `players` map.
 * @param {object} players - The map of all connected players.
 * @param {Array} trail - The player's trail.
 * @param {object} baseClaim - The initial base claim data, if any.
 * @param {object} client - The PostgreSQL database client.
 */
async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const { isInfiltratorActive, isCarveModeActive } = player;

    if (isInfiltratorActive) {
        console.log('[DEBUG] Infiltrator mode active. Delegating...');
        return await handleInfiltratorClaim(io, socket, player, players, trail, baseClaim, client);
    }

    console.log(`\n[DEBUG] =================== NEW STANDARD CLAIM ===================`);
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
            // The `socket` variable is now correctly defined and this will work.
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

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        const intersects = await client.query(
            `SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;`,
            [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]
        );

        if (!intersects.rows[0].intersect) {
            socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing land.' });
            return null;
        }
    }

    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(
        `SELECT owner_id, username, area, is_shield_active FROM territories
         WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`,
        [userId]
    );

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            // Note: handleShieldHit now needs the `player` object passed directly
            attackerNetGainGeom = await handleShieldHit(player, victim, attackerNetGainGeom, client, io, players);
        } else if (isCarveModeActive) {
            await handleCarveOut(victim, attackerNetGainGeom, client);
        } else {
            // NEW LOGIC TO DIFFERENTIATE WIPEOUT FROM PARTIAL TAKEOVER
            const containmentCheck = await client.query(
                `SELECT ST_Contains($1::geometry, $2::geometry) AS is_contained;`,
                [attackerNetGainGeom, victim.area]
            );
            const isFullWipeout = containmentCheck.rows[0].is_contained;

            if (isFullWipeout) {
                // The attacker's claim fully contains the victim's territory.
                console.log(`[DEBUG] Attacker's claim FULLY CONTAINS ${victim.username}'s land. Performing full wipeout.`);
                attackerNetGainGeom = await handleWipeout(victim, attackerNetGainGeom, client);
            } else {
                // The attacker's claim only partially hits the victim.
                console.log(`[PARTIAL TAKEOVER] Slicing territory from ${victim.username}.`);
                await client.query(
                    `UPDATE territories SET area = ST_Difference(area, $1::geometry), area_sqm = ST_Area(ST_Difference(area, $1::geometry)::geography) WHERE owner_id = $2;`,
                    [attackerNetGainGeom, victim.owner_id]
                );
                console.log(`[PARTIAL TAKEOVER] ${victim.username}'s territory has been sliced.`);
            }
        }
    }

    if (isCarveModeActive) {
        await client.query('UPDATE territories SET is_carve_mode_active = false WHERE owner_id = $1', [userId]);
        player.isCarveModeActive = false;
    }

    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const patched = await client.query(
        `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Multi(ST_RemoveRepeatedPoints(ST_MakeValid($1))), 3)) AS geojson, ST_Area(ST_MakeValid($1)::geography) AS area_sqm;`,
        [finalArea]
    );

    const finalAreaGeoJSON = patched.rows[0].geojson;
    const finalAreaSqM = patched.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Final area is invalid.' });
        return null;
    }

    await client.query(
        `INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
         VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE NULL END)
         ON CONFLICT (owner_id) DO UPDATE
         SET area = ST_GeomFromGeoJSON($3), area_sqm = $4, original_base_point = CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE territories.original_base_point END;`,
        [userId, player.name, finalAreaGeoJSON, finalAreaSqM, isInitialBaseClaim, baseClaim?.lng, baseClaim?.lat]
    );

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm by ${player.name}`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;