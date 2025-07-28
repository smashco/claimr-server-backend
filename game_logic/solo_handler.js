// solo_handler.js

import turfDifference from '@turf/difference';
import turfUnion from '@turf/union';
import turfIntersect from '@turf/intersect';
import turfArea from '@turf/area';
import turfBooleanContains from '@turf/boolean-contains';
import turfBooleanIntersects from '@turf/boolean-intersects';

/**
 * Handles a solo territory attack between attacker and victim.
 * Rules implemented:
 * - Wipeout if victim’s remaining area < 30%
 * - No wipeout if an unshielded player is fully inside the attacker
 * - Full wipeout if fully surrounded and overlaps
 * - Partial wipeout if partially inside
 * - Shield: if active, attacker just carves a hole
 */
export default async function handleSoloClaim(attacker, victim) {
  const { trail } = attacker;
  const { territory, shield } = victim;

  const fullyInside = turfBooleanContains(trail, territory);
  const overlaps = turfBooleanIntersects(trail, territory);

  const victimArea = turfArea(territory);

  // 🛡️ 1. Shield: Punch hole, but do not wipeout
  if (shield) {
    const holed = turfDifference(territory, trail);
    if (!holed || turfArea(holed) < victimArea * 0.1) {
      // territory too damaged
      return {
        result: 'Shield blocked wipeout, but territory mostly lost',
        victimShieldBroken: true,
        updatedTerritory: null,
        victimEliminated: true
      };
    }
    return {
      result: 'Shield absorbed attack by making hole',
      victimShieldBroken: true,
      updatedTerritory: holed,
      victimEliminated: false
    };
  }

  // 🌀 2. Full Inside but no overlap: surround wipeout
  if (fullyInside && !overlaps) {
    return {
      result: 'Wipeout: Surrounded with no contact',
      victimEliminated: true,
      absorbedArea: territory
    };
  }

  // 🔥 3. Full Inside + Overlap: full wipeout
  if (fullyInside && overlaps) {
    const absorbed = turfUnion(trail, territory);
    return {
      result: 'Full Wipeout: Complete overlap',
      victimEliminated: true,
      absorbedArea: absorbed
    };
  }

  // ⚠️ 4. Partial overlap: calculate area-based partial wipeout
  if (overlaps) {
    const overlapArea = turfIntersect(trail, territory);
    const damaged = turfDifference(territory, trail);

    const remainingArea = damaged ? turfArea(damaged) : 0;
    const remainingPercent = remainingArea / victimArea;

    if (remainingPercent < 0.3) {
      return {
        result: 'Wipeout: Remaining territory < 30%',
        victimEliminated: true,
        updatedTerritory: null
      };
    }

    return {
      result: 'Partial Damage: > 30% remains',
      victimEliminated: false,
      updatedTerritory: damaged,
      damagedArea: overlapArea
    };
  }

  // 🧊 5. No interaction
  return {
    result: 'No Effect: No overlap or containment',
    victimEliminated: false
  };
}
