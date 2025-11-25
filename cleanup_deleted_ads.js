// Script to clean up deleted ads from the database
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

const db = admin.firestore();

async function cleanupDeletedAds() {
    console.log('🧹 Starting cleanup of deleted ads...');

    try {
        // Get all ads with status 'DELETED'
        const deletedAdsSnapshot = await db.collection('ads')
            .where('status', '==', 'DELETED')
            .get();

        console.log(`Found ${deletedAdsSnapshot.size} deleted ads`);

        if (deletedAdsSnapshot.empty) {
            console.log('✅ No deleted ads to clean up');
            return;
        }

        // Delete each ad
        const batch = db.batch();
        let count = 0;

        deletedAdsSnapshot.forEach((doc) => {
            const adData = doc.data();
            console.log(`Deleting ad: ${doc.id} (Payment: ${adData.payment_status}, Approval: ${adData.approval_status})`);
            batch.delete(doc.ref);
            count++;

            // Firestore batch limit is 500
            if (count >= 500) {
                console.warn('⚠️  Batch limit reached (500). You may need to run this script multiple times.');
            }
        });

        // Commit the batch
        await batch.commit();
        console.log(`✅ Successfully deleted ${count} ads from the database`);

        // Verify cleanup
        const remainingDeleted = await db.collection('ads')
            .where('status', '==', 'DELETED')
            .get();

        if (remainingDeleted.empty) {
            console.log('✅ Cleanup complete! No deleted ads remain in the database');
        } else {
            console.log(`⚠️  ${remainingDeleted.size} deleted ads still remain. Run script again.`);
        }

    } catch (error) {
        console.error('❌ Error cleaning up deleted ads:', error);
        throw error;
    }
}

// Run the cleanup
cleanupDeletedAds()
    .then(() => {
        console.log('Script completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });
