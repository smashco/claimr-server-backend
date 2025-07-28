const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;

    // Log activePower status at the very start
    console.log(`[DEBUG] [CHECK] Player: ${playerName}, activePower BEFORE claim: ${player.activePower}`);

    const isInitialClaim = !!baseClaim;
    const activePower = player.activePower;
    const isInfiltrator = activePower === 'INFILTRATOR';
    const isShieldBreaker = activePower === 'SHIELD_BREAKER';

    console.log(`[DEBUG] [START] Player: ${playerName}, UserID: ${userId}, Power: ${activePower}, InitialClaim: ${isInitialClaim}`);

    let newPolygon;

    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;

        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });
        const area = turf.area(newPolygon);

        console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

        // Check if the player already owns territory
        const ownTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownTerritory.rows.length > 0;

        // Check for enemy overlaps
        const enemies = await client.query(`
            SELECT id, owner_id, area, shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))`,
            [userId, JSON.stringify(newPolygon.geometry)]
        );

        console.log(`[DEBUG] Found ${enemies.rowCount} intersecting enemy territories`);

        if (enemies.rowCount > 0) {
            const target = enemies.rows[0];
            const shielded = target.shield_active;

            if (!isInfiltrator && !isShieldBreaker) {
                console.log(`[REJECTED] Cannot claim inside enemy territory without power.`);
                socket.emit('claimRejected', { reason: 'Use Infiltrator or Shield Breaker to invade enemy territory.' });
                return;
            }

            // INFILTRATOR requires no territory
            if (isInfiltrator && hasOwnTerritory) {
                console.log(`[REJECTED] Infiltrator only works when you have no territory.`);
                socket.emit('claimRejected', { reason: 'Infiltrator can only be used when you have zero territory.' });
                return;
            }

            if (shielded) {
                console.log(`[SHIELD DETECTED] Player has power: ${activePower}`);

                if (isShieldBreaker) {
                    // Remove shield but deny the claim
                    await client.query(`UPDATE territories SET shield_active = false WHERE id = $1`, [target.id]);
                    player.activePower = null;
                    console.log(`[SHIELD BREAKER] Shield removed. Power consumed.`);
                    socket.emit('claimRejected', { reason: 'Enemy shield was broken by Shield Breaker. Try again now.' });
                    return;
                }

                if (isInfiltrator) {
                    // Shield absorbs the Infiltrator
                    await client.query(`UPDATE territories SET shield_active = false WHERE id = $1`, [target.id]);
                    player.activePower = null;
                    console.log(`[INFILTRATOR BLOCKED] Enemy shield absorbed the attack. Power consumed.`);
                    socket.emit('claimRejected', { reason: 'Enemy shield absorbed your Infiltrator. Try again.' });
                    return;
                }
            }

            // No shield and has appropriate power
            console.log(`[INFILTRATION SUCCESS] Claim carving success using ${activePower}`);

            await client.query(`
                UPDATE territories SET area = ST_Difference(area, ST_GeomFromGeoJSON($1)) WHERE id = $2`,
                [JSON.stringify(newPolygon.geometry), target.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), $3, false)`,
                [userId, JSON.stringify(newPolygon.geometry), 'solo']);

            player.activePower = null;
            socket.emit('claimAccepted', { message: `${activePower} claim successful!` });
            console.log(`[SUCCESS] New base carved using ${activePower}. Player: ${playerName}`);
            return;
        }

        if (isInfiltrator) {
            console.log(`[REJECTED] Infiltrator failed: Not inside enemy territory.`);
            socket.emit('claimRejected', { reason: 'You must infiltrate enemy territory. Power consumed.' });
            player.activePower = null;
            return;
        }

        if (isShieldBreaker) {
            console.log(`[REJECTED] Shield Breaker failed: No enemy found.`);
            socket.emit('claimRejected', { reason: 'No enemy to break. Power consumed.' });
            player.activePower = null;
            return;
        }

        // Normal base claim (no powers used)
        await client.query(`
            INSERT INTO territories (owner_id, area, mode, shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), $3, false)`,
            [userId, JSON.stringify(newPolygon.geometry), 'solo']);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[SUCCESS] Base claim successful.`);
        return;
    }

    // Expansion claim
    if (!trail || trail.length < 3) {
        console.log(`[REJECTED] Trail too short.`);
        socket.emit('claimRejected', { reason: 'Loop must have at least 3 points.' });
        return;
    }

    const trailCoords = [...trail.map(p => [p.lng, p.lat]), [trail[0].lng, trail[0].lat]];
    newPolygon = turf.polygon([trailCoords]);
    const expansionArea = turf.area(newPolygon);
    console.log(`[DEBUG] Expansion area: ${expansionArea.toFixed(2)} sqm`);

    if (expansionArea < 100) {
        console.log(`[REJECTED] Area too small.`);
        socket.emit('claimRejected', { reason: 'Claim area too small.' });
        return;
    }

    const result = await client.query(`SELECT area FROM territories WHERE owner_id = $1`, [userId]);
    if (result.rows.length === 0) {
        socket.emit('claimRejected', { reason: 'You must have a base to expand from.' });
        return;
    }

    const playerArea = result.rows[0].area;
    const connected = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersect`,
        [JSON.stringify(newPolygon.geometry), playerArea]
    );

    if (!connected.rows[0].intersect) {
        console.log(`[REJECTED] Expansion not connected to base.`);
        socket.emit('claimRejected', { reason: 'Expansion must connect to your territory.' });
        return;
    }

    await client.query(`
        UPDATE territories
        SET area = ST_Union(area, ST_GeomFromGeoJSON($1))
        WHERE owner_id = $2`,
        [JSON.stringify(newPolygon.geometry), userId]);

    socket.emit('claimAccepted', { message: 'Expansion successful!' });
    console.log(`[SUCCESS] Expansion merged successfully.`);
}

module.exports = handleSoloClaim;
