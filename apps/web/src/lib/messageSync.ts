import { LIMITS, type Message } from '@hearth/shared';
import { fetchMessages, sendMessage } from '../api/chat';
import { ApiError } from '../api/client';
import { useMessageStore } from '../stores/messages';

/** History page size (older pages and the first page of a channel). */
export const HISTORY_PAGE = LIMITS.messageHistoryPageDefault;
/** Catch-up page size after a reconnect. */
export const CATCH_UP_PAGE = LIMITS.messageHistoryPageMax;

const store = () => useMessageStore.getState();

// ---- Socket connection epochs ----
//
// Every connect and every disconnect starts a new epoch. A channel's `syncedThrough` is "live" (and
// live events may advance it) only if the latest page or a full catch-up completed inside the
// current connected epoch, i.e. with no disconnect in between. Otherwise a live event could move the
// cursor past messages that were missed while the socket was down.

let connection = { connected: false, epoch: 0 };

/** Called by the socket wiring (socket/chatEvents.ts) on every connect and disconnect. */
export function setSocketConnected(connected: boolean): void {
  connection = { connected, epoch: connection.epoch + 1 };
}

/** The current epoch if the socket is connected, else `null`. */
function liveEpoch(): number | null {
  return connection.connected ? connection.epoch : null;
}

/** Marks `channelId` live if the socket stayed connected in `epoch` for the whole operation. */
function markLiveIfStill(channelId: string, epoch: number | null): void {
  if (epoch !== null && epoch === liveEpoch()) store().setLiveEpoch(channelId, epoch);
}

/** `message:created`: inserts the message and, if the channel is live, advances its cursor. */
export function receiveCreated(message: Message): void {
  const entry = store().channels[message.channelId];
  if (!entry) return; // not opened this session (unread badges arrive in Phase 4)
  store().upsert(message);
  const epoch = liveEpoch();
  if (epoch !== null && entry.liveEpoch === epoch) store().advanceSynced(message.channelId, message.id);
}

/** `message:updated`: replaces the message only if it is loaded (never inserts). */
export function receiveUpdated(message: Message): void {
  store().updateIfPresent(message);
}

// ---- Loading ----

const latestInFlight = new Map<string, Promise<void>>();

/**
 * Fetches the latest page of a channel and marks it loaded. A short page means there is nothing
 * older. Concurrent calls for the same channel (the list and reconnect catch-up) share one request.
 */
export function loadLatest(channelId: string): Promise<void> {
  const inFlight = latestInFlight.get(channelId);
  if (inFlight) return inFlight;
  store().ensureChannel(channelId);
  const epoch = liveEpoch();
  const request = (async () => {
    try {
      const messages = await fetchMessages(channelId, { limit: HISTORY_PAGE });
      if (!store().channels[channelId]) return; // forgotten meanwhile (deleted)
      store().loadLatest(channelId, messages, messages.length >= HISTORY_PAGE);
      markLiveIfStill(channelId, epoch);
    } finally {
      latestInFlight.delete(channelId);
    }
  })();
  latestInFlight.set(channelId, request);
  return request;
}

const olderInFlight = new Map<string, Promise<void>>();

/**
 * Loads the page before the oldest loaded message. Concurrent calls for the same channel (the
 * button and the top-of-list observer) share one request.
 */
export function loadOlder(channelId: string): Promise<void> {
  const inFlight = olderInFlight.get(channelId);
  if (inFlight) return inFlight;
  const entry = store().channels[channelId];
  const before = entry?.ids[0];
  if (!entry?.loaded || !entry.hasOlder || before === undefined) return Promise.resolve();

  const request = (async () => {
    try {
      const messages = await fetchMessages(channelId, { before, limit: HISTORY_PAGE });
      store().upsertMany(channelId, messages);
      store().setHasOlder(channelId, messages.length >= HISTORY_PAGE);
    } finally {
      olderInFlight.delete(channelId);
    }
  })();
  olderInFlight.set(channelId, request);
  return request;
}

// ---- Reconnect catch-up ----

async function runCatchUp(channelId: string): Promise<void> {
  const epoch = liveEpoch();
  let entry = store().channels[channelId];
  if (!entry) return;
  // Opened but never loaded (e.g. the first load failed), or nothing synced yet (the channel was
  // empty): start from the latest page. It may be a load that began before this connect, so page
  // `?after=` it below as well (or, if it was empty, load again inside this epoch).
  if (!entry.loaded || entry.syncedThrough === null) {
    await loadLatest(channelId);
    entry = store().channels[channelId];
    if (!entry) return;
    if (entry.syncedThrough === null) {
      if (epoch !== null && entry.liveEpoch !== epoch) await loadLatest(channelId);
      return;
    }
  }
  let cursor = entry.syncedThrough;
  for (;;) {
    const page = await fetchMessages(channelId, { after: cursor, limit: CATCH_UP_PAGE });
    if (!store().channels[channelId]) return; // forgotten meanwhile (deleted)
    store().upsertMany(channelId, page);
    const last = page.at(-1);
    // The cursor follows the page, not the store, so tombstoned ids can't stall the loop.
    if (last !== undefined) {
      store().advanceSynced(channelId, last.id);
      cursor = last.id;
    }
    // A short page means we are at the newest message.
    if (page.length < CATCH_UP_PAGE || last === undefined) break;
  }
  markLiveIfStill(channelId, epoch);
}

const catchUpInFlight = new Map<string, { epoch: number; promise: Promise<void> }>();

/**
 * Pages `?after=<syncedThrough>` for one channel until a page comes back shorter than the limit
 * (or loads its latest page if it never loaded). A catch-up already running in the same connection
 * epoch is shared; one from an earlier epoch is followed by a fresh run.
 */
export function catchUpChannel(channelId: string): Promise<void> {
  const epoch = connection.epoch;
  const inFlight = catchUpInFlight.get(channelId);
  if (inFlight?.epoch === epoch) return inFlight.promise;
  const previous = inFlight?.promise.catch(() => undefined) ?? Promise.resolve();
  const promise = previous
    .then(() => runCatchUp(channelId))
    .finally(() => {
      if (catchUpInFlight.get(channelId)?.promise === promise) catchUpInFlight.delete(channelId);
    });
  catchUpInFlight.set(channelId, { epoch, promise });
  return promise;
}

/**
 * Catch-up for every channel opened this session (run on every socket connect, including the first,
 * and when the browser comes back online). A channel that is gone or no longer accessible (404/403)
 * is dropped from the store; other failures are left for the next connect (or the list's Retry).
 */
export async function catchUpAll(): Promise<void> {
  const channelIds = Object.keys(store().channels);
  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        await catchUpChannel(channelId);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          store().forgetChannel(channelId);
        }
      }
    }),
  );
}

/**
 * Sends (or re-sends) a pending message by its nonce. The optimistic copy is replaced by the real
 * message (here or by the `message:created` event, whichever comes first) or marked failed; the
 * error is rethrown for the page's alert.
 */
export async function deliverPending(nonce: string): Promise<void> {
  const pending = store().pending[nonce];
  if (!pending) return;
  store().retryPending(nonce);
  try {
    const message = await sendMessage(pending.channelId, pending.content, nonce);
    store().resolvePending(nonce, message);
  } catch (err) {
    store().failPending(nonce);
    throw err;
  }
}
