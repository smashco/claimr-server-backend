const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;
    const isInitialClaim = !!baseClaim;
    const activePower = player.activePower;
    const isInfiltrator = activePower === 'INFILTRATOR';

    const timestamp = () => new Date().toISOString();
    console.log(`[${timestamp()}] [START] Player: ${playerName}, ID: ${userId}, Power: ${activePower}, InitialClaim: ${isInitialClaim}`);
    console.log(`[${timestamp()}] Full player object:`, JSON.stringify(player, null, 2));

    let newPolygon;

    // ========== BASE CLAIM ==========
    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });
        const area = turf.area(newPolygon);
        console.log(`[${timestamp()}] Generated base circle area: ${area.toFixed(2)} sqm`);

        // Check if player already owns any territory
        const ownResult = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownResult.rowCount > 0;

        // Check for enemy overlaps
        const enemyResult = await client.query(`
            SELECT id, owner_id, is_shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        const enemyCount = enemyResult.rowCount;
        console.log(`[${timestamp()}] Enemy overlaps found: ${enemyCount}`);

        if (enemyCount > 0) {
            const target = enemyResult.rows[0];
            const shielded = target.is_shield_active;

            if (!isInfiltrator) {
                console.log(`[${timestamp()}] [REJECTED] Power required to invade enemy territory.`);
                socket.emit('claimRejected', { reason: 'Use INFILTRATOR to invade enemy territory.' });
                return;
            }

            if (hasOwnTerritory) {
                console.log(`[${timestamp()}] [REJECTED] INFILTRATOR only allowed before first base.`);
                socket.emit('claimRejected', { reason: 'INFILTRATOR can only be used before your first base.' });
                player.activePower = null;
                return;
            }

            if (shielded) {
                console.log(`[${timestamp()}] [BLOCKED] Enemy had shield. Breaking shield.`);
                await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                player.activePower = null;
                socket.emit('claimRejected', { reason: 'Enemy shield absorbed INFILTRATOR. Shield removed. Power consumed.' });
                return;
            }

            // Carve enemy land and insert new territory
            console.log(`[${timestamp()}] [SUCCESS] INFILTRATOR carving into enemy land...`);
            await client.query(`
                UPDATE territories SET area = ST_Difference(area, ST_GeomFromGeoJSON($1))
                WHERE id = $2
            `, [JSON.stringify(newPolygon.geometry), target.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, is_shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
            `, [userId, JSON.stringify(newPolygon.geometry)]);

            player.activePower = null;
            socket.emit('claimAccepted', { message: 'INFILTRATOR successful! Territory claimed.' });
            console.log(`[${timestamp()}] [DONE] INFILTRATOR claim succeeded.`);
            return;
        }

        // INFILTRATOR used, but no enemy
        if (isInfiltrator) {
            console.log(`[${timestamp()}] [REJECTED] INFILTRATOR failed: No enemy target.`);
            socket.emit('claimRejected', { reason: 'No enemy territory found. INFILTRATOR wasted.' });
            player.activePower = null;
            return;
        }

        // Normal base claim (no enemy)
        console.log(`[${timestamp()}] [INFO] No enemy territory. Proceeding with base claim.`);
        await client.query(`
            INSERT INTO territories (owner_id, area, mode, is_shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[${timestamp()}] [SUCCESS] Base claim completed.`);
        return;
    }

    // ========== EXPANSION ==========
    if (!trail || trail.length < 3) {
        console.log(`[${timestamp()}] [REJECTED] Trail too short for expansion.`);
        socket.emit('claimRejected', { reason: 'Closed loop with at least 3 points required for expansion.' });
        return;
    }

    const trailCoords = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
    newPolygon = turf.polygon([trailCoords]);
    const area = turf.area(newPolygon);
    console.log(`[${timestamp()}] Expansion polygon area: ${area.toFixed(2)} sqm`);

    if (area < 100) {
        console.log(`[${timestamp()}] [REJECTED] Expansion too small.`);
        socket.emit('claimRejected', { reason: 'Expansion area must be at least 100 sqm.' });
        return;
    }

    const baseResult = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    if (baseResult.rowCount === 0) {
        console.log(`[${timestamp()}] [REJECTED] Expansion attempted without a base.`);
        socket.emit('claimRejected', { reason: 'You must have a base before expanding.' });
        return;
    }

    const baseArea = baseResult.rows[0].area;
    const connectCheck = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS connected
    `, [JSON.stringify(newPolygon.geometry), baseArea]);

    if (!connectCheck.rows[0].connected) {
        console.log(`[${timestamp()}] [REJECTED] Expansion must be connected to existing territory.`);
        socket.emit('claimRejected', { reason: 'Expansion must be connected to your territory.' });
        return;
    }

    await client.query(`
        UPDATE territories
        SET area = ST_Union(area, ST_GeomFromGeoJSON($1))
        WHERE owner_id = $2
    `, [JSON.stringify(newPolygon.geometry), userId]);

    socket.emit('claimAccepted', { message: 'Territory expanded!' });
    console.log(`[${timestamp()}] [SUCCESS] Expansion added to territory.`);
}

module.exports = handleSoloClaim;
