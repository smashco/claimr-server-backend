// superpower_manager.js

require('dotenv').config();
const debug = require('debug')('server:superpower');
const logPayment = require('debug')('server:payment'); // Use the payment debugger
const logDb = require('debug')('server:db');         // Use the DB debugger
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
        logPayment(`[MANAGER] Creating purchase order for item '${itemId}' for user ${googleId}`);
        if (!this.razorpay) {
            throw new Error('Payment gateway is not configured.');
        }

        const userRes = await this.pool.query("SELECT superpowers FROM territories WHERE owner_id = $1", [googleId]);
        if (userRes.rowCount > 0) {
            const ownedPowers = userRes.rows[0].superpowers?.owned || [];
            if (ownedPowers.includes(itemId)) {
                logPayment(`[MANAGER-BLOCK] Purchase blocked for user ${googleId}: already owns '${itemId}'.`);
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
            logPayment(`[MANAGER] Razorpay order ${order.id} created for user ${googleId}.`);
            return { orderId: order.id, amount: order.amount };
        } catch (err) {
            logPayment(`[MANAGER-ERROR] Error creating Razorpay order for user ${googleId}: %O`, err);
            throw new Error('Server error while creating payment order.');
        }
    }

    // =======================================================================//
    // ===================== MODIFIED FUNCTION STARTS HERE =====================//
    // =======================================================================//
    async verifyAndGrantPower(googleId, itemId, paymentDetails) {
        logPayment(`[MANAGER] Verifying payment for user ${googleId} for item '${itemId}'`);
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = paymentDetails;

        const body = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            logPayment(`[MANAGER-FAIL] Payment verification FAILED for user ${googleId}. Mismatched signatures.`);
            throw new Error('Payment verification failed: Invalid signature.');
        }

        logPayment(`[MANAGER] Signature verified. Proceeding to grant power '${itemId}' to user ${googleId}.`);
        
        // FIX: Await the grantPower function and store its result to return it.
        const newInventory = await this.grantPower(googleId, itemId);
        
        logPayment(`[MANAGER] Payment verified and power '${itemId}' granted. Final inventory: %O`, newInventory);
        
        // FIX: Return the updated inventory so server.js can use it.
        return newInventory;
    }

    async usePower(googleId, powerId) {
        debug(`User ${googleId} is using power '${powerId}'. Revoking from inventory.`);
        return await this.revokePower(googleId, powerId);
    }
    
    async grantPower(googleId, powerId) {
        logDb(`[GRANT-POWER] Granting '${powerId}' to user ${googleId}.`);
        const client = await this.pool.connect();
        try {
            logDb(`[GRANT-POWER] BEGIN transaction for user ${googleId}.`);
            await client.query('BEGIN');
            
            logDb(`[GRANT-POWER] Fetching current superpowers for ${googleId} with row lock.`);
            let userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            
            if (userRes.rowCount === 0) {
                logDb(`[GRANT-POWER] User ${googleId} not found. This should not happen in a purchase flow. Rolling back.`);
                await client.query('ROLLBACK');
                throw new Error(`User ${googleId} does not exist.`);
            }

            const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
            const ownedList = currentSuperpowers.owned || [];
            logDb(`[GRANT-POWER] Current inventory for ${googleId}: [${ownedList.join(', ')}]`);
            
            if (ownedList.includes(powerId)) {
                logDb(`[GRANT-POWER] User ${googleId} already owns '${powerId}'. No changes needed. Committing transaction.`);
            } else {
                ownedList.push(powerId);
                logDb(`[GRANT-POWER] New inventory for ${googleId}: [${ownedList.join(', ')}]`);
            }
            
            const finalInventory = { owned: ownedList };
            logDb(`[GRANT-POWER] Executing UPDATE query for ${googleId}...`);
            const { rows: [updated] } = await client.query(
                "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
                [JSON.stringify(finalInventory), googleId]
            );
            
            logDb(`[GRANT-POWER] COMMIT transaction for ${googleId}.`);
            await client.query('COMMIT');
            
            logDb(`[GRANT-POWER] SUCCESS. Inventory for ${googleId} is now saved as: %O`, updated.superpowers);
            
            return updated.superpowers;
        } catch (err) {
            logDb(`[GRANT-POWER-ERROR] An error occurred. Rolling back transaction for ${googleId}. Error: ${err.message}`);
            await client.query('ROLLBACK');
            debug(`Error details for grantPower: %O`, err);
            throw err;
        } finally {
            logDb(`[GRANT-POWER] Releasing database client for user ${googleId}.`);
            client.release();
        }
    }
    // =======================================================================//
    // ====================== MODIFIED FUNCTION ENDS HERE ======================//
    // =======================================================================//

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
            logDb(`COMMIT successful. Superpower inventory for ${googleId} revoked and saved to database: %O`, updated.superpowers);
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