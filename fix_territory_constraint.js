require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function migrate() {
    try {
        console.log('Dropping constraint territories_owner_id_key with CASCADE...');
        await pool.query('ALTER TABLE territories DROP CONSTRAINT IF EXISTS territories_owner_id_key CASCADE');
        console.log('Constraint and dependencies dropped successfully.');
    } catch (err) {
        console.error('Error dropping constraint:', err);
    } finally {
        await pool.end();
    }
}

migrate();
//aas