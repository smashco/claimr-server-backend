
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

            // ✅ Step 1: Carve the island (hole) from the victim's territory
            await client.query(`
                UPDATE territories
                SET area = ST_MakeValid(ST_Difference(area, ${newAreaWKT})),
                    area_sqm = ST_Area(ST_MakeValid(ST_Difference(area, ${newAreaWKT}))::geography)
                WHERE owner_id = $1;
            `, [victim.owner_id]);

            // ✅ Step 2: Add the infiltrator's island as a union (not overwrite)
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
        }
    } else {
        // [EXPANSION LOGIC REMAINS UNCHANGED — omitted here for brevity]
        // You already have complete handling for expansion cases.
    }

    // [EXPANSION LOGIC and merging victims is unchanged and continues below...]
    // This handles further merging/collision logic for non-base claims.

    // Your existing expansion logic continues from here...
}

module.exports = handleSoloClaim;