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

    createChallenge(challengerId, opponentGoogleId) {
        const challenger = this.players[challengerId];

        // Find opponent by Google ID (opponentGoogleId is sent from client)
        const opponentSocketId = Object.keys(this.players).find(
            socketId => this.players[socketId].googleId === opponentGoogleId
        );

        if (!challenger || !opponentSocketId) {
            throw new Error("Player not found.");
        }

        const opponent = this.players[opponentSocketId];

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
            opponentId: opponentSocketId, // Store socket ID, not Google ID
            expiresAt: Date.now() + 30000 // 30 seconds to accept
        });

        // Notify opponent using their socket ID
        this.io.to(opponentSocketId).emit('raceChallengeReceived', {
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

        const p1 = this.players[p1Id];
        const p2 = this.players[p2Id];

        // Calculate midpoint between both players for fairness
        const p1Point = turf.point([p1.lastKnownPosition.lng, p1.lastKnownPosition.lat]);
        const p2Point = turf.point([p2.lastKnownPosition.lng, p2.lastKnownPosition.lat]);
        const midpoint = turf.midpoint(p1Point, p2Point);

        // Project 500m (0.5km) from midpoint in a random direction
        const bearing = Math.floor(Math.random() * 360);
        const finishPoint = turf.destination(midpoint, 0.5, bearing, { units: 'kilometers' });

        const raceState = {
            id: raceId,
            participants: [p1Id, p2Id],
            startTime: Date.now(),
            finishLine: finishPoint.geometry.coordinates, // [lng, lat]
            finishRadius: 0.03, // 30 meters tolerance
            isActive: true
        };

        this.activeRaces.set(raceId, raceState);

        // Notify both players with the SAME finish line
        const finishLineData = {
            lat: finishPoint.geometry.coordinates[1],
            lng: finishPoint.geometry.coordinates[0]
        };

        [p1Id, p2Id].forEach(pid => {
            this.io.to(pid).emit('raceStarted', {
                raceId,
                finishLine: finishLineData,
                opponentName: pid === p1Id ? this.players[p2Id].name : this.players[p1Id].name
            });
        });

        debug(`Race started: ${raceId}, Finish: ${finishLineData.lat}, ${finishLineData.lng}`);
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
