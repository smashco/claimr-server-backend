const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;
    const isInitialClaim = !!baseClaim;
    const activePower = player.activePower || null;
    const isInfiltrator = activePower === 'INFILTRATOR';

    console.log(`[${new Date().toISOString()}] [DEBUG] [START] Player: ${playerName}, ID: ${userId}, Power: ${activePower}, InitialClaim: ${isInitialClaim}`);
    console.log(`[${new Date().toISOString()}] [DEBUG] Full player object: ${JSON.stringify(player, null, 2)}`);

    let newPolygon;

    // ========== BASE CLAIM ==========
    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });

        const area = turf.area(newPolygon);
        console.log(`[${new Date().toISOString()}] [DEBUG] Generated base circle area: ${area.toFixed(2)} sqm`);

        // Check if player already owns any territory
        const ownTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownTerritory.rows.length > 0;

        // Check for overlapping enemy territories
        const enemyQuery = await client.query(`
            SELECT id, owner_id, is_shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        const enemyCount = enemyQuery.rowCount;
        console.log(`[${new Date().toISOString()}] [DEBUG] Enemy overlaps found: ${enemyCount}`);

        // 🛡️ Enemy found
        if (enemyCount > 0) {
            const enemy = enemyQuery.rows[0];
            const shielded = enemy.is_shield_active;

            // ❌ Power required
            if (!isInfiltrator) {
                console.log(`[${new Date().toISOString()}] [REJECTED] Power required to invade enemy territory.`);
                socket.emit('claimRejected', { reason: 'Use INFILTRATOR to invade enemy territory.' });
                return;
            }

            // ❌ Infiltrator can only be used before claiming base
            if (isInfiltrator && hasOwnTerritory) {
                console.log(`[${new Date().toISOString()}] [REJECTED] INFILTRATOR only allowed before first base.`);
                socket.emit('claimRejected', { reason: 'INFILTRATOR can only be used before your first claim.' });
                player.activePower = null;
                return;
            }

            // 🛡️ Shield blocks it
            if (shielded) {
                console.log(`[${new Date().toISOString()}] [BLOCKED] Enemy shield absorbed INFILTRATOR.`);
                await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [enemy.id]);
                player.activePower = null;
                socket.emit('claimRejected', { reason: 'Enemy shield absorbed INFILTRATOR. Shield removed. Power consumed.' });
                return;
            }

            // ✅ Carve enemy land
            console.log(`[${new Date().toISOString()}] [SUCCESS] INFILTRATOR carving enemy territory...`);

            await client.query(`
                UPDATE territories SET area = ST_Difference(area, ST_GeomFromGeoJSON($1)) WHERE id = $2
            `, [JSON.stringify(newPolygon.geometry), enemy.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, is_shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
            `, [userId, JSON.stringify(newPolygon.geometry)]);

            player.activePower = null;
            socket.emit('claimAccepted', { message: 'INFILTRATOR claim successful!' });
            console.log(`[${new Date().toISOString()}] [SUCCESS] INFILTRATOR claim completed.`);
            return;
        }

        // INFILTRATOR wasted if no enemy
        if (isInfiltrator) {
            console.log(`[${new Date().toISOString()}] [WASTED] INFILTRATOR used but no enemy territory.`);
            player.activePower = null;
            socket.emit('claimRejected', { reason: 'No enemy found. INFILTRATOR wasted.' });
            return;
        }

        // ✅ Normal base claim
        await client.query(`
            INSERT INTO territories (owner_id, area, mode, is_shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[${new Date().toISOString()}] [SUCCESS] Base claim completed.`);
        return;
    }

    // ========== EXPANSION CLAIM ==========
    if (!trail || trail.length < 3) {
        console.log(`[${new Date().toISOString()}] [REJECTED] Not enough trail points for expansion.`);
        socket.emit('claimRejected', { reason: 'You must form a closed loop with at least 3 points.' });
        return;
    }

    const trailCoords = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
    newPolygon = turf.polygon([trailCoords]);

    const expansionArea = turf.area(newPolygon);
    console.log(`[${new Date().toISOString()}] [DEBUG] Expansion area: ${expansionArea.toFixed(2)} sqm`);

    if (expansionArea < 100) {
        console.log(`[${new Date().toISOString()}] [REJECTED] Expansion too small.`);
        socket.emit('claimRejected', { reason: 'Expansion too small. Minimum 100 sqm required.' });
        return;
    }

    const playerTerritories = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);

    if (playerTerritories.rows.length === 0) {
        console.log(`[${new Date().toISOString()}] [REJECTED] Expansion without a base.`);
        socket.emit('claimRejected', { reason: 'You need a base before expanding.' });
        return;
    }

    const baseArea = playerTerritories.rows[0].area;

    const connectionCheck = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS connected
    `, [JSON.stringify(newPolygon.geometry), baseArea]);

    if (!connectionCheck.rows[0].connected) {
        console.log(`[${new Date().toISOString()}] [REJECTED] Expansion not connected to base.`);
        socket.emit('claimRejected', { reason: 'Expansion must connect to your existing territory.' });
        return;
    }

    await client.query(`
        UPDATE territories SET area = ST_Union(area, ST_GeomFromGeoJSON($1)) WHERE owner_id = $2
    `, [JSON.stringify(newPolygon.geometry), userId]);

    socket.emit('claimAccepted', { message: 'Territory expanded!' });
    console.log(`[${new Date().toISOString()}] [SUCCESS] Expansion completed.`);
}

module.exports = handleSoloClaim;
