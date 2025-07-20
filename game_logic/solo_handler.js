// claimr_server/game_logic/solo_handler.js

const turf = require('@turf/turf');
const wellknown = require('wellknown');

const MINIMUM_CLAIM_AREA_SQM = 100; // Minimum area in square meters to be a valid claim

/**
 * Handles a territory claim for a solo player.
 * @param {SocketIO.Socket} socket - The socket of the player making the claim.
 * @param {object} player - The player object from the server's memory.
 * @param {Array<object>} trail - An array of {lat, lng} points for the trail.
 * @param {object} baseClaim - An object with {lat, lng, radius} for the first claim.
 * @param {pg.PoolClient} client - The database client for transactions.
 * @returns {Promise<object|null>} An object with finalTotalArea and ownerIdsToUpdate, or null on handled error.
 */
async function handleSoloClaim(socket, player, trail, baseClaim, client) {
    const { googleId, name } = player;
    
    // 1. Basic Validation
    if (!trail || trail.length < 4) { // A polygon needs at least 3 unique vertices + closing point
        socket.emit('claimRejected', { reason: 'Trail is too short to form a polygon.' });
        return null;
    }

    // 2. Convert Trail to a PostGIS Geometry String (Well-Known Text)
    const trailCoordinates = trail.map(p => `${p.lng} ${p.lat}`).join(', ');
    const trailWkt = `POLYGON((${trailCoordinates}))`;
    const newTrailGeom = `ST_SetSRID(ST_GeomFromText('${trailWkt}'), 4326)`;

    // 3. Get Player's Existing Territory (if any)
    const existingTerritoryQuery = 'SELECT ST_AsBinary(area) as area_wkb FROM territories WHERE owner_id = $1';
    const territoryResult = await client.query(existingTerritoryQuery, [googleId]);

    const hasExistingTerritory = territoryResult.rowCount > 0 && territoryResult.rows[0].area_wkb !== null;
    
    let finalGeometrySql;
    let queryParams = [googleId, name]; // Base parameters for the final query

    // 4. Perform Geometric Union based on player state
    if (hasExistingTerritory) {
        // PLAYER HAS TERRITORY: Merge new trail with existing area
        console.log(`[GAME] Merging new trail for existing player ${name}`);
        const existingTerritoryGeom = `ST_GeomFromWKB($3)`; // Use parameter binding for safety
        finalGeometrySql = `ST_Union(${existingTerritoryGeom}, ${newTrailGeom})`;
        queryParams.push(territoryResult.rows[0].area_wkb); // Add the existing geometry buffer to params

    } else {
        // FIRST CLAIM: Merge new trail with the starting base circle
        if (!baseClaim || !baseClaim.lat || !baseClaim.lng || !baseClaim.radius) {
            // This is the error you were seeing. It means baseClaim is missing or malformed.
            socket.emit('claimRejected', { reason: 'Invalid base data for merge.' });
            return null;
        }
        console.log(`[GAME] Merging new trail with base circle for new player ${name}`);

        const center = [baseClaim.lng, baseClaim.lat];
        const radiusInMeters = baseClaim.radius;
        // Use turf.js to generate a GeoJSON circle
        const circleGeoJSON = turf.circle(center, radiusInMeters, { units: 'meters', steps: 64 });
        // Convert the GeoJSON to a WKT string that PostGIS can understand
        const circleWkt = wellknown.stringify(circleGeoJSON);
        const circleGeom = `ST_SetSRID(ST_GeomFromText('${circleWkt}'), 4326)`;

        finalGeometrySql = `ST_Union(${newTrailGeom}, ${circleGeom})`;
    }

    // 5. Update Database with the new, merged geometry
    const updateQuery = `
        WITH new_geom_collection AS (
            SELECT ${finalGeometrySql} as geom_collection
        ),
        new_geom AS (
            SELECT ST_CollectionExtract(geom_collection, 3) as geom FROM new_geom_collection
        )
        INSERT INTO territories (owner_id, owner_name, area, area_sqm)
        SELECT $1, $2, new_geom.geom, ST_Area(new_geom.geom::geography)
        FROM new_geom
        WHERE ST_Area(new_geom.geom::geography) > ${MINIMUM_CLAIM_AREA_SQM}
        ON CONFLICT (owner_id) DO UPDATE
        SET 
            area = (SELECT geom FROM new_geom),
            area_sqm = (SELECT ST_Area(geom::geography) FROM new_geom)
        RETURNING area_sqm;
    `;
    
    // Execute the query with the correct parameters
    const updateResult = await client.query(updateQuery, queryParams);

    if (updateResult.rowCount === 0) {
        throw new Error(`Claimed area is too small (min ${MINIMUM_CLAIM_AREA_SQM} sqm).`);
    }

    const finalTotalArea = updateResult.rows[0].area_sqm;

    return {
        finalTotalArea,
        ownerIdsToUpdate: [googleId]
    };
}

module.exports = handleSoloClaim;