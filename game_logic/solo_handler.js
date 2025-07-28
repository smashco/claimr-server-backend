// solo_handler.js

import turfDifference from '@turf/difference';
import turfUnion from '@turf/union';
import turfIntersect from '@turf/intersect';
import turfArea from '@turf/area';
import turfBooleanContains from '@turf/boolean-contains';
import turfBooleanIntersects from '@turf/boolean-intersects';

/**
 * Handles a solo territory claim including regular and infiltrator logic
 * @param {Object} attacker - { id, trail: GeoJSON, socket, power, hasTerritory }
 * @param {Object} victim - { id, territory: GeoJSON, shield: boolean, socket }
 * @returns {Object} outcome
 */
export async function handleSoloClaim(attacker, victim) {
  const { trail, power, hasTerritory } = attacker;
  const { territory, shield } = victim;

  const fullyInside = turfBooleanContains(trail, territory);
  const overlaps = turfBooleanIntersects(trail, territory);
  const areaTrail = turfArea(trail);

  // --- INFILTRATOR POWER ---
  if (power === 'infiltrator') {
    if (hasTerritory) {
      return {
        result: 'Infiltrator power blocked: already has territory',
        success: false
      };
    }

    if (!overlaps) {
      return {
        result: 'Infiltrator failed: not inside enemy territory',
        success: false,
        infiltratorUsed: true
      };
    }

    if (shield) {
      return {
        result: 'Infiltrator failed: enemy was shielded',
        success: false,
        shieldBroken: true,
        infiltratorUsed: true
      };
    }

    // Success: carve out circle from enemy territory
    const newVictimTerritory = turfDifference(territory, trail);

    return {
      result: 'Infiltrator success: base carved inside enemy territory',
      success: true,
      updatedTerritory: newVictimTerritory,
      gainedArea: trail,
      infiltratorUsed: true
    };
  }

  // --- REGULAR CLAIM SCENARIOS ---

  // Case 1: Victim is shielded — punch hole / island
  if (shield) {
    const holed = turfDifference(territory, trail);
    if (!holed) {
      return {
        result: 'Shield blocked wipeout, but entire base removed',
        victimShieldBroken: true,
        updatedTerritory: null
      };
    }

    return {
      result: 'Shield absorbed and punched hole',
      victimShieldBroken: true,
      updatedTerritory: holed
    };
  }

  // Case 2: Entire victim base fully inside attacker's shape (but no intersect) = surrounded wipeout
  if (fullyInside && !overlaps) {
    return {
      result: 'Wipeout by full containment',
      victimEliminated: true,
      absorbedArea: territory
    };
  }

  // Case 3: Fully intersected and contained — wipeout
  if (fullyInside && overlaps) {
    const absorbed = turfUnion(trail, territory);
    return {
      result: 'Full wipeout by overlap',
      victimEliminated: true,
      absorbedArea: absorbed
    };
  }

  // Case 4: Partial intersection — subtract overlap
  if (overlaps) {
    const damaged = turfDifference(territory, trail);
    const overlapArea = turfIntersect(trail, territory);

    return {
      result: 'Partial damage',
      victimEliminated: false,
      updatedTerritory: damaged,
      damagedArea: overlapArea
    };
  }

  // Case 5: No intersection — skip
  return {
    result: 'No effect — attack missed',
    victimEliminated: false
  };
}

export default handleSoloClaim;
