// geofence_service.js
const togeojson = require('@mapbox/togeojson');
const { DOMParser } = require('xmldom');

class GeofenceService {
    /**
     * @param {object} pool The PostgreSQL connection pool.
     * @param {object} io The Socket.IO server instance for broadcasting updates.
     */
    constructor(pool, io) {
        this.pool = pool;
        this.io = io;
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
                (EXISTS (SELECT 1 FROM geofence_zones WHERE zone_type = 'allowed' AND ST_Intersects(geom, ${pointWKT})))
                AND
                (NOT EXISTS (SELECT 1 FROM geofence_zones WHERE zone_type = 'blocked' AND ST_Intersects(geom, ${pointWKT})))
            AS is_valid;`;

        try {
            const result = await this.pool.query(query);
            // This logic is complex. If there are NO allowed zones, the first EXISTS is false, so is_valid is false. This is correct.
            // If the point is in an allowed zone, the first is true. Then it checks if it's NOT in a blocked zone. This logic is correct.
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
        const query = `SELECT id, name, zone_type, ST_AsGeoJSON(geom) as geojson FROM geofence_zones;`;
        try {
            const result = await this.pool.query(query);
            return result.rows.map(row => {
                try {
                    return {
                        ...row,
                        geojson: JSON.parse(row.geojson)
                    };
                } catch (e) {
                    console.error(`[GeofenceService] Error parsing GeoJSON for zone ID ${row.id}`);
                    return null;
                }
            }).filter(Boolean); // Filter out any nulls from failed parsing
        } catch (error) {
            console.error('[GeofenceService] Error fetching geofence polygons:', error);
            return [];
        }
    }

    /**
     * Parses a KML file, extracts the polygon, adds it to the database,
     * and broadcasts the update to all clients.
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
        const polygonFeature = geojson.features.find(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));

        if (!polygonFeature) {
            throw new Error('No Polygon or MultiPolygon found in the KML file.');
        }

        const geomWKT = `ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON('${JSON.stringify(polygonFeature.geometry)}')), 4326)`;
        const insertQuery = `INSERT INTO geofence_zones (name, zone_type, geom) VALUES ($1, $2, ${geomWKT});`;
        await this.pool.query(insertQuery, [name, zoneType]);
        console.log(`[GeofenceService] Successfully added new zone: ${name} (${zoneType})`);

        // Broadcast the update to all connected game clients
        const allZones = await this.getGeofencePolygons();
        this.io.emit('geofenceUpdate', allZones);
        console.log('[GeofenceService] Broadcasted geofence update to all clients.');
    }

    /**
     * Deletes a geofence zone by its ID and broadcasts the update.
     * @param {number} id The ID of the zone to delete.
     */
    async deleteZone(id) {
        if (!id) throw new Error('Zone ID is required for deletion.');
        await this.pool.query('DELETE FROM geofence_zones WHERE id = $1', [id]);
        console.log(`[GeofenceService] Deleted geofence zone with ID: ${id}`);

        // Broadcast the update to all connected game clients
        const allZones = await this.getGeofencePolygons();
        this.io.emit('geofenceUpdate', allZones);
        console.log('[GeofenceService] Broadcasted geofence update to all clients.');
    }
}

module.exports = GeofenceService;