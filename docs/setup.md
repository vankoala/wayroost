# Setting up Signalbox

This guide takes you from nothing to Signalbox on your phone. Plan on about
30 minutes. Every step is safe to repeat.

- [What you need](#what-you-need)
- [1. Get the code](#1-get-the-code)
- [2. Create the Cloudflare Access application](#2-create-the-cloudflare-access-application)
- [3. Write the config](#3-write-the-config)
- [4. Install the app](#4-install-the-app)
- [5. Create the tunnel](#5-create-the-tunnel)
- [6. Open it on your phone](#6-open-it-on-your-phone)
- [7. Let agents work together (optional)](#7-let-agents-work-together-optional)
- [Check that it's locked down](#check-that-its-locked-down)
- [Updating](#updating) · [Uninstalling](#uninstalling)
- [Running on WSL2](#running-on-wsl2)
- [Troubleshooting](#troubleshooting)

## What you need

| Requirement | Notes |
| --- | --- |
| A Linux machine with systemd | Tested on Ubuntu 22.04, including WSL2 with `systemd=true`. This is the machine your agents run on. |
| Node.js 22 or newer, installed system-wide | `node --version`. The installer refuses a `node` or `npm` that anyone but root could modify, such as one from nvm in your home directory. |
| Hermes Agent and/or Paseo | Either or both. Hermes needs its dashboard running (default `:9119`) with password sign-in. Paseo needs its daemon (default `:6777`). |
| A Cloudflare account and a domain on Cloudflare | The free plan works. Cloudflare Access (Zero Trust) is free for up to 50 users. |
| `cloudflared`, `git`, `rsync`, `curl`, `python3` | `cloudflared` comes from [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). |

Tested versions: Hermes Agent 0.21 (dashboard API), Paseo 0.5.1 and 0.9.2.

## 1. Get the code

The installer runs this code as root, so it must live somewhere only root can
change. The installer refuses a directory that anyone but root could modify,
including through a parent directory, so an agent running as your user can't
swap the code. That rules out your home directory, and also Debian's
`/usr/local/src`, which is often `root:staff` with mode 2775. A directory under
`/opt` works:

```bash
sudo git clone https://github.com/vankoala/signalbox /opt/src/signalbox
```

## 2. Create the Cloudflare Access application

Access is the front door: Cloudflare blocks everyone except you before a single
request reaches your machine. Create it **before** the tunnel exists, so the
hostname is protected from the first moment it resolves.

1. Open the Cloudflare dashboard and go to **Zero Trust → Access → Applications
   → Add an application → Self-hosted**. If this is your first time in Zero
   Trust, you'll pick a team name and the free plan.
2. **Application name:** `Signalbox`. **Session duration:** `24 hours`.
3. **Public hostname:** pick a subdomain on your domain, for example
   `signalbox.example.com`. Leave the path empty.
4. **Policy:** create a new policy named `Only me`, **Action: Allow**, and add an
   include rule **Emails** → your email address. Attach it to the application.
5. **Login methods:** the default *One-time PIN* works: Cloudflare emails you a
   code. You can add Google or GitHub sign-in instead.
6. **Cookie settings** (under advanced settings, if shown): *HTTP Only* on,
   *SameSite* `Lax`.
7. Save.

You don't need to copy anything from the dashboard: step 5 reads the team name
and the application's AUD tag from Cloudflare's login redirect.

## 3. Write the config

```bash
sudo install -d -m 755 /etc/signalbox
sudo cp -n /opt/src/signalbox/deploy/config.example.json /etc/signalbox/config.json
sudoedit /etc/signalbox/config.json
```

`cp -n` never overwrites a config you already have, so this is safe to repeat.
Set these fields:

- `access.allowedEmails`: the same email as in the Access policy. This is a
  second check inside Signalbox.
- `hermes.enabled` / `paseo.enabled`: turn off whichever you don't run.

Leave `publicOrigin`, `access.teamDomain` and `access.aud` as they are; step 5
fills them in. Every field is described in [configuration.md](configuration.md).

## 4. Install the app

```bash
sudo /opt/src/signalbox/deploy/install.sh
```

The installer:

1. checks that only root can modify the code, every directory above it, and the
   `node` and `npm` it's about to run;
2. installs build dependencies with npm install scripts disabled, runs the test
   suite, builds, and copies the result to `/opt/signalbox`;
3. installs and enables `signalbox.service`, a systemd service that runs as a
   throwaway system user with no access to `/home`.

While the config is missing or still has its `YOUR-` placeholders, the service
isn't started, and the installer tells you what's next:

```
Next: sudo deploy/setup-tunnel.sh <hostname> — it fills in the Access values and starts Signalbox.
```

The app listens on `127.0.0.1:8790` only. Until the tunnel exists, nothing
outside your machine can reach it.

## 5. Create the tunnel

Sign `cloudflared` in to your Cloudflare account once, as root. `-H` makes sure
the certificate lands in root's home, where the setup script looks for it, even
if your `sudo` keeps your own home:

```bash
sudo -H cloudflared tunnel login
```

Then let the setup script do the rest. Pass the bare hostname, without
`https://` or a path (it's lowercased for you):

```bash
sudo /opt/src/signalbox/deploy/setup-tunnel.sh signalbox.example.com
```

It:

1. checks that only root can change the code and `cloudflared`, that
   `cloudflared tunnel login` has been run, that the config exists and
   Signalbox is installed, and that the hostname and tunnel name are valid;
2. creates a dedicated tunnel named `signalbox`, or reuses the live tunnel with
   that name. Your other tunnels are untouched. Set `TUNNEL_NAME` for another
   name. If the tunnel was deleted and recreated, its new credential replaces
   the stored one;
3. points your hostname at it with a DNS record, overwriting any existing record
   for that hostname;
4. reads your Access team name and the application's AUD tag from Cloudflare's
   login redirect, and writes them, with `publicOrigin`, into
   `/etc/signalbox/config.json`;
5. writes `/etc/signalbox/cloudflared.yml`, pointing at the port in
   `listen.port`. Only Signalbox is routed, over HTTP/2, and cloudflared itself
   also requires a valid Access token;
6. installs `signalbox-tunnel.service`, then restarts both services.

If the script says the hostname isn't behind Access yet, finish step 2 and run
it again.

## 6. Open it on your phone

1. Open `https://signalbox.example.com`, enter your email, and type the code
   Cloudflare sends you.
2. If you run Hermes, open **Settings (⚙) → Hermes sign-in** and enter your
   Hermes dashboard username and password. Signalbox checks them with Hermes and
   keeps them only on your machine.
3. Add Signalbox to your home screen:
   - iPhone (Safari): **Share → Add to Home Screen**.
   - Android (Chrome): **⋮ → Add to Home screen** (or **Install app**).

## 7. Let agents work together (optional)

The [project bridge](bridge.md) lets the agents in one project list, read,
message and start each other's chats, and wait for each other's answers, across
Hermes and Paseo. Approvals stay with you. It's off by default, and it listens
on `127.0.0.1` only.

1. Add `"bridge": { "enabled": true }` to `/etc/signalbox/config.json`, then
   restart Signalbox. It creates the bridge token on this start:

   ```bash
   sudoedit /etc/signalbox/config.json
   sudo systemctl restart signalbox
   ```

2. Register the bridge with the agents of the user they run as (here `you`).
   Look at the planned changes first:

   ```bash
   sudo /opt/src/signalbox/deploy/setup-bridge.sh you --dry-run
   sudo /opt/src/signalbox/deploy/setup-bridge.sh you
   ```

   For Hermes, the script also installs and enables the `signalbox-identity`
   plugin, which tells the bridge which Hermes chat is calling.
   `--no-hermes-plugin` leaves it out.

3. Reload the agents: restart the Hermes dashboard and the gateway
   (`hermes gateway restart`), so both load the plugin (without it,
   `/reload-mcp` in a Hermes chat is enough), and start new sessions of Claude
   Code, OpenCode and pi. New Paseo agents get the tools; restart running ones.

**Settings → Project bridge** shows what agents did in the last hour, and
**Pause** stops the bridge at once. To undo step 2, run the script again with
`--remove`.

## Check that it's locked down

From any machine:

```bash
curl -sI https://signalbox.example.com | grep -i location
# location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/... ← Cloudflare's login
```

On the host:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/api/me   # 401: needs an Access token
curl -s http://127.0.0.1:8791/ready                                      # {"status":200,"readyConnections":4,...}
systemctl status signalbox signalbox-tunnel
journalctl -u signalbox -f
```

## Updating

```bash
cd /opt/src/signalbox
sudo git pull
sudo deploy/install.sh
```

`install.sh` rebuilds Signalbox and restarts it. If the pull changed anything in
`deploy/`, also re-run `setup-tunnel.sh`, which refreshes the tunnel's unit and
config from the templates:

```bash
sudo git diff --stat HEAD@{1} HEAD -- deploy/    # what the pull changed in deploy/
sudo deploy/setup-tunnel.sh signalbox.example.com
```

If you use the project bridge, run `setup-bridge.sh` again after `install.sh`,
never before: it updates the Hermes plugin, which needs the new agents' side
that `install.sh` installs. Then restart the Hermes dashboard and the gateway,
so each loads the plugin and starts the new agents' side:

```bash
sudo deploy/setup-bridge.sh you
hermes gateway restart    # as you; restart the Hermes dashboard too
```

In the other order, Hermes' calls to the bridge fail with HTTP 400 until the
new agents' side is installed and Hermes restarts (see
[bridge.md](bridge.md#upgrading)).

## Uninstalling

If you set up the project bridge, first remove it from your agents with
`sudo /opt/src/signalbox/deploy/setup-bridge.sh you --remove`. Then:

```bash
sudo systemctl disable --now signalbox-tunnel signalbox
sudo rm /etc/systemd/system/signalbox.service /etc/systemd/system/signalbox-tunnel.service
sudo systemctl daemon-reload
sudo -H cloudflared tunnel list                   # note the id of the signalbox tunnel
sudo -H cloudflared tunnel delete signalbox       # or your TUNNEL_NAME
sudo rm -f /root/.cloudflared/<tunnel-id>.json
sudo rm -rf /opt/signalbox /etc/signalbox /var/lib/private/signalbox /var/lib/signalbox
```

If you no longer use cloudflared for anything else, also remove its account
certificate, `sudo rm /root/.cloudflared/cert.pem`. Then remove the DNS record
and the Access application in the Cloudflare dashboard, and the source,
`/opt/src/signalbox`, if you like.

## Running on WSL2

Signalbox runs well on WSL2 with a few adjustments:

- **Enable systemd:** `/etc/wsl.conf` needs `[boot]` `systemd=true`, then
  `wsl --shutdown` from Windows.
- **Keep WSL running:** WSL stops a distro soon after its last Windows-side
  process exits, and systemd services don't count. To have Signalbox, and
  anything else you run as systemd services, come back after a reboot, start
  WSL at sign-in with a hidden script in your Windows Startup folder
  (`shell:startup`), for example `Start WSL.vbs`:

  ```vb
  Set shell = CreateObject("WScript.Shell")
  shell.Run "wsl.exe -d Ubuntu-22.04 --exec /bin/sleep infinity", 0, False
  ```

- **Tunnel protocol:** QUIC (UDP) connections to Cloudflare keep dropping
  through WSL's NAT, which makes pages very slow. The tunnel template therefore
  uses `protocol: http2`.
- **First request after boot:** the first DNS lookup from WSL can take several
  seconds. Signalbox fetches Cloudflare's signing keys at startup and every 30
  minutes, so a sign-in never waits on it.

## Troubleshooting

Signalbox logs every refused request with a reason:

```bash
journalctl -u signalbox | grep 'request denied'
```

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Refusing to use …: … must be owned by root and not writable by others." | The code, or a directory above it, can be modified by someone other than root | Clone into a root-only directory such as `/opt/src/signalbox`. |
| "Refusing to run …: … must be owned by root and not writable by others." | `node`, `npm` or `cloudflared`, or a directory or symlink on the way to it, can be modified by someone other than root | Install it system-wide, for example from your distribution's packages. |
| `setup-tunnel.sh` says "Run `cloudflared tunnel login` first (as root)." | cloudflared isn't signed in to your Cloudflare account as root, or the login went to your own home | Run `sudo -H cloudflared tunnel login`, then the script again. |
| `setup-tunnel.sh` says "Invalid hostname" | You passed a URL or a path | Pass just the hostname, like `signalbox.example.com`. |
| `setup-tunnel.sh` says the config doesn't exist, or "Signalbox isn't installed yet." | Steps 3 or 4 were skipped | Write the config (step 3) and run `install.sh` (step 4) first. |
| `setup-tunnel.sh` says "Tunnel credentials not found at …" | The tunnel was created elsewhere, for example on another machine | Fetch them with the `cloudflared tunnel token --cred-file …` command the script prints, then run it again. |
| Cloudflare shows *Access denied* | Your email isn't in the Access policy | Edit the policy in Zero Trust. |
| Signalbox says "Your secure session ended" in a loop | `access.allowedEmails` doesn't match the email you signed in with | Fix the config and `sudo systemctl restart signalbox`. The log reason is `identity not allowed`. |
| Log reason `missing access token` | The request didn't come through Access, for example the tunnel points at the wrong service | Re-run `setup-tunnel.sh`. |
| Log reason `invalid access token (ERR_JWT_CLAIM_VALIDATION_FAILED)` | Wrong `aud` or `teamDomain` | Re-run `setup-tunnel.sh`, which re-reads both. |
| Log reason `invalid access token (ERR_JWKS_TIMEOUT)` | The host couldn't reach `<team>.cloudflareaccess.com` | Check DNS and outbound HTTPS from the host. |
| `systemctl status signalbox` shows `start-limit-hit` | Signalbox failed to start 5 times within 60 s, so systemd stopped retrying. Usually the config is invalid. | Read the reason with `journalctl -u signalbox` and fix it. Re-running `install.sh` or `setup-tunnel.sh` clears the limit; by hand, run `sudo systemctl reset-failed signalbox` and `sudo systemctl restart signalbox`. |
| Pages are very slow and the tunnel log shows QUIC errors | UDP issues, common on WSL2 and some NATs | Make sure `/etc/signalbox/cloudflared.yml` has `protocol: http2`. |
| `cloudflared tunnel route dns` attached the hostname to a different tunnel | cloudflared prefers the tunnel in `~/.cloudflared/config.yml` | Use `setup-tunnel.sh`, which passes an explicit config and `--overwrite-dns`. |
| The inbox shows **Connect Hermes** | No saved Hermes sign-in | Sign in under **Settings → Hermes sign-in**. |
| Settings → Connections says "Hermes rejected the saved sign-in. Sign in again in Settings." | The dashboard password changed | Sign in again under Settings. |
| Settings → Connections says "Reconnecting to Paseo…" or "Connecting…" for Paseo | The Paseo daemon isn't running, or it uses another port | Start the daemon, or set `paseo.url`. |
| No home-screen icon after adding to the home screen | The browser fetched the icons without the Access cookie | Remove and re-add the shortcut while signed in. |
| An agent says "The Signalbox bridge isn't set up on this machine" | Its user has no copy of the bridge token | Run `setup-bridge.sh` for that user (step 7). |
| An agent says "Signalbox isn't answering at http://127.0.0.1:8792" | Signalbox is stopped, or the bridge is off in the config | Turn it on (step 7) and restart Signalbox. If it still fails, look for "the project bridge could not start" in `journalctl -u signalbox`. |
| `setup-bridge.sh` says "Signalbox hasn't created the bridge token yet" | Signalbox hasn't restarted since the bridge was turned on | `sudo systemctl restart signalbox`, then run it again. |
| An agent under Hermes says `Invalid arguments. arguments: Unrecognized key: "_signalbox_caller"` | Hermes loaded the `signalbox-identity` plugin while it still ran an older bridge | Run `install.sh`, then restart the Hermes dashboard and gateway (see [Updating](#updating)). |
