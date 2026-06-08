// ── IndexedDB — stocare permanentă pe dispozitiv ─────────────────
const DB = (() => {
  const DB_NAME    = 'traseu_ro';
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('locations')) {
          db.createObjectStore('locations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t  = db.transaction(store, mode);
      const s  = t.objectStore(store);
      const req = fn(s);
      if (req) {
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      } else {
        t.oncomplete = () => resolve();
        t.onerror    = e => reject(e.target.error);
      }
    }));
  }

  // ── Locații ──────────────────────────────────────────────────────
  function getAllLocations() {
    return open().then(db => new Promise((resolve, reject) => {
      const t    = db.transaction('locations', 'readonly');
      const s    = t.objectStore('locations');
      const req  = s.getAll();
      req.onsuccess = e => {
        const locs = (e.target.result || [])
          .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
        resolve(locs);
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  function saveLocation(loc) {
    return tx('locations', 'readwrite', s => s.put(loc));
  }

  function deleteLocation(id) {
    return tx('locations', 'readwrite', s => s.delete(id));
  }

  function clearLocations() {
    return tx('locations', 'readwrite', s => s.clear());
  }

  function saveAllLocations(locs) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('locations', 'readwrite');
      const s = t.objectStore('locations');
      s.clear();
      locs.forEach((loc, i) => s.put({ ...loc, order: i }));
      t.oncomplete = () => resolve();
      t.onerror    = e => reject(e.target.error);
    }));
  }

  // ── Stare (mode, start) ──────────────────────────────────────────
  function getState() {
    return open().then(db => new Promise((resolve, reject) => {
      const t   = db.transaction('state', 'readonly');
      const s   = t.objectStore('state');
      const req = s.getAll();
      req.onsuccess = e => {
        const state = {};
        (e.target.result || []).forEach(r => { state[r.key] = r.value; });
        resolve(state);
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  function setState(key, value) {
    return tx('state', 'readwrite', s => s.put({ key, value }));
  }

  return { getAllLocations, saveLocation, deleteLocation, clearLocations, saveAllLocations, getState, setState };
})();
