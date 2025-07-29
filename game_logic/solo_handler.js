const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive;

    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);
    console.log(`[DEBUG] Infiltrator Active: ${isInfiltrator}`);

    let newAreaPolygon, newAreaSqM;
    let infiltratorInitialBasePolygon = player.infiltratorInitialBasePolygon || null;

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
        const finalInfiltratorShapeGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        console.log(`[DEBUG] Base circle area: ${newAreaSqM.toFixed(2)} sqm`);

        if (isInfiltrator) {
            console.log(`[DEBUG] Attempting Infiltrator Base`);
            const result = await client.query(`
                SELECT owner_id, username, is_shield_active, area
                FROM territories
                WHERE ST_Contains(area, ST_MakeValid(ST_GeomFromGeoJSON($1))) AND owner_id != $2
                LIMIT 1;
            `, [finalInfiltratorShapeGeoJSON, userId]);

            console.log(`[DEBUG] Enemy Territories Overlapping: ${result.rowCount}`);

            if (result.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Base must be inside enemy territory.' });
                return null;
            }

            const victim = result.rows[0];
            console.log(`[DEBUG] Infiltrator Target: ${victim.username}, Shield Active: ${victim.is_shield_active}`);

            if (victim.is_shield_active) {
                console.log(`[REJECTED] Blocked by shield of ${victim.username}`);
                await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

                const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
                if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

                player.isInfiltratorActive = false;
                socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked your infiltrator power.` });
                return null;
            }

            console.log(`[DEBUG] Carving out base hole from ${victim.username}'s land`);

            // Cut a hole in enemy
            await client.query(
                `UPDATE territories
                 SET area = ST_MakeValid(ST_Difference(area, ST_MakeValid(ST_GeomFromGeoJSON($1))))
                 WHERE owner_id = $2`,
                [finalInfiltratorShapeGeoJSON, victim.owner_id]
            );

            // Add to infiltrator's territory
            await client.query(
                `INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
                 VALUES ($1, $2, $2, ST_MakeValid(ST_GeomFromGeoJSON($3)), $4, ST_SetSRID(ST_Point($5, $6), 4326))
                 ON CONFLICT (owner_id) DO UPDATE
                 SET area = ST_CollectionExtract(ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3))), 3),
                     area_sqm = ST_Area(ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3)))::geography),
                     original_base_point = territories.original_base_point`,
                [userId, player.name, finalInfiltratorShapeGeoJSON, newAreaSqM, baseClaim.lng, baseClaim.lat]
            );

            // Store infiltrator base temporarily
            player.infiltratorInitialBasePolygon = newAreaPolygon;

            console.log(`[SUCCESS] Infiltrator base placed, waiting for expansion`);
            return {
                finalTotalArea: newAreaSqM,
                areaClaimed: newAreaSqM,
                ownerIdsToUpdate: [victim.owner_id, userId]
            };
        } else {
            const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
            const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
            if (check.rowCount > 0) {
                console.log(`[REJECTED] Base overlaps existing territory`);
                socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
                return null;
            }
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

        // Injected Logic: If infiltrator base exists, merge with expansion
        if (isInfiltrator && infiltratorInitialBasePolygon) {
            console.log(`[DEBUG] Merging infiltrator base with expansion shape`);
            newAreaPolygon = turf.union(infiltratorInitialBasePolygon, newAreaPolygon);
            newAreaSqM = turf.area(newAreaPolygon);
            player.infiltratorInitialBasePolygon = null;
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
            console.log(`[DEBUG] ${victim.username} is shielded, skipping carve.`);
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            const diff = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = diff.rows[0].final_geom;
            continue;
        }

        if (isInfiltrator) {
            console.log(`[DEBUG] Infiltrator carving from ${victim.username}`);
            const carve = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [victim.area, attackerNetGainGeom]);

            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid($1::geometry),
                    area_sqm = ST_Area(ST_MakeValid($1::geometry)::geography)
                WHERE owner_id = $2;
            `, [carve.rows[0].final_geom, victim.owner_id]);
        } else {
            console.log(`[DEBUG] Absorbing ${victim.username}`);
            const merge = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = merge.rows[0].final_geom;

            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
        }
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

    player.isInfiltratorActive = false;

    console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm`);
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;
