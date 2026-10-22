import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { seedDb } from '../mocks/data';
import type { Collection, Db } from '../types';

// Store en mémoire qui simule l'API REST tant que le back-end n'existe pas.
// Il est recopié dans le localStorage pour survivre à un rechargement.

const STORAGE_KEY = 'ultra-planning-db-v1';

type Item<C extends Collection> = Db[C][number];

type Action =
  | { type: 'upsert'; collection: Collection; item: { id: number } }
  | { type: 'remove'; collection: Collection; id: number }
  | { type: 'insertMany'; collection: Collection; items: { id: number }[] }
  | { type: 'reset' };

function nextId(list: { id: number }[]): number {
  return list.reduce((max, x) => Math.max(max, x.id), 0) + 1;
}

function reducer(db: Db, action: Action): Db {
  switch (action.type) {
    case 'upsert': {
      const list = db[action.collection] as { id: number }[];
      const item = action.item.id ? action.item : { ...action.item, id: nextId(list) };
      const exists = list.some((x) => x.id === item.id);
      const updated = exists
        ? list.map((x) => (x.id === item.id ? { ...x, ...item } : x))
        : [...list, item];
      return { ...db, [action.collection]: updated };
    }
    case 'remove': {
      const list = db[action.collection] as { id: number }[];
      return { ...db, [action.collection]: list.filter((x) => x.id !== action.id) };
    }
    case 'insertMany': {
      const list = db[action.collection] as { id: number }[];
      let id = nextId(list);
      const added = action.items.map((x) => ({ ...x, id: id++ }));
      return { ...db, [action.collection]: [...list, ...added] };
    }
    case 'reset':
      return seedDb();
  }
}

function loadDb(): Db {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...seedDb(), ...JSON.parse(raw) };
  } catch {
    // stockage indisponible : on repart des données de démonstration
  }
  return seedDb();
}

interface DataApi {
  db: Db;
  /** Crée l'élément si id vaut 0 (id attribué par le store), sinon le met à jour. */
  save: <C extends Collection>(collection: C, item: Item<C>) => void;
  remove: (collection: Collection, id: number) => void;
  insertMany: <C extends Collection>(collection: C, items: Omit<Item<C>, 'id'>[]) => void;
  reset: () => void;
}

const DataContext = createContext<DataApi | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [db, dispatch] = useReducer(reducer, undefined, loadDb);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      // ignoré : la persistance n'est qu'un confort de démonstration
    }
  }, [db]);

  const api = useMemo<DataApi>(
    () => ({
      db,
      save: (collection, item) => dispatch({ type: 'upsert', collection, item }),
      remove: (collection, id) => dispatch({ type: 'remove', collection, id }),
      insertMany: (collection, items) =>
        dispatch({ type: 'insertMany', collection, items: items.map((x) => ({ ...x, id: 0 })) }),
      reset: () => dispatch({ type: 'reset' }),
    }),
    [db],
  );

  return <DataContext.Provider value={api}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData doit être utilisé dans <DataProvider>');
  return ctx;
}

/** Index id → élément, pour les jointures d'affichage. */
export function byId<T extends { id: number }>(list: T[]): Map<number, T> {
  return new Map(list.map((x) => [x.id, x]));
}
