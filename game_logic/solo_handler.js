const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) { 
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    let newAreaPolygon;
    let newAreaSqM;

    // --- SECTION 1: VALIDATE THE CLAIM ---
    if (isInitialBaseClaim) {
        if (!player.isInfiltratorActive) {
            const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
            const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
            const intersectionResult = await client.query(intersectionCheckQuery);
            if (intersectionResult.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; 
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);
    } else {
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        newAreaPolygon = turf.polygon([pointsForPolygon]);
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]); 
        if (existingUserAreaRes.rowCount === 0 || turf.area(JSON.parse(existingUserAreaRes.rows[0].geojson_area)) === 0) {
            socket.emit('claimRejected', { reason: 'You must have a base to expand.' });
            return null;
        }
        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingUserAreaRes.rows[0].geojson_area]);
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }
    
    // --- SECTION 2: PREPARE FOR COMBAT ---
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set([userId]);
    
    let attackerTotalInfluenceGeom;
    const attackerExistingAreaRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    if (attackerExistingAreaRes.rowCount > 0 && attackerExistingAreaRes.rows[0].area) {
        const influenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS full_influence`, [attackerExistingAreaRes.rows[0].area]);
        attackerTotalInfluenceGeom = influenceResult.rows[0].full_influence;
    } else {
        const geomResult = await client.query(`SELECT ${newAreaWKT} as geom`);
        attackerTotalInfluenceGeom = geomResult.rows[0].geom;
    }

    let attackerFinalAreaGeom = attackerTotalInfluenceGeom;

    // --- SECTION 3: PROCESS COMBAT INTERACTIONS ---
    const intersectingTerritoriesQuery = `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`;
    const intersectingTerritoriesResult = await client.query(intersectingTerritoriesQuery, [userId]);

    for (const row of intersectingTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        affectedOwnerIds.add(victimId);
        
        if (row.is_shield_active) {
            console.log(`[GAME] Shield blocked attack. Creating island.`);
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victimId]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victimId);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            // Use ST_CollectionExtract to guarantee a clean polygon result
            const protectedResult = await client.query(`SELECT ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3) as final_geom;`, [attackerFinalAreaGeom, victimCurrentArea]);
            attackerFinalAreaGeom = protectedResult.rows[0].final_geom;

        } else if (player.isInfiltratorActive && isInitialBaseClaim) {
            console.log(`[GAME] Infiltrator is carving a new base from ${row.username}.`);
            // Use ST_CollectionExtract to guarantee a clean polygon result
            const carveResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, ${newAreaWKT}), 3)) as remaining_area;`, [victimCurrentArea]);
            const remainingAreaGeoJSON = carveResult.rows[0].remaining_area;
            const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);

        } else {
            // Use ST_CollectionExtract to guarantee a clean polygon result for the wipeout check
            const diffForWipeoutCheck = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3)) AS remaining_area;`, [victimCurrentArea, attackerTotalInfluenceGeom]);
            const remainingAreaForWipeout = diffForWipeoutCheck.rows[0].remaining_area;
            const remainingSqMWipeout = remainingAreaForWipeout ? turf.area(JSON.parse(remainingAreaForWipeout)) : 0;

            if (Math.round(remainingSqMWipeout) > 10) {
                // PARTIAL HIT
                console.log(`[GAME] Partially claiming territory from ${row.username}.`);
                // Use ST_CollectionExtract to guarantee a clean polygon result for the partial claim
                const partialHitResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, ${newAreaWKT}), 3)) as remaining_area;`, [victimCurrentArea]);
                const remainingAreaGeoJSON = partialHitResult.rows[0].remaining_area;
                const remainingAreaSqM = remainingAreaGeoJSON ? turf.area(JSON.parse(remainingAreaGeoJSON)) : 0;
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
            } else {
                // FULL WIPEOUT
                console.log(`[GAME] Wiping out unshielded player: ${row.username}.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
            }
        }
    }

    // --- SECTION 4: FINALIZE AND SAVE ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalAreaGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }
    
    if (isInitialBaseClaim) {
        const profileRes = await client.query('SELECT username, owner_name, profile_image_url FROM territories WHERE owner_id=$1', [userId]);
        const pUsername = profileRes.rowCount > 0 ? profileRes.rows[0].username : player.name;
        const pOwnerName = profileRes.rowCount > 0 ? profileRes.rows[0].owner_name : player.name;
        const pImageUrl = profileRes.rowCount > 0 ? profileRes.rows[0].profile_image_url : null;
        
        const query = `
            INSERT INTO territories (owner_id, owner_name, username, profile_image_url, area, area_sqm, original_base_point)
            VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, ST_SetSRID(ST_Point($7, $8), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET 
            area = ST_GeomFromGeoJSON($5), 
            area_sqm = $6,
            original_base_point = ST_SetSRID(ST_Point($7, $8), 4326);
        `;
        await client.query(query, [userId, pOwnerName, pUsername, pImageUrl, finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat]);
    } else {
        const query = `UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }
    
    if (player.isInfiltratorActive) {
        player.isInfiltratorActive = false;
        console.log(`[GAME] Consuming INFILTRATOR power for ${player.name}.`);
    }
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleSoloClaim;