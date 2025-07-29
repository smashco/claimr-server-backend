const turf = require("@turf/turf");

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
    const userId = player.googleId;
    const playerName = player.name;
    const power = player.currentPower;
    const team = player.team;

    let polygon = player.claimedArea;
    let oldEnemyArea = player.currentEnemyArea;

    console.log("Trail", trail);
    console.log("BaseClaim", baseClaim);

    if (!trail || trail.length < 3) {
        console.warn("[CLAIM] Invalid trail");
        return;
    }

    const points = [...trail, trail[0]]; // close polygon
    let newAreaPolygon;
    try {
        newAreaPolygon = turf.polygon([points]);
    } catch (err) {
        console.error("[ERROR] Invalid polygon:", err.message);
        return;
    }

    const newAreaSqM = turf.area(newAreaPolygon);
    console.log(`[DEBUG] New Area: ${newAreaSqM.toFixed(2)} sqm`);

    // ============ BASE CLAIM ============
    if (baseClaim) {
        console.log(`[BASE CLAIM] for ${playerName}, Power: ${power}`);

        if (power === "infiltrator") {
            console.log("[INFILTRATOR] Base initialized");
            player.infiltratorInitialBasePolygon = newAreaPolygon;
        }

        if (!polygon || polygon.coordinates.length === 0) {
            player.claimedArea = newAreaPolygon;
        } else {
            const updatedClaim = turf.union(polygon, newAreaPolygon);
            player.claimedArea = updatedClaim;
        }

        return;
    }

    // ============ INFILTRATOR EXPANSION ============
    if (power === "infiltrator") {
        console.log("[INFILTRATOR] Attempting to expand from infiltrator base");

        const initialPoly = player.infiltratorInitialBasePolygon;
        if (!initialPoly) {
            console.warn("[INFILTRATOR] No initial base polygon set");
            return;
        }

        const fullTrail = turf.union(initialPoly, newAreaPolygon);
        const intersected = turf.intersect(fullTrail, oldEnemyArea);

        if (intersected) {
            const carvedEnemy = turf.difference(oldEnemyArea, intersected);
            const updatedClaim = turf.union(player.claimedArea, intersected);

            player.claimedArea = updatedClaim;
            player.currentEnemyArea = carvedEnemy;

            console.log(`[INFILTRATOR] Claimed ${turf.area(intersected).toFixed(2)} sqm`);
        } else {
            console.log("[INFILTRATOR] No enemy territory intersected");
        }

        player.infiltratorInitialBasePolygon = null;
        return;
    }

    // ============ ERASER ============
    if (power === "eraser") {
        const intersected = turf.intersect(newAreaPolygon, oldEnemyArea);
        if (intersected) {
            const newEnemyArea = turf.difference(oldEnemyArea, intersected);
            player.currentEnemyArea = newEnemyArea;

            console.log(`[ERASER] Removed ${turf.area(intersected).toFixed(2)} sqm from enemy`);
        } else {
            console.log("[ERASER] No overlap with enemy");
        }
        return;
    }

    // ============ TELEPORT ============
    if (power === "teleport") {
        player.claimedArea = newAreaPolygon;
        console.log(`[TELEPORT] Teleported to new area: ${newAreaSqM.toFixed(2)} sqm`);
        return;
    }

    // ============ MAGNET ============
    if (power === "magnet") {
        const buffered = turf.buffer(newAreaPolygon, 10, { units: "meters" });
        const newClaim = turf.union(player.claimedArea, buffered);
        player.claimedArea = newClaim;

        console.log(`[MAGNET] Pulled ${turf.area(buffered).toFixed(2)} sqm`);
        return;
    }

    // ============ DUPLICATE ============
    if (power === "duplicate") {
        const shifted = turf.transformTranslate(player.claimedArea, 50, 90); // shift 50m east
        const duplicated = turf.union(player.claimedArea, shifted);
        player.claimedArea = duplicated;

        console.log("[DUPLICATE] Area duplicated");
        return;
    }

    // ============ ERASE ENEMY ============
    if (power === "eraser-enemy") {
        const overlap = turf.intersect(oldEnemyArea, newAreaPolygon);
        if (overlap) {
            player.currentEnemyArea = turf.difference(oldEnemyArea, overlap);
            console.log(`[ERASER-ENEMY] Erased ${turf.area(overlap).toFixed(2)} sqm`);
        } else {
            console.log("[ERASER-ENEMY] No overlap with enemy");
        }
        return;
    }

    // ============ NORMAL CLAIM ============
    console.log("[NORMAL CLAIM] Executing default claim logic");
    const intersected = turf.intersect(newAreaPolygon, oldEnemyArea);

    if (intersected) {
        const updatedEnemy = turf.difference(oldEnemyArea, intersected);
        const updatedClaim = turf.union(player.claimedArea, intersected);

        player.claimedArea = updatedClaim;
        player.currentEnemyArea = updatedEnemy;

        console.log(`[NORMAL CLAIM] Claimed ${turf.area(intersected).toFixed(2)} sqm from enemy`);
    } else {
        console.log("[NORMAL CLAIM] No intersected enemy area");
    }
}

module.exports = { handleSoloClaim };
