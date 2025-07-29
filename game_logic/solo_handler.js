const turf = require('@turf/turf');
const { handleInfiltratorBaseClaim } = require('./interactions/infiltrator_interaction');
const { handleShieldHit } = require('./interactions/shield_interaction');
const { handleUnshieldedInteraction } = require('./interactions/unshielded_interaction');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    console.log(`[DEBUG] Attacker: ${player.name} (${player.id})`);

    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon, newAreaSqM;

    // Part 1: Initial Claim Logic
    if (isInitialBaseClaim) {
        if (player.isInfiltratorActive) {
            return await handleInfiltratorBaseClaim(io, socket, player, players, baseClaim, client);
        }
        console.log(`[DEBUG] Processing Regular Base Claim.`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        try { newAreaPolygon = turf.circle(center, radius, { units: 'meters' }); } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid base geometry.' }); return null;
        }
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
        if (check.rowCount > 0) {
            socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' }); return null;
        }
    } else {
    // Part 2: Expansion Logic
        console.log(`[DEBUG] Processing Expansion Claim.`);
        if (trail.length < 3) { socket.emit('claimRejected', { reason: 'Expansion trail too short.' }); return null; }
        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try { newAreaPolygon = turf.polygon([points]); } catch (e) {
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' }); return null;
        }
        const existingRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]);
        if (existingRes.rowCount === 0) { socket.emit('claimRejected', { reason: 'You must have a base to expand.' }); return null; }
        const intersects = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;`, [JSON.stringify(newAreaPolygon.geometry), existingRes.rows[0].geojson_area]);
        if (!intersects.rows[0].intersect) { socket.emit('claimRejected', { reason: 'Expansion must connect to your territory.' }); return null; }
    }
    
    newAreaSqM = turf.area(newAreaPolygon);
    if (newAreaSqM < 100 && !isInitialBaseClaim) { socket.emit('claimRejected', { reason: 'Area too small (min 100sqm).' }); return null; }

    // Part 3: Shared Interaction Logic
    console.log(`[DEBUG] Calculating territory changes...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);
    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;
    
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerExistingAreaRes.rows[0]?.area || `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;
    const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingArea]);
    const attackerInfluenceZone = influenceResult.rows[0].full_influence;

    const victims = await client.query(`SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`, [userId]);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);
        if (victim.is_shield_active) {
            attackerNetGainGeom = await handleShieldHit(victim, attackerNetGainGeom, client, io, players);
        } else {
            attackerNetGainGeom = await handleUnshieldedInteraction(victim, newAreaWKT, attackerNetGainGeom, attackerInfluenceZone, client);
        }
    }

    // Part 4: Final Merge and Save
    let finalAreaGeom;
    const attackerCurrentAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerCurrentAreaRes.rowCount > 0 && attackerCurrentAreaRes.rows[0].area) {
        const unionResult = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [attackerCurrentAreaRes.rows[0].area, attackerNetGainGeom]);
        finalAreaGeom = unionResult.rows[0].final_area;
    } else {
        finalAreaGeom = attackerNetGainGeom;
    }

    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [finalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claim was nullified by protected territories.' });
        return null;
    }

    const saveQuery = `
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4, CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `;
    await client.query(saveQuery, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);
    
    player.isInfiltratorActive = false; // Final fallback reset
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;