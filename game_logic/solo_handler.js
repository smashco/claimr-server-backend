const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!(baseClaim && baseClaim.lat && baseClaim.lng);
    const playerPower = (player.power || '').toLowerCase();

    // =========================================================
    // 🕵️ INFILTRATOR POWER LOGIC
    // =========================================================
    if (playerPower === 'infiltrator') {
        
        // SCENARIO 1: INFILTRATOR SABOTAGE (using a "base claim" action)
        // This is for punching a hole in enemy territory, often as a first move.
        // It does NOT grant any territory to the infiltrator.
        if (isInitialBaseClaim) {
            console.log(`[DEBUG] =================== INFILTRATOR SABOTAGE (via Base Claim) ===================`);
            const center = [baseClaim.lng, baseClaim.lat];
            const radius = baseClaim.radius || 30; // Standard radius for a sabotage hole
            const sabotagePolygon = turf.circle(center, radius, { units: 'meters' });
            const sabotageWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(sabotagePolygon.geometry)}'))`;

            const victims = await client.query(`
                SELECT owner_id, area FROM territories
                WHERE ST_Intersects(area, ${sabotageWKT}) AND owner_id != $1;
            `, [userId]);

            if (victims.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Infiltrator attack must be inside enemy territory.' });
                return null;
            }

            const affectedOwnerIds = new Set();
            for (const victim of victims.rows) {
                affectedOwnerIds.add(victim.owner_id);

                const carved = await client.query(`
                    SELECT ST_Difference($1::geometry, ${sabotageWKT}) AS updated_geom,
                           ST_Area(ST_Difference($1::geometry, ${sabotageWKT})::geography) AS updated_area
                `, [victim.area]);
                
                const updatedGeom = carved.rows[0].updated_geom;
                const updatedAreaSqM = carved.rows[0].updated_area;

                await client.query(`
                    UPDATE territories SET area = $1, area_sqm = $2 WHERE owner_id = $3
                `, [updatedGeom, updatedAreaSqM, victim.owner_id]);
            }
            
            console.log(`[SUCCESS] Infiltrator sabotaged ${affectedOwnerIds.size} territories.`);
            socket.emit('actionSuccess', { message: 'Sabotage successful! You still need to claim a base on empty land.' });

            return {
                finalTotalArea: 0, // Infiltrator's own area is unchanged
                areaClaimed: 0,    // No area is claimed in a sabotage
                ownerIdsToUpdate: Array.from(affectedOwnerIds)
            };
        }
        
        // SCENARIO 2: INFILTRATOR TRAIL (carving a custom shape)
        // This is the logic from your previous request, now correctly placed.
        // It requires staging a point first, then drawing a trail.
        else {
             // This logic assumes a staging mechanism exists (like player.infiltratorStagedPolygon)
             // For simplicity, we are combining the previous implementation here.
            console.log(`[DEBUG] =================== INFILTRATOR EXECUTION (Carve with Trail) ===================`);

            if (!player.infiltratorStagedPolygon) {
                socket.emit('claimRejected', { reason: 'No Infiltrator staging point found. Tap your land first to stage.' });
                return null;
            }
            if (!trail || trail.length < 3) {
                socket.emit('claimRejected', { reason: 'Infiltrator trail must form a loop.' });
                return null;
            }

            const trailPolygon = turf.polygon([[...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]]]);
            const fullInfiltratorPolygon = turf.union(player.infiltratorStagedPolygon, trailPolygon);
            player.infiltratorStagedPolygon = null;

            const fullInfilWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(fullInfiltratorPolygon.geometry)}'))`;
            
            const victims = await client.query(`
                SELECT owner_id, area FROM territories
                WHERE ST_Intersects(area, ${fullInfilWKT}) AND owner_id != $1;
            `, [userId]);

            if (victims.rowCount === 0) {
                socket.emit('claimRejected', { reason: 'Your carving must enter enemy territory.' });
                return null;
            }
            
            let affectedOwnerIds = new Set();
            for (const victim of victims.rows) {
                affectedOwnerIds.add(victim.owner_id);
                const carved = await client.query(`
                    SELECT ST_Difference($1::geometry, ${fullInfilWKT}) AS updated_geom,
                           ST_Area(ST_Difference($1::geometry, ${fullInfilWKT})::geography) AS updated_area
                `, [victim.area]);
                await client.query(`
                    UPDATE territories SET area = $1, area_sqm = $2 WHERE owner_id = $3
                `, [carved.rows[0].updated_geom, carved.rows[0].updated_area, victim.owner_id]);
            }

            console.log(`[SUCCESS] Infiltrator trail carved a hole in enemy land.`);
            return {
                finalTotalArea: 0,
                areaClaimed: 0,
                ownerIdsToUpdate: Array.from(affectedOwnerIds)
            };
        }

    } 
    // =========================================================
    // 🧱 NORMAL BASE / EXPANSION CLAIM LOGIC (For non-Infiltrators)
    // =========================================================
    else {
        console.log(`[DEBUG] =================== NEW CLAIM (Normal Player) ===================`);
        console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);

        let newAreaPolygon, newAreaSqM;

        if (isInitialBaseClaim) {
            const center = [baseClaim.lng, baseClaim.lat];
            const radius = baseClaim.radius || 30;
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
            newAreaSqM = turf.area(newAreaPolygon);
            
            const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
            const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);

            if (check.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
                return null;
            }
        } else {
             if (trail.length < 3) {
                socket.emit('claimRejected', { reason: 'Trail must form a polygon.' });
                return null;
            }
            const points = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
            newAreaPolygon = turf.polygon([points]);
            newAreaSqM = turf.area(newAreaPolygon);

            const existingRes = await client.query(`SELECT 1 FROM territories WHERE owner_id = $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))`, [userId, JSON.stringify(newAreaPolygon.geometry)]);

            if (existingRes.rowCount === 0) {
                 socket.emit('claimRejected', { reason: 'Expansion must connect to your land.' });
                 return null;
            }
        }

        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        const affectedOwnerIds = new Set([userId]);
        let attackerNetGainGeomRes = await client.query(`SELECT ${newAreaWKT} AS geom`);
        let attackerNetGainGeom = attackerNetGainGeomRes.rows[0].geom;

        const victims = await client.query(`
            SELECT owner_id, area, is_shield_active FROM territories
            WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;
        `, [userId]);

        for (const victim of victims.rows) {
            affectedOwnerIds.add(victim.owner_id);
            if (victim.is_shield_active) {
                await client.query(`UPDATE territories SET is_shield_active = false WHERE owner_id = $1`, [victim.owner_id]);
                const vSocketId = Object.keys(players).find(id => players[id]?.googleId === victim.owner_id);
                if (vSocketId) io.to(vSocketId).emit('lastStandActivated', { chargesLeft: 0 });
                const diff = await client.query(`SELECT ST_Difference($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
                attackerNetGainGeom = diff.rows[0].final_geom;
                continue;
            }
            const merge = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_geom`, [attackerNetGainGeom, victim.area]);
            attackerNetGainGeom = merge.rows[0].final_geom;
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1`, [victim.owner_id]);
        }

        const userExisting = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
        let finalArea = attackerNetGainGeom;
        if (userExisting.rowCount > 0 && userExisting.rows[0].area) {
            const unionRes = await client.query(`SELECT ST_Union($1::geometry, $2::geometry) AS final_area`, [userExisting.rows[0].area, attackerNetGainGeom]);
            finalArea = unionRes.rows[0].final_area;
        }

        const patched = await client.query(`
            SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Multi(ST_MakeValid($1)), 3)) AS geojson,
                   ST_Area(ST_MakeValid($1)::geography) AS area_sqm;
        `, [finalArea]);

        const finalAreaGeoJSON = patched.rows[0].geojson;
        const finalAreaSqM = patched.rows[0].area_sqm || 0;

        await client.query(`
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $2, ST_GeomFromGeoJSON($3), $4,
                CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326) ELSE NULL END)
            ON CONFLICT (owner_id) DO UPDATE
            SET area = ST_GeomFromGeoJSON($3), area_sqm = $4,
                original_base_point = CASE WHEN $5 THEN ST_SetSRID(ST_Point($6, $7), 4326)
                                           ELSE territories.original_base_point END;
        `, [userId, player.name, finalAreaGeoJSON, finalAreaSqM, isInitialBaseClaim, baseClaim?.lng, baseClaim?.lat]);

        console.log(`[SUCCESS] Normal claim committed: +${newAreaSqM.toFixed(2)} sqm`);
        return {
            finalTotalArea: finalAreaSqM,
            areaClaimed: newAreaSqM,
            ownerIdsToUpdate: Array.from(affectedOwnerIds)
        };
    }
}

module.exports = handleSoloClaim;