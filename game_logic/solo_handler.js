const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    console.log(`\n\n[DEBUG] =================== NEW CLAIM ===================`);
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;
    const isInfiltrator = player.isInfiltratorActive;

    console.log(`[DEBUG] Claim Type: ${isInitialBaseClaim ? 'BASE' : 'EXPANSION'}`);
    console.log(`[DEBUG] Infiltrator Active: ${isInfiltrator}`);

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
        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;
        console.log(`[DEBUG] Base circle area: ${newAreaSqM.toFixed(2)} sqm`);

        if (isInfiltrator) {
            console.log(`[DEBUG] Attempting Infiltrator Base`);
            const result = await client.query(`
                SELECT owner_id, username, is_shield_active, area
                FROM territories
                WHERE ST_Contains(area, ${newAreaWKT}) AND owner_id != $1
                LIMIT 1;
            `, [userId]);

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

            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);

            await client.query(`
                INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
                VALUES ($1, $2, $2, ST_MakeValid(ST_GeomFromGeoJSON($3)), $4, ST_SetSRID(ST_Point($5, $6), 4326))
                ON CONFLICT (owner_id) DO UPDATE
                SET area = ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3))),
                    area_sqm = ST_Area(ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3)))::geography),
                    original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);
            `, [userId, player.name, JSON.stringify(newAreaPolygon.geometry), newAreaSqM, baseClaim.lng, baseClaim.lat]);

            console.log(`[SUCCESS] Infiltrator base placed successfully`);
            player.isInfiltratorActive = false;

            return {
                finalTotalArea: newAreaSqM,
                areaClaimed: newAreaSqM,
                ownerIdsToUpdate: [victim.owner_id, userId]
            };
        } else {
            const check = await client.query(`SELECT 1 FROM territories WHERE ST_Intersects(area, ${newAreaWKT});`);
            if (check.rowCount > 0) {
                console.log(`[REJECTED] Base overlaps existing territory`);
                socket.emit('claimRejected', { reason: 'Base overlaps existing territory.' });
                return null;
            }

            await client.query(`
                INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
                VALUES ($1, $2, $2, ST_MakeValid(ST_GeomFromGeoJSON($3)), $4, ST_SetSRID(ST_Point($5, $6), 4326))
                ON CONFLICT (owner_id) DO UPDATE
                SET area = ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3))),
                    area_sqm = ST_Area(ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3)))::geography),
                    original_base_point = ST_SetSRID(ST_Point($5, $6), 4326);
            `, [userId, player.name, JSON.stringify(newAreaPolygon.geometry), newAreaSqM, baseClaim.lng, baseClaim.lat]);

            console.log(`[SUCCESS] Base placed successfully`);
            return {
                finalTotalArea: newAreaSqM,
                areaClaimed: newAreaSqM,
                ownerIdsToUpdate: [userId]
            };
        }
    } else {
        console.log(`[DEBUG] Processing Expansion Claim`);
        const coordinates = trail.map(p => [p.lng, p.lat]);
        coordinates.push(coordinates[0]);
        newAreaPolygon = turf.polygon([[...coordinates]]);
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[DEBUG] Expansion Area: ${newAreaSqM.toFixed(2)} sqm`);

        const newAreaWKT = `ST_MakeValid(ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}'))`;

        const victims = await client.query(`
            SELECT owner_id, username, area
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ${newAreaWKT});
        `, [userId]);

        console.log(`[DEBUG] Overlapping enemies found: ${victims.rowCount}`);

        for (const victim of victims.rows) {
            console.log(`[DEBUG] Absorbing ${victim.username}`);
            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);
        }

        console.log(`[DEBUG] Merging with existing area`);

        await client.query(`
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm)
            VALUES ($1, $2, $2, ST_MakeValid(ST_GeomFromGeoJSON($3)), $4)
            ON CONFLICT (owner_id) DO UPDATE
            SET area = ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3))),
                area_sqm = ST_Area(ST_Union(territories.area, ST_MakeValid(ST_GeomFromGeoJSON($3)))::geography);
        `, [userId, player.name, JSON.stringify(newAreaPolygon.geometry), newAreaSqM]);

        const finalArea = await client.query(`
            SELECT area_sqm FROM territories WHERE owner_id = $1;
        `, [userId]);

        const finalTotalArea = finalArea.rows[0]?.area_sqm || newAreaSqM;
        console.log(`[DEBUG] Final total area: ${finalTotalArea.toFixed(2)} sqm`);
        console.log(`[SUCCESS] Claim committed: +${newAreaSqM.toFixed(2)} sqm`);

        const ownerIdsToUpdate = [userId, ...victims.rows.map(v => v.owner_id)];
        return {
            finalTotalArea,
            areaClaimed: newAreaSqM,
            ownerIdsToUpdate
        };
    }
}

module.exports = handleSoloClaim;
