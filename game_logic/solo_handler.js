const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive;

    let newAreaPolygon, newAreaSqM;

    // --- Base Claim ---
    if (isInitialBaseClaim) {
        console.log(`[DEBUG] Initial Base Claim`);
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch {
            socket.emit('claimRejected', { reason: 'Invalid base location.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;

        if (isInfiltrator) {
            console.log(`[DEBUG] Infiltrator mode (base)`);
            const result = await client.query(`
                SELECT owner_id, username, is_shield_active, area
                FROM territories
                WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1
                LIMIT 1;
            `, [userId]);

            if (result.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Base must be inside enemy territory.' });
                return null;
            }

            const victim = result.rows[0];

            if (victim.is_shield_active) {
                await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
                socket.emit('claimRejected', { reason: `${victim.username}'s shield blocked the infiltrator.` });

                const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
                if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

                player.isInfiltratorActive = false;
                return null;
            }

            // Carve hole
            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);

            await client.query(`
                INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
                VALUES ($1, $2, $2, ${newAreaWKT}, $3, ST_SetSRID(ST_Point($4, $5), 4326))
                ON CONFLICT (owner_id) DO UPDATE
                SET area = ${newAreaWKT}, area_sqm = $3,
                    original_base_point = ST_SetSRID(ST_Point($4, $5), 4326);
            `, [userId, player.name, newAreaSqM, baseClaim.lng, baseClaim.lat]);

            player.isInfiltratorActive = false;
            return {
                finalTotalArea: newAreaSqM,
                areaClaimed: newAreaSqM,
                ownerIdsToUpdate: [victim.owner_id, userId]
            };
        } else {
            const check = await client.query(`
                SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});
            `);
            if (check.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
                return null;
            }
        }

    } else {
        // --- Expansion Logic ---
        console.log(`[DEBUG] Expansion Claim`);
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Need at least 3 points.' });
            return null;
        }

        const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
        try {
            newAreaPolygon = turf.polygon([points]);
        } catch {
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
            return null;
        }

        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) {
            socket.emit('claimRejected', { reason: 'Area too small.' });
            return null;
        }

        const existingRes = await client.query(`SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1`, [userId]);
        if (existingRes.rowCount === 0) {
            socket.emit('claimRejected', { reason: 'Need a base first.' });
            return null;
        }

        const existingArea = JSON.parse(existingRes.rows[0].geojson_area);
        const intersects = await client.query(`
            SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect;
        `, [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea.geometry || existingArea)]);

        if (!intersects.rows[0].intersect) {
            socket.emit('claimRejected', { reason: 'Must connect to existing land.' });
            return null;
        }
    }

    // --- Shared Logic ---
    console.log(`[DEBUG] Calculating Net Gain...`);
    const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
    const affectedOwnerIds = new Set([userId]);

    let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
    let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

    const victims = await client.query(`
        SELECT owner_id, username, area, is_shield_active FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
    `, [userId]);

    for (const victim of victims.rows) {
        affectedOwnerIds.add(victim.owner_id);

        if (victim.is_shield_active) {
            console.log(`[DEBUG] Shielded: ${victim.username}`);
            await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);

            const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
            if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });

            const diff = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = diff.rows[0].final_geom;
        } else if (isInfiltrator) {
            console.log(`[DEBUG] INFILTRATOR: Carving hole from ${victim.username}`);
            const carve = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [victim.area, attackerNetGainGeom]);

            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid($1::geometry), area_sqm = ST_Area(ST_MakeValid($1::geometry)::geography)
                WHERE owner_id = $2;
            `, [carve.rows[0].final_geom, victim.owner_id]);
        } else {
            console.log(`[DEBUG] Absorbing ${victim.username}`);
            const merge = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = merge.rows[0].final_geom;

            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
        }
    }

    // Final merge with existing territory
    const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    let finalArea = attackerNetGainGeom;

    if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
        const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
        finalArea = unionRes.rows[0].final_area;
    }

    const finalRes = await client.query(`
        SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm;
    `, [finalArea]);

    const finalAreaGeoJSON = finalRes.rows[0].geojson;
    const finalAreaSqM = finalRes.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claim resulted in invalid area.' });
        return null;
    }

    await client.query(`
        INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
        VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
            CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE NULL END)
        ON CONFLICT (owner_id) DO UPDATE
        SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
            original_base_point = CASE WHEN ${isInitialBaseClaim} THEN ST_SetSRID(ST_Point($5, $6), 4326) ELSE territories.original_base_point END;
    `, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim?.lng, baseClaim?.lat]);

    player.isInfiltratorActive = false;

    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM,
        ownerIdsToUpdate: Array.from(affectedOwnerIds)
    };
}

module.exports = handleSoloClaim;
