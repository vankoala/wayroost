import { KeyRound, LoaderCircle, Smartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { codeFromHash, guessDeviceName, normalizeCode } from '../pairing';
import { Logo } from './common';
import '../devices.css';

// Pairing this browser. A pairing link (from a paired desktop's QR code, or
// `sudo wayroost pair` on the PC) carries the code in the URL fragment, which
// browsers never send to a server; the page takes it out of the address bar as
// soon as it has drawn and posts it only when you tap Pair. Opened without a
// code (or shown because this browser isn't paired), it asks for one. A link
// opened while the page is up (a fresh code after one expired, say) arrives as
// a fragment change and replaces the code in use.

/** Takes the fragment out of the address bar, so a code isn't left on screen or in history. */
function scrubFragment(): void {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

export function PairPage() {
  // Read without side effects (React may run this twice); the effect below scrubs it.
  const [linkCode, setLinkCode] = useState(() => codeFromHash(location.hash));
  const [typed, setTyped] = useState('');
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = linkCode ?? normalizeCode(typed);

  useEffect(() => {
    document.title = 'Pair this device';
  }, []);

  useEffect(() => {
    scrubFragment();
    const onHashChange = () => {
      const next = codeFromHash(location.hash);
      scrubFragment();
      if (!next) return;
      setLinkCode(next);
      setError(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.pair(code, name.trim());
      // Signed in: start the app afresh with the new device cookie.
      location.replace('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="pair-page">
      <form className="pair-card" onSubmit={submit}>
        <Logo size={44} />
        <h1>Pair this device</h1>
        {linkCode ? (
          <p className="muted">
            You opened a pairing link. Name this device, then tap Pair. It stays signed in to Wayroost until you revoke it in
            Settings → Devices.
          </p>
        ) : (
          <>
            <p className="muted">
              This browser isn't signed in to Wayroost yet. On a paired desktop, open Settings → Devices and choose{' '}
              <strong>Pair a phone</strong>, then scan the code. On the PC itself, run <code>sudo wayroost pair</code>.
            </p>
            <label className="field">
              <span>Pairing code</span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="abcd-efgh-…"
                autoComplete="one-time-code"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
              />
            </label>
          </>
        )}
        <label className="field">
          <span>Device name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" />
          <small>Shown in your list of devices, so you can tell them apart.</small>
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !code || !name.trim()}>
          {busy ? <LoaderCircle size={18} className="spin" /> : linkCode ? <Smartphone size={18} /> : <KeyRound size={18} />}
          Pair
        </button>
      </form>
    </main>
  );
}
