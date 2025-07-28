const turf = require('@turf/turf');
const db = require('../db');

async function handleSoloClaim(socket, data, players, io) {
    const player = players[socket.id];
    const userId = player?.userId || 'unknown';

    const {
        latitude,
        longitude,
        radius,
        initialClaim,
        powerUsed
    } = data;

    const infiltratorActive = powerUsed === 'INFILTRATOR';

    console.log(`[DEBUG] [START] Player: ${player.username}, UserID: ${userId}, Infiltrator: ${infiltratorActive}, InitialClaim: ${initialClaim}`);

    const point = turf.point([longitude, latitude]);
    const circle = turf.circle(point, radius / 1000, { steps: 64, units: 'kilometers' });
    const newPolygon = turf.polygon(circle.geometry.coordinates);
    const area = turf.area(newPolygon);

    console.log(`[DEBUG] Generated circle area: ${area.toFixed(2)} sqm`);

    const client = await db.connect();
    try {
        // Check for overlapping enemy territories
        const enemies = await client.query(`
            SELECT id, owner_id, area, is_shield_active
            FROM territories
            WHERE owner_id != $1 AND ST_Intersects(area, ST_GeomFromGeoJSON($2))`,
            [userId, JSON.stringify(newPolygon.geometry)]
        );

        if (enemies.rows.length > 0) {
            console.log(`[DEBUG] Found ${enemies.rows.length} intersecting enemy territories`);

            for (const target of enemies.rows) {
                const shielded = target.is_shield_active;

                if (initialClaim || (!infiltratorActive && shielded)) {
                    console.log(`[REJECTED] Cannot claim inside enemy territory without Infiltrator or shield still active.`);
                    return socket.emit('claimRejected', { reason: 'Cannot claim inside enemy territory.' });
                }

                const existingArea = turf.area(target.area);
                const intersection = turf.intersect(newPolygon, target.area);

                if (!intersection) {
                    console.log(`[DEBUG] Intersection null — skipping.`);
                    continue;
                }

                const intersectionArea = turf.area(intersection);

                const fullyInside = intersectionArea >= existingArea * 0.98;

                if (fullyInside) {
                    console.log(`[DEBUG] Fully inside enemy territory. Deleting territory ${target.id} and absorbing.`);
                    await client.query(`DELETE FROM territories WHERE id = $1`, [target.id]);
                } else {
                    console.log(`[DEBUG] Partial intersection. Subtracting overlapping part.`);
                    await client.query(`
                        UPDATE territories
                        SET area = ST_Difference(area, ST_GeomFromGeoJSON($1))
                        WHERE id = $2
                    `, [JSON.stringify(newPolygon.geometry), target.id]);
                }

                // Deactivate shield
                if (shielded) {
                    console.log(`[DEBUG] Deactivating shield for territory ${target.id}`);
                    await client.query(`UPDATE territories SET is_shield_active = false WHERE id = $1`, [target.id]);
                }
            }
        } else {
            console.log(`[DEBUG] No enemy territories intersected.`);
        }

        // Claim the new territory
        await client.query(`
            INSERT INTO territories (owner_id, area, is_shield_active, created_at)
            VALUES ($1, ST_GeomFromGeoJSON($2), true, NOW())`,
            [userId, JSON.stringify(newPolygon.geometry)]
        );

        console.log(`[SUCCESS] Territory claimed successfully by ${player.username}`);
        io.emit('territoryClaimed', {
            ownerId: userId,
            area: newPolygon.geometry,
            is_shield_active: true,
            username: player.username
        });
    } catch (err) {
        console.error(`[DB] FATAL Error during territory claim:`, err);
        socket.emit('claimRejected', { reason: 'Internal server error.' });
    } finally {
        client.release();
    }
}

module.exports = handleSoloClaim;
