const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkTerritoryModes() {
    const client = await pool.connect();
    try {
        console.log('Checking territory game_mode distribution...\n');

        // Get all territories with their game modes
        const result = await client.query(`
            SELECT id, owner_id, username, game_mode, area_sqm 
            FROM territories 
            WHERE area_sqm > 0
            ORDER BY game_mode, id;
        `);

        console.log(`Total territories: ${result.rows.length}\n`);

        // Group by mode
        const byMode = result.rows.reduce((acc, row) => {
            if (!acc[row.game_mode]) acc[row.game_mode] = [];
            acc[row.game_mode].push(row);
            return acc;
        }, {});

        console.log('Territories by game mode:');
        for (const [mode, territories] of Object.entries(byMode)) {
            console.log(`\n${mode}: ${territories.length} territories`);
            territories.forEach(t => {
                console.log(`  - ID ${t.id}: ${t.username} (${t.area_sqm.toFixed(2)} sqm)`);
            });
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

checkTerritoryModes();
