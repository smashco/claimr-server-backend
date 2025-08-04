const togeojson = require('@mapbox/togeojson');
const { DOMParser } = require('xmldom');

class GeofenceService {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Checks if a given lat/lng coordinate is within a valid playable area.
     * A location is valid if it's inside an 'allowed' zone AND NOT inside any 'blocked' zone.
     * @param {number} lat Latitude
     * @param {number} lng Longitude
     * @returns {Promise<boolean>} True if the location is valid.
     */
    async isLocationValid(lat, lng) {
        if (lat === undefined || lng === undefined) return false;

        const pointWKT = `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;

        const query = `
            SELECT
                (
                    EXISTS (
                        SELECT 1 FROM geofence_zones
                        WHERE zone_type = 'allowed' AND ST_Contains(geom, ${pointWKT})
                    )
                )
                AND
                (
                    NOT EXISTS (
                        SELECT 1 FROM geofence_zones
                        WHERE zone_type = 'blocked' AND ST_Contains(geom, ${pointWKT})
                    )
                ) AS is_valid;
        `;
        try {
            const result = await this.pool.query(query);
            // If there are no 'allowed' zones at all, the first EXISTS will be false.
            // The check will correctly return false, meaning no area is playable.
            return result.rows[0]?.is_valid || false;
        } catch (error) {
            console.error('[GeofenceService] Error validating location:', error);
            return false; // Fail-safe: if the check fails, deny access.
        }
    }

    /**
     * Fetches all geofence zones from the DB as GeoJSON objects.
     * @returns {Promise<Array<Object>>} A list of zone objects.
     */
    async getGeofencePolygons() {
        const query = `
            SELECT id, name, zone_type, ST_AsGeoJSON(geom) as geojson
            FROM geofence_zones;
        `;
        try {
            const result = await this.pool.query(query);
            return result.rows.map(row => ({
                ...row,
                geojson: JSON.parse(row.geojson) // Parse the stringified GeoJSON
            }));
        } catch (error) {
            console.error('[GeofenceService] Error fetching geofence polygons:', error);
            return [];
        }
    }

    /**
     * Parses a KML file, extracts the polygon, and adds it to the database.
     * @param {string} kmlString The string content of the KML file.
     * @param {string} name The name for the new zone.
     * @param {string} zoneType Either 'allowed' or 'blocked'.
     */
    async addZoneFromKML(kmlString, name, zoneType) {
        if (!['allowed', 'blocked'].includes(zoneType)) {
            throw new Error('Invalid zoneType. Must be "allowed" or "blocked".');
        }

        const kml = new DOMParser().parseFromString(kmlString);
        const geojson = togeojson.kml(kml);

        // Find the first Polygon or MultiPolygon feature
        const polygonFeature = geojson.features.find(
            f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        );

        if (!polygonFeature) {
            throw new Error('No Polygon or MultiPolygon found in the KML file.');
        }
        
        // --- THIS IS THE FIX ---
        // We wrap the geometry creation with ST_Force2D() to strip the Z (altitude) dimension.
        const geomWKT = `ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON('${JSON.stringify(polygonFeature.geometry)}')), 4326)`;
        // --- END OF FIX ---

        const insertQuery = `
            INSERT INTO geofence_zones (name, zone_type, geom)
            VALUES ($1, $2, ${geomWKT});
        `;

        await this.pool.query(insertQuery, [name, zoneType]);
        console.log(`[GeofenceService] Successfully added new zone: ${name} (${zoneType})`);
    }

    /**
     * Deletes a geofence zone by its ID.
     * @param {number} id The ID of the zone to delete.
     */
    async deleteZone(id) {
        if (!id) throw new Error('Zone ID is required for deletion.');
        await this.pool.query('DELETE FROM geofence_zones WHERE id = $1', [id]);
        console.log(`[GeofenceService] Deleted geofence zone with ID: ${id}`);
    }
}

module.exports = GeofenceService;