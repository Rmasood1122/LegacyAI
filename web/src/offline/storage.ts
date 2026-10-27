// The ONE place the application keeps anything in the browser (decision D42): the locked offline pack and its key,
// in IndexedDB, under one record. The lint rules allow IndexedDB in this file only; nothing else is ever stored.
// Tested in a real browser by e2e/offline.spec.ts (the unit tests use MemoryPackStorage).
import type { PackStorage, StoredPack } from './store.ts';

const DB_NAME = 'legacyai-offline';
const STORE = 'pack';
const RECORD = 'current';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  return request(req);
}

export class IndexedDbPackStorage implements PackStorage {
  readonly #factory: IDBFactory;

  constructor(factory: IDBFactory = indexedDB) {
    this.#factory = factory;
  }

  async #run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb(this.#factory);
    try {
      const tx = db.transaction(STORE, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
      const [result] = await Promise.all([request(act(tx.objectStore(STORE))), done]);
      return result;
    } finally {
      db.close();
    }
  }

  read = async (): Promise<StoredPack | null> => ((await this.#run('readonly', (s) => s.get(RECORD))) as StoredPack | undefined) ?? null;

  write = async (pack: StoredPack): Promise<void> => {
    await this.#run('readwrite', (s) => s.put(pack, RECORD));
  };

  remove = async (): Promise<void> => {
    await this.#run('readwrite', (s) => s.delete(RECORD));
  };
}
