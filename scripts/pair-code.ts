// Recovery: prints a pairing code from the running server, for when no paired
// desktop is at hand (a fresh install, a lost desktop, or pairing locked after
// too many wrong codes). Run it as root on the server's machine:
//   sudo npx tsx scripts/pair-code.ts [--phone | --desktop] [--config /etc/wayroost/config.json]
// or, installed by deploy/install-wayroost-server.sh: sudo wayroost pair (a phone) or
// sudo wayroost pair-desktop, which run dist/server/pair-code.js with the installed config.
//
// It asks the server over its recovery socket, <stateDir>/pairing/pair.sock,
// which only root and the service user can open (see server/src/pairing-socket.ts).
// The code is single use and lasts 10 minutes; it also lifts a pairing lock.
import { readFileSync } from 'node:fs';
import { spkiFingerprint } from '../lib/loopback-tls.js';
import { configPath, loadConfig } from '../server/src/config.js';
import { wayroostEnv } from '../server/src/environment.js';
import { pairingSocketPath, requestRecoveryCode } from '../server/src/pairing-socket.js';
import type { DeviceKind } from '../shared/protocol.js';

const USAGE = 'Usage: pair-code [--phone | --desktop] [--config <path>]';

function parseArgs(argv: string[]): { kind: DeviceKind; config: string } {
  let kind: DeviceKind = 'desktop';
  let config = configPath();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--phone') kind = 'phone';
    else if (arg === '--desktop') kind = 'desktop';
    else if (arg === '--config' && argv[i + 1]) config = argv[(i += 1)]!;
    else throw new Error(USAGE);
  }
  return { kind, config };
}

try {
  const { kind, config: configPath } = parseArgs(process.argv.slice(2));
  // It only talks to the server's recovery socket, never the supervisor, so it doesn't need that key.
  const config = loadConfig(configPath, { allowLocalDev: wayroostEnv('DEV_ALLOW_LOOPBACK') === '1', withoutSupervisor: true });
  if (!config.devices.enabled) throw new Error('Device sign-in is turned off in the config, so there is nothing to pair.');
  let pins: { server: string; rescue: string } | undefined;
  if (kind === 'desktop' && config.tls) {
    const server = spkiFingerprint(readFileSync(config.tls.certFile));
    let rescue: string;
    try { rescue = spkiFingerprint(readFileSync('/etc/wayroost/supervisor-tls-cert.pem')); }
    catch { throw new Error('Cannot read the supervisor TLS certificate; re-run install-supervisor.sh to create its TLS certificate.'); }
    pins = { server, rescue };
  }
  const socket = pairingSocketPath(config.stateDir);
  let made;
  try {
    made = await requestRecoveryCode(socket, kind);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new Error('Run this as root (sudo): only root and the server can ask for a code.');
    if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new Error(`The server isn't running (no socket at ${socket}). Start it, then try again.`);
    throw err;
  }
  const minutes = Math.round((made.expiresAt - Date.now()) / 60_000);
  console.log(`Pairing code for a ${made.kind} (single use, ${minutes} minutes):\n\n  ${made.code}\n`);
  if (made.urls.length) {
    console.log('Open one of these on the device you are pairing:');
    for (const url of made.urls) console.log(`  ${url}`);
    console.log('');
  }
  if (pins) {
    console.log(`Server fingerprint: ${pins.server}\nSupervisor rescue fingerprint: ${pins.rescue}`);
    if (kind === 'desktop') console.log(`\nDesktop pairing token (paste into the recovery form):\n${JSON.stringify({ code: made.code, serverPin: pins.server, rescuePin: pins.rescue })}\n`);
  }
  if (kind === 'desktop') console.log(pins ? 'Paste the whole token line into the Wayroost desktop recovery form (the bare code only works on an already-paired desktop’s pairing page).' : 'For the development desktop app, type the code into the app.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
