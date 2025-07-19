// game_logic/utils.js

/**
 * Creates a PostGIS-compatible WKT string for a polygon from a trail array.
 * @param {Array<Object>} trail - An array of {lat, lng} points.
 * @returns {string|null} The WKT string or null if the trail is invalid.
 */
function createPolygonWkt(trail) {
    if (!trail || trail.length < 3) {
        return null;
    }
    // Ensure the polygon is closed by adding the first point to the end if it's not already there.
    const firstPoint = trail[0];
    const lastPoint = trail[trail.length - 1];
    if (firstPoint.lat !== lastPoint.lat || firstPoint.lng !== lastPoint.lng) {
        trail.push(firstPoint);
    }
    const coordinatesString = trail.map(p => `${p.lng} ${p.lat}`).join(', ');
    return `POLYGON((${coordinatesString}))`;
}

/**
 * Creates a PostGIS geometry string from a trail array.
 * @param {Array<Object>} trail - An array of {lat, lng} points.
 * @returns {string|null} The full geometry string or null.
 */
function createPolygonGeom(trail) {
    const wkt = createPolygonWkt(trail);
    if (!wkt) return null;
    return `ST_SetSRID(ST_GeomFromText('${wkt}'), 4326)`;
}

module.exports = {
    createPolygonGeom
};