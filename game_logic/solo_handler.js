const turf = require("@turf/turf");

async function handleSoloClaim(io, socket, player, players, trail, baseClaim, client) {
  const userId = player.googleId;
  const polygon = player.claimedArea;
  const playerName = player.name;
  const power = player.currentPower;
  const team = player.team;
  const oldEnemyArea = player.currentEnemyArea;

  console.log("Trail", trail);
  console.log("BaseClaim", baseClaim);

  if (trail.length < 3) return;

  const newAreaPolygon = turf.polygon([trail]);
  const newAreaSqM = turf.area(newAreaPolygon);

  // BASE CLAIM LOGIC
  if (baseClaim) {
    if (power === "infiltrator") {
      console.log("[INFILTRATOR] Base Circle initialized");
      player.infiltratorInitialBasePolygon = newAreaPolygon;
    }

    if (!polygon || polygon.coordinates.length === 0) {
      player.claimedArea = newAreaPolygon;
    } else {
      const updatedClaim = turf.union(polygon, newAreaPolygon);
      player.claimedArea = updatedClaim;
    }

    console.log(`[BASE CLAIM] ${newAreaSqM.toFixed(2)} sqm`);
    return;
  }

  // INFILTRATOR EXPANSION LOGIC
  if (power === "infiltrator") {
    console.log("[INFILTRATOR] Trail detected — trying to claim into enemy");

    if (!player.infiltratorInitialBasePolygon) {
      console.warn("[INFILTRATOR] No initial base polygon, aborting claim");
      return;
    }

    const initialPoly = player.infiltratorInitialBasePolygon;
    const fullTrail = turf.union(initialPoly, newAreaPolygon);

    const intersected = turf.intersect(fullTrail, player.currentEnemyArea);

    if (intersected) {
      const carvedOutEnemy = turf.difference(player.currentEnemyArea, intersected);
      const updatedClaim = turf.union(player.claimedArea, intersected);

      player.claimedArea = updatedClaim;
      player.currentEnemyArea = carvedOutEnemy;

      console.log(`[INFILTRATOR] Claimed ${turf.area(intersected).toFixed(2)} sqm`);
    } else {
      console.log("[INFILTRATOR] No intersected enemy area");
    }

    player.infiltratorInitialBasePolygon = null;
    return;
  }

  // ERASE ENEMY POWER
  if (power === "eraser") {
    const intersected = turf.intersect(newAreaPolygon, player.currentEnemyArea);
    if (intersected) {
      const newEnemyArea = turf.difference(player.currentEnemyArea, intersected);
      player.currentEnemyArea = newEnemyArea;

      console.log(`[ERASER] Removed ${turf.area(intersected).toFixed(2)} sqm from enemy`);
    } else {
      console.log("[ERASER] No overlap with enemy");
    }
    return;
  }

  // TELEPORT — just overwrite area
  if (power === "teleport") {
    player.claimedArea = newAreaPolygon;
    console.log(`[TELEPORT] Teleported to new area ${newAreaSqM.toFixed(2)} sqm`);
    return;
  }

  // MAGNET — Expand your area by buffering trail and merging
  if (power === "magnet") {
    const buffered = turf.buffer(newAreaPolygon, 10, { units: "meters" });
    const newClaim = turf.union(player.claimedArea, buffered);
    player.claimedArea = newClaim;

    console.log(`[MAGNET] Pulled ${turf.area(buffered).toFixed(2)} sqm`);
    return;
  }

  // DUPLICATE — Copy current claim and shift it
  if (power === "duplicate") {
    const shifted = turf.transformTranslate(player.claimedArea, 50, 90);
    const duplicated = turf.union(player.claimedArea, shifted);
    player.claimedArea = duplicated;

    console.log("[DUPLICATE] Area duplicated");
    return;
  }

  // ERASE ENEMY DIRECTLY
  if (power === "eraser-enemy") {
    const overlap = turf.intersect(player.currentEnemyArea, newAreaPolygon);
    if (overlap) {
      player.currentEnemyArea = turf.difference(player.currentEnemyArea, overlap);
      console.log(`[ERASER-ENEMY] Erased ${turf.area(overlap).toFixed(2)} sqm`);
    } else {
      console.log("[ERASER-ENEMY] No overlap with enemy");
    }
    return;
  }

  // NORMAL CLAIM — default claim logic
  const intersected = turf.intersect(newAreaPolygon, player.currentEnemyArea);
  if (intersected) {
    const enemyAfterCarve = turf.difference(player.currentEnemyArea, intersected);
    const updatedClaim = turf.union(player.claimedArea, intersected);

    player.claimedArea = updatedClaim;
    player.currentEnemyArea = enemyAfterCarve;

    console.log(`[NORMAL CLAIM] Claimed ${turf.area(intersected).toFixed(2)} sqm from enemy`);
  } else {
    console.log("[NORMAL CLAIM] No intersected enemy area");
  }
}

module.exports = { handleSoloClaim };
