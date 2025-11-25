# Ad Cleanup Guide

## Problem
The database contains many ads with `status = 'DELETED'` that are cluttering the database and showing up in debug logs.

## Solution

### 1. Clean Up Existing Deleted Ads

Run the cleanup script to permanently remove all deleted ads:

```bash
cd /Users/smitbhoir/runerrX/claimr_server
node cleanup_deleted_ads.js
```

This will:
- Find all ads where `status = 'DELETED'`
- Permanently delete them from the database
- Show count of deleted ads
- Verify cleanup was successful

### 2. Code Changes Made

#### Removed Debug Logging
**File**: `server.js:L748-765`
- Removed the debug query that was logging all ads (including deleted ones)
- This was causing the console spam you saw

#### Existing Filters
All ad queries already filter out deleted ads:
```sql
WHERE (a.status IS NULL OR a.status != 'DELETED')
```

This filter is present in:
- `/api/ads` - Mobile app endpoint
- `/api/brands/territories` - Brand portal
- `/api/brands/dashboard-stats` - Brand dashboard
- `/api/player/rent-earnings` - Player earnings

### 3. Why Keep the DELETE Status?

Instead of permanently deleting ads immediately, we use soft delete (`status = 'DELETED'`) because:

1. **Audit Trail** - Track what was deleted and when
2. **Payment Records** - Keep payment history for accounting
3. **Dispute Resolution** - Recover if deletion was accidental

However, old deleted ads should be cleaned up periodically.

### 4. Automated Cleanup (Recommended)

Add a cron job to clean up deleted ads older than 30 days:

```javascript
// Add to server.js
const cron = require('node-cron');

// Run cleanup every day at 2 AM
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Running deleted ads cleanup...');
  try {
    const result = await pool.query(`
      DELETE FROM ads 
      WHERE status = 'DELETED' 
        AND updated_at < NOW() - INTERVAL '30 days'
    `);
    console.log(`[CRON] Cleaned up ${result.rowCount} old deleted ads`);
  } catch (err) {
    console.error('[CRON] Error cleaning up ads:', err);
  }
});
```

### 5. Verification

After running cleanup, verify:
```sql
-- Should return 0 rows
SELECT COUNT(*) FROM ads WHERE status = 'DELETED';

-- Check active ads only
SELECT COUNT(*) FROM ads 
WHERE payment_status = 'PAID' 
  AND approval_status = 'APPROVED'
  AND (status IS NULL OR status != 'DELETED')
  AND end_time >= NOW();
```

## Files Modified
- ✅ `cleanup_deleted_ads.js` - New cleanup script
- ✅ `server.js` - Removed debug logging
- ✅ All queries already filter deleted ads

## Next Steps
1. Run the cleanup script once
2. Consider adding automated cleanup cron job
3. Monitor database size
