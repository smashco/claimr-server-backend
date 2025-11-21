const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function addApprovalStatus() {
    const client = await pool.connect();
    try {
        console.log('Adding approval_status and status columns to ads table...');

        await client.query(`
            ALTER TABLE ads 
            ADD COLUMN IF NOT EXISTS approval_status VARCHAR(50) CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING',
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) CHECK (status IN ('ACTIVE', 'PAUSED', 'DELETED')) DEFAULT 'ACTIVE';
        `);

        console.log('Columns added successfully!');
    } catch (err) {
        console.error('Error updating ads table:', err);
    } finally {
        client.release();
        pool.end();
    }
}

addApprovalStatus();
