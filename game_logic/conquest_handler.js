const turf = require('@turf/turf');
const debug = require('debug')('server:game:conquest');

class ConquestHandler {
    constructor(pool, io, players) {
        this.pool = pool;
        this.io = io;
        this.players = players;
        this.activeConquests = new Map(); // attackerId -> { territoryId, lapsCompleted, referencePath, startTime, expiresAt }
        this.activeArenas = new Map(); // attackerId -> { territoryId, center, radius, status, createdAt, timeoutTimer }
        this.baseLinks = new Map(); // linkId -> { playerId, baseA, baseB, trail, expiresAt }
    }

    // --- ARENA & CONQUERING LOGIC ---

    async createConquestArena(attackerId, territoryId) {
        const attacker = this.players[attackerId];
        if (!attacker) throw new Error("Player not found.");

        // Check if attacker already has an active arena
        if (this.activeArenas.has(attackerId)) {
            throw new Error("You already have an active conquest arena. Complete or cancel it first.");
        }

        // Verify territory exists and is not owned by attacker
        const res = await this.pool.query(
            'SELECT id, owner_id, owner_name, laps_required, ST_AsGeoJSON(area) as geojson FROM territories WHERE id = $1',
            [territoryId]
        );
        if (res.rowCount === 0) throw new Error("Territory not found.");
        const territory = res.rows[0];

        if (territory.owner_id === attacker.googleId) {
            throw new Error("You already own this territory.");
        }

        // Parse GeoJSON to calculate center and radius
        let center, maxRadius;
        if (territory.geojson) {
            const geojson = JSON.parse(territory.geojson);
            const polygon = geojson.type === 'Polygon'
                ? turf.polygon(geojson.coordinates)
                : turf.polygon(geojson.coordinates[0]);

            const centerPoint = turf.center(polygon);
            center = { lat: centerPoint.geometry.coordinates[1], lng: centerPoint.geometry.coordinates[0] };

            // Calculate max distance from center to any boundary point
            const coords = geojson.type === 'Polygon' ? geojson.coordinates[0] : geojson.coordinates[0][0];
            maxRadius = 0;
            coords.forEach(coord => {
                const point = turf.point(coord);
                const distance = turf.distance(centerPoint, point, { units: 'meters' });
                if (distance > maxRadius) maxRadius = distance;
            });
        } else {
            throw new Error("Territory has no geometry.");
        }

        const arenaRadius = maxRadius * 1.5; // 50% beyond territory edge

        // Create arena with 5-minute timeout
        const timeoutTimer = setTimeout(() => {
            this._handleArenaTimeout(attackerId);
        }, 5 * 60 * 1000); // 5 minutes

        this.activeArenas.set(attackerId, {
            territoryId,
            victimOwnerId: territory.owner_id,
            victimOwnerName: territory.owner_name,
            center,
            radius: arenaRadius,
            lapsRequired: territory.laps_required + 1, // Progressive difficulty
            status: 'waiting_for_entry',
            createdAt: Date.now(),
            timeoutTimer
        });

        // Notify attacker
        this.io.to(attackerId).emit('arenaCreated', {
            territoryId,
            center,
            radius: arenaRadius,
            lapsRequired: territory.laps_required + 1,
            victimName: territory.owner_name
        });

        // Notify victim
        const victimSocketId = Object.keys(this.players).find(k => this.players[k].googleId === territory.owner_id);
        if (victimSocketId) {
            this.io.to(victimSocketId).emit('territoryThreatened', {
                territoryId,
                attackerName: attacker.name,
                message: `⚠️ ${attacker.name} is preparing to attack your territory!`
            });
        }

        debug(`Arena created: ${attacker.name} targeting Territory ${territoryId}`);
    }

    _handleArenaTimeout(attackerId) {
        const arena = this.activeArenas.get(attackerId);
        if (!arena) return;

        this.activeArenas.delete(attackerId);
        this.io.to(attackerId).emit('arenaTimeout', {
            message: 'Arena timed out. Click "Conquer" again to create a new arena.'
        });

        debug(`Arena timeout for attacker ${attackerId}`);
    }

    checkArenaEntry(attackerId, currentLocation) {
        const arena = this.activeArenas.get(attackerId);
        if (!arena || arena.status !== 'waiting_for_entry') return false;

        // Calculate distance to arena center
        const R = 6371e3; // Earth radius in meters
        const φ1 = currentLocation.lat * Math.PI / 180;
        const φ2 = arena.center.lat * Math.PI / 180;
        const Δφ = (arena.center.lat - currentLocation.lat) * Math.PI / 180;
        const Δλ = (arena.center.lng - currentLocation.lng) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        if (distance <= arena.radius) {
            // Attacker entered arena!
            arena.status = 'ready_to_start';

            this.io.to(attackerId).emit('arenaEntered', {
                territoryId: arena.territoryId,
                lapsRequired: arena.lapsRequired,
                timeLimit: 30, // minutes
                message: `Complete ${arena.lapsRequired} lap${arena.lapsRequired > 1 ? 's' : ''} in 30 minutes`
            });

            // Notify victim
            const victimSocketId = Object.keys(this.players).find(k => this.players[k].googleId === arena.victimOwnerId);
            if (victimSocketId) {
                const attacker = this.players[attackerId];
                this.io.to(victimSocketId).emit('territoryUnderAttack', {
                    territoryId: arena.territoryId,
                    attackerName: attacker?.name || 'Unknown',
                    message: `🚨 ${attacker?.name || 'Unknown'} has entered the conquest zone!`
                });
            }

            debug(`Arena entered: ${attackerId} for territory ${arena.territoryId}`);
            return true;
        }

        return false;
    }

    startConquest(attackerId) {
        const arena = this.activeArenas.get(attackerId);
        if (!arena) throw new Error("No active arena found.");
        if (arena.status !== 'ready_to_start') throw new Error("Arena not ready. Enter the arena first.");

        // Check if another player is already conquering this territory
        const existingConquest = Array.from(this.activeConquests.values()).find(c => c.territoryId === arena.territoryId);
        if (existingConquest) {
            // Multiple attackers allowed - they race to complete first
            debug(`Multiple attackers on territory ${arena.territoryId}`);
        }

        // Clear arena timeout
        if (arena.timeoutTimer) {
            clearTimeout(arena.timeoutTimer);
        }

        // Create conquest state
        const conquestState = {
            territoryId: arena.territoryId,
            victimOwnerId: arena.victimOwnerId,
            lapsRequired: arena.lapsRequired,
            lapsCompleted: 0,
            referencePath: null, // Will be set on first lap
            startTime: Date.now(),
            expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
        };

        this.activeConquests.set(attackerId, conquestState);
        this.activeArenas.delete(attackerId); // Remove arena once conquest starts

        this.io.to(attackerId).emit('conquestStarted', {
            territoryId: arena.territoryId,
            lapsRequired: arena.lapsRequired,
            expiresAt: conquestState.expiresAt
        });

        debug(`Conquest started: ${attackerId} attacking territory ${arena.territoryId}`);
    }


    recordLap(attackerId, lapPath) {
        const conquest = this.activeConquests.get(attackerId);
        if (!conquest) {
            debug(`No active conquest for attacker ${attackerId}`);
            return { success: false, message: 'No active conquest found.' };
        }

        // Check if conquest has expired
        if (Date.now() > conquest.expiresAt) {
            this.activeConquests.delete(attackerId);
            return { success: false, message: 'Conquest time expired!' };
        }

        // First lap - store as reference
        if (conquest.lapsCompleted === 0) {
            conquest.referencePath = lapPath;
            conquest.lapsCompleted = 1;

            // Notify victim of first lap
            const victimSocketId = Object.keys(this.players).find(k => this.players[k].googleId === conquest.victimOwnerId);
            if (victimSocketId) {
                const attacker = this.players[attackerId];
                this.io.to(victimSocketId).emit('conquestProgress', {
                    territoryId: conquest.territoryId,
                    attackerName: attacker?.name || 'Unknown',
                    lapsCompleted: 1,
                    lapsRequired: conquest.lapsRequired,
                    message: `⏱️ ${attacker?.name || 'Unknown'} completed lap 1/${conquest.lapsRequired}`
                });
            }

            debug(`Lap 1 recorded for attacker ${attackerId}. Reference path set.`);
            return {
                success: true,
                message: `Lap 1/${conquest.lapsRequired} complete! Follow the same route.`,
                lapsCompleted: 1,
                lapsRequired: conquest.lapsRequired
            };
        }

        // Subsequent laps - validate path similarity
        const similarity = this._calculatePathSimilarity(lapPath, conquest.referencePath);

        if (similarity < 0.7) { // 70% similarity threshold (flexible)
            debug(`Conquest failed for ${attackerId}: Similarity ${Math.round(similarity * 100)}% < 70%. AvgError: ${Math.round((1 - similarity) * 50)}m`);
            this.activeConquests.delete(attackerId);
            return {
                success: false,
                message: 'Route too different from first lap! Conquest failed.',
                similarity: Math.round(similarity * 100)
            };
        }

        conquest.lapsCompleted++;

        // Notify victim of lap progress
        const victimSocketId = Object.keys(this.players).find(k => this.players[k].googleId === conquest.victimOwnerId);
        if (victimSocketId) {
            const attacker = this.players[attackerId];
            this.io.to(victimSocketId).emit('conquestProgress', {
                territoryId: conquest.territoryId,
                attackerName: attacker?.name || 'Unknown',
                lapsCompleted: conquest.lapsCompleted,
                lapsRequired: conquest.lapsRequired,
                message: `⏱️ ${attacker?.name || 'Unknown'} completed lap ${conquest.lapsCompleted}/${conquest.lapsRequired}`
            });
        }

        debug(`Lap ${conquest.lapsCompleted} recorded for attacker ${attackerId}. Similarity: ${Math.round(similarity * 100)}%`);

        // Check if conquest is complete
        if (conquest.lapsCompleted >= conquest.lapsRequired) {
            this._finalizeConquest(attackerId);
            return {
                success: true,
                message: 'Conquest successful! Territory claimed!',
                lapsCompleted: conquest.lapsCompleted,
                lapsRequired: conquest.lapsRequired,
                complete: true
            };
        }

        return {
            success: true,
            message: `Lap ${conquest.lapsCompleted}/${conquest.lapsRequired} complete!`,
            lapsCompleted: conquest.lapsCompleted,
            lapsRequired: conquest.lapsRequired
        };
    }

    _calculatePathSimilarity(path1, path2) {
        // Robust similarity check using Symmetric Average Minimum Distance
        // This handles different sampling rates and speed variations better than index matching
        if (!path1 || !path2 || path1.length === 0 || path2.length === 0) return 0;

        const getAverageMinDistance = (sourcePath, targetPath) => {
            let totalMinDist = 0;
            for (const p1 of sourcePath) {
                let minDist = Infinity;
                for (const p2 of targetPath) {
                    // Simple Euclidean approximation for speed (sufficient for small areas)
                    // Or use Haversine if precision needed. Using Haversine here for consistency.
                    const R = 6371e3;
                    const φ1 = p1.lat * Math.PI / 180;
                    const φ2 = p2.lat * Math.PI / 180;
                    const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
                    const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
                    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                        Math.cos(φ1) * Math.cos(φ2) *
                        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    const d = R * c;

                    if (d < minDist) minDist = d;
                }
                totalMinDist += minDist;
            }
            return totalMinDist / sourcePath.length;
        };

        // Check forward and backward to ensure paths cover each other
        const avgDist1 = getAverageMinDistance(path1, path2);
        const avgDist2 = getAverageMinDistance(path2, path1);

        // If average deviation is less than 30 meters, consider it a match
        // We convert this to a 0-1 score. 0m error = 1.0, 50m error = 0.0
        const avgError = (avgDist1 + avgDist2) / 2;
        const threshold = 50; // meters

        if (avgError > threshold) return 0;
        return 1 - (avgError / threshold);
    }

    async _finalizeConquest(attackerId) {
        const conquest = this.activeConquests.get(attackerId);
        if (!conquest) return;

        const attacker = this.players[attackerId];
        if (!attacker) {
            this.activeConquests.delete(attackerId);
            return;
        }

        // Check if another attacker already conquered this territory (race condition)
        const currentOwner = await this.pool.query('SELECT owner_id FROM territories WHERE id = $1', [conquest.territoryId]);
        if (currentOwner.rows[0]?.owner_id === attacker.googleId) {
            // Already owned (shouldn't happen, but handle gracefully)
            this.activeConquests.delete(attackerId);
            return;
        }

        // Cancel all other conquest attempts on this territory (first wins!)
        for (const [otherAttackerId, otherConquest] of this.activeConquests.entries()) {
            if (otherConquest.territoryId === conquest.territoryId && otherAttackerId !== attackerId) {
                this.activeConquests.delete(otherAttackerId);
                this.io.to(otherAttackerId).emit('conquestFailed', {
                    territoryId: conquest.territoryId,
                    message: `Another player conquered this territory first!`
                });
                debug(`Conquest cancelled for ${otherAttackerId} - territory ${conquest.territoryId} already conquered`);
            }
        }

        try {
            await this.pool.query('BEGIN');

            // Transfer ownership and increment laps_required
            await this.pool.query(
                `UPDATE territories 
                 SET owner_id = $1, owner_name = $2, username = $3, profile_image_url = $4, 
                     laps_required = $5, identity_color = $6, brand_wrapper = NULL
                 WHERE id = $7`,
                [attacker.googleId, attacker.name, attacker.name, attacker.profileImageUrl, conquest.lapsRequired, attacker.identityColor, conquest.territoryId]
            );

            await this.pool.query('COMMIT');

            this.activeConquests.delete(attackerId);

            this.io.emit('conquerAttemptSuccessful', {
                territoryId: conquest.territoryId,
                newOwnerId: attacker.googleId,
                newOwnerName: attacker.name
            });

            debug(`Conquest successful: Territory ${conquest.territoryId} now owned by ${attacker.name}`);

        } catch (err) {
            await this.pool.query('ROLLBACK');
            console.error("Error finalizing conquest:", err);
            this.activeConquests.delete(attackerId);
        }
    }

    // --- BASE LINKING LOGIC ---

    async startBaseLink(playerId, baseA_Id, baseB_Id) {
        // Validate ownership of both bases
        // Create a temporary "bridge" state
        // This is complex geometry logic, simplified for now:
        // Just tracking that a link attempt is active.

        const linkId = `link-${playerId}-${Date.now()}`;
        this.baseLinks.set(linkId, {
            id: linkId,
            playerId,
            baseA: baseA_Id,
            baseB: baseB_Id,
            status: 'active',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
        });

        return linkId;
    }

    async finalizeBaseLink(playerId) {
        // Find active link for player
        const linkId = Array.from(this.baseLinks.keys()).find(k => this.baseLinks.get(k).playerId === playerId);
        if (!linkId) throw new Error("No active base link found.");

        const link = this.baseLinks.get(linkId);

        // In a real implementation, we would verify the trail geometry here.
        // For now, we assume the client enforced the "run back" rule.

        try {
            await this.pool.query('BEGIN');
            // Create a permanent link record in DB (assuming a table exists, or just log it)
            // For this MVP, we'll just log success and maybe merge the areas if they touch?
            // Or just store the link.

            // Let's assume we just want to acknowledge the link for now.
            debug(`Base link finalized for ${playerId}: ${link.baseA} <-> ${link.baseB}`);

            await this.pool.query('COMMIT');

            this.baseLinks.delete(linkId);
            this.io.to(playerId).emit('baseLinkFinalized', { linkId });

        } catch (err) {
            await this.pool.query('ROLLBACK');
            throw err;
        }
    }
}

module.exports = ConquestHandler;
