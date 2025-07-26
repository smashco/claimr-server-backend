const turf = require('@turf/turf');

// This script handles ALL normal attacks on unshielded players.

/**
 * Handles an attack on an unshielded victim, determining if it's a partial hit or a full wipeout.
 * @param {object} client - The database client.
 * @param {object} victimCurrentArea - The victim's current territory geometry.
 * @param {string} newAreaWKT - The WKT of the attacker's new claim loop.
 * @param {object} attackerTotalInfluenceGeom - The attacker's full potential territory for this turn.
 * @param {string} victimId - The ID of the victim.
 */
async function handleUnshieldedInteraction(client, victimCurrentArea, newAreaWKT, attackerTotalInfluenceGeom, victimId) {
    // First, determine if this is a full wipeout by checking against the attacker's total influence.
    const diffForWipeoutCheck = await client.query(
        `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, $2::geometry), 3)) AS remaining_area;`, 
        [victimCurrentArea, attackerTotalInfluenceGeom]
    );

    const remainingAreaForWipeout = diffForWipeoutCheck.rows[0].remaining_area;
    const remainingSqMWipeout = remainingAreaForWipeout ? (turf.area(JSON.parse(remainingAreaForWipeout)) || 0) : 0;

    if (Math.round(remainingSqMWipeout) > 10) {
        // PARTIAL HIT: The victim survives with a smaller area.
        console.log(`[Interaction] Unshielded partial hit on victim ${victimId}.`);
        
        // The victim's territory is reduced ONLY by the new claim loop.
        const partialHitResult = await client.query(
            `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, ${newAreaWKT}), 3)) as remaining_area;`, 
            [victimCurrentArea]
        );
        const remainingAreaGeoJSON = partialHitResult.rows[0].remaining_area;
        const remainingAreaSqM = remainingAreaGeoJSON ? (turf.area(JSON.parse(remainingAreaGeoJSON)) || 0) : 0;
        await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, 
            [remainingAreaGeoJSON, remainingAreaSqM, victimId]
        );
        return { wasWipedOut: false };
    } else {
        // FULL WIPEOUT: The victim is eliminated.
        console.log(`[Interaction] Unshielded player ${victimId} was wiped out.`);
        await client.query(`UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0 WHERE owner_id = $1;`, [victimId]);
        return { wasWipedOut: true };
    }
}

module.exports = handleUnshieldedInteraction;