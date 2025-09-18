// superpower_manager.js

require('dotenv').config();
const debug = require('debug')('server:superpower');
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

    /**
     * Creates a Razorpay order for a superpower, but only if the user does not already own it.
     * @param {string} googleId - The Google ID of the user.
     * @param {string} itemId - The ID of the superpower to purchase (e.g., 'lastStand').
     * @returns {Promise<object>} The Razorpay order details.
     */
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

        const amount = 2900; // Price in paise (e.g., ₹29.00)
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

    /**
     * Verifies a Razorpay payment and grants a unique superpower to the user.
     * @param {string} googleId - The user's Google ID.
     * @param {string} itemId - The superpower ID.
     * @param {object} paymentDetails - Contains razorpay_order_id, razorpay_payment_id, razorpay_signature.
     * @returns {Promise<void>}
     */
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

    /**
     * Removes a superpower from a user's inventory after it has been used.
     * @param {string} googleId - The user's Google ID.
     * @param {string} powerId - The superpower ID to remove.
     * @returns {Promise<object>} The user's new superpower inventory.
     */
    async usePower(googleId, powerId) {
        debug(`User ${googleId} is using power '${powerId}'. Removing from inventory.`);
        return await this.revokePower(googleId, powerId);
    }
    
    /**
     * Grants a superpower to a user (Admin action).
     * @param {string} googleId - The user's Google ID.
     * @param {string} powerId - The superpower ID to grant.
     * @returns {Promise<object>} The user's new superpower inventory.
     */
    async grantPower(googleId, powerId) {
        debug(`Granting power '${powerId}' to user ${googleId}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            if (userRes.rowCount === 0) throw new Error("Player not found.");

            const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
            const ownedList = currentSuperpowers.owned || [];
            
            if (!ownedList.includes(powerId)) {
                ownedList.push(powerId);
            } else {
                debug(`User ${googleId} already owns '${powerId}', no changes made.`);
            }
            
            const { rows: [updated] } = await client.query(
                "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
                [JSON.stringify({ owned: ownedList }), googleId]
            );
            await client.query('COMMIT');
            debug(`Successfully granted power. New inventory for ${googleId}: %O`, updated.superpowers);
            return updated.superpowers;
        } catch (err) {
            await client.query('ROLLBACK');
            debug(`Error granting power to ${googleId}: %O`, err);
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Revokes a superpower from a user (Admin action or post-use).
     * @param {string} googleId - The user's Google ID.
     * @param {string} powerId - The superpower ID to revoke.
     * @returns {Promise<object>} The user's new superpower inventory.
     */
    async revokePower(googleId, powerId) {
        debug(`Revoking power '${powerId}' from user ${googleId}`);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
            if (userRes.rowCount === 0) throw new Error("Player not found.");
            
            const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
            let ownedList = currentSuperpowers.owned || [];

            if (!ownedList.includes(powerId)) {
                debug(`Cannot revoke '${powerId}' from ${googleId}, they do not own it.`);
                // We don't throw an error here to make the operation idempotent.
                // It just ensures the final state is "not owned".
            }
            
            const updatedOwnedList = ownedList.filter(p => p !== powerId);
            
            const { rows: [updated] } = await client.query(
                "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
                [JSON.stringify({ owned: updatedOwnedList }), googleId]
            );
            await client.query('COMMIT');
            debug(`Successfully revoked power. New inventory for ${googleId}: %O`, updated.superpowers);
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