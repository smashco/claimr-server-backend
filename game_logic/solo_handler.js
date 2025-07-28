const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;

    // Debug: Check player's power at start
    const activePower = player.activePower;
    const isInfiltrator = activePower === 'INFILTRATOR';
    const isShieldBreaker = activePower === 'SHIELD_BREAKER';
    const isInitialClaim = !!baseClaim;

    console.log(`[DEBUG] [START] Player: ${playerName}, ID: ${userId}, Power: ${activePower}, InitialClaim: ${isInitialClaim}`);

    let newPolygon;

    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });

        const area = turf.area(newPolygon);
        console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

        // Check if the player already owns any territory
        const ownTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownTerritory.rows.length > 0;

        // Check for overlaps with enemy territories
        const enemies = await client.query(`
            SELECT id, owner_id, area, is_shield_active
            FROM territories
            WHERE owner_id != $1
              AND ST_Intersects(area, ST_GeomFromGeoJSON($2))
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        console.log(`[DEBUG] Enemy overlaps found: ${enemies.rowCount}`);

        if (enemies.rowCount > 0) {
            const target = enemies.rows[0];
            const shielded = target.is_shield_active;

            if (!isInfiltrator && !isShieldBreaker) {
                console.log(`[REJECTED] Power required to invade.`);
                socket.emit('claimRejected', { reason: 'Use Infiltrator or Shield Breaker to invade enemy territory.' });
                return;
            }

            if (isInfiltrator && hasOwnTerritory) {
                console.log(`[REJECTED] Infiltrator can only be used on first claim.`);
                socket.emit('claimRejected', { reason: 'Infiltrator only works when you have no existing territory.' });
                return;
            }

            if (shielded) {
                console.log(`[DEBUG] Target has active shield.`);

                if (isShieldBreaker) {
                    await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                    player.activePower = null;
                    console.log(`[SHIELD BREAKER] Shield removed. Claim denied this turn.`);
                    socket.emit('claimRejected', { reason: 'Shield broken. Try claiming again.' });
                    return;
                }

                if (isInfiltrator) {
                    await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                    player.activePower = null;
                    console.log(`[INFILTRATOR BLOCKED] Shield absorbed infiltrator. Power used.`);
                    socket.emit('claimRejected', { reason: 'Enemy shield absorbed your Infiltrator. Try again.' });
                    return;
                }
            }

            // Power is valid, proceed with carving enemy land
            await client.query(`
                UPDATE territories
                SET area = ST_Difference(area, ST_GeomFromGeoJSON($1))
                WHERE id = $2
            `, [JSON.stringify(newPolygon.geometry), target.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, is_shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
            `, [userId, JSON.stringify(newPolygon.geometry)]);

            player.activePower = null;
            socket.emit('claimAccepted', { message: `${activePower} claim successful!` });
            console.log(`[SUCCESS] ${activePower} used. New territory created by ${playerName}`);
            return;
        }

        // If power used but no enemy was present
        if (isInfiltrator) {
            player.activePower = null;
            console.log(`[REJECTED] Infiltrator failed - no enemy.`)
            socket.emit('claimRejected', { reason: 'You must infiltrate enemy territory. Power consumed.' });
            return;
        }

        if (isShieldBreaker) {
            player.activePower = null;
            console.log(`[REJECTED] Shield Breaker failed - no enemy.`)
            socket.emit('claimRejected', { reason: 'No enemy to break. Power consumed.' });
            return;
        }

        // Normal base claim
        await client.query(`
            INSERT INTO territories (owner_id, area, mode, is_shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)
        `, [userId, JSON.stringify(newPolygon.geometry)]);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[SUCCESS] Base territory created.`);
        return;
    }

    // === EXPANSION CLAIM ===
    if (!trail || trail.length < 3) {
        socket.emit('claimRejected', { reason: 'Loop must have at least 3 points.' });
        console.log(`[REJECTED] Trail too short.`);
        return;
    }

    const trailCoords = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
    newPolygon = turf.polygon([trailCoords]);

    const expansionArea = turf.area(newPolygon);
    console.log(`[DEBUG] Expansion area: ${expansionArea.toFixed(2)} sqm`);

    if (expansionArea < 100) {
        socket.emit('claimRejected', { reason: 'Claim area too small.' });
        console.log(`[REJECTED] Area too small.`);
        return;
    }

    const result = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    if (result.rows.length === 0) {
        socket.emit('claimRejected', { reason: 'You must have a base to expand from.' });
        return;
    }

    const playerArea = result.rows[0].area;

    const connected = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect
    `, [JSON.stringify(newPolygon.geometry), playerArea]);

    if (!connected.rows[0].intersect) {
        socket.emit('claimRejected', { reason: 'Expansion must connect to your territory.' });
        console.log(`[REJECTED] Expansion not connected to base.`);
        return;
    }

    await client.query(`
        UPDATE territories
        SET area = ST_Union(area, ST_GeomFromGeoJSON($1))
        WHERE owner_id = $2
    `, [JSON.stringify(newPolygon.geometry), userId]);

    socket.emit('claimAccepted', { message: 'Expansion successful!' });
    console.log(`[SUCCESS] Territory expanded.`);
}

module.exports = handleSoloClaim;
