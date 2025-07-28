const turf = require('@turf/turf');

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;
    const isInitialClaim = !!baseClaim;
    const isInfiltrator = player.activePower === 'INFILTRATOR';

    console.log(`[DEBUG] [START] Player: ${playerName}, UserID: ${userId}, Infiltrator: ${isInfiltrator}, InitialClaim: ${isInitialClaim}`);

    let newPolygon;

    if (isInitialClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = baseClaim.radius || 30;
        newPolygon = turf.circle(center, radius, { steps: 32, units: 'meters' });

        const area = turf.area(newPolygon);
        console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

        const ownTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [userId]);
        const hasOwnTerritory = ownTerritory.rows.length > 0;

        const enemies = await client.query(`
            SELECT id, owner_id, area, is_shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))`,
            [userId, JSON.stringify(newPolygon.geometry)]
        );

        console.log(`[DEBUG] Found ${enemies.rowCount} intersecting enemy territories`);

        if (hasOwnTerritory && isInfiltrator) {
            console.log(`[REJECTED] Infiltrator can only be used when you have zero territory.`);
            socket.emit('claimRejected', { reason: 'Infiltrator can only be used when you have no territory.' });
            return;
        }

        if (enemies.rowCount > 0) {
            const target = enemies.rows[0];
            const shielded = target.is_shield_active;

            if (!isInfiltrator) {
                console.log(`[REJECTED] Cannot claim inside enemy territory without Infiltrator.`);
                socket.emit('claimRejected', { reason: 'Cannot claim inside enemy territory without Infiltrator.' });
                return;
            }

            if (shielded) {
                console.log(`[BLOCKED] Infiltrator blocked by shield. Removing shield.`);
                await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                player.activePower = null;
                socket.emit('claimRejected', { reason: 'Enemy shield blocked the infiltrator. Shield removed, power consumed.' });
                return;
            }

            console.log(`[INFILTRATOR] Carving land from enemy ID ${target.id}`);
            await client.query(`
                UPDATE territories SET area = ST_Difference(area, ST_GeomFromGeoJSON($1))
                WHERE id = $2`, [JSON.stringify(newPolygon.geometry), target.id]);

            await client.query(`
                INSERT INTO territories (owner_id, area, mode, is_shield_active)
                VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)`,
                [userId, JSON.stringify(newPolygon.geometry)]);

            player.activePower = null;
            socket.emit('claimAccepted', { message: 'Infiltrator successful! Territory carved.' });
            console.log(`[SUCCESS] Infiltrator success by ${playerName}`);
            return;
        }

        if (isInfiltrator) {
            console.log(`[REJECTED] Infiltrator failed: not overlapping any enemy.`);
            player.activePower = null;
            socket.emit('claimRejected', { reason: 'No enemy territory to infiltrate. Power consumed.' });
            return;
        }

        await client.query(`
            INSERT INTO territories (owner_id, area, mode, is_shield_active)
            VALUES ($1, ST_GeomFromGeoJSON($2), 'solo', false)`,
            [userId, JSON.stringify(newPolygon.geometry)]);

        socket.emit('claimAccepted', { message: 'Base claimed successfully!' });
        console.log(`[SUCCESS] Base claimed by ${playerName}`);
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
        console.log(`[REJECTED] No base found to expand from.`);
        socket.emit('claimRejected', { reason: 'You must have a base to expand from.' });
        return;
    }

    const playerArea = result.rows[0].area;
    const connected = await client.query(`
        SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) AS intersect`,
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
    console.log(`[SUCCESS] Expansion merged for ${playerName}`);
}

module.exports = handleSoloClaim;
