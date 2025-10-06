// superpower_manager.js

require('dotenv').config();
const debug = require('debug')('server:superpower');
const logPayment = require('debug')('server:payment');
const logDb = require('debug')('server:db');
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


   async verifyAndGrantPower(googleId, itemId, paymentDetails) {
       logPayment(`[MANAGER] Verifying payment for user ${googleId} for item '${itemId}'`);
       const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = paymentDetails;


       const body = `${razorpay_order_id}|${razorpay_payment_id}`;
       const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest('hex');


       if (expectedSignature !== razorpay_signature) {
           logPayment(`[MANAGER-FAIL] Payment verification FAILED for user ${googleId}. Mismatched signatures.`);
           throw new Error('Payment verification failed.');
       }


       logPayment(`[MANAGER] Signature verified. Proceeding to grant power '${itemId}' to user ${googleId}.`);
       const newInventory = await this.grantPower(googleId, itemId);
       logPayment(`[MANAGER] Payment verified and power '${itemId}' granted. Final inventory: %O`, newInventory);
       return newInventory;
   }
  
   // =======================================================================//
   // ===================== MODIFIED & NEW FUNCTIONS ========================//
   // =======================================================================//


   /**
    * Activates a power's effect. For Last Stand, this only turns on the shield flag.
    * For instant-use powers, it will consume them immediately.
    */
   async usePower(googleId, powerId) {
       debug(`User ${googleId} is ACTIVATING power '${powerId}'.`);


       if (powerId === 'lastStand') {
           // For Last Stand, we ONLY set the active flag. We DO NOT remove it from inventory.
           const client = await this.pool.connect();
           try {
               await client.query('BEGIN');
               logDb(`Setting is_shield_active=true for user ${googleId}`);
               await client.query("UPDATE territories SET is_shield_active = true WHERE owner_id = $1", [googleId]);
               await client.query('COMMIT');
               debug(`Power '${powerId}' is now ACTIVE for user ${googleId}. It remains in their inventory.`);
               const userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1", [googleId]);
               return userRes.rows[0].superpowers;
           } catch (err) {
               await client.query('ROLLBACK');
               debug(`Error activating power for ${googleId}: %O`, err);
               throw err;
           } finally {
               client.release();
           }
       } else {
           // For other powers like Ghost Runner, activation IS consumption.
           debug(`Instantly CONSUMING power '${powerId}' for user ${googleId} upon activation.`);
           return await this.revokePower(googleId, powerId);
       }
   }


   /**
    * Consumes a power from inventory. This is called when a power's effect is used up,
    * such as a shield blocking an attack. Runs within an existing transaction.
    */
   async consumePower(googleId, powerId, client) {
       debug(`CONSUMING power '${powerId}' for user ${googleId} as part of a transaction.`);
      
       const userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
       if (userRes.rowCount === 0) {
           debug(`Cannot consume power for non-existent user ${googleId}.`);
           return { owned: [] };
       }
      
       const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
       let ownedList = currentSuperpowers.owned || [];
       const updatedOwnedList = ownedList.filter(p => p !== powerId);
      
       logDb(`Consuming '${powerId}'. Old inventory: [${ownedList.join(', ')}], New: [${updatedOwnedList.join(', ')}]`);


       const { rows: [updated] } = await client.query(
           "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
           [JSON.stringify({ owned: updatedOwnedList }), googleId]
       );
      
       if (powerId === 'lastStand') {
           await client.query("UPDATE territories SET is_shield_active = false WHERE owner_id = $1", [googleId]);
           logDb(`Deactivated shield for ${googleId} after consumption.`);
       }
      
       return updated.superpowers;
   }


   async grantPower(googleId, powerId) {
       logDb(`[GRANT-POWER] Granting '${powerId}' to user ${googleId}.`);
       const client = await this.pool.connect();
       try {
           await client.query('BEGIN');
           let userRes = await client.query("SELECT superpowers FROM territories WHERE owner_id = $1 FOR UPDATE", [googleId]);
           if (userRes.rowCount === 0) {
               await client.query('ROLLBACK');
               throw new Error(`User ${googleId} does not exist.`);
           }


           const currentSuperpowers = userRes.rows[0].superpowers || { owned: [] };
           const ownedList = currentSuperpowers.owned || [];
          
           if (!ownedList.includes(powerId)) {
               ownedList.push(powerId);
           }
          
           const finalInventory = { owned: ownedList };
           const { rows: [updated] } = await client.query(
               "UPDATE territories SET superpowers = $1 WHERE owner_id = $2 RETURNING superpowers",
               [JSON.stringify(finalInventory), googleId]
           );
          
           await client.query('COMMIT');
           logDb(`[GRANT-POWER] SUCCESS. Inventory for ${googleId} is now saved as: %O`, updated.superpowers);
           return updated.superpowers;
       } catch (err) {
           await client.query('ROLLBACK');
           debug(`Error details for grantPower: %O`, err);
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
           logDb(`COMMIT successful. Superpower inventory for ${googleId} revoked and saved: %O`, updated.superpowers);
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