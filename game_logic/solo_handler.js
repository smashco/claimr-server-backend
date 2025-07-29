const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;
    const isInitialClaim = !!baseClaim;
    const activePower = player.activePower;
    const isInfiltrator = activePower === 'INFILTRATOR';

    console.log(`[DEBUG] [START] Player: ${playerName}, ID: ${userId}, Power: ${activePower}, InitialClaim: ${isInitialClaim}`);
    console.log('[DEBUG] Full player object:', JSON.stringify(player, null, 2));

    let newPolygon;

    // ========== Base Claim ==========
    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });
        const area = turf.area(newPolygon);
        console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

        // Check if player already owns any territory
        const ownTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownTerritory.rows.length > 0;

        // Check for enemy overlaps
        const enemyQuery = await client.query(`
            SELECT id, owner_id, area, is_shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        const enemyCount = enemyQuery.rowCount;
        console.log(`[DEBUG] Enemy overlaps found: ${enemyCount}`);

        if (enemyCount > 0) {
            const target = enemyQuery.rows[0];
            const shielded = target.is_shield_active;

            if (!isInfiltrator) {
                console.log(`[REJECTED] Power required to invade.`);
                socket.emit('claimRejected', { reason: 'Use INFILTRATOR to invade enemy territory.' });
                return;
            }

            if (isInfiltrator && hasOwnTerritory) {
                console.log(`[REJECTED] INFILTRATOR only works before claiming your first base.`);
                socket.emit('claimRejected', { reason: 'INFILTRATOR can only be used before your first claim.' });
                player.activePower = null;
                return;
            }

            if (shielded) {
                console.log(`[INFILTRATOR BLOCKED] Enemy shield absorbed it.`);
                await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                player.activePower = null;
                socket.emit('claimRejected', { reason: 'Enemy shield absorbed INFILTRATOR. Shield removed. Power consumed.' });
                return;
            }

            // Carve enemy land
            console.log(`[SUCCESS] INFILTRATOR carving enemy territory...`);
            await client.query(`
                UPDATE territories SET area = ST_Difference(area, ST_GeomFromGeoJSON($1)) WHERE id = $2
            `, [JSON.stringify(newPolygon.geometry), target.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, is_shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
            `, [userId, JSON.stringify(newPolygon.geometry)]);

            player.activePower = null;
            socket.emit('claimAccepted', { message: 'INFILTRATOR claim successful!' });
            console.log(`[SUCCESS] INFILTRATOR claim succeeded.`);
            return;
        }

        // INFILTRATOR used but no enemy
        if (isInfiltrator) {
            console.log(`[REJECTED] INFILTRATOR failed: no enemy target.`);
            socket.emit('claimRejected', { reason: 'No enemy territory found. INFILTRATOR wasted.' });
            player.activePower = null;
            return;
        }

        // Normal base claim
        await client.query(`
            INSERT INTO territories (owner_id, area, mode, is_shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[SUCCESS] Base claim completed.`);
        return;
    }

    // ========== Expansion Claim ==========
    if (!trail || trail.length < 3) {
        console.log(`[REJECTED] Not enough trail points.`);
        socket.emit('claimRejected', { reason: 'You must form a closed loop with at least 3 points.' });
        return;
    }

    const trailCoords = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
    newPolygon = turf.polygon([trailCoords]);
    const area = turf.area(newPolygon);
    console.log(`[DEBUG] Expansion area: ${area.toFixed(2)} sqm`);

    if (area < 100) {
        console.log(`[REJECTED] Expansion too small.`);
        socket.emit('claimRejected', { reason: 'Expansion too small. Minimum 100 sqm required.' });
        return;
    }

    const playerTerritories = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    if (playerTerritories.rows.length === 0) {
        console.log(`[REJECTED] Expansion attempted without a base.`);
        socket.emit('claimRejected', { reason: 'You need a base before expanding.' });
        return;
    }

    const baseArea = playerTerritories.rows[0].area;
    const connectCheck = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS connected
    `, [JSON.stringify(newPolygon.geometry), baseArea]);

    if (!connectCheck.rows[0].connected) {
        console.log(`[REJECTED] Expansion not connected.`);
        socket.emit('claimRejected', { reason: 'Your expansion must connect to your existing territory.' });
        return;
    }

    await client.query(`
        UPDATE territories SET area = ST_Union(area, ST_GeomFromGeoJSON($1)) WHERE owner_id = $2
    `, [JSON.stringify(newPolygon.geometry), userId]);

    socket.emit('claimAccepted', { message: 'Territory expanded!' });
    console.log(`[SUCCESS] Expansion added to territory.`);
}

module.exports = handleSoloClaim;
