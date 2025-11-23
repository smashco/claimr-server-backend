const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function updateAdsTable() {
    const client = await pool.connect();
    try {
        console.log('Updating ads table schema...');

        await client.query(`
            ALTER TABLE ads 
            ADD COLUMN IF NOT EXISTS background_color VARCHAR(50),
            ADD COLUMN IF NOT EXISTS overlay_url TEXT;
        `);

        console.log('Ads table updated successfully!');
    } catch (err) {
        console.error('Error updating ads table:', err);
    } finally {
        client.release();
        pool.end();
    }
}

updateAdsTable();
