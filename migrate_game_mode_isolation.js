const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function addGameModeColumn() {
    const client = await pool.connect();
    try {
        console.log('Starting game mode isolation migration...\n');

        // Check if column already exists
        const checkColumn = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'territories' 
            AND column_name = 'game_mode';
        `);

        if (checkColumn.rows.length > 0) {
            console.log('✓ Column game_mode already exists. Skipping creation.');
        } else {
            console.log('Adding game_mode column to territories table...');
            await client.query(`
                ALTER TABLE territories 
                ADD COLUMN game_mode VARCHAR(50) DEFAULT 'areaCapture';
            `);
            console.log('✓ Column added successfully.');
        }

        // Check if index exists
        const checkIndex = await client.query(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'territories' 
            AND indexname = 'idx_territories_game_mode';
        `);

        if (checkIndex.rows.length > 0) {
            console.log('✓ Index idx_territories_game_mode already exists. Skipping creation.');
        } else {
            console.log('\nCreating index on game_mode column...');
            await client.query(`
                CREATE INDEX idx_territories_game_mode 
                ON territories(game_mode);
            `);
            console.log('✓ Index created successfully.');
        }

        // Backfill existing territories
        console.log('\nBackfilling existing territories with default mode...');
        const updateResult = await client.query(`
            UPDATE territories 
            SET game_mode = 'areaCapture' 
            WHERE game_mode IS NULL;
        `);
        console.log(`✓ Updated ${updateResult.rowCount} territories.`);

        // Verify migration
        console.log('\nVerifying migration...');
        const stats = await client.query(`
            SELECT game_mode, COUNT(*) as count 
            FROM territories 
            GROUP BY game_mode 
            ORDER BY count DESC;
        `);

        console.log('\nTerritory distribution by game mode:');
        stats.rows.forEach(row => {
            console.log(`  - ${row.game_mode}: ${row.count} territories`);
        });

        console.log('\n✅ Migration completed successfully!');

    } catch (err) {
        console.error('❌ Migration failed:', err);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

addGameModeColumn();
