const turf = require('@turf/turf');
const debug = require('debug')('server:game:race');

class RaceHandler {
    constructor(io, players) {
        this.io = io;
        this.players = players; // Reference to the global players object
        this.activeRaces = new Map(); // raceId -> { challengerId, opponentId, state, ... }
        this.pendingChallenges = new Map(); // challengeId -> { challengerId, opponentId, expiresAt }
    }

    // --- CHALLENGE LOGIC ---

    createChallenge(challengerId, opponentId) {
        const challenger = this.players[challengerId];
        const opponent = this.players[opponentId];

        if (!challenger || !opponent) {
            throw new Error("Player not found.");
        }

        // Check if players are close enough (500m)
        const dist = turf.distance(
            turf.point([challenger.lastKnownPosition.lng, challenger.lastKnownPosition.lat]),
            turf.point([opponent.lastKnownPosition.lng, opponent.lastKnownPosition.lat]),
            { units: 'kilometers' }
        );

        if (dist > 0.5) {
            throw new Error("Opponent is too far away.");
        }

        const challengeId = `race-${challengerId}-${Date.now()}`;
        this.pendingChallenges.set(challengeId, {
            id: challengeId,
            challengerId,
            opponentId,
            expiresAt: Date.now() + 30000 // 30 seconds to accept
        });

        // Notify opponent
        this.io.to(opponentId).emit('raceChallengeReceived', {
            challengeId,
            challengerName: challenger.name,
            distanceKm: dist
        });

        debug(`Challenge created: ${challenger.name} vs ${opponent.name}`);
        return challengeId;
    }

    acceptChallenge(challengeId, acceptingPlayerId) {
        const challenge = this.pendingChallenges.get(challengeId);
        if (!challenge) {
            throw new Error("Challenge expired or invalid.");
        }

        if (challenge.opponentId !== acceptingPlayerId) {
            throw new Error("Not authorized to accept this challenge.");
        }

        this.pendingChallenges.delete(challengeId);
        this._startRace(challenge.challengerId, challenge.opponentId);
    }

    rejectChallenge(challengeId, rejectingPlayerId) {
        const challenge = this.pendingChallenges.get(challengeId);
        if (challenge && challenge.opponentId === rejectingPlayerId) {
            this.pendingChallenges.delete(challengeId);
            this.io.to(challenge.challengerId).emit('raceChallengeRejected', { reason: 'Opponent declined.' });
        }
    }

    // --- RACE LOGIC ---

    _startRace(p1Id, p2Id) {
        const raceId = `active-race-${Date.now()}`;
        
        // Determine a finish line 500m away based on Challenger's heading (simplified: just pick a point 500m North for now, 
        // ideally we'd use their current bearing but we might not have it. 
        // BETTER: Use the midpoint + 500m in a random direction or just 500m from Challenger)
        
        const p1 = this.players[p1Id];
        const startPoint = turf.point([p1.lastKnownPosition.lng, p1.lastKnownPosition.lat]);
        // Project 500m (0.5km) North (0 degrees) for simplicity, or random bearing
        const bearing = Math.floor(Math.random() * 360);
        const finishPoint = turf.destination(startPoint, 0.5, bearing, { units: 'kilometers' });
        
        const raceState = {
            id: raceId,
            participants: [p1Id, p2Id],
            startTime: Date.now(),
            finishLine: finishPoint.geometry.coordinates, // [lng, lat]
            finishRadius: 0.03, // 30 meters tolerance
            isActive: true
        };

        this.activeRaces.set(raceId, raceState);

        // Notify both players
        [p1Id, p2Id].forEach(pid => {
            this.io.to(pid).emit('raceStarted', {
                raceId,
                finishLine: { lat: finishPoint.geometry.coordinates[1], lng: finishPoint.geometry.coordinates[0] },
                opponentName: pid === p1Id ? this.players[p2Id].name : this.players[p1Id].name
            });
        });

        debug(`Race started: ${raceId}`);
    }

    checkRaceProgress(playerId, lat, lng) {
        // Find race where this player is a participant
        for (const [raceId, race] of this.activeRaces) {
            if (race.participants.includes(playerId) && race.isActive) {
                const distToFinish = turf.distance(
                    turf.point([lng, lat]),
                    turf.point(race.finishLine),
                    { units: 'kilometers' }
                );

                if (distToFinish <= race.finishRadius) {
                    this._endRace(raceId, playerId);
                    return;
                }
            }
        }
    }

    _endRace(raceId, winnerId) {
        const race = this.activeRaces.get(raceId);
        if (!race) return;

        race.isActive = false;
        this.activeRaces.delete(raceId);

        const loserId = race.participants.find(p => p !== winnerId);

        this.io.to(winnerId).emit('raceWon', { raceId });
        if (loserId) {
            this.io.to(loserId).emit('raceLost', { raceId, winnerName: this.players[winnerId].name });
        }

        debug(`Race ended. Winner: ${this.players[winnerId].name}`);
    }
}

module.exports = RaceHandler;
