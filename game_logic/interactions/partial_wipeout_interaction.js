/**
* @file partial_wipeout_interaction.js
* @description Handles the interaction where an attacker's claim partially overwrites an unshielded victim's territory.
*/


/**
* Calculates the result of a partial territory overwrite.
* The victim's territory is reduced to the largest contiguous area remaining after the attacker's
* claim is subtracted. Any smaller, disconnected "islands" of the victim's territory are wiped out.
* The attacker's claim is then merged with their own existing territory in the main handler.
*
* @param {object} victim - The victim player's data from the database { owner_id, username, area }.
* @param {string} attackerNetGainGeom - The WKT representation of the attacker's claim geometry.
* @param {object} client - The PostgreSQL database client.
* @returns {Promise<void>} This function modifies the victim's territory directly.
*/
async function handlePartialWipeout(victim, attackerNetGainGeom, client) {
    console.log(`[PARTIAL_WIPEOUT] Partially overwriting territory from ${victim.username}.`);
 
 
    // This query calculates the difference, then if the result is a MultiPolygon,
    // it finds the single largest polygon by area and discards the rest.
    // This implements the "wiping out rest of area" logic from the diagram.
    const query = `
        WITH new_area_calc AS (
            SELECT
                (
                    SELECT geom
                    FROM (
                        -- Calculate the difference, ensure it's valid, and extract only polygon types
                        -- Then, dump the components of the resulting geometry (e.g., each polygon in a MultiPolygon)
                        SELECT (ST_Dump(ST_CollectionExtract(ST_MakeValid(ST_Difference(area, $1::geometry)), 3))).geom
                    ) AS parts
                    -- Order the parts by area in descending order and take only the largest one
                    ORDER BY ST_Area(geom) DESC
                    LIMIT 1
                ) AS largest_geom
            FROM territories
            WHERE owner_id = $2
        )
        UPDATE territories
        SET
            -- Update the area to the largest remaining part. If no parts remain, set to an empty geometry.
            area = COALESCE((SELECT largest_geom FROM new_area_calc), ST_GeomFromText('GEOMETRYCOLLECTION EMPTY')),
            -- Update the area in square meters accordingly. If empty, set to 0.
            area_sqm = COALESCE(ST_Area((SELECT largest_geom FROM new_area_calc)::geography), 0)
        WHERE owner_id = $2;
    `;
 
 
    await client.query(query, [attackerNetGainGeom, victim.owner_id]);
 
 
    console.log(`[PARTIAL_WIPEOUT] ${victim.username}'s territory has been partially wiped.`);
    // As with carving, the attacker's geometry is not modified by this function.
    // The solo_handler will merge the original claim shape with the attacker's base.
 }
 
 
 // FIX: Ensure the function is exported as a property inside an object.
 module.exports = { handlePartialWipeout };