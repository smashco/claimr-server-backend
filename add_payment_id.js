const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function addPaymentIdColumn() {
    try {
        console.log('Adding payment_id column to ads table...');
        await pool.query(`
            ALTER TABLE ads 
            ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255);
        `);
        console.log('Successfully added payment_id column.');
    } catch (err) {
        console.error('Error adding column:', err);
    } finally {
        await pool.end();
    }
}

addPaymentIdColumn();
