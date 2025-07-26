const turf = require('@turf/turf');

/**
 * Handles all logic for a solo player's territory claim, including validation and combat.
 */
async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const isInitialBaseClaim = !!baseClaim;

    // --- SECTION 1: VALIDATE AND CREATE THE NEW CLAIM POLYGON ---
    let newAreaPolygon;
    let newAreaSqM;

    if (isInitialBaseClaim) {
        // It's a new base claim (a circle)
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30; // 30 meters default radius
        newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        newAreaSqM = turf.area(newAreaPolygon);

        // For non-infiltrators, the base cannot be inside existing territory
        if (!player.isInfiltratorActive) {
            const basePointWKT = `ST_SetSRID(ST_Point(${baseClaim.lng}, ${baseClaim.lat}), 4326)`;
            const intersectionCheckQuery = `SELECT 1 FROM territories WHERE ST_Intersects(area, ${basePointWKT});`;
            const intersectionResult = await client.query(intersectionCheckQuery);
            if (intersectionResult.rowCount > 0) {
                socket.emit('claimRejected', { reason: 'Cannot claim a new base inside existing territory.' });
                return null;
            }
        }
    } else {
        // It's an expansion claim (a loop from a trail)
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

        // Expansion must connect to the player's existing territory
        const existingUserAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM territories WHERE owner_id = $1', [userId]);
        const existingArea = existingUserAreaRes.rows.length > 0 ? JSON.parse(existingUserAreaRes.rows[0].geojson_area) : null;
        if (!existingArea || turf.area(existingArea) === 0) {
            socket.emit('claimRejected', { reason: 'You must have a base to expand.' });
            return null;
        }
        const intersectsExisting = await client.query(
            `SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`,
            [JSON.stringify(newAreaPolygon.geometry), JSON.stringify(existingArea)]
        );
        if (!intersectsExisting.rows[0].intersects) {
            socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
            return null;
        }
    }

    // --- SECTION 2: CALCULATE ATTACKER'S POTENTIAL AREA & IDENTIFY VICTIMS ---
    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    
    const attackerRes = await client.query('SELECT area FROM territories WHERE owner_id = $1', [userId]);
    const attackerExistingArea = attackerRes.rowCount > 0 ? attackerRes.rows[0].area : `ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')`;

    const potentialInfluenceResult = await client.query(`SELECT ST_Union($1::geometry, ${newAreaWKT}) AS geom`, [attackerExistingArea]);
    const attackerPotentialInfluenceGeom = potentialInfluenceResult.rows[0].geom;

    let attackerFinalGeom = attackerPotentialInfluenceGeom;
    
    const victimsRes = await client.query(
        `SELECT owner_id, username, area, is_shield_active FROM territories WHERE ST_Intersects(area, ${newAreaWKT}) AND owner_id != $1;`,
        [userId]
    );

    const ownerIdsToUpdate = new Set([userId]);

    // --- SECTION 3: PROCESS COMBAT INTERACTIONS WITH EACH VICTIM ---
    for (const victim of victimsRes.rows) {
        ownerIdsToUpdate.add(victim.owner_id);

        if (victim.is_shield_active) {
            // SCENARIO A: SHIELDED VICTIM
            console.log(`[GAME] Attack blocked by shield from ${victim.username}. Creating island in attacker's territory.`);
            
            const protectedResult = await client.query(
                `SELECT ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3) as final_geom;`,
                [attackerFinalGeom, victim.area]
            );
            attackerFinalGeom = protectedResult.rows[0].final_geom;
            
            await client.query('UPDATE territories SET is_shield_active = false WHERE owner_id = $1', [victim.owner_id]);
            const victimSocketId = Object.keys(players).find(id => players[id] && players[id].googleId === victim.owner_id);
            if (victimSocketId) io.to(victimSocketId).emit('lastStandActivated', { chargesLeft: 0 });

        } else if (player.isInfiltratorActive && isInitialBaseClaim) {
            // SCENARIO B: INFILTRATOR BASE CLAIM
            console.log(`[GAME] Infiltrator is carving a new base out of ${victim.username}.`);
            const carveResult = await client.query(`SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, ${newAreaWKT}), 3)) as remaining_area;`, [victim.area]);
            const remainingAreaGeoJSON = carveResult.rows[0].remaining_area;
            const remainingAreaSqM = remainingAreaGeoJSON ? (turf.area(JSON.parse(remainingAreaGeoJSON)) || 0) : 0;
            await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingAreaGeoJSON, remainingAreaSqM, victim.owner_id]);

        } else {
            // SCENARIO C: UNSHIELDED VICTIM
            const remainingVictimResult = await client.query(
                `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3)) as remaining_geojson;`,
                [victim.area, attackerPotentialInfluenceGeom]
            );
            
            const remainingGeoJSON = remainingVictimResult.rows[0].remaining_geojson;
            const remainingSqM = remainingGeoJSON ? (turf.area(JSON.parse(remainingGeoJSON)) || 0) : 0;

            if (remainingSqM < 1) {
                console.log(`[GAME] Wiping out unshielded player: ${victim.username}.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victim.owner_id]);
            } else {
                console.log(`[GAME] Partially claiming territory from ${victim.username}.`);
                await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, [remainingGeoJSON, remainingSqM, victim.owner_id]);
            }
        }
    }

    // --- SECTION 4: FINALIZE ATTACKER'S CLAIM AND SAVE ---
    const finalAreaResult = await client.query('SELECT ST_AsGeoJSON($1) as geojson, ST_Area($1::geography) as area_sqm', [attackerFinalGeom]);
    const finalAreaGeoJSON = finalAreaResult.rows[0].geojson;
    const finalAreaSqM = finalAreaResult.rows[0].area_sqm || 0;

    if (!finalAreaGeoJSON || finalAreaSqM < 1) {
        socket.emit('claimRejected', { reason: 'Claimed area was nullified by protected territories.' });
        return null;
    }
    
    // --- CORRECTED LOGIC ---
    if (isInitialBaseClaim) {
        // For a new base, we INSERT or UPDATE the original_base_point.
        const query = `
            INSERT INTO territories (owner_id, owner_name, username, area, area_sqm, original_base_point)
            VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4), $5, ST_SetSRID(ST_Point($6, $7), 4326))
            ON CONFLICT (owner_id) DO UPDATE SET 
                area = ST_GeomFromGeoJSON($4), 
                area_sqm = $5,
                original_base_point = ST_SetSRID(ST_Point($6, $7), 4326);
        `;
        await client.query(query, [userId, player.name, player.name, finalAreaGeoJSON, finalAreaSqM, baseClaim.lng, baseClaim.lat]);
    } else {
        // For an expansion, the row must already exist. We only UPDATE area and area_sqm.
        // This avoids the SQL syntax error.
        const query = `
            UPDATE territories 
            SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 
            WHERE owner_id = $3;
        `;
        await client.query(query, [finalAreaGeoJSON, finalAreaSqM, userId]);
    }
    
    if (player.isInfiltratorActive) {
        player.isInfiltratorActive = false;
        console.log(`[GAME] Consuming INFILTRATOR power-up for ${player.name}.`);
    }
    
    return {
        finalTotalArea: finalAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(ownerIdsToUpdate) 
    };
}

module.exports = handleSoloClaim;