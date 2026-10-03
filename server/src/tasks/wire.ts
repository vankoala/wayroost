import type { ConversationSummary, ServerEvent } from '../../../shared/protocol.js';
import type { BackgroundGate } from '../background.js';
import type { Bridge } from '../bridge/service.js';
import type { Feed } from '../feed/service.js';
import type { HermesAdapter, Logger } from '../hermes/adapter.js';
import { HermesAuthError } from '../hermes/auth.js';
import { UserFacingError } from '../sources.js';
import type { HermesMessageRow } from '../hermes/normalize.js';
import type { PaseoAdapter } from '../paseo/adapter.js';
import { TaskRelay, type TaskRelayDeps } from './relay.js';
import type { WorkerUpdatesSetting } from './setting.js';
import { TaskStore } from './store.js';

// Worker updates need all three: Paseo (the workers), Hermes (the chats that
// start them, read through its dashboard like the rest of Signalbox) and the
// bridge (the only way anything reaches a chat). Without one of them, none.

/** The chats side, through Hermes' dashboard: the same read-only calls a chat's page makes. */
export function hermesChats(hermes: HermesAdapter): TaskRelayDeps['chats'] {
  const auth = () => {
    const signedIn = hermes.dashboard();
    if (!signedIn) throw new Error('Wayroost is not signed in to Hermes.');
    return signedIn;
  };
  return {
    connected: () => hermes.status().state === 'connected',
    async rows(id: string): Promise<HermesMessageRow[]> {
      const page = await auth().json<{ messages?: HermesMessageRow[] }>(
        `/api/sessions/${encodeURIComponent(id)}/messages?limit=200&order=latest`,
      ).catch((err: unknown) => {
        if (err instanceof HermesAuthError) throw new UserFacingError(err.message, err.status ?? (err.kind === 'unavailable' ? 503 : 502));
        throw err;
      });
      return page.messages ?? [];
    },
    async find(id: string): Promise<ConversationSummary | undefined> {
      const list = await hermes.listConversations();
      const current = await hermes.resolveListedChat(id, list);
      return list.find((c) => c.id === current) ?? hermes.summaryOf(current);
    },
    async origin(id: string): Promise<string | undefined> {
      const row = await auth().json<{ source?: unknown }>(`/api/sessions/${encodeURIComponent(id)}`);
      return typeof row.source === 'string' ? row.source : undefined;
    },
  };
}

/** The workers side: Paseo's agents as the adapter already follows them. */
export function paseoWorkers(paseo: PaseoAdapter): TaskRelayDeps['workers'] {
  return {
    // Loaded AND connected: during an outage the cached list is history, not news.
    get agentsLoaded() {
      return paseo.agentsLoaded && paseo.status().state === 'connected';
    },
    workerSnapshot: (id) => paseo.workerSnapshot(id),
    workerSnapshots: () => paseo.workerSnapshots(),
    lookUp: (id) => paseo.lookUpWorker(id),
    async lastMessage(id: string): Promise<string | undefined> {
      const { items } = await paseo.getConversation(id);
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.kind === 'assistant' && item.text.trim()) return item.text;
      }
      return undefined;
    },
  };
}

export function createTaskRelay(options: {
  hermes: HermesAdapter;
  paseo: PaseoAdapter;
  bridge: Bridge;
  hub: { observe(observer: (event: ServerEvent) => void): void };
  feed?: Feed;
  setting: WorkerUpdatesSetting;
  stateDir: string;
  log: Logger;
  background: BackgroundGate;
}): TaskRelay {
  return new TaskRelay({
    workers: paseoWorkers(options.paseo),
    chats: hermesChats(options.hermes),
    bridge: options.bridge,
    hub: options.hub,
    ...(options.feed ? { feed: options.feed } : {}),
    store: new TaskStore(options.stateDir, Date.now, options.hermes.chatIdentity, options.log),
    setting: options.setting,
    log: options.log,
    background: options.background,
  });
}
