import { Check, LoaderCircle, LockOpen, Monitor, Pencil, QrCode, Smartphone, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DeviceInfo, DeviceKind, DeviceList, PairOffer } from '../../../shared/protocol';
import { api } from '../api';
import { shortTime } from '../format';
import { countdown, groupCode, KIND_LABEL } from '../pairing';
import { qrPath, tryEncodeQr } from '../qr';
import { toast, useStore } from '../store';
import { ConfirmDialog, Page } from './common';
import '../devices.css';

// Settings → Devices & access (a page of the shell): every paired device, with rename and revoke,
// and "Pair a phone", which shows a one-time code as a QR drawn right here
// (src/qr.ts; nothing is sent to an outside service). A desktop manages every
// device; a phone sees the list and can rename or remove only itself.

/** While a code is on screen, look for the new device this often. */
const OFFER_POLL_MS = 3_000;

function QrImage({ text }: { text: string }) {
  const qr = useMemo(() => tryEncodeQr(text), [text]);
  if (!qr) {
    // A very long configured address can be past what the encoder holds:
    // the link and the code below still work.
    return (
      <div className="qr-fallback" role="note">
        <p className="muted">This address is too long for a QR code. Open this link on the phone, or type the code below.</p>
        <code>{text}</code>
      </div>
    );
  }
  const side = qr.size + 8;
  return (
    <svg className="qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
      <rect width={side} height={side} className="qr-light" />
      <path d={qrPath(qr)} className="qr-dark" />
    </svg>
  );
}

function OfferCard({ offer, onNew, onClose }: { offer: PairOffer; onNew: () => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = offer.expiresAt - now;
  const what = offer.kind === 'phone' ? 'phone' : 'computer';
  return (
    <div className="group offer-card" aria-live="polite">
      <div className="offer-head">
        <div className="grow">
          <div className="offer-title">Pair a {what}</div>
          <div className="muted">
            {offer.kind === 'phone'
              ? "Scan this with the phone's camera, then tap Pair on the page that opens."
              : 'Open the link on the computer, then click Pair.'}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the pairing code">
          <X size={20} />
        </button>
      </div>
      {left > 0 ? (
        <>
          <QrImage text={offer.url} />
          <div className="offer-code">
            <span className="muted">Or type this code</span>
            <code>{groupCode(offer.code)}</code>
          </div>
          <div className="muted offer-expiry">Works once, for {countdown(left)} more.</div>
        </>
      ) : (
        <div className="offer-expired">
          <p className="muted">This code has expired.</p>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <QrCode size={16} /> New code
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  current,
  canManage,
  onRenamed,
  onRevoke,
}: {
  device: DeviceInfo;
  current: boolean;
  canManage: boolean;
  onRenamed: (device: DeviceInfo) => void;
  onRevoke: (device: DeviceInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const Icon = device.kind === 'phone' ? Smartphone : Monitor;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      onRenamed(await api.renameDevice(device.id, name.trim()));
      setEditing(false);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kv device-row">
      <Icon size={20} />
      {editing ? (
        <form className="grow device-rename" onSubmit={save}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            aria-label="Device name"
            autoFocus
          />
          <button type="submit" className="icon-btn" aria-label="Save the name" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Cancel renaming"
            onClick={() => {
              setName(device.name);
              setEditing(false);
            }}
          >
            <X size={18} />
          </button>
        </form>
      ) : (
        <div className="grow">
          <div className="device-name">
            <span>{device.name}</span>
            {current && <span className="tag tag-current">This device</span>}
          </div>
          <div className="muted">
            {KIND_LABEL[device.kind]} · paired {shortTime(device.created)} · last used {current ? 'now' : shortTime(device.lastSeen)}
          </div>
        </div>
      )}
      {canManage && !editing && (
        <div className="device-actions">
          <button type="button" className="icon-btn" aria-label={`Rename ${device.name}`} onClick={() => setEditing(true)}>
            <Pencil size={17} />
          </button>
          <button type="button" className="icon-btn danger" aria-label={`Revoke ${device.name}`} onClick={() => onRevoke(device)}>
            <Trash2 size={17} />
          </button>
        </div>
      )}
    </div>
  );
}

export function DevicesPage() {
  const me = useStore((s) => s.device);
  const [list, setList] = useState<DeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairOffer | null>(null);
  const [offering, setOffering] = useState(false);
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = list?.currentId ?? me?.id ?? null;
  const desktop = (list?.devices.find((d) => d.id === currentId) ?? me)?.kind === 'desktop';

  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.devices();
      // A new device since the last look: it was just paired, most likely with the code on screen.
      const added = known.current ? next.devices.filter((d) => !known.current!.has(d.id)) : [];
      known.current = new Set(next.devices.map((d) => d.id));
      if (added.length) {
        toast(`Paired ${added.map((d) => d.name).join(', ')}`, 'info');
        setOffer(null);
      }
      setList(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    document.title = 'Devices';
    void load();
  }, [load]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => void load(), OFFER_POLL_MS);
    return () => clearInterval(timer);
  }, [offer, load]);

  const makeOffer = async (kind: DeviceKind) => {
    setOffering(true);
    try {
      setOffer(await api.pairOffer(kind));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setOffering(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    try {
      await api.unlockPairing();
      await load();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeDevice(revoking.id);
      if (revoking.id === currentId) {
        location.replace('/'); // this browser is signed out now
        return;
      }
      toast(`Revoked ${revoking.name}`, 'info');
      setRevoking(null);
      await load();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="page-devices devices-page" title="Devices & access">
      <p className="muted page-intro">
        Every phone and computer that can open Wayroost. Each one paired once with a single-use code, and stays signed in
        until you revoke it here.
      </p>

      {list?.pairingLocked && (
        <div className="group locked-card" role="status">
          <div className="kv">
            <TriangleAlert size={18} />
            <div className="grow">
              <div>Pairing is locked</div>
              <div className="muted">
                Too many wrong codes were tried. {desktop ? 'Unlock it when you are ready to pair again.' : 'Unlock it from a paired desktop.'}
              </div>
            </div>
            {desktop && (
              <button type="button" className="btn btn-secondary" onClick={unlock} disabled={busy}>
                <LockOpen size={16} /> Unlock
              </button>
            )}
          </div>
        </div>
      )}

      {desktop ? (
        offer ? (
          <OfferCard offer={offer} onNew={() => void makeOffer(offer.kind)} onClose={() => setOffer(null)} />
        ) : (
          <div className="pair-buttons">
            <button type="button" className="btn btn-primary" onClick={() => void makeOffer('phone')} disabled={offering || list?.pairingLocked}>
              {offering ? <LoaderCircle size={16} className="spin" /> : <QrCode size={16} />} Pair a phone
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void makeOffer('desktop')} disabled={offering || list?.pairingLocked}>
              <Monitor size={16} /> Pair a computer
            </button>
          </div>
        )
      ) : (
        list && <p className="muted page-intro">To pair another device, use Settings → Devices on a paired desktop.</p>
      )}

      <div className="group-title">Paired devices</div>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !list ? (
        <div className="group">
          <div className="kv muted">
            <LoaderCircle size={18} className="spin" /> Loading…
          </div>
        </div>
      ) : (
        <div className="group">
          {list.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              current={device.id === currentId}
              canManage={desktop || device.id === currentId}
              onRenamed={(renamed) =>
                setList((l) => l && { ...l, devices: l.devices.map((d) => (d.id === renamed.id ? renamed : d)) })
              }
              onRevoke={setRevoking}
            />
          ))}
        </div>
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          message={
            revoking.id === currentId
              ? 'This browser signs out at once. To use Wayroost here again, pair it with a new code.'
              : 'It signs out at once, including any page it has open. To use it again, pair it with a new code.'
          }
          confirmLabel="Revoke"
          danger
          busy={busy}
          onConfirm={() => void revoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </Page>
  );
}
