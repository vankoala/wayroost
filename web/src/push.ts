import { api } from './api';

// Phone notifications for this browser: the service worker (public/sw.js) plus a
// Web Push subscription Signalbox keeps. iPhones only allow it for Signalbox
// installed on the Home Screen, and the permission prompt must come from a tap.

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const supported = () =>
  window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/** A name for this device in Settings ("iPhone", "Chrome on Windows"). */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : 'Safari';
  return os === 'iPhone' || os === 'iPad' ? os : `${browser} on ${os}`;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** Ask for permission and subscribe this browser. Call it straight from a tap. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'needs-install' : 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  const key = keyBytes((await api.pushKey()).publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // One made with another key (a reinstall) can't be used: start over.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.pushAddDevice({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api.pushRemoveDevice(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
  return 'off';
}
