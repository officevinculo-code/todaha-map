// IndexedDBラッパー。画像はBlobのまま保存するため localStorage ではなく IndexedDB を使用する。

const DB_NAME = 'todaha_map_db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('themes')) {
        db.createObjectStore('themes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('achievements')) {
        const store = db.createObjectStore('achievements', { keyPath: 'id' });
        store.createIndex('by_theme', 'themeId');
        store.createIndex('by_theme_pref', ['themeId', 'prefId']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const Db = {
  async addTheme(theme) {
    const db = await openDB();
    const t = tx(db, ['themes'], 'readwrite');
    await reqToPromise(t.objectStore('themes').add(theme));
    return theme;
  },

  async getThemes() {
    const db = await openDB();
    const t = tx(db, ['themes'], 'readonly');
    return reqToPromise(t.objectStore('themes').getAll());
  },

  async deleteTheme(themeId) {
    const db = await openDB();
    const achievements = await this.getAchievementsByTheme(themeId);
    const t = tx(db, ['themes', 'achievements'], 'readwrite');
    t.objectStore('themes').delete(themeId);
    const store = t.objectStore('achievements');
    for (const a of achievements) store.delete(a.id);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async addAchievement(achievement) {
    const db = await openDB();
    const t = tx(db, ['achievements'], 'readwrite');
    await reqToPromise(t.objectStore('achievements').add(achievement));
    return achievement;
  },

  async deleteAchievement(id) {
    const db = await openDB();
    const t = tx(db, ['achievements'], 'readwrite');
    await reqToPromise(t.objectStore('achievements').delete(id));
  },

  async getAchievementsByTheme(themeId) {
    const db = await openDB();
    const t = tx(db, ['achievements'], 'readonly');
    const idx = t.objectStore('achievements').index('by_theme');
    return reqToPromise(idx.getAll(IDBKeyRange.only(themeId)));
  },
};
