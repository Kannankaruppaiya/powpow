/**
 * IndexedDB persistence.
 *
 * The previous design kept every scraped record inside one job object in
 * chrome.storage.local and rewrote the whole thing on each progress update.
 * At 5,000 records that is a ~4.8 MB blob re-serialised on the order of a
 * thousand times per run — several gigabytes of writes for one scrape.
 *
 * Here the job metadata (the queue and the counters, which stay small) is
 * separate from the records, and records are written per task in one
 * transaction. Both the service worker and the side panel are extension pages
 * on the same origin, so the side panel reads records straight out of the
 * database rather than pulling them through a message — which also sidesteps
 * the 64 MiB message ceiling on a big export.
 */

const DB_NAME = 'maps-lead-scraper';
const DB_VERSION = 1;

export const STORE_META = 'meta';
export const STORE_RECORDS = 'records';
export const STORE_SEEN = 'seen';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META); // out-of-line keys: 'job', 'settings'
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const records = db.createObjectStore(STORE_RECORDS, { keyPath: 'key' });
        // Records outlive a single run, so every query is scoped by job.
        records.createIndex('jobId', 'jobId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SEEN)) {
        db.createObjectStore(STORE_SEEN, { keyPath: 'key' });
      }

      // A version bump must not silently drop a user's data.
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
        console.info('[maps-lead-scraper] upgraded database', event.oldVersion, '->', DB_VERSION);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The database is blocked by another tab.'));
  });

  return dbPromise;
}

/** Promisify one transaction, resolving with `result` once it commits. */
function run(db, storeNames, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    try {
      result = work(tx);
    } catch (err) {
      tx.abort();
      reject(err);
    }
  });
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/* -------------------------------------------------------------------- meta */

export async function putMeta(key, value) {
  const db = await openDb();
  return run(db, STORE_META, 'readwrite', (tx) => {
    tx.objectStore(STORE_META).put(value, key);
  });
}

export async function getMeta(key) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  return request(tx.objectStore(STORE_META).get(key));
}

/* ----------------------------------------------------------------- records */

/**
 * Write records for a job in one transaction.
 *
 * Callers pass only the records a task actually touched, so the cost of a
 * progress write is proportional to that task rather than to everything
 * collected so far.
 */
export async function putRecords(jobId, records) {
  if (!records || !records.length) return 0;
  const db = await openDb();
  await run(db, STORE_RECORDS, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_RECORDS);
    for (const record of records) {
      if (!record || !record.key) continue;
      store.put({ ...record, jobId });
    }
  });
  return records.length;
}

export async function getRecords(jobId) {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const index = tx.objectStore(STORE_RECORDS).index('jobId');
  return (await request(index.getAll(IDBKeyRange.only(jobId)))) || [];
}

export async function countRecords(jobId) {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  return request(tx.objectStore(STORE_RECORDS).index('jobId').count(IDBKeyRange.only(jobId)));
}

/**
 * Read a window of a job's records, for a virtualised table that must stay
 * responsive with tens of thousands of rows.
 */
export async function pageRecords(jobId, offset = 0, limit = 100) {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const index = tx.objectStore(STORE_RECORDS).index('jobId');

  return new Promise((resolve, reject) => {
    const out = [];
    let skipped = false;
    const cursorReq = index.openCursor(IDBKeyRange.only(jobId));

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(out);
      if (offset > 0 && !skipped) {
        skipped = true;
        cursor.advance(offset);
        return undefined;
      }
      out.push(cursor.value);
      if (out.length >= limit) return resolve(out);
      cursor.continue();
      return undefined;
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/** Remove specific records, e.g. ones skipped as already seen in an earlier run. */
export async function deleteRecords(keys) {
  if (!keys || !keys.length) return 0;
  const db = await openDb();
  await run(db, STORE_RECORDS, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_RECORDS);
    for (const key of keys) if (key) store.delete(key);
  });
  return keys.length;
}

export async function clearRecords(jobId) {
  const db = await openDb();
  const keys = await (async () => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    return request(tx.objectStore(STORE_RECORDS).index('jobId').getAllKeys(IDBKeyRange.only(jobId)));
  })();

  await run(db, STORE_RECORDS, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_RECORDS);
    for (const key of keys || []) store.delete(key);
  });
  return (keys || []).length;
}

/* -------------------------------------------------------------------- seen */

/** Remember business keys so a later run can skip them. */
export async function addSeen(keys) {
  if (!keys || !keys.length) return 0;
  const db = await openDb();
  const at = Date.now();
  await run(db, STORE_SEEN, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_SEEN);
    for (const key of keys) if (key) store.put({ key, at });
  });
  return keys.length;
}

/** Which of these keys have been seen before. Returns a Set for O(1) checks. */
export async function filterSeen(keys) {
  const db = await openDb();
  const tx = db.transaction(STORE_SEEN, 'readonly');
  const store = tx.objectStore(STORE_SEEN);
  const found = new Set();

  await Promise.all(
    [...new Set(keys || [])].filter(Boolean).map(async (key) => {
      const hit = await request(store.get(key));
      if (hit) found.add(key);
    })
  );
  return found;
}

export async function countSeen() {
  const db = await openDb();
  const tx = db.transaction(STORE_SEEN, 'readonly');
  return request(tx.objectStore(STORE_SEEN).count());
}

export async function clearSeen() {
  const db = await openDb();
  return run(db, STORE_SEEN, 'readwrite', (tx) => {
    tx.objectStore(STORE_SEEN).clear();
  });
}

/** Test hook: drop the cached connection so a fresh open is forced. */
export function resetDbCache() {
  dbPromise = null;
}
