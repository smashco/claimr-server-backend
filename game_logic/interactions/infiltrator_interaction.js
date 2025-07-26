const turf = require('@turf/turf');

// This script handles ONLY the logic for an Infiltrator carving a base out of an enemy.

/**
 * Handles an Infiltrator claiming a new base inside an unshielded victim's territory.
 * @param {object} client - The database client.
 * @param {object} victimCurrentArea - The victim's current territory geometry.
 * @param {string} newAreaWKT - The WKT of the Infiltrator's new base circle.
 * @param {string} victimId - The ID of the victim.
 */
async function handleInfiltratorInteraction(client, victimCurrentArea, newAreaWKT, victimId) {
    console.log(`[Interaction] Infiltrator is carving a new base from victim ${victimId}.`);
    
    // The victim's territory has the Infiltrator's base carved out of it.
    const carveResult = await client.query(
        `SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_Difference($1::geometry, ${newAreaWKT}), 3)) as remaining_area;`, 
        [victimCurrentArea]
    );

    const remainingAreaGeoJSON = carveResult.rows[0].remaining_area;
    const remainingAreaSqM = remainingAreaGeoJSON ? (turf.area(JSON.parse(remainingAreaGeoJSON)) || 0) : 0;

    // Update the victim's territory to the new, smaller shape.
    await client.query(`UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2 WHERE owner_id = $3;`, 
        [remainingAreaGeoJSON, remainingAreaSqM, victimId]
    );
}

module.exports = handleInfiltratorInteraction;