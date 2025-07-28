// solo_handler.js (ESM-compatible full script with corrected function name)

import turfDifference from '@turf/difference';
import turfUnion from '@turf/union';
import turfIntersect from '@turf/intersect';
import turfArea from '@turf/area';
import turfBooleanContains from '@turf/boolean-contains';
import turfBooleanIntersects from '@turf/boolean-intersects';

/**
 * Handles a solo territory attack between attacker and victim
 * @param {Object} attacker - { id, trail: GeoJSON, socket }
 * @param {Object} victim - { id, territory: GeoJSON, shield: boolean, socket }
 * @returns {Object} outcome
 */
export async function handleSoloClaim(attacker, victim) {
  const { trail } = attacker;
  const { territory, shield } = victim;

  const fullyInside = turfBooleanContains(trail, territory);
  const overlaps = turfBooleanIntersects(trail, territory);

  // Case 1: Victim has shield → punch hole/island
  if (shield) {
    const holed = turfDifference(territory, trail);
    if (!holed) {
      // Hole completely destroyed territory
      return {
        result: 'Shield blocked wipeout, but territory lost',
        victimShieldBroken: true,
        updatedTerritory: null
      };
    }
    return {
      result: 'Shield absorbed attack by making hole',
      victimShieldBroken: true,
      updatedTerritory: holed
    };
  }

  // Case 2: Entire victim inside attacker base (after shield down) → Wipeout
  if (fullyInside && !overlaps) {
    return {
      result: 'Wipeout by Surrounding (No Contact)',
      victimEliminated: true,
      absorbedArea: territory
    };
  }

  // Case 3: Fully intersected → Wipeout
  if (fullyInside && overlaps) {
    const absorbed = turfUnion(trail, territory);
    return {
      result: 'Full Wipeout by Contact',
      victimEliminated: true,
      absorbedArea: absorbed
    };
  }

  // Case 4: Partial damage
  if (overlaps) {
    const overlapArea = turfIntersect(trail, territory);
    const damaged = turfDifference(territory, trail);

    return {
      result: 'Partial Damage',
      victimEliminated: false,
      updatedTerritory: damaged,
      damagedArea: overlapArea
    };
  }

  // Case 5: No interaction
  return {
    result: 'No Effect',
    victimEliminated: false
  };
}

export default handleSoloClaim;
