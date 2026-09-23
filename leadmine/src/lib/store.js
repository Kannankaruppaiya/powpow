/** IndexedDB persistence. */

// Deliberately not renamed with the product.
const DB_NAME = 'maps-lead-scraper';
// 2: `notes` (what the user and the judge said about a lead) and `suppression` (the do-not-contact list).
const DB_VERSION = 2;

export const STORE_META = 'meta';
export const STORE_RECORDS = 'records';
export const STORE_SEEN = 'seen';
/** What was said about a lead, apart from what was scraped about it. */
export const STORE_NOTES = 'notes';
/** Addresses, domains and profiles never to contact. Survives everything. */
export const STORE_SUPPRESSION = 'suppression';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blockedTimer = null;

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
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        db.createObjectStore(STORE_NOTES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SUPPRESSION)) {
        db.createObjectStore(STORE_SUPPRESSION, { keyPath: 'value' });
      }

      // A version bump must not silently drop a user's data.
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
        console.info('[leadmine] upgraded database', event.oldVersion, '->', DB_VERSION);
      }
    };

    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      // A newer build opening a newer version must not be blocked by this connection.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(blockedTimer);
      reject(request.error);
    };
    // "Blocked" is a wait, not a failure.
    request.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(
        () => reject(new Error('The database is held open by an older LeadMine page. Close it and try again.')),
        10000
      );
    };
  });
  // A failed open must not be cached: the next call gets to try again.
  dbPromise.catch(() => {
    dbPromise = null;
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

/** Write records for a job in one transaction. */
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

/** Every record from every run. */
export async function getAllRecords() {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  return (await request(tx.objectStore(STORE_RECORDS).getAll())) || [];
}

export async function countRecords(jobId) {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  return request(tx.objectStore(STORE_RECORDS).index('jobId').count(IDBKeyRange.only(jobId)));
}

/** Read a window of a job's records. */
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

/* ------------------------------------------------------------------- notes */

/** Notes for these keys, as a Map. Missing keys are simply absent. */
export async function getNotes(keys) {
  const db = await openDb();
  const tx = db.transaction(STORE_NOTES, 'readonly');
  const store = tx.objectStore(STORE_NOTES);
  const out = new Map();
  await Promise.all(
    [...new Set(keys || [])].filter(Boolean).map(async (key) => {
      const hit = await request(store.get(key));
      if (hit) out.set(key, hit);
    })
  );
  return out;
}

export async function getAllNotes() {
  const db = await openDb();
  const tx = db.transaction(STORE_NOTES, 'readonly');
  const all = (await request(tx.objectStore(STORE_NOTES).getAll())) || [];
  return new Map(all.map((note) => [note.key, note]));
}

/** Merge patches into notes, one transaction for the lot. */
export async function putNotes(patches) {
  if (!patches || !patches.length) return 0;
  const db = await openDb();
  const at = Date.now();
  await run(db, STORE_NOTES, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_NOTES);
    for (const patch of patches) {
      if (!patch || !patch.key) continue;
      const req = store.get(patch.key);
      req.onsuccess = () => {
        const next = { ...(req.result || { key: patch.key }), ...patch, updatedAt: at };
        for (const [field, value] of Object.entries(next)) if (value === null) delete next[field];
        store.put(next);
      };
    }
  });
  return patches.length;
}

/* ------------------------------------------------------------- suppression */

/** Every entry, as [{ value, kind, reason, at }]. */
export async function getSuppression() {
  const db = await openDb();
  const tx = db.transaction(STORE_SUPPRESSION, 'readonly');
  return (await request(tx.objectStore(STORE_SUPPRESSION).getAll())) || [];
}

export async function addSuppression(entries) {
  if (!entries || !entries.length) return 0;
  const db = await openDb();
  const at = Date.now();
  await run(db, STORE_SUPPRESSION, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_SUPPRESSION);
    for (const entry of entries) if (entry && entry.value) store.put({ at, ...entry });
  });
  return entries.length;
}

/** Replace the whole list — the panel edits it as one block of text. */
export async function setSuppression(entries) {
  const db = await openDb();
  const at = Date.now();
  await run(db, STORE_SUPPRESSION, 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_SUPPRESSION);
    store.clear();
    for (const entry of entries || []) if (entry && entry.value) store.put({ at, ...entry });
  });
  return (entries || []).length;
}

/** Test hook: drop the cached connection so a fresh open is forced. */
export function resetDbCache() {
  dbPromise = null;
}
