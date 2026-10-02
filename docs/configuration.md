# Configuration

Signalbox reads one JSON file, `/etc/signalbox/config.json` (or the path in
`SIGNALBOX_CONFIG`). It is validated strictly at startup: unknown keys at any
level, unsafe values and missing fields stop the service with a clear message
instead of starting in a weaker state.

This is `deploy/config.example.json`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8790 },
  "publicOrigin": "https://signalbox.example.com",
  "access": {
    "teamDomain": "https://YOUR-TEAM.cloudflareaccess.com",
    "aud": "YOUR-ACCESS-APPLICATION-AUD-TAG",
    "allowedEmails": ["you@example.com"]
  },
  "hermes": { "enabled": true, "url": "http://127.0.0.1:9119" },
  "paseo": { "enabled": true, "url": "ws://127.0.0.1:6777" },
  "stateDir": "/var/lib/signalbox"
}
```

You set `access.allowedEmails` and turn off whichever of Hermes and Paseo you
don't run. `deploy/setup-tunnel.sh` fills in `publicOrigin`,
`access.teamDomain` and `access.aud` for you. Until the `YOUR-` placeholders
are gone, the installer doesn't start the service.

## Fields

| Field | Default | Rules | Meaning |
| --- | --- | --- | --- |
| `listen.host` | `127.0.0.1` | loopback: `127.0.0.1`, `localhost` or `::1` | Only cloudflared (same machine) should reach the app. |
| `listen.port` | `8790` | 1–65535 | Local port for the app. `setup-tunnel.sh` points the tunnel at it. |
| `publicOrigin` | required | `https://` origin, no path | The address you open on your phone. Used for the CSP, the Origin checks and the allowed `Host`. |
| `access.teamDomain` | required | `https://<team>.cloudflareaccess.com` | Your Zero Trust team. Signalbox fetches signing keys from `<teamDomain>/cdn-cgi/access/certs`. |
| `access.aud` | required | non-empty | The Access application's AUD tag. Tokens issued for any other application are rejected. |
| `access.allowedEmails` | required | at least one, plain ASCII | Who may use Signalbox, checked again after Cloudflare's own policy. |
| `access.jwksUrl` | `<teamDomain>/cdn-cgi/access/certs` | must live under the team domain | **For tests only.** Where to fetch the signing keys. |
| `hermes.enabled` | `true` | | Turn off if you don't run Hermes. |
| `hermes.url` | `http://127.0.0.1:9119` | `http://` or `https://` loopback | The Hermes dashboard. Only its origin is used; any path is dropped. |
| `hermes.secretPrompts` | `false` | `true` or `false` | Lets you answer all of Hermes' password prompts from the phone: sudo, a skill's secret, a vault master password, a 2FA code, and a login to save. When it's off, they only get a notice. What you type passes through Cloudflare; see [Password and secret prompts](hermes.md#password-and-secret-prompts). |
| `paseo.enabled` | `true` | at least one source enabled | Turn off if you don't run Paseo. |
| `paseo.url` | `ws://127.0.0.1:6777` | `ws://` or `wss://` loopback | The Paseo daemon (`/ws` is added if no path is given). |
| `bridge.enabled` | `false` | | Turns on the [project bridge](bridge.md): a listener on `127.0.0.1` that agents use to reach the other chats in their project. |
| `bridge.port` | `8792` | 1–65535, not `listen.port` and not 8791 | The bridge listener's port. It only ever binds to `127.0.0.1`. |
| `speech.enabled` | `false` | | Turns on [voice mode](voice.md). `deploy/setup-speech.sh` sets it after installing the speech service. |
| `speech.socket` | `/run/signalbox-speech.sock` | absolute path | The speech service's Unix socket. |
| `feed.enabled` | `false` | | Turns on [For you](for-you.md): cards from Hermes' brief and daytime checks (posted through the bridge, so turn that on too), the proactivity and quiet-hours settings, and phone notifications (these need an `https://` `publicOrigin`). |
| `stateDir` | required | absolute path | Private state: the saved Hermes sign-in, the Paseo client id, the bridge token, and For you's cards and phone subscriptions. The systemd unit uses `/var/lib/signalbox` (mode 700). |
| `staticDir` | next to the server bundle | absolute path | Built web assets. You won't normally set this. |

The example leaves the bridge out, so it stays off. To turn it on, add:

```json
"bridge": { "enabled": true }
```

Answering Hermes' password prompts from the phone is off too. To turn it on,
add `secretPrompts` to the `hermes` block, then restart Signalbox:

```json
"hermes": { "enabled": true, "url": "http://127.0.0.1:9119", "secretPrompts": true }
```

Read the [risks](../SECURITY.md#known-limits) first.

There is deliberately no option to turn off authentication.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `SIGNALBOX_CONFIG` | the server | Path to the config file. Default `/etc/signalbox/config.json`, which is also what the systemd unit sets. |
| `LOG_LEVEL` | the server | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal` or `silent`. Applies to all of Signalbox's logs. |
| `SIGNALBOX_DEV_ALLOW_LOOPBACK` | the server | `1` lets the config use a local Access issuer and a plain-http loopback origin. **For tests only**: with it set, anyone who can run a local key server could mint tokens. The systemd unit never sets it. |
| `TUNNEL_NAME` | `deploy/setup-tunnel.sh` | The dedicated tunnel to create or reuse: 1 to 64 letters, digits, dots, underscores or hyphens. Default `signalbox`. |
| `PORT` | `npm run demo` | The demo's address, `http://127.0.0.1:<PORT>`. Default `8795`. The demo server itself listens on the next port up, behind a local stand-in for Cloudflare. |
| `PASEO_LOG` | `npm run check:paseo` | Log level of the Paseo daemon the compatibility harness starts. Default `silent`. |
| `CHROME` | `npm run check:ui`, `scripts/e2e-local.ts`, `scripts/make-icons.mjs` | Path to Chrome. Default `/usr/bin/google-chrome`. |
| `SIGNALBOX_BRIDGE_URL` | `signalbox-bridge.mjs` | The bridge listener. Default `http://127.0.0.1:8792`; anything that isn't `http://` on this machine is refused. `setup-bridge.sh` sets it when `bridge.port` isn't the default. |
| `SIGNALBOX_BRIDGE_TOKEN_FILE` | `signalbox-bridge.mjs` | Where the agent's copy of the bridge token is. Default `~/.config/signalbox/bridge-token`. |
| `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` | `signalbox-bridge.mjs` | Set by Paseo for the agents it runs: which agent is calling, and its folder. |

## Files

| Path | Owner / mode | Contents |
| --- | --- | --- |
| `/opt/src/signalbox` | root; it and every parent directory writable by root only | Source. The installer refuses a directory that anyone but root could modify, including through a parent, so pick a root-only location. Debian's `/usr/local/src`, for example, is often `root:staff` with mode 2775, which is refused. |
| `/opt/signalbox` | root, read-only to the service | Installed build and runtime dependencies. |
| `/etc/signalbox/config.json` | root, 644 | The config above. It contains no secrets. |
| `/etc/signalbox/cloudflared.yml` | root, 644 | Tunnel config, generated from `deploy/cloudflared.yml.template`. |
| `/etc/signalbox/tunnel-credentials.json` | root, 600 | The tunnel's secret. systemd passes it to cloudflared with `LoadCredential`. |
| `/etc/systemd/system/signalbox.service`, `signalbox-tunnel.service` | root, 644 | The two services, installed from `deploy/`. |
| `/root/.cloudflared/cert.pem` | root | cloudflared's account certificate, from `cloudflared tunnel login`. The deploy scripts always use root's own home, even when `sudo` keeps yours. |
| `/root/.cloudflared/<tunnel-id>.json` | root | The tunnel credential as cloudflared created it. `setup-tunnel.sh` copies it to `/etc/signalbox/tunnel-credentials.json`. |
| `/var/lib/signalbox/` | service user, 700 | `hermes-credentials.json` (600), `paseo-client-id` (600), `bridge-token` (600) once the bridge has been on, and with For you on, `feed.json` (600: cards and settings) and `push.json` (600: the VAPID key and each device's push subscription). |
| `/opt/signalbox/bin/signalbox-bridge.mjs` | root, 755 | The bridge's agent side, a stdio MCP server, installed by `install.sh`. |
| `~/.config/signalbox/bridge-token` | your user, 600 (folder 700) | The agents' copy of the bridge token, written by `setup-bridge.sh`. |
| `/opt/signalbox-speech/` | root, read-only to the service | Voice mode: the speech service's venv and models, from `setup-speech.sh`. Its program is `/opt/signalbox/bin/signalbox-speech.py`. |
| `/run/signalbox-speech.sock` | root, group `signalbox-voice`, 660 | Voice mode: the speech service's socket, made by `signalbox-speech.socket`. |

## Ports

| Port | Bound to | What |
| --- | --- | --- |
| 8790 | 127.0.0.1 | Signalbox |
| 8791 | 127.0.0.1 | cloudflared metrics and readiness (`GET /ready`) |
| 8792 | 127.0.0.1 | The project bridge, when it's on, and For you's card routes (`/pulse/v1/…`). Never routed through the tunnel. |
| none | Unix socket | The speech service (voice mode) listens on `/run/signalbox-speech.sock` only, with no network at all. |
| 9119 | your Hermes setup | Hermes dashboard (Signalbox connects locally) |
| 6777 | your Paseo setup | Paseo daemon (Signalbox connects locally) |

Never route Hermes or Paseo ports through a tunnel. Only Signalbox should be
public, and only behind Access.
