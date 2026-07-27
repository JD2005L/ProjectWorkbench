// Test fixture: writes paired job+event batches to a JournalStore until killed.
//
// Used by the kill -9 durability test. Each batch writes two records and bumps a counter, so a
// partially applied batch is detectable after recovery. Prints the batch number once the write is
// durable, giving the test a lower bound on what must survive.
import { JournalStore } from '../../app/orchestrator/store/journal.js';

const [journalPath, snapshotPath, lockPath] = process.argv.slice(2);

const store = await JournalStore.open({
  journalPath, snapshotPath, lockPath, compactEveryRecords: 25,
});

for (let n = 1; ; n++) {
  await store.transact((tx) => {
    tx.put('jobs', `pwjob_${n}`, { n, status: 'implementing' });
    tx.put('events', `ev_${n}`, { n, job_id: `pwjob_${n}` });
    tx.nextSequence('global');
  });
  process.stdout.write(`${n}\n`);
}
