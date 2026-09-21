// IndexedDB shared by the service worker, the offscreen recorder and the popup
// (all run on the extension's origin). Metadata and audio live in separate
// stores so listing never loads the blobs.

const DB_NAME = 'speakr-recorder';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        db.createObjectStore('audio');
        // Chunks are written every 10 s while recording, so a crash or a closed
        // browser loses at most the last few seconds; see recoverOrphans().
        db.createObjectStore('chunks');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putRecording = (rec) => tx('recordings', 'readwrite', (s) => s.put(rec));
export const getRecording = (id) => tx('recordings', 'readonly', (s) => s.get(id));
export const listRecordings = async () =>
  (await tx('recordings', 'readonly', (s) => s.getAll())).sort((a, b) => b.startedAt - a.startedAt);

// Read-modify-write in one transaction: the background and the recorder both
// patch the same record, and readwrite transactions on a store serialize.
export async function updateRecording(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('recordings', 'readwrite');
    const store = t.objectStore('recordings');
    let next = null;
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      next = { ...req.result, ...patch };
      store.put(next);
    };
    t.oncomplete = () => resolve(next);
    t.onerror = () => reject(t.error);
  });
}

export const putAudio = (id, blob) => tx('audio', 'readwrite', (s) => s.put(blob, id));
export const getAudio = (id) => tx('audio', 'readonly', (s) => s.get(id));
export const deleteAudio = (id) => tx('audio', 'readwrite', (s) => s.delete(id));

// Zero-padded so string order is recording order.
const chunkKey = (id, seq) => `${id}:${String(seq).padStart(6, '0')}`;
const chunkRange = (id) => IDBKeyRange.bound(`${id}:`, `${id}:￿`);

export const putChunk = (id, seq, blob) => tx('chunks', 'readwrite', (s) => s.put(blob, chunkKey(id, seq)));
export const getChunks = (id) => tx('chunks', 'readonly', (s) => s.getAll(chunkRange(id)));
export const deleteChunks = (id) => tx('chunks', 'readwrite', (s) => s.delete(chunkRange(id)));

export async function deleteRecording(id) {
  await deleteChunks(id);
  await deleteAudio(id);
  await tx('recordings', 'readwrite', (s) => s.delete(id));
}

// Turn the chunks of an interrupted recording into a playable file.
export async function assembleChunks(id) {
  const chunks = await getChunks(id);
  if (!chunks.length) return null;
  const blob = new Blob(chunks, { type: 'audio/webm' });
  await putAudio(id, blob);
  await deleteChunks(id);
  return blob;
}
