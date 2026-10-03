import { AsyncLocalStorage } from 'node:async_hooks';
import { UserFacingError } from '../sources.js';

// The request's device signal follows nested backend work, including retries and queued
// callbacks. Background work started outside a request has no device authorization.
const requests = new AsyncLocalStorage<AbortSignal | undefined>();

export const deviceSignal = (): AbortSignal | undefined => requests.getStore();

export function checkDeviceSignal(signal = deviceSignal()): void {
  if (signal?.aborted) throw new UserFacingError('Pair this device before controlling the PC.', 403);
}

export function withDeviceSignal<T>(signal: AbortSignal | undefined, action: () => T): T {
  return requests.run(signal, () => { checkDeviceSignal(signal); return action(); });
}

/** Cancellation also keeps its owner's context, so cleanup cannot send revoked work. */
export function onDeviceAbort(cancel: (error: UserFacingError) => void, signal = deviceSignal()): () => void {
  if (!signal) return () => {};
  const abort = () => requests.run(signal, () => cancel(new UserFacingError('Pair this device before controlling the PC.', 403)));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}

/** Preserve transport cancellation/deadlines while also cancelling on device revocation. */
export function actionSignal(transport?: AbortSignal, signal = deviceSignal()): AbortSignal | undefined {
  return transport && signal ? AbortSignal.any([transport, signal]) : transport ?? signal;
}

/** Retire an SDK waiter on revocation even when the SDK cannot cancel its pending reply. */
export function abortOnDevice<T>(pending: Promise<T>, signal = deviceSignal()): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const cancel = () => { cleanup(); reject(new UserFacingError('Pair this device before controlling the PC.', 403)); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    pending.then(value => { cleanup(); resolve(value); }, err => { cleanup(); reject(err); });
  });
}

/** SDK calls retain their device authorization when a client is held across an await. */
export function deviceClient<T extends object>(client: T, signal = deviceSignal()): T {
  return new Proxy(client, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const current = signal ?? deviceSignal();
        checkDeviceSignal(current);
        const result: unknown = withDeviceSignal(current, () => Reflect.apply(value, target, args));
        return result instanceof Promise ? abortOnDevice(result, current) : result;
      };
    },
  });
}
