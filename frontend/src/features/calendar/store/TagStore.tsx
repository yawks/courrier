import { createContext, useContext, useReducer, useEffect, ReactNode, useState, useRef, useCallback } from 'react';
import { useVault } from '../../../shared/security/VaultProvider';
import { Tag, EventTagMapping } from '../../../shared/types';
import { cacheGetStale, cacheSet } from '../utils/eventCache';

const STORAGE_KEY_TAGS = 'calendar-desktop-tags';
const STORAGE_KEY_MAPPINGS = 'calendar-event-tags';
const TAG_SYNC_BATCH_DELAY = 1_500;

type TagsAction =
  | { type: 'INIT'; payload: Tag[] }
  | { type: 'ADD'; payload: Tag }
  | { type: 'REMOVE'; payload: string }
  | { type: 'UPDATE'; payload: { id: string; data: Partial<Tag> } };

type MappingsAction =
  | { type: 'INIT'; payload: EventTagMapping }
  | { type: 'SET'; payload: { seriesId: string; tagId: string } }
  | { type: 'REMOVE'; payload: string }; // seriesId

function tagsReducer(state: Tag[], action: TagsAction): Tag[] {
  switch (action.type) {
    case 'INIT':
      return action.payload;
    case 'ADD':
      return [...state, action.payload];
    case 'REMOVE':
      return state.filter((t) => t.id !== action.payload);
    case 'UPDATE':
      return state.map((t) =>
        t.id === action.payload.id ? { ...t, ...action.payload.data } : t
      );
  }
}

function mappingsReducer(state: EventTagMapping, action: MappingsAction): EventTagMapping {
  switch (action.type) {
    case 'INIT':
      return action.payload;
    case 'SET':
      return { ...state, [action.payload.seriesId]: action.payload.tagId };
    case 'REMOVE': {
      const copy = { ...state };
      delete copy[action.payload];
      return copy;
    }
  }
}

interface TagContextValue {
  tags: Tag[];
  eventTags: EventTagMapping;
  addTag: (name: string, color: string) => void;
  removeTag: (id: string) => void;
  updateTag: (id: string, data: Partial<Tag>) => void;
  setEventTag: (seriesId: string, tagId: string) => void;
  removeEventTag: (seriesId: string) => void;
  isLoaded: boolean;
  refreshTags: () => Promise<void>;
  isSynchronizing: boolean;
}

const TagContext = createContext<TagContextValue | null>(null);

export function TagProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const [tags, dispatchTags] = useReducer(tagsReducer, [], () => {
    const saved = vault.read<Tag[] | null>(STORAGE_KEY_TAGS, null);
    if (saved !== null) return saved;
    const stored = localStorage.getItem(STORAGE_KEY_TAGS);
    return stored ? JSON.parse(stored) as Tag[] : [];
  });

  const [eventTags, dispatchMappings] = useReducer(mappingsReducer, {},
    () => vault.read<EventTagMapping>(STORAGE_KEY_MAPPINGS, {}));
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSynchronizing, setIsSynchronizing] = useState(false);
  const [localEditRevision, setLocalEditRevision] = useState(0);
  const [syncRequest, setSyncRequest] = useState(0);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const refreshTaskRef = useRef<Promise<void> | null>(null);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (vault.read<EventTagMapping | null>(STORAGE_KEY_MAPPINGS, null) !== null) {
      setIsLoaded(true);
      return;
    }
    let active = true;
    cacheGetStale<EventTagMapping>(STORAGE_KEY_MAPPINGS).then((data) => {
      if (!active) return;
      if (data) dispatchMappings({ type: 'INIT', payload: data });
      setIsLoaded(true);
    }).catch(() => { if (active) setIsLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    vault.write(STORAGE_KEY_TAGS, tags);
    localStorage.removeItem(STORAGE_KEY_TAGS);
  }, [tags]);

  useEffect(() => {
    if (isLoaded) {
      vault.write(STORAGE_KEY_MAPPINGS, eventTags);
      // The vault is now authoritative; old cache data must not return after a restore.
      void cacheSet(STORAGE_KEY_MAPPINGS, {});
    }
  }, [eventTags, isLoaded]);

  const noteLocalEdit = () => setLocalEditRevision(value => value + 1);
  const addTag = (name: string, color: string) => {
    dispatchTags({ type: 'ADD', payload: { id: crypto.randomUUID(), name, color } });
    noteLocalEdit();
  };

  const removeTag = (id: string) => {
    if (!tags.some(tag => tag.id === id)) return;
    dispatchTags({ type: 'REMOVE', payload: id });
    // Also remove any mappings associated with this tag
    Object.entries(eventTags).forEach(([seriesId, tagId]) => {
      if (tagId === id) {
        dispatchMappings({ type: 'REMOVE', payload: seriesId });
      }
    });
    noteLocalEdit();
  };

  const updateTag = (id: string, data: Partial<Tag>) => {
    dispatchTags({ type: 'UPDATE', payload: { id, data } });
    noteLocalEdit();
  };

  const setEventTag = (seriesId: string, tagId: string) => {
    if (eventTags[seriesId] === tagId) return;
    dispatchMappings({ type: 'SET', payload: { seriesId, tagId } });
    noteLocalEdit();
  };

  const removeEventTag = (seriesId: string) => {
    if (!(seriesId in eventTags)) return;
    dispatchMappings({ type: 'REMOVE', payload: seriesId });
    noteLocalEdit();
  };

  const refreshTags = useCallback(() => {
    clearTimeout(batchTimerRef.current);
    batchTimerRef.current = undefined;
    if (refreshTaskRef.current) return refreshTaskRef.current;
    setIsSynchronizing(true);
    const task = (async () => {
      try {
        const merged = await vaultRef.current.syncCalendarTags?.();
        if (!merged) return;
        dispatchTags({ type: 'INIT', payload: merged['calendar-desktop-tags'] });
        dispatchMappings({ type: 'INIT', payload: merged['calendar-event-tags'] });
        // Edits made while the PUT was in flight are preserved locally and
        // scheduled as a new batch, never marked as already uploaded.
        if (merged.needsUpload) setSyncRequest(value => value + 1);
      } finally {
        setIsSynchronizing(false);
      }
    })();
    refreshTaskRef.current = task;
    void task.finally(() => { if (refreshTaskRef.current === task) refreshTaskRef.current = null; }).catch(() => {});
    return task;
  }, []);

  const syncEnabled = !!vault.configSyncSettings?.enabled;
  const syncSource = `${vault.configSyncSettings?.serverUrl ?? ''}|${vault.configSyncSettings?.username ?? ''}`;
  useEffect(() => {
    if (!isLoaded || !syncEnabled) return;
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = undefined;
      // Failures keep the local batch. The vault exposes the sync error, and
      // the next edit, explicit refresh, resume or reconnect retries it.
      void refreshTags().catch(() => {});
    }, TAG_SYNC_BATCH_DELAY);
    return () => { clearTimeout(batchTimerRef.current); batchTimerRef.current = undefined; };
  }, [isLoaded, syncEnabled, syncSource, localEditRevision, syncRequest, refreshTags]);

  useEffect(() => {
    if (!syncEnabled) return;
    const retry = () => setSyncRequest(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') retry(); };
    globalThis.addEventListener('online', retry);
    document.addEventListener('visibilitychange', visible);
    return () => {
      globalThis.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [syncEnabled]);

  return (
    <TagContext.Provider
      value={{
        tags,
        eventTags,
        addTag,
        removeTag,
        updateTag,
        setEventTag,
        removeEventTag,
        isLoaded,
        refreshTags,
        isSynchronizing,
      }}
    >
      {children}
    </TagContext.Provider>
  );
}

export function useTags() {
  const ctx = useContext(TagContext);
  if (!ctx) throw new Error('useTags must be used within TagProvider');
  return ctx;
}
