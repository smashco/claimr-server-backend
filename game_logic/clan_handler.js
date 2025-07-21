// claimr_server/game_logic/clan_handler.js

const turf = require('@turf/turf');

async function handleClanClaim(io, socket, player, trail, baseClaim, client) { 
    const clanId = player.clanId;
    const userId = player.googleId; 
    
    const clanShieldRes = await client.query('SELECT has_shield FROM clans WHERE id = $1', [clanId]);
    const clanHasShield = clanShieldRes.rows.length > 0 ? clanShieldRes.rows[0].has_shield : false;


    if (!baseClaim) {
        socket.emit('claimRejected', { reason: 'Clan claims must start from an active clan base (missing baseClaim data).' });
        return null;
    }

    const clanBaseResult = await client.query('SELECT base_location FROM clans WHERE id = $1', [clanId]);
    if (clanBaseResult.rows.length === 0 || !clanBaseResult.rows[0].base_location) {
        socket.emit('claimRejected', { reason: 'Clan base is not active. Leader must activate it.' });
        return null;
    }
    const baseLocationWKT = clanBaseResult.rows[0].base_location;
    
    let newAreaPolygon;
    let newAreaSqM;

    if (trail.length === 1 && baseClaim) {
        const center = [baseClaim.lng, baseClaim.lat];
        const radius = 56.42; 
        try {
            newAreaPolygon = turf.circle(center, radius, { units: 'meters' });
        } catch (e) {
            console.error(`[ClanClaim] Error creating initial clan base circle for clan ${clanId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid base location geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        console.log(`[ClanClaim] Initial clan base claim attempt for clan ${clanId}. Area: ${newAreaSqM} sqm.`);

        const memberInfoRes = await client.query('SELECT role FROM clan_members WHERE clan_id = $1 AND user_id = $2', [clanId, userId]);
        if (memberInfoRes.rows.length === 0 || memberInfoRes.rows[0].role !== 'leader') {
            socket.emit('claimRejected', { reason: 'Only the clan leader can establish the clan base.' });
            return null;
        }

        if (clanBaseResult.rows[0].base_location) {
            socket.emit('claimRejected', { reason: 'Clan base already established.' });
            return null;
        }

        await client.query(`UPDATE clans SET base_location = ST_SetSRID(ST_Point($1, $2), 4326) WHERE id = $3;`, [baseClaim.lng, baseClaim.lat, clanId]);

    } else { 
        if (trail.length < 3) {
            socket.emit('claimRejected', { reason: 'Expansion trail must have at least 3 points to form a polygon.' });
            return null;
        }
        const pointsForPolygon = [...trail.map(p => [p.lng, p.lat]), trail[0] ? [trail[0].lng, trail[0].lat] : null].filter(Boolean);
        try {
            newAreaPolygon = turf.polygon([pointsForPolygon]);
        } catch (e) {
            console.error(`[ClanClaim] Error creating polygon from trail for clan ${clanId}:`, e.message);
            socket.emit('claimRejected', { reason: 'Invalid loop geometry.' });
            return null;
        }
        newAreaSqM = turf.area(newAreaPolygon);
        if (newAreaSqM < 100) { 
            socket.emit('claimRejected', { reason: 'Area is too small to claim (min 100sqm).' });
            return null;
        }

        const existingClanAreaRes = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM clan_territories WHERE clan_id = $1', [clanId]); 
        const existingClanAreaGeoJSON = existingClanAreaRes.rows.length > 0 ? existingClanAreaRes.rows[0].geojson_area : null;
        const existingClanAreaTurf = existingClanAreaGeoJSON ? JSON.parse(existingClanAreaGeoJSON) : null;


        if (!existingClanAreaTurf || turf.area(existingClanAreaTurf) === 0) { 
            console.warn(`[ClanClaim] Player ${userId} attempting expansion claim for clan ${clanId} but clan has no existing territory/base.`);
            socket.emit('claimRejected', { reason: 'Clan base must be established before expansion.' });
            return null;
        }

        const intersectsExisting = await client.query(`SELECT ST_Intersects(ST_GeomFromGeoJSON($1), ST_GeomFromGeoJSON($2)) as intersects;`, [JSON.stringify(newAreaPolygon.geometry), existingClanAreaGeoJSON]);
        if (!intersectsExisting.rows[0].intersects) {
            console.log(`[ClanClaim] Expansion claim for clan ${clanId} does not connect to existing territory.`);
            socket.emit('claimRejected', { reason: 'Expansion must connect to your clan\'s existing territory.' });
            return null;
        }
        
        const startPoint = trail[0];
        const distanceThreshold = 70; 
        const distanceCheckResult = await client.query(`
            SELECT ST_Distance(
                ST_Transform(ST_SetSRID(ST_GeomFromText('POINT(${startPoint.lng} ${startPoint.lat})'), 4326), 28355),
                ST_Transform($1, 28355)
            ) AS distance_meters;
        `, [baseLocationWKT]);

        if (distanceCheckResult.rows[0].distance_meters > distanceThreshold) {
            socket.emit('claimRejected', { reason: 'Trail must start closer to the clan base.' });
            return null;
        }
    }


    const newAreaWKT = `ST_GeomFromGeoJSON('${JSON.stringify(newAreaPolygon.geometry)}')`;
    const affectedOwnerIds = new Set(); 
    affectedOwnerIds.add(clanId.toString()); 

    // --- Area Steal Mechanism (Clan vs Solo & Clan vs Clan) ---
    const intersectingSoloTerritoriesQuery = `
        SELECT owner_id, username, area, has_shield, ST_AsText(original_base_point) as original_base_point_wkt
        FROM territories
        WHERE ST_Intersects(area, ${newAreaWKT});
    `; 
    const intersectingSoloTerritoriesResult = await client.query(intersectingSoloTerritoriesQuery);

    for (const row of intersectingSoloTerritoriesResult.rows) {
        const victimId = row.owner_id;
        const victimCurrentArea = row.area;
        const victimUsername = row.username;
        const victimHasShield = row.has_shield;
        const victimOriginalBasePointWKT = row.original_base_point_wkt;

        const isFriendlySoloPlayer = await client.query('SELECT 1 FROM clan_members WHERE clan_id = $1 AND user_id = $2', [clanId, victimId]);
        if (isFriendlySoloPlayer.rowCount > 0) {
            console.log(`[ClanClaim] Skipping steal from friendly solo player ${victimUsername}.`);
            continue; 
        }

        const intersectionGeomResult = await client.query(`SELECT ST_AsGeoJSON(ST_Intersection(ST_GeomFromGeoJSON($1), $2)) AS intersected_geom;`, [JSON.stringify(newAreaPolygon.geometry), victimCurrentArea]);
        const intersectedGeomGeoJSON = intersectionGeomResult.rows[0].intersected_geom;
        const intersectedSqM = intersectedGeomGeoJSON ? turf.area(JSON.parse(intersectedGeomGeoJSON)) : 0;

        if (intersectedSqM > 0) {
            console.log(`[ClanClaim] Clan ${player.name}'s claim intersects solo player ${victimUsername}'s territory.`);

            let shieldActivated = false;
            if (victimHasShield && victimOriginalBasePointWKT) {
                const basePointIntersectsClaim = await client.query(`SELECT ST_Intersects(ST_GeomFromText($1), ST_GeomFromGeoJSON($2)) AS intersects_base_point;`, [victimOriginalBasePointWKT, intersectedGeomGeoJSON]);
                if (basePointIntersectsClaim.rows[0].intersects_base_point) {
                    shieldActivated = true;
                    console.log(`[ClanClaim] Solo player ${victimUsername}'s shield activated! Clan cannot steal base point.`);
                    socket.emit('claimRejected', { reason: `Solo player ${victimUsername}'s shield activated! Cannot steal this area.` });
                    return null;
                }
            }
            
            if (!shieldActivated) {
                const diffGeomResult = await client.query(`
                    SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
                `, [victimCurrentArea]);

                const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;

                if (remainingAreaGeoJSON && JSON.parse(remainingAreaGeoJSON).coordinates.length > 0) { 
                    const remainingAreaTurf = JSON.parse(remainingAreaGeoJSON);
                    const remainingAreaSqM = turf.area(remainingAreaTurf);
                    await client.query(`
                        UPDATE territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                        WHERE owner_id = $3;
                    `, [remainingAreaGeoJSON, remainingAreaSqM, victimId]);
                    console.log(`[ClanClaim] Stolen from solo player ${victimId}. Remaining area: ${remainingAreaSqM}`);
                    affectedOwnerIds.add(victimId);
                    const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                    if (victimSocket) {
                      victimSocket.emit('runTerminated', { reason: `Clan ${player.name}'s clan has stolen some of your territory!` }); 
                    }
                } else {
                    await client.query(`
                        UPDATE territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0
                        WHERE owner_id = $1;
                    `, [victimId]);
                    console.log(`[ClanClaim] Entire territory stolen from solo player ${victimId}.`);
                    affectedOwnerIds.add(victimId);
                    const victimSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === victimId);
                    if (victimSocket) {
                      victimSocket.emit('runTerminated', { reason: `Clan ${player.name}'s clan has acquired your area!` });
                    }
                }
            }
        }
    }

    const intersectingOtherClansQuery = `
        SELECT ct.clan_id, c.name, ct.area, c.has_shield 
        FROM clan_territories ct JOIN clans c ON ct.clan_id = c.id
        WHERE ST_Intersects(ct.area, ${newAreaWKT}) AND ct.clan_id != $1;
    `;
    const intersectingOtherClansResult = await client.query(intersectingOtherClansQuery);

    for (const row of intersectingOtherClansResult.rows) {
        const victimClanId = row.clan_id;
        const victimClanCurrentArea = row.area;
        const victimClanName = row.name;
        const victimClanHasShield = row.has_shield;

        const intersectionGeomResult = await client.query(`SELECT ST_AsGeoJSON(ST_Intersection(ST_GeomFromGeoJSON($1), $2)) AS intersected_geom;`, [JSON.stringify(newAreaPolygon.geometry), victimClanCurrentArea]);
        const intersectedGeomGeoJSON = intersectionGeomResult.rows[0].intersected_geom;
        const intersectedSqM = intersectedGeomGeoJSON ? turf.area(JSON.parse(intersectedGeomGeoJSON)) : 0;

        if (intersectedSqM > 0) {
            console.log(`[ClanClaim] Clan ${player.name}'s claim intersects other clan ${victimClanName}'s territory.`);

            let shieldActivated = false;
            if (victimClanHasShield) { 
                console.log(`[ClanClaim] Clan ${victimClanName}'s shield activated! Claim Rejected.`);
                socket.emit('claimRejected', { reason: `Clan ${victimClanName}'s shield activated! Cannot steal this area.` });
                return null;
            }

            if (!shieldActivated) {
                const diffGeomResult = await client.query(`
                    SELECT ST_AsGeoJSON(ST_Difference($1, ${newAreaWKT})) AS remaining_area;
                `, [victimClanCurrentArea]);

                const remainingAreaGeoJSON = diffGeomResult.rows[0].remaining_area;

                if (remainingAreaGeoJSON && JSON.parse(remainingAreaGeoJSON).coordinates.length > 0) { 
                    const remainingAreaTurf = JSON.parse(remainingAreaGeoJSON);
                    const remainingAreaSqM = turf.area(remainingAreaTurf);
                    await client.query(`
                        UPDATE clan_territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
                        WHERE clan_id = $3;
                    `, [remainingAreaGeoJSON, remainingAreaSqM, victimClanId]);
                    console.log(`[ClanClaim] Stolen from clan ${victimClanId}. Remaining area: ${remainingAreaSqM}`);
                    affectedOwnerIds.add(victimClanId.toString()); 
                    const victimClanMembers = await client.query('SELECT user_id FROM clan_members WHERE clan_id = $1', [victimClanId]);
                    for (const memberRow of victimClanMembers.rows) {
                        const memberSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === memberRow.user_id);
                        if (memberSocket) {
                            memberSocket.emit('runTerminated', { reason: `Clan ${player.name}'s clan has stolen some of your clan's territory!` });
                        }
                    }
                } else {
                    await client.query(`
                        UPDATE clan_territories SET area = ST_GeomFromText('GEOMETRYCOLLECTION EMPTY'), area_sqm = 0
                        WHERE clan_id = $1;
                    `, [victimClanId]);
                    console.log(`[ClanClaim] Entire territory stolen from clan ${victimClanId}.`);
                    affectedOwnerIds.add(victimClanId.toString());
                    const victimClanMembers = await client.query('SELECT user_id FROM clan_members WHERE clan_id = $1', [victimClanId]);
                    for (const memberRow of victimClanMembers.rows) {
                        const memberSocket = Object.values(io.sockets.sockets).find(s => s.player && s.player.googleId === memberRow.user_id);
                        if (memberSocket) {
                            memberSocket.emit('runTerminated', { reason: `Clan ${player.name}'s clan has acquired your clan's entire area!` });
                        }
                    }
                }
            }
        }
    }


    let finalClanAreaSqM;
    let finalClanAreaGeoJSON;

    const existingClanAreaResult = await client.query('SELECT ST_AsGeoJSON(area) as geojson_area FROM clan_territories WHERE clan_id = $1', [clanId]); 
    const existingClanAreaGeoJSON = existingClanAreaResult.rows.length > 0 ? existingClanAreaResult.rows[0].geojson_area : null;
    const existingClanAreaTurf = existingClanAreaGeoJSON ? JSON.parse(existingClanAreaGeoJSON) : null;

    if (existingClanAreaTurf && turf.area(existingClanAreaTurf) > 0) { 
        const unionResult = await client.query(`
            SELECT ST_AsGeoJSON(ST_Union(ST_GeomFromGeoJSON($1), ${newAreaWKT})) AS united_area;
        `, [existingClanAreaGeoJSON]); 
        finalClanAreaGeoJSON = unionResult.rows[0].united_area;
        finalClanAreaSqM = turf.area(JSON.parse(finalClanAreaGeoJSON));
        console.log(`[ClanClaim] Unioned new area for clan ${clanId}. Total: ${finalClanAreaSqM}`);
        await client.query(`
            UPDATE clan_territories SET area = ST_GeomFromGeoJSON($1), area_sqm = $2
            WHERE clan_id = $3;
        `, [finalClanAreaGeoJSON, finalClanAreaSqM, clanId]);
    } else {
        finalClanAreaGeoJSON = JSON.stringify(newAreaPolygon.geometry);
        finalClanAreaSqM = newAreaSqM;
        console.log(`[ClanClaim] Initial/reclaim area for clan ${clanId}. Total: ${finalClanAreaSqM}`);
        await client.query(`
            INSERT INTO clan_territories (clan_id, area, area_sqm)
            VALUES ($1, ST_GeomFromGeoJSON($2), $3)
            ON CONFLICT (clan_id) DO UPDATE SET area = ST_GeomFromGeoJSON($2), area_sqm = $3;
        `, [clanId, finalClanAreaGeoJSON, finalClanAreaSqM]);
    }
    
    return {
        finalTotalArea: finalClanAreaSqM,
        areaClaimed: newAreaSqM, 
        ownerIdsToUpdate: Array.from(affectedOwnerIds) 
    };
}

module.exports = handleClanClaim;
