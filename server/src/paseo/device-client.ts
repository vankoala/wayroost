import { DaemonClient, type ConnectionState, type DaemonClientConfig } from '@getpaseo/client/internal/daemon-client';
import { createWebSocketTransportFactory, defaultWebSocketFactory } from '@getpaseo/client/internal/daemon-client-websocket-transport';
import type { SessionInboundMessage } from '@getpaseo/protocol/messages';
import { checkDeviceSignal, deviceSignal, onDeviceAbort, withDeviceSignal } from '../security/device-signal.js';

interface Creation {
  result: Promise<unknown>;
}

// The pinned 0.9.2 SDK does not expose cancellation for uploads, sends or creation
// recovery. Keep its internal hooks here; the real-SDK tests check this contract.
interface Dispatch {
  config: DaemonClientConfig;
  scheduleReconnect(...args: unknown[]): void;
  sendSessionMessageOrThrow(message: SessionInboundMessage): Promise<void>;
  waitForWithCancel(...args: unknown[]): { promise: Promise<unknown>; cancel(error: Error): void };
  creations: {
    operations: Map<string, Creation>;
    submit(operation: Creation): Promise<void>;
    fail(operation: Creation, error: Error): void;
    deps: {
      observe(kind: string, key: string, next: (snapshot: unknown) => void, error: (error: Error) => void): () => void;
    };
  };
}

const guarded = new WeakSet<DaemonClient>();
const SEND_TIMEOUT_MS = 60_000;

/** Each device owns its queued send, rather than the shared SDK reconnect callback. */
function connected(client: DaemonClient, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    let removeAbort = () => {};
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); unsubscribe(); removeAbort();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Paseo timed out waiting to send.')), SEND_TIMEOUT_MS);
    removeAbort = onDeviceAbort(finish, signal);
    if (!settled) unsubscribe = client.subscribeConnectionStatus((state: ConnectionState) => {
      if (state.status === 'connected') finish();
      else if (state.status !== 'connecting') finish(new Error('Paseo disconnected before sending.'));
    });
    // subscribeConnectionStatus immediately invokes the callback.
    if (settled) { unsubscribe(); removeAbort(); }
  });
}

/** Guard every frame and retire SDK work while preserving the shared lifecycle. */
export function guardDaemonClient(client: DaemonClient): void {
  if (!(client instanceof DaemonClient) || guarded.has(client)) return;
  const sdk = client as unknown as Dispatch;
  // An operation failure may ask the SDK to reconnect; its transport belongs to
  // the server, while replayed user operations retain their own authorization.
  const reconnect = sdk.scheduleReconnect.bind(client);
  sdk.scheduleReconnect = (...args) => withDeviceSignal(undefined, () => reconnect(...args));
  const factory = sdk.config.transportFactory ?? createWebSocketTransportFactory(sdk.config.webSocketFactory ?? defaultWebSocketFactory);
  sdk.config.transportFactory = options => {
    const transport = factory(options);
    const send = transport.send.bind(transport);
    return {
      send(frame) { checkDeviceSignal(); send(frame); },
      close: transport.close.bind(transport), onOpen: transport.onOpen.bind(transport),
      onClose: transport.onClose.bind(transport), onError: transport.onError.bind(transport),
      onMessage: transport.onMessage.bind(transport),
    };
  };

  const send = sdk.sendSessionMessageOrThrow.bind(client);
  sdk.sendSessionMessageOrThrow = async message => {
    const signal = deviceSignal();
    checkDeviceSignal(signal);
    if (signal && client.getConnectionState().status === 'connecting') await connected(client, signal);
    return withDeviceSignal(signal, () => send(message));
  };

  const wait = sdk.waitForWithCancel.bind(client);
  sdk.waitForWithCancel = (...args) => {
    checkDeviceSignal();
    const waiter = wait(...args);
    const removeAbort = onDeviceAbort(waiter.cancel);
    void waiter.promise.then(removeAbort, removeAbort);
    return waiter;
  };

  // CreationClient can recover outside the original async stack. Bind its operation
  // to the same signal and fail it on revocation before reconnect can replay it.
  const scopes = new WeakMap<Creation, AbortSignal>();
  const creations = sdk.creations;
  const submit = creations.submit.bind(creations);
  creations.submit = operation => {
    const signal = scopes.get(operation) ?? deviceSignal();
    if (signal && !scopes.has(operation)) {
      scopes.set(operation, signal);
      const removeAbort = onDeviceAbort(error => creations.fail(operation, error), signal);
      void operation.result.then(removeAbort, removeAbort);
    }
    if (signal?.aborted) return Promise.resolve();
    return withDeviceSignal(signal, () => submit(operation));
  };
  const observe = creations.deps.observe.bind(creations.deps);
  creations.deps.observe = (kind, key, next, error) => {
    const operation = creations.operations.get(JSON.stringify([kind, key]));
    const signal = operation ? scopes.get(operation) : undefined;
    return withDeviceSignal(signal, () => observe(kind, key,
      snapshot => withDeviceSignal(signal, () => next(snapshot)), error));
  };
  guarded.add(client);
}
