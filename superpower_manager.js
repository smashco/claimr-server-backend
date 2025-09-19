// superpower_manager.js

require('dotenv').config();
const debug = require('debug')('server:superpower');
const dbDebug = require('debug')('server:db'); // Import the DB debugger
const crypto = require('crypto');

class SuperpowerManager {
    constructor(pool, razorpayInstance) {
        this.pool = pool;
        this.razorpay = razorpayInstance;
        if (!pool) {
            throw new Error("SuperpowerManager requires a database pool.");
        }
        if (!razorpayInstance) {
            console.warn("[SuperpowerManager] Razorpay instance not provided. Payment features will be disabled.");
        }
    }

    async createPurchaseOrder(googleId, itemId) {
        debug(`Attempting to create purchase order for item '${itemId}' for user ${googleId}`);
        if (!this.razorpay) {
            throw new Error('Payment gateway is not configured.');
        }

        const userRes = await this.pool.query("SELECT superpowers FROM territories WHERE owner_id = $1", [googleId]);
        if (userRes.rowCount > 0) {
            const ownedPowers = userRes.rows[0].superpowers?.owned || [];
            if (ownedPowers.includes(itemId)) {
                debug(`Purchase blocked for user ${googleId}: already owns '${itemId}'.`);
                throw new Error('You already own this superpower.');
            }
        }

        const amount = 2900;
        const currency = 'INR';
        const options = {
            amount,
            currency,
            receipt: `item_${Date.now()}${crypto.randomBytes(2).toString('hex')}`,
            notes: {
                purchaseType: 'superpower',
                itemId: itemId,
                googleId: googleId
            }
        };

        try {
            const order = await this.razorpay.orders.create(options);
            if (!order) {
                throw new Error('Failed to create Razorpay order.');
            }
            debug(`Razorpay order ${order.id} created for user ${googleId}.`);
            return { orderId: order.id, amount: order.amount };
        } catch (err) {
            debug(`Error creating Razorpay order for user ${googleId}: %O`, err);
            throw new Error('Server error while creating payment order.');
        }
    }

    async verifyAndGrantPower(googleId, itemId, paymentDetails) {
        debug(`Verifying payment for user ${googleId} for item '${itemId}'`);
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = paymentDetails;

        const body = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            debug(`Payment verification FAILED for user ${googleId}. Mismatched signatures.`);
            throw new Error('Payment verification failed.');
        }

        await this.grantPower(googleId, itemId);
        debug(`Payment verified and power '${itemId}' granted to user ${googleId}.`);
    }

    async usePower(googleId, powerId) {
        debug(`User ${googleId} is using power '${powerId}'. Removing from inventory.`);
        return await this.revokePower(googleId, powerId);
    }
    
    async grantPower(googleId, powerId) {
        debug(`Granting power '${powerId}' to user ${googleId}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            let userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            if (userRes.rowCount === 0) {
                debug(`User ${googleId} not found. Creating a placeholder entry before granting power.`);
                await client.query(`INSERT INTO territories (owner_id) VALUES ($1)`, [googleId]);
                userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            }

            const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
            const ownedList = currentSuperpowers.owned || [];
            
            if (!ownedList.includes(powerId)) {
                ownedList.push(powerId);
            } else {
                debug(`User ${googleId} already owns '${powerId}', no changes made.`);
            }
            
            const finalInventory = { owned: ownedList };
            const { rows: [updated] } = await client.query(
                "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
                [JSON.stringify(finalInventory), googleId]
            );
            
            await client.query('COMMIT');

            // ===================================================================
            // NEW DEBUG LOG
            // ===================================================================
            dbDebug(`COMMIT successful. Superpower inventory for ${googleId} saved to database: %O`, updated.superpowers);
            
            return updated.superpowers;
        } catch (err) {
            await client.query('ROLLBACK');
            debug(`Error granting power to ${googleId}: %O`, err);
            throw err;
        } finally {
            client.release();
        }
    }

    async revokePower(googleId, powerId) {
        debug(`Revoking power '${powerId}' from user ${googleId}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            if (userRes.rowCount === 0) {
                debug(`Cannot revoke power from non-existent user ${googleId}.`);
                await client.query('ROLLBACK');
                return { owned: [] };
            }
            
            const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
            let ownedList = currentSuperpowers.owned || [];
            
            const updatedOwnedList = ownedList.filter(p => p !== powerId);
            
            const { rows: [updated] } = await client.query(
                "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
                [JSON.stringify({ owned: updatedOwnedList }), googleId]
            );
            await client.query('COMMIT');
            dbDebug(`COMMIT successful. Superpower inventory for ${googleId} revoked and saved to database: %O`, updated.superpowers);
            return updated.superpowers;
        } catch (err) {
            await client.query('ROLLBACK');
            debug(`Error revoking power from ${googleId}: %O`, err);
            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = SuperpowerManager;