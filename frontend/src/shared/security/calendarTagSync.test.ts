import { beforeEach, expect, it, vi } from 'vitest';
import { ConfigSyncConflictError, fetchRemoteVault, putRemoteVault } from '../api/configSyncApi';
import { generateVaultKey, encryptVaultWithKey, decryptVaultWithKey } from './vaultCrypto';
import { matchingTagSyncBaseline, mergeCalendarTags, synchronizeCalendarTags, tagSyncBaseline } from './calendarTagSync';

vi.mock('../api/configSyncApi', async original => ({
  ...await original<typeof import('../api/configSyncApi')>(),
  fetchRemoteVault: vi.fn(), putRemoteVault: vi.fn(),
}));
const tag = (id: string, name = id) => ({ id, name, color: '#123456' });
const local = {
  'calendar-desktop-tags': [tag('shared', 'Local'), tag('local')],
  'calendar-event-tags': { conflict: 'local', localEvent: 'local' },
  'calendar-desktop-calendars': [{ id: 'local-calendar' }],
};
const remote = {
  'calendar-desktop-tags': [tag('shared', 'WebDAV'), tag('remote')],
  'calendar-event-tags': { conflict: 'remote', remoteEvent: 'remote' },
  'calendar-desktop-calendars': [{ id: 'remote-calendar' }],
  'calendar-desktop-exchange-accounts': [{ id: 'remote-account' }],
};
const location = { serverUrl: 'https://cloud.example', username: 'fixture', password: 'fixture' };
beforeEach(() => vi.resetAllMocks());

async function setup(payload = remote, revision = 4, etag: string | undefined = '"v4"') {
  const key = await generateVaultKey();
  const vault = await encryptVaultWithKey(payload, key, crypto.getRandomValues(new Uint8Array(16)), 1);
  const document = { format: 'courrier-config' as const, version: 1 as const, deviceId: 'remote', revision, updatedAt: '', vault };
  vi.mocked(fetchRemoteVault).mockResolvedValue({ exists: true, document, etag });
  vi.mocked(putRemoteVault).mockResolvedValue('"v5"');
  return { key, document };
}

it('unions definitions and mappings, with remote values and ordering winning conflicts', () => {
  expect(mergeCalendarTags(local, remote)).toEqual({
    'calendar-desktop-tags': [tag('shared', 'WebDAV'), tag('remote'), tag('local')],
    'calendar-event-tags': { conflict: 'remote', localEvent: 'local', remoteEvent: 'remote' },
  });
});

it('fetches before uploading and preserves every non-tag remote field', async () => {
  const { key } = await setup();
  const result = await synchronizeCalendarTags(location, key, () => local, 'this-device', 1);
  expect(vi.mocked(fetchRemoteVault).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(putRemoteVault).mock.invocationCallOrder[0]);
  const [, document, etag] = vi.mocked(putRemoteVault).mock.calls[0];
  expect(etag).toBe('"v4"');
  expect(document.revision).toBe(5);
  expect(await decryptVaultWithKey(document.vault, key)).toEqual({ ...remote, ...mergeCalendarTags(local, remote) });
  expect(result?.etag).toBe('"v5"');
  expect(local['calendar-desktop-calendars']).toEqual([{ id: 'local-calendar' }]);
});

it('does not upload again when remote tags already contain all local values', async () => {
  const { key } = await setup();
  await synchronizeCalendarTags(location, key, () => remote, 'this-device', 1);
  expect(putRemoteVault).not.toHaveBeenCalled();
});

it('re-reads and merges a concurrent remote change before retrying a conflict', async () => {
  const { key, document } = await setup();
  const changed = { ...remote, 'calendar-desktop-tags': [tag('shared', 'Newest remote')] };
  const vault = await encryptVaultWithKey(changed, key, crypto.getRandomValues(new Uint8Array(16)), 1);
  vi.mocked(fetchRemoteVault).mockResolvedValueOnce({ exists: true, document, etag: '"v4"' })
    .mockResolvedValue({ exists: true, document: { ...document, vault, revision: 6 }, etag: '"v6"' });
  vi.mocked(putRemoteVault).mockRejectedValueOnce(new ConfigSyncConflictError()).mockResolvedValue('"v7"');
  const result = await synchronizeCalendarTags(location, key, () => local, 'this-device', 1);
  expect(fetchRemoteVault).toHaveBeenCalledTimes(2);
  expect(vi.mocked(putRemoteVault).mock.calls[1][2]).toBe('"v6"');
  expect(result?.payload['calendar-desktop-tags']).toContainEqual(tag('shared', 'Newest remote'));
});

it('does not upload if reading or decrypting the remote configuration fails', async () => {
  const { key } = await setup();
  vi.mocked(fetchRemoteVault).mockRejectedValue(new Error('offline'));
  await expect(synchronizeCalendarTags(location, key, () => local, 'device', 1)).rejects.toThrow('offline');
  expect(putRemoteVault).not.toHaveBeenCalled();
});

it('never overwrites a document without a usable server version', async () => {
  const { key, document } = await setup();
  vi.mocked(fetchRemoteVault).mockResolvedValue({ exists: true, document });
  await expect(synchronizeCalendarTags(location, key, () => local, 'device', 1)).rejects.toBeInstanceOf(ConfigSyncConflictError);
  expect(putRemoteVault).not.toHaveBeenCalled();
});

it('confirms a successful upload after its response is lost, without replaying it', async () => {
  const { key, document } = await setup();
  vi.mocked(fetchRemoteVault).mockResolvedValueOnce({ exists: true, document, etag: '"v4"' })
    .mockImplementation(async () => ({ exists: true, document: vi.mocked(putRemoteVault).mock.calls[0][1], etag: '"v5"' }));
  vi.mocked(putRemoteVault).mockRejectedValue(new Error('response lost'));
  expect((await synchronizeCalendarTags(location, key, () => local, 'device', 1))?.revision).toBe(5);
  expect(putRemoteVault).toHaveBeenCalledOnce();
});

it('does not recreate a deleted remote configuration', async () => {
  const { key } = await setup();
  vi.mocked(fetchRemoteVault).mockResolvedValue({ exists: false });
  expect(await synchronizeCalendarTags(location, key, () => local, 'device', 1)).toBeNull();
  expect(putRemoteVault).not.toHaveBeenCalled();
});

it('rejects malformed tag data before uploading', () => {
  expect(() => mergeCalendarTags({}, { 'calendar-desktop-tags': [{ id: 'broken' }] })).toThrow('invalidRemoteVault');
});

it('uploads local retagging and definition changes when WebDAV has not changed', async () => {
  const { key } = await setup();
  const result = await synchronizeCalendarTags(location, key, () => local, 'device', 1, remote);
  expect(result?.payload['calendar-event-tags']).toMatchObject({ conflict: 'local' });
  expect(result?.payload['calendar-desktop-tags']).toContainEqual(tag('shared', 'Local'));
});

it('keeps the remote association and definition when both devices changed them', () => {
  const base = { ...remote, 'calendar-desktop-tags': [tag('shared', 'Before')], 'calendar-event-tags': { conflict: 'before' } };
  const merged = mergeCalendarTags(local, remote, base);
  expect(merged['calendar-desktop-tags']).toContainEqual(tag('shared', 'WebDAV'));
  expect(merged['calendar-event-tags'].conflict).toBe('remote');
});

it('propagates a local removal instead of resurrecting the remote tag', () => {
  const base = { 'calendar-desktop-tags': [tag('removed')], 'calendar-event-tags': { event: 'removed' } };
  expect(mergeCalendarTags({ 'calendar-desktop-tags': [], 'calendar-event-tags': {} }, base, base)).toEqual({
    'calendar-desktop-tags': [], 'calendar-event-tags': {},
  });
});

it('does not resurrect remotely removed definitions or associations from a stale device', () => {
  const base = { 'calendar-desktop-tags': [tag('removed')], 'calendar-event-tags': { event: 'removed' } };
  expect(mergeCalendarTags(base, {}, base)).toEqual({
    'calendar-desktop-tags': [], 'calendar-event-tags': {},
  });
});

it('allows clearing one association while retaining its definition', () => {
  const base = { 'calendar-desktop-tags': [tag('kept')], 'calendar-event-tags': { event: 'kept' } };
  expect(mergeCalendarTags({ ...base, 'calendar-event-tags': {} }, base, base)).toEqual({
    'calendar-desktop-tags': [tag('kept')], 'calendar-event-tags': {},
  });
});

it('retains edits made during an upload as pending changes against the uploaded snapshot', () => {
  const before = { 'calendar-desktop-tags': [tag('a'), tag('b')], 'calendar-event-tags': { event: 'a' } };
  const during = { ...before, 'calendar-event-tags': { event: 'b' } };
  expect(mergeCalendarTags(during, before, before)['calendar-event-tags'].event).toBe('b');
  expect(mergeCalendarTags(during, { ...before, 'calendar-event-tags': { event: 'remote' } }, before)['calendar-event-tags'].event).toBe('remote');
});

it('never reuses a synchronization baseline from another WebDAV location', () => {
  const baseline = tagSyncBaseline(location, remote);
  expect(matchingTagSyncBaseline(location, baseline)).toEqual(mergeCalendarTags({}, remote));
  expect(matchingTagSyncBaseline({ ...location, username: 'another' }, baseline)).toBeUndefined();
  expect(matchingTagSyncBaseline({ ...location, serverUrl: 'https://other.example' }, baseline)).toBeUndefined();
});

it('does not interpret a vault lock during the remote read as local tag deletions', async () => {
  const { key } = await setup();
  await expect(synchronizeCalendarTags(location, key, () => {
    throw new Error('Vault locked');
  }, 'device', 1, remote)).rejects.toThrow('Vault locked');
  expect(putRemoteVault).not.toHaveBeenCalled();
});
