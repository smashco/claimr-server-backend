const turf = require('@turf/turf');
const debug = require('debug')('server:game:conquest');

class ConquestHandler {
    constructor(pool, io, players) {
        this.pool = pool;
        this.io = io;
        this.players = players;
        this.activeConquests = new Map(); // territoryId -> { attackerId, lapsCompleted, startTime, expiresAt }
        this.baseLinks = new Map(); // linkId -> { playerId, baseA, baseB, trail, expiresAt }
    }

    // --- CONQUERING LOGIC ---

    async startConquerAttempt(attackerId, territoryId) {
        const attacker = this.players[attackerId];
        if (!attacker) throw new Error("Player not found.");

        // Verify territory exists and is not owned by attacker
        const res = await this.pool.query('SELECT id, owner_id, laps_required, area FROM territories WHERE id = $1', [territoryId]);
        if (res.rowCount === 0) throw new Error("Territory not found.");
        const territory = res.rows[0];

        if (territory.owner_id === attacker.googleId) throw new Error("You already own this territory.");

        // Start conquest state
        const conquestState = {
            territoryId,
            attackerId,
            lapsRequired: territory.laps_required + 1, // Each conquest increases difficulty
            lapsCompleted: 0,
            startTime: Date.now(),
            expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes to conquer
            lastLapTime: Date.now()
        };

        this.activeConquests.set(territoryId, conquestState);

        // Notify attacker and owner (if online)
        this.io.to(attackerId).emit('conquerAttemptStarted', {
            territoryId,
            lapsRequired: conquestState.lapsRequired,
            expiresAt: conquestState.expiresAt
        });

        const ownerSocketId = Object.keys(this.players).find(k => this.players[k].googleId === territory.owner_id);
        if (ownerSocketId) {
            this.io.to(ownerSocketId).emit('territoryUnderAttack', { territoryId, attackerName: attacker.name });
        }

        debug(`Conquest started: ${attacker.name} vs Territory ${territoryId}`);
    }

    recordLap(attackerId, territoryId) {
        const conquest = this.activeConquests.get(territoryId);
        if (!conquest || conquest.attackerId !== attackerId) return;

        conquest.lapsCompleted++;
        conquest.lastLapTime = Date.now();

        debug(`Lap recorded for Territory ${territoryId}. Progress: ${conquest.lapsCompleted}/${conquest.lapsRequired}`);

        if (conquest.lapsCompleted >= conquest.lapsRequired) {
            this._finalizeConquest(territoryId);
        } else {
            this.io.to(attackerId).emit('conquestLapCompleted', {
                territoryId,
                lapsCompleted: conquest.lapsCompleted,
                lapsRequired: conquest.lapsRequired
            });
        }
    }

    async _finalizeConquest(territoryId) {
        const conquest = this.activeConquests.get(territoryId);
        if (!conquest) return;

        const attacker = this.players[conquest.attackerId];

        try {
            await this.pool.query('BEGIN');

            // Transfer ownership and increment laps_required
            await this.pool.query(
                `UPDATE territories 
                 SET owner_id = $1, owner_name = $2, username = $3, profile_image_url = $4, 
                     laps_required = $5, identity_color = $6, brand_wrapper = NULL
                 WHERE id = $7`,
                [attacker.googleId, attacker.name, attacker.name, attacker.profileImageUrl, conquest.lapsRequired, attacker.identityColor, territoryId]
            );

            await this.pool.query('COMMIT');

            this.activeConquests.delete(territoryId);

            this.io.emit('conquerAttemptSuccessful', {
                territoryId,
                newOwnerId: attacker.googleId,
                newOwnerName: attacker.name
            });

            debug(`Conquest successful: Territory ${territoryId} now owned by ${attacker.name}`);

        } catch (err) {
            await this.pool.query('ROLLBACK');
            console.error("Error finalizing conquest:", err);
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
