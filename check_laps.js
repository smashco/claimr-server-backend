const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function checkLaps() {
    try {
        const res = await pool.query('SELECT id, username, laps_required FROM territories WHERE id = 166');
        console.log('Territory 166:', res.rows[0]);
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

checkLaps();
