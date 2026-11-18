import { ConfigSyncConflictError, fetchRemoteVault, putRemoteVault, type NextcloudConfigLocation, type RemoteVaultDocument } from '../api/configSyncApi';
import { decryptVaultWithKey, encryptVaultWithKey } from './vaultCrypto';
import type { Tag, EventTagMapping } from '../types';
import type { PortableConfigPayload } from './portableConfig';

export const TAG_CONFIG_KEYS = ['calendar-desktop-tags', 'calendar-event-tags'] as const;
export const TAG_SYNC_BASE_KEY = 'courrier:tag-sync-base-v1';

export interface TagSyncBaseline {
  serverUrl: string;
  username: string;
  payload: PortableConfigPayload;
}

export function tagSyncBaseline(location: NextcloudConfigLocation, payload: PortableConfigPayload): TagSyncBaseline {
  return {
    serverUrl: location.serverUrl.trim().replace(/\/+$/, ''),
    username: location.username.trim(),
    payload: mergeCalendarTags({}, payload),
  };
}

export function matchingTagSyncBaseline(location: NextcloudConfigLocation, baseline?: TagSyncBaseline): PortableConfigPayload | undefined {
  return baseline?.serverUrl === location.serverUrl.trim().replace(/\/+$/, '')
    && baseline.username === location.username.trim() ? baseline.payload : undefined;
}

export function mergeCalendarTags(local: PortableConfigPayload, remote: PortableConfigPayload, base?: PortableConfigPayload) {
  const readTags = (payload: PortableConfigPayload): Tag[] => {
    const value = payload[TAG_CONFIG_KEYS[0]] ?? [];
    if (!Array.isArray(value) || value.some(tag => !tag || typeof tag.id !== 'string'
      || typeof tag.name !== 'string' || typeof tag.color !== 'string')) throw new Error('invalidRemoteVault');
    return value;
  };
  const readMappings = (payload: PortableConfigPayload): EventTagMapping => {
    const value = payload[TAG_CONFIG_KEYS[1]] ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(tagId => typeof tagId !== 'string')) throw new Error('invalidRemoteVault');
    return value as EventTagMapping;
  };
  const mergeEntries = <T,>(localValues: Map<string, T>, remoteValues: Map<string, T>, baseValues?: Map<string, T>) => {
    const merged = new Map<string, T>();
    for (const id of new Set([...remoteValues.keys(), ...localValues.keys(), ...(baseValues?.keys() ?? [])])) {
      const changed = (values: Map<string, T>) => baseValues
        && (values.has(id) !== baseValues.has(id) || JSON.stringify(values.get(id)) !== JSON.stringify(baseValues.get(id)));
      // Without a baseline keep the conservative legacy union. With a baseline,
      // only concurrent changes are conflicts; unchanged remote values must not
      // prevent a local retag or removal from being saved.
      const source = baseValues
        ? changed(localValues) && !changed(remoteValues) ? localValues : remoteValues
        : remoteValues.has(id) ? remoteValues : localValues;
      if (source.has(id)) merged.set(id, source.get(id)!);
    }
    return merged;
  };
  const tagEntries = (payload: PortableConfigPayload) => new Map(readTags(payload).map(tag => [tag.id, tag]));
  const baseTags = base ? tagEntries(base) : undefined;
  const tags = mergeEntries(tagEntries(local), tagEntries(remote), baseTags);
  const mappings = mergeEntries(new Map(Object.entries(readMappings(local))), new Map(Object.entries(readMappings(remote))),
    base ? new Map(Object.entries(readMappings(base))) : undefined);
  const deletedTags = new Set([...(baseTags?.keys() ?? [])].filter(id => !tags.has(id)));
  return {
    [TAG_CONFIG_KEYS[0]]: [...tags.values()],
    [TAG_CONFIG_KEYS[1]]: Object.fromEntries([...mappings].filter(([, tagId]) => !deletedTags.has(tagId))),
  };
}

/** Only tags are merged automatically. Remote accounts/sources are never replaced. */
export async function synchronizeCalendarTags(
  location: NextcloudConfigLocation,
  syncKey: CryptoKey,
  readLocal: () => PortableConfigPayload,
  deviceId: string,
  iterations: number,
  base?: PortableConfigPayload,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await fetchRemoteVault(location);
    if (!remote.document) return null; // Never recreate a missing configuration with tags alone.
    const remotePayload = await decryptVaultWithKey<PortableConfigPayload>(remote.document.vault, syncKey);
    const localSnapshot = mergeCalendarTags({}, readLocal());
    const tags = mergeCalendarTags(localSnapshot, remotePayload, base);
    const merged: PortableConfigPayload = { ...remotePayload, ...tags };
    if (JSON.stringify(merged) === JSON.stringify(remotePayload)) {
      return { payload: merged, etag: remote.etag, revision: remote.document.revision, localSnapshot };
    }
    // Do not perform an unconditional write to an existing configuration.
    if (!remote.etag) throw new ConfigSyncConflictError();
    const document: RemoteVaultDocument = {
      ...remote.document, deviceId, revision: remote.document.revision + 1,
      updatedAt: new Date().toISOString(),
      vault: await encryptVaultWithKey(merged, syncKey, crypto.getRandomValues(new Uint8Array(16)), iterations),
    };
    try {
      const etag = await putRemoteVault(location, document, remote.etag);
      return { payload: merged, etag, revision: document.revision, localSnapshot };
    } catch (error) {
      if (error instanceof ConfigSyncConflictError) {
        // Re-read and re-merge once, rather than overwriting a concurrent edit.
        if (attempt === 0) continue;
      } else {
        // A failed response can follow a successful PUT. Confirm before
        // reporting failure; never replay an uncertain write blindly.
        const confirmed = await fetchRemoteVault(location).catch(() => null);
        if (confirmed?.document && JSON.stringify(confirmed.document.vault) === JSON.stringify(document.vault)) {
          return { payload: merged, etag: confirmed.etag, revision: document.revision, localSnapshot };
        }
      }
      throw error;
    }
  }
  throw new ConfigSyncConflictError();
}
