import { DaemonClient, type FetchAgentTimelinePayload } from '@getpaseo/client/internal/daemon-client';
import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { describe, expect, it, vi } from 'vitest';
import { AgentTimelineMirror, type MirrorSink } from '../src/paseo/mirror.js';
import { BackgroundGate } from '../src/background.js';

const timestamp = '2026-09-27T00:00:00Z';
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
type Entry = FetchAgentTimelinePayload['entries'][number];

function entry(seqStart: number, item: AgentTimelineItem, seqEnd = seqStart): Entry {
  return { seqStart, seqEnd, provider: 'pi', item, turnId: 'fake-turn', timestamp, sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }], collapsed: [] };
}

function page(epoch: string, entries: Entry[], endSeq = Math.max(0, ...entries.map((e) => e.seqEnd))): FetchAgentTimelinePayload {
  return {
    requestId: 'fake-request', agentId: 'fake-agent', agent: null, epoch, reset: false, entries,
    direction: 'tail', projection: 'projected', staleCursor: false, gap: false, error: null,
    window: { minSeq: 1, maxSeq: endSeq, nextSeq: endSeq + 1 },
    startCursor: entries.length ? { epoch, seq: entries[0]!.seqStart } : null,
    endCursor: entries.length ? { epoch, seq: endSeq } : null,
    hasOlder: false, hasNewer: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** Exercise the SDK's timeline dispatch without opening a socket. */
function fixture(fetch: DaemonClient['fetchAgentTimeline'], role: 'primary' | 'shadow' = 'primary') {
  const client = new DaemonClient({ url: 'ws://127.0.0.1:8892', clientId: 'fake-mirror', logger: quietLog });
  let update!: (message: SessionOutboundMessage) => void;
  let snapshot!: (value: { subscriptionId: string }) => void;
  vi.spyOn(client, 'observeTimeline').mockImplementation(() => ({
    subscriptionId: 'fake-timeline', ready: Promise.resolve({ subscriptionId: 'fake-timeline' }),
    subscribe: (observer: { update: typeof update; snapshot: typeof snapshot }) => {
      update = observer.update;
      snapshot = observer.snapshot;
      snapshot({ subscriptionId: 'fake-timeline' });
      return () => {};
    },
    release: async () => {},
  }) as never);
  vi.spyOn(client, 'fetchAgentTimeline').mockImplementation(fetch);
  const sink: MirrorSink = { reset: vi.fn(), upsert: vi.fn(), append: vi.fn(), status: vi.fn(), failure: vi.fn() };
  // The primary's mirror: catch-ups and reloads run on their own (a shadow's wait for the next open).
  const mirror = new AgentTimelineMirror(client, 'fake-agent', sink, new BackgroundGate(role));
  const replacement = (epoch: string) => update({ type: 'agent.timeline.replacement', payload: { agentId: 'fake-agent', epoch } } as never);
  const live = (seq: number | undefined, item: AgentTimelineItem, epoch = 'fake-epoch') => update({
    type: 'agent_stream', payload: { agentId: 'fake-agent', ...(seq === undefined ? {} : { epoch, seq }), timestamp,
      event: { type: 'timeline', provider: 'pi', item, turnId: 'fake-turn' } },
  });
  const restored = () => snapshot({ subscriptionId: 'fake-timeline' });
  return { mirror, sink, replacement, live, restored };
}

describe('Paseo mirror deliberate shadow reloads', () => {
  it.each([
    ['assistant_message', 'event first'], ['assistant_message', 'response first'],
    ['reasoning', 'event first'], ['reasoning', 'response first'],
  ] as const)('replays %s events over a reopened tail (%s)', async (type, order) => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history])).mockReturnValueOnce(pending.promise);
    const { mirror, sink, live, restored } = fixture(fetch, 'shadow');
    try {
      await mirror.loadTail();
      restored();
      expect(mirror.loaded).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      const read = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const snapshot = page('fake-epoch', [history, entry(2, { type, text: 'Snapshot' })]);
      if (order === 'response first') pending.resolve(snapshot);
      // Seq 2 is already in the snapshot; seq 3 arrived after it was taken.
      live(2, { type, text: 'Snapshot' });
      live(3, { type, text: ' plus live' });
      if (order === 'event first') pending.resolve(snapshot);
      await read;
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type, text: 'Snapshot plus live' }]);
      expect(mirror.rows.at(-1)?.seqEnd).toBe(3);
      expect(mirror.loaded).toBe(true);
      expect(sink.append).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { mirror.close(); }
  });

  it('buffers through overlapping deliberate tail reads', async () => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const first = deferred<FetchAgentTimelinePayload>();
    const second = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history]))
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { mirror, live, restored } = fixture(fetch, 'shadow');
    try {
      await mirror.loadTail();
      restored();
      const reads = [mirror.loadTail(), mirror.loadTail()];
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      live(2, { type: 'assistant_message', text: 'During first read' });
      first.resolve(page('fake-epoch', [history]));
      await reads[0];
      live(3, { type: 'assistant_message', text: ' and second read' });
      second.resolve(page('fake-epoch', [history]));
      await reads[1];
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type: 'assistant_message', text: 'During first read and second read' }]);
      expect(mirror.loaded).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { mirror.close(); }
  });

  it('keeps a gap discovered during a deliberate reload stale without fetching again', async () => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history])).mockReturnValueOnce(pending.promise);
    const { mirror, live, restored } = fixture(fetch, 'shadow');
    try {
      await mirror.loadTail();
      restored();
      const read = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      live(3, { type: 'assistant_message', text: 'After a gap' });
      pending.resolve(page('fake-epoch', [history]));
      await read;
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type: 'assistant_message', text: 'After a gap' }]);
      expect(mirror.loaded).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { mirror.close(); }
  });

  it('preserves live-only progress received during a deliberate reload', async () => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history])).mockReturnValueOnce(pending.promise);
    const { mirror, live, restored } = fixture(fetch, 'shadow');
    try {
      await mirror.loadTail();
      restored();
      const read = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      live(undefined, { type: 'assistant_message', text: 'Demo progress' });
      pending.resolve(page('fake-epoch', [history]));
      await read;
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type: 'assistant_message', text: 'Demo progress' }]);
      live(2, { type: 'user_message', text: 'Next demo message' });
      expect(mirror.loaded).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { mirror.close(); }
  });

  it('retains buffered events and stale status if the deliberate fetch fails', async () => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history])).mockReturnValueOnce(pending.promise);
    const { mirror, live, restored } = fixture(fetch, 'shadow');
    try {
      await mirror.loadTail();
      restored();
      const read = mirror.loadTail();
      const failed = expect(read).rejects.toThrow('fake-tail-failure');
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      live(2, { type: 'assistant_message', text: 'Demo live message' });
      pending.reject(new Error('fake-tail-failure'));
      await failed;
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type: 'assistant_message', text: 'Demo live message' }]);
      expect(mirror.loaded).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { mirror.close(); }
  });
});

describe.each(['primary', 'shadow'] as const)('%s mirror request ordering', role => {
  it.each(['older first', 'newer first'] as const)('keeps the newest issued tail and buffered events (%s)', async order => {
    const history = entry(1, { type: 'user_message', text: 'Demo history' });
    const older = deferred<FetchAgentTimelinePayload>();
    const newer = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [history]))
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { mirror, sink, live } = fixture(fetch, role);
    try {
      await mirror.loadTail();
      const first = mirror.loadTail();
      const second = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      live(3, { type: 'assistant_message', text: 'B' });
      live(4, { type: 'assistant_message', text: 'C' });
      const oldPage = page('fake-epoch', [history, entry(2, { type: 'assistant_message', text: 'A' })]);
      const newPage = page('fake-epoch', [history, entry(2, { type: 'assistant_message', text: 'AB' }, 3)]);
      if (order === 'older first') {
        older.resolve(oldPage);
        await first;
        expect(sink.reset).toHaveBeenCalledOnce();
        newer.resolve(newPage);
        await second;
      } else {
        newer.resolve(newPage);
        await second;
        expect(mirror.rows.at(-1)?.item).toEqual({ type: 'assistant_message', text: 'AB' });
        older.resolve(oldPage);
        await first;
      }
      expect(mirror.rows.map(row => row.item)).toEqual([history.item, { type: 'assistant_message', text: 'ABC' }]);
      expect(mirror.rows.at(-1)?.seqEnd).toBe(4);
      expect(mirror.loaded).toBe(true);
      expect(sink.reset).toHaveBeenCalledTimes(2);
      expect(sink.append).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { mirror.close(); }
  });

  it('ignores an obsolete tail error after a newer tail succeeds', async () => {
    const older = deferred<FetchAgentTimelinePayload>();
    const newer = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { mirror, sink } = fixture(fetch, role);
    try {
      const first = mirror.loadTail();
      const settled = expect(first).resolves.toBeNull();
      const second = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      newer.resolve(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'Newest history' })]));
      await second;
      older.reject(new Error('fake-obsolete-tail-error'));
      await settled;
      expect(mirror.rows[0]?.item).toEqual({ type: 'assistant_message', text: 'Newest history' });
      expect(mirror.loaded).toBe(true);
      expect(sink.reset).toHaveBeenCalledOnce();
      expect(sink.failure).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { mirror.close(); }
  });
});

it.each(['older first', 'newer first'] as const)('keeps a shadow stale if the newest tail fails (%s)', async order => {
  const history = entry(1, { type: 'user_message', text: 'Demo history' });
  const older = deferred<FetchAgentTimelinePayload>();
  const newer = deferred<FetchAgentTimelinePayload>();
  const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
    .mockResolvedValueOnce(page('fake-epoch', [history]))
    .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const { mirror, sink, restored } = fixture(fetch, 'shadow');
  try {
    await mirror.loadTail();
    restored();
    const first = mirror.loadTail();
    const second = mirror.loadTail();
    const failed = expect(second).rejects.toThrow('fake-current-tail-error');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const settleOlder = async () => {
      older.resolve(page('fake-epoch', [history, entry(2, { type: 'assistant_message', text: 'Obsolete history' })]));
      await first;
    };
    if (order === 'older first') await settleOlder();
    newer.reject(new Error('fake-current-tail-error'));
    await failed;
    if (order === 'newer first') await settleOlder();
    expect(mirror.rows.map(row => row.item)).toEqual([history.item]);
    expect(mirror.loaded).toBe(false);
    expect(sink.reset).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally { mirror.close(); }
});

describe('Paseo mirror passive request ordering', () => {
  it.each(['snapshot', 'reset', 'error'] as const)('ignores a catch-up superseded by a deliberate tail (%s)', async outcome => {
    const pending = deferred<FetchAgentTimelinePayload>();
    const current = page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'AB' }, 2)]);
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'A' })]))
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
    const { mirror, sink, live } = fixture(fetch);
    try {
      await mirror.loadTail();
      const catchUp = mirror.catchUp();
      const settled = expect(catchUp).resolves.toBeUndefined();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await mirror.loadTail();
      live(3, { type: 'assistant_message', text: 'C' });
      if (outcome === 'error') pending.reject(new Error('fake-obsolete-catch-up-error'));
      else pending.resolve(page(outcome === 'reset' ? 'fake-obsolete-epoch' : 'fake-epoch',
        [entry(1, { type: 'assistant_message', text: 'Obsolete' })], 1));
      await settled;
      expect(mirror.rows[0]?.item).toEqual({ type: 'assistant_message', text: 'ABC' });
      expect(mirror.loaded).toBe(true);
      expect(sink.reset).toHaveBeenCalledTimes(2);
      expect(sink.failure).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { mirror.close(); }
  });

  it.each(['resolve', 'reject'] as const)('ignores a replacement reload superseded by a deliberate tail (%s)', async outcome => {
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-old', []))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page('fake-current', [entry(1, { type: 'assistant_message', text: 'AB' }, 2)]));
    const { mirror, sink, live, replacement } = fixture(fetch);
    try {
      await mirror.loadTail();
      replacement('fake-current');
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await mirror.loadTail();
      live(3, { type: 'assistant_message', text: 'C' }, 'fake-current');
      if (outcome === 'resolve') pending.resolve(page('fake-current', [entry(1, { type: 'assistant_message', text: 'A' })]));
      else pending.reject(new Error('fake-obsolete-reload-error'));
      await vi.waitFor(() => expect(mirror.rows[0]?.item).toEqual({ type: 'assistant_message', text: 'ABC' }));
      expect(mirror.loaded).toBe(true);
      expect(sink.reset).toHaveBeenCalledTimes(2);
      expect(sink.failure).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { mirror.close(); }
  });

  it('ignores a deliberate tail superseded by a catch-up', async () => {
    const pending = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'A' })]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'AB' }, 2)]));
    const { mirror, sink, live } = fixture(fetch);
    try {
      await mirror.loadTail();
      const read = mirror.loadTail();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await mirror.catchUp();
      live(3, { type: 'assistant_message', text: 'C' });
      pending.resolve(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'A' })]));
      await read;
      expect(mirror.rows[0]?.item).toEqual({ type: 'assistant_message', text: 'ABC' });
      expect(sink.reset).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { mirror.close(); }
  });
});

describe('Paseo mirror projected anchors', () => {
  it.each(['assistant_message', 'reasoning'] as const)('preserves fetched %s anchors across collapsed tool updates', async (type) => {
    const tool: AgentTimelineItem = { type: 'tool_call', callId: 'fake-tool', name: 'Read', status: 'completed', error: null, detail: { type: 'unknown', input: null, output: null } };
    // The daemon collapses seq 3 into the tool at seq 1, leaving separate text anchors.
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', [entry(1, tool, 3), entry(2, { type, text: 'A' }), entry(4, { type, text: 'B' })]))
      .mockResolvedValue(page('fake-epoch', [entry(4, { type, text: 'BC' }, 5)], 5));
    const { mirror } = fixture(fetch);
    await mirror.loadTail();
    const anchors = mirror.rows.map((row) => row.key);
    expect(mirror.rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
    await mirror.catchUp();
    await mirror.catchUp();
    expect(mirror.rows.map((row) => row.item)).toEqual([tool, { type, text: 'A' }, { type, text: 'BC' }]);
    expect(mirror.rows.map((row) => row.key)).toEqual(anchors);
    mirror.close();
  });

  it.each(['assistant_message', 'reasoning'] as const)('preserves live %s anchors across interleaved tool updates', async (type) => {
    const tool: AgentTimelineItem = { type: 'tool_call', callId: 'fake-tool', name: 'Read', status: 'running', error: null, detail: { type: 'unknown', input: null, output: null } };
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-epoch', []))
      .mockResolvedValue(page('fake-epoch', [entry(4, { type, text: 'BC' }, 5)], 5));
    const { mirror, live } = fixture(fetch);
    await mirror.loadTail();
    live(1, tool);
    live(2, { type, text: 'A' });
    live(3, { ...tool, status: 'completed' });
    live(4, { type, text: 'B' });
    const anchors = mirror.rows.map((row) => row.key);
    expect(mirror.rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
    await mirror.catchUp();
    expect(mirror.rows.map((row) => row.item)).toEqual([{ ...tool, status: 'completed' }, { type, text: 'A' }, { type, text: 'BC' }]);
    expect(mirror.rows.map((row) => row.key)).toEqual(anchors);
    mirror.close();
  });
});

describe('Paseo mirror replacement invalidation', () => {
  it.each(['resolve', 'reject'] as const)('reloads a replacement delivered in the same task as a catch-up %s', async (outcome) => {
    const old = page('fake-old', [entry(1, { type: 'assistant_message', text: 'Old history' })]);
    const pending = deferred<FetchAgentTimelinePayload>();
    const current = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(old).mockReturnValueOnce(pending.promise).mockReturnValueOnce(current.promise);
    const { mirror, sink, replacement } = fixture(fetch);
    await mirror.loadTail();
    const catchUp = mirror.catchUp();
    void catchUp.catch(() => {});
    if (outcome === 'resolve') pending.resolve(page('fake-old', [entry(1, { type: 'assistant_message', text: 'Obsolete response' }, 2)]));
    else pending.reject(new Error('fake obsolete request failure'));
    replacement('fake-current');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mirror.loaded).toBe(false);
    expect(sink.upsert).not.toHaveBeenCalled();
    current.resolve(page('fake-current', [entry(1, { type: 'assistant_message', text: 'Rewound history' })]));
    await catchUp;
    expect(mirror.rows.map((row) => row.item)).toEqual([{ type: 'assistant_message', text: 'Rewound history' }]);
    expect(mirror.loaded).toBe(true);
    expect(sink.reset).toHaveBeenCalledTimes(2);
    expect(sink.failure).not.toHaveBeenCalled();
    mirror.close();
  });

  it('discards an initial tail invalidated before its continuation runs', async () => {
    const pending = deferred<FetchAgentTimelinePayload>();
    const fresh = page('fake-current', [entry(1, { type: 'user_message', text: 'Current history' })]);
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>().mockReturnValueOnce(pending.promise).mockResolvedValue(fresh);
    const { mirror, sink, replacement } = fixture(fetch);
    const loading = mirror.loadTail();
    await new Promise((resolve) => setImmediate(resolve));
    pending.resolve(page('fake-old', [entry(1, { type: 'user_message', text: 'Obsolete history' })]));
    replacement('fake-current');
    await loading;
    await new Promise((resolve) => setImmediate(resolve));
    expect(mirror.rows.map((row) => row.item)).toEqual([{ type: 'user_message', text: 'Current history' }]);
    expect(vi.mocked(sink.reset).mock.calls.flatMap(([rows]) => rows.map((row) => row.item))).not.toContainEqual({ type: 'user_message', text: 'Obsolete history' });
    mirror.close();
  });

  it('retains another replacement while a full reload is in flight', async () => {
    const pending = deferred<FetchAgentTimelinePayload>();
    const current = deferred<FetchAgentTimelinePayload>();
    const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
      .mockResolvedValueOnce(page('fake-old', []))
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(current.promise);
    const { mirror, sink, replacement } = fixture(fetch);
    await mirror.loadTail();
    replacement('fake-intermediate');
    pending.resolve(page('fake-intermediate', [entry(1, { type: 'user_message', text: 'Obsolete history' })]));
    replacement('fake-current');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mirror.loaded).toBe(false);
    expect(sink.reset).toHaveBeenCalledTimes(1);
    current.resolve(page('fake-current', [entry(1, { type: 'user_message', text: 'Current history' })]));
    await expect.poll(() => mirror.loaded).toBe(true);
    expect(mirror.rows.map((row) => row.item)).toEqual([{ type: 'user_message', text: 'Current history' }]);
    mirror.close();
  });
});

it.each(['resolve', 'reject'] as const)('invalidates a pending shadow tail on replacement (%s), without an automatic retry', async (outcome) => {
  const pending = deferred<FetchAgentTimelinePayload>();
  const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>().mockReturnValueOnce(pending.promise)
    .mockResolvedValue(page('fake-new-epoch', [entry(1, { type: 'assistant_message', text: 'New history' })]));
  const { mirror, replacement, sink } = fixture(fetch, 'shadow');
  const read = mirror.loadTail();
  const settled = read.catch(() => null);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  replacement('fake-new-epoch');
  if (outcome === 'resolve') pending.resolve(page('fake-old-epoch', [entry(1, { type: 'assistant_message', text: 'Obsolete history' })]));
  else pending.reject(new Error('fake-obsolete-error'));
  await settled;
  await expect(read).resolves.toBeNull();
  expect(mirror.rows).toEqual([]);
  expect(mirror.loaded).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
  expect(sink.failure).not.toHaveBeenCalled();
  await mirror.loadTail();
  expect(mirror.rows[0]?.item).toMatchObject({ text: 'New history' });
  mirror.close();
});

it('invalidates a pending shadow tail when a live event changes its epoch', async () => {
  const pending = deferred<FetchAgentTimelinePayload>();
  const fetch = vi.fn<DaemonClient['fetchAgentTimeline']>()
    .mockResolvedValueOnce(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'Old history' })]))
    .mockReturnValueOnce(pending.promise);
  const { mirror, live } = fixture(fetch, 'shadow');
  await mirror.loadTail();
  await mirror.catchUp();
  const read = mirror.loadTail();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  live(1, { type: 'assistant_message', text: 'New epoch' }, 'fake-new-epoch');
  pending.resolve(page('fake-epoch', [entry(1, { type: 'assistant_message', text: 'Obsolete history' })]));
  await expect(read).resolves.toBeNull();
  expect(mirror.rows.map(row => row.item)).toEqual([{ type: 'assistant_message', text: 'New epoch' }]);
  expect(mirror.loaded).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  mirror.close();
});
