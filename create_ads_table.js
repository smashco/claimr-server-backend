const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function createAdsTable() {
    const client = await pool.connect();
    try {
        console.log('Creating ads table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS ads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                territory_id INTEGER REFERENCES territories(id),
                brand_name VARCHAR(255) NOT NULL,
                ad_content_url TEXT NOT NULL,
                ad_type VARCHAR(50) CHECK (ad_type IN ('IMAGE', 'VIDEO')),
                start_time TIMESTAMP WITH TIME ZONE,
                end_time TIMESTAMP WITH TIME ZONE,
                payment_status VARCHAR(50) CHECK (payment_status IN ('PENDING', 'PAID')) DEFAULT 'PENDING',
                amount_paid DECIMAL(10, 2),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        console.log('Ads table created successfully!');
    } catch (err) {
        console.error('Error creating ads table:', err);
    } finally {
        client.release();
        pool.end();
    }
}

createAdsTable();
