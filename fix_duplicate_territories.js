const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixDuplicateTerritories() {
    const client = await pool.connect();
    try {
        console.log('Finding users with duplicate territory records...');

        // Find users with multiple territory records
        const duplicatesQuery = `
            SELECT owner_id, COUNT(*) as count
            FROM territories
            GROUP BY owner_id
            HAVING COUNT(*) > 1
            ORDER BY count DESC;
        `;

        const duplicates = await client.query(duplicatesQuery);
        console.log(`Found ${duplicates.rows.length} users with duplicate territories:`);
        duplicates.rows.forEach(row => {
            console.log(`  - User ${row.owner_id}: ${row.count} records`);
        });

        if (duplicates.rows.length === 0) {
            console.log('No duplicates found!');
            return;
        }

        console.log('\nMerging duplicate territories...');

        for (const { owner_id } of duplicates.rows) {
            await client.query('BEGIN');

            try {
                // Get all territories for this user
                const territories = await client.query(
                    'SELECT id, area_sqm, ST_AsGeoJSON(area) as geojson FROM territories WHERE owner_id = $1 ORDER BY area_sqm DESC',
                    [owner_id]
                );

                console.log(`\nUser ${owner_id} has ${territories.rows.length} territories`);

                // Keep the largest territory
                const mainTerritory = territories.rows[0];
                const duplicateTerritories = territories.rows.slice(1);

                console.log(`  Keeping territory ${mainTerritory.id} (${mainTerritory.area_sqm} sqm)`);

                // Delete the duplicate territories
                for (const dup of duplicateTerritories) {
                    console.log(`  Deleting duplicate territory ${dup.id} (${dup.area_sqm} sqm)`);

                    // First, reassign any ads from the duplicate to the main territory
                    const adsUpdate = await client.query(
                        'UPDATE ads SET territory_id = $1 WHERE territory_id = $2',
                        [mainTerritory.id, dup.id]
                    );
                    if (adsUpdate.rowCount > 0) {
                        console.log(`    Reassigned ${adsUpdate.rowCount} ad(s) to main territory`);
                    }

                    // Now delete the duplicate territory
                    await client.query('DELETE FROM territories WHERE id = $1', [dup.id]);
                }

                await client.query('COMMIT');
                console.log(`  ✓ Merged territories for user ${owner_id}`);

            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  ✗ Error merging territories for user ${owner_id}:`, err.message);
            }
        }

        console.log('\n✓ Done! All duplicate territories have been merged.');

    } catch (err) {
        console.error('Fatal error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

fixDuplicateTerritories();
