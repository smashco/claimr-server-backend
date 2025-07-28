import turf from '@turf/turf';
import { client } from './db'; // PostgreSQL client
import { broadcastToAll } from './socketUtils'; // Your broadcast function

export async function handleSoloClaim(attackerId, newClaimGeoJSON) {
    console.log(`[DEBUG] ==== SOLO CLAIM STARTED ====`);

    const attacker = await client.query(`SELECT * FROM players WHERE id = $1`, [attackerId]);
    if (!attacker.rows.length) return console.error(`Attacker ${attackerId} not found.`);

    const claimArea = turf.area(newClaimGeoJSON);
    console.log(`[DEBUG] Claim area: ${claimArea.toFixed(2)} sqm`);

    // STEP 1: Find overlapping victims
    const result = await client.query(`
        SELECT id, owner_id, area, area_sqm FROM territories
        WHERE ST_Intersects(area, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
        AND owner_id != $2
    `, [JSON.stringify(newClaimGeoJSON), attackerId]);

    const victimRows = result.rows;
    const victimsToBroadcast = new Set();

    for (const victim of victimRows) {
        const player = await client.query(`SELECT shield_active, name FROM players WHERE id = $1`, [victim.owner_id]);
        const isShielded = player.rows[0]?.shield_active;

        if (isShielded) {
            console.log(`[DEBUG] SKIPPED: ${player.rows[0].name} is shielded.`);
            continue;
        }

        const intersection = await client.query(`
            SELECT ST_AsGeoJSON(ST_Intersection(area, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))) AS intersect
            FROM territories
            WHERE id = $2
        `, [JSON.stringify(newClaimGeoJSON), victim.id]);

        const intersectJSON = intersection.rows[0].intersect;
        if (!intersectJSON) continue;

        const difference = await client.query(`
            SELECT ST_AsGeoJSON(ST_Difference(area, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))) AS diff
            FROM territories
            WHERE id = $2
        `, [JSON.stringify(newClaimGeoJSON), victim.id]);

        const diffJSON = difference.rows[0].diff;
        const remainingArea = diffJSON ? turf.area(JSON.parse(diffJSON)) : 0;

        const wipeThreshold = 1000; // sqm
        const percentThreshold = 0.10; // 10%

        if (remainingArea < wipeThreshold || remainingArea < victim.area_sqm * percentThreshold) {
            console.log(`[DEBUG] -> ${player.rows[0].name} wiped out. Remaining: ${remainingArea.toFixed(2)} sqm`);
            await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE id = $1`, [victim.id]);
        } else {
            console.log(`[DEBUG] -> ${player.rows[0].name} partially hit. Remaining: ${remainingArea.toFixed(2)} sqm`);
            await client.query(`
                UPDATE territories SET area = ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), area_sqm = $2 WHERE id = $3
            `, [diffJSON, remainingArea, victim.id]);
        }

        victimsToBroadcast.add(victim.owner_id);
    }

    // STEP 2: Add new claim for attacker
    const attackerTerritory = await client.query(`SELECT id FROM territories WHERE owner_id = $1`, [attackerId]);
    if (attackerTerritory.rows.length) {
        const prevId = attackerTerritory.rows[0].id;
        const prevAreaResult = await client.query(`SELECT ST_AsGeoJSON(area) as geo FROM territories WHERE id = $1`, [prevId]);

        const merged = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(
                ST_SetSRID(ST_GeomFromGeoJSON($1), 4326),
                ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)
            )) AS merged
        `, [prevAreaResult.rows[0].geo, JSON.stringify(newClaimGeoJSON)]);

        const mergedJSON = merged.rows[0].merged;
        const mergedArea = turf.area(JSON.parse(mergedJSON));

        await client.query(`
            UPDATE territories SET area = ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), area_sqm = $2 WHERE id = $3
        `, [mergedJSON, mergedArea, prevId]);
    } else {
        const areaSize = turf.area(newClaimGeoJSON);
        await client.query(`
            INSERT INTO territories (owner_id, area, area_sqm) VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3)
        `, [attackerId, JSON.stringify(newClaimGeoJSON), areaSize]);
    }

    victimsToBroadcast.add(attackerId);

    // STEP 3: Broadcast
    broadcastToAll('territoryUpdate', {
        players: Array.from(victimsToBroadcast),
        mode: 'solo'
    });

    console.log(`[DEBUG] ==== SOLO CLAIM COMPLETE ====`);
}
