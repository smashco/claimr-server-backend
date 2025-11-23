const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function debugRentData() {
    try {
        // console.log('--- TABLES ---');
        // const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        // tables.rows.forEach(t => console.log(t.table_name));

        // console.log('\n--- USERS (trying app_users) ---');
        // // Try app_users as it's a common alternative
        // try {
        //     const users = await pool.query('SELECT id, username, email FROM app_users');
        //     users.rows.forEach(u => console.log(`${u.id} | ${u.username} | ${u.email}`));
        // } catch (e) { console.log('app_users table not found'); }

        console.log('\n--- USER CHECK ---');
        try {
            const user = await pool.query("SELECT * FROM app_users WHERE id = '118072292624872977575' OR google_id = '118072292624872977575'");
            if (user.rows.length > 0) {
                console.log('User found:', user.rows[0]);
            } else {
                console.log('User 118072292624872977575 not found in app_users');
                // List all users to see what IDs look like
                const allUsers = await pool.query('SELECT id, username, google_id FROM app_users LIMIT 5');
                allUsers.rows.forEach(u => console.log(`User: ${u.id} | GoogleID: ${u.google_id} | Name: ${u.username}`));
            }
        } catch (e) { console.log('Error querying app_users:', e.message); }

        console.log('\n--- ACTIVE AD ON 165 ---');
        const ads = await pool.query("SELECT id, territory_id, brand_name, payment_status, status, start_time, end_time FROM ads WHERE territory_id = 165 AND payment_status = 'PAID' AND status = 'ACTIVE'");
        ads.rows.forEach(a => {
            console.log(`Ad: ${a.id} | Terr: ${a.territory_id} | Brand: ${a.brand_name} | Payment: ${a.payment_status} | Status: ${a.status}`);
            console.log(`   Start: ${a.start_time} | End: ${a.end_time}`);
        });

    } catch (err) {
        console.error('Debug Error:', err);
    } finally {
        await pool.end();
    }
}

debugRentData();
