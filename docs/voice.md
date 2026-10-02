# Voice mode

Talk to your agents and hear their replies, on a phone or a desktop. Speech is
turned into text and back on your own PC: nothing is sent anywhere else, and
nothing is kept. It's off until you set it up (below).

## Using it

- **Talk.** In any chat, hold the mic button next to the message box, talk, and
  let go. For a longer message, tap the mic once, talk, and tap the square to
  finish. While holding, slide your finger away from the button to cancel.
- **Check, then send.** What you said appears in the message box, so you can fix
  a word before sending. Settings → Voice → **Send what you say right away**
  skips that step.
- **Hear the reply.** After you send a spoken message, the agent's reply is read
  aloud sentence by sentence as it streams in (Settings → Voice → **Read replies
  aloud**). The strip above the message box shows what's happening and has a
  Stop button; pressing the mic also stops the reading.
- **Listen to any reply.** Every finished reply has a **Listen** button.
- **What gets read.** Code blocks, tables and images are skipped, links are read
  as their text (or "a link"), and long file paths as their last part. A long
  reply stops after about 4,000 characters with "There's more on screen."
- **Voice and speed.** Settings → Voice offers the 28 English Kokoro voices and
  four speeds, plus **Try it**. These choices are kept on each device.

Phones: iPhone and Android work in the browser and in the installed app while
it's open and the screen is on. Audio stops when the phone locks; background
listening would need a native app.

## How it works

1. The browser records 16 kHz mono 16-bit PCM in an AudioWorklet
   (`web/public/voice-worklet.js`, which filters and resamples the microphone)
   and streams 0.1-second frames over the live WebSocket. Each frame starts with
   the recording's number (1–255); a frame holding only the number ends it.
2. Signalbox collects one recording per browser (`VoiceSession` in
   `server/src/speech.ts`), at most 2 minutes, and passes it to the speech
   service. The text goes back to that browser only, as `voice` events.
3. Replies are read aloud by `POST /api/voice/speak` (text in, WAV out). The
   browser cuts the streaming reply into sentences
   (`web/src/voice/text.ts`, with rules from an earlier, tested
   splitter) and asks for each one, two ahead of what's playing
   (`web/src/voice/reader.ts`). Only replies after your latest message count,
   so a reload that renames every message doesn't make it start over.
4. The speech service (`speech/signalbox-speech.py`) runs NVIDIA Parakeet TDT
   0.6B v2 (int8, English) for speech-to-text and Kokoro-82M for
   text-to-speech, through sherpa-onnx, on the CPU, 4 threads each.

Measured on a 12-core desktop CPU with the service's own sandbox: writing down a
5-second message takes 0.1–0.2 s. Reading aloud runs about six times faster than
real time: a short sentence is ready in about 0.16 s, a 5-second one in about
0.9 s. The models take about 3 s to load and 1.2 GB of memory. No GPU is used.

## Setting it up

Run as root after `install.sh`:

```bash
sudo deploy/setup-speech.sh
```

That downloads the models (about 1 GB). If you already have them, point it at
your copies instead; they get exactly the same checks:

```bash
sudo deploy/setup-speech.sh --stt-dir /path/to/parakeet-tdt-0.6b-v2-int8 --kokoro-archive /path/to/kokoro-multi-lang-v1_0.tar.bz2
```

It's safe to re-run. It:

- makes the system group `signalbox-voice`, the only group that may open the
  speech socket;
- checks that only root can change `/opt/signalbox-speech` (and every folder
  above it), then builds a fresh root-owned venv there from
  `speech/requirements.txt` (pinned by hash, wheels only);
- puts the models in `/opt/signalbox-speech/models`, checking every file against
  the SHA-256 the publishers give (Hugging Face for Parakeet, the sherpa-onnx
  release for Kokoro) before installing it;
- makes `/opt/signalbox-speech/root`, the empty folder the service sees as its
  whole system, and installs `signalbox-speech.socket` and
  `signalbox-speech.service`, and a Signalbox drop-in
  (`signalbox.service.d/20-speech.conf`) that adds it to the group;
- sets `"speech": {"enabled": true}` in `/etc/signalbox/config.json` (backed up
  first), starts the service and restarts Signalbox.

Reload the page and the mic appears in every chat. To turn voice mode off:
`sudo deploy/setup-speech.sh --remove` (the venv and models stay in
`/opt/signalbox-speech` until you delete them).

`install.sh` installs the service's program with the rest of Signalbox, brings
its units up to date, and restarts the service only when the program or a unit
changed.

## Privacy and security

- **Nothing leaves your PC.** Audio and text only travel between your browser,
  Signalbox and the speech service, through your Cloudflare tunnel.
- **Nothing is kept or logged on your PC:** no audio, no transcripts, no text
  read aloud. A transcript you haven't sent yet sits in the message box's saved
  draft on your device, like anything you type, until you send or clear it.
- **The microphone is asked for only when voice mode is on.** Signalbox's
  `Permissions-Policy` says `microphone=()` until then, and `microphone=(self)`
  after, so only Signalbox's own page can ask, and the browser asks you first.
- **The speech service is boxed in.** It has no network at all
  (`PrivateNetwork=yes`) and runs as a throwaway system user. Its whole view of
  the system is an empty folder (`RootDirectory=/opt/signalbox-speech/root`)
  with only the system's programs and libraries, its own program and its
  models mounted in, read-only: no `/etc` (apart from the loader's cache),
  `/home`, `/root`, `/var`, `/run`,
  `/usr/local` or Windows drives. It listens only on
  `/run/signalbox-speech.sock`, which systemd creates (so nothing else can pose
  as the service), hands it already open, and lets only root and Signalbox
  open. Requests carry audio or text, never a file path.
- **Nobody but root can change what writes down your words:** its program, its
  Python packages (pinned by hash) and its models (checked by SHA-256) are all
  owned by root. An agent running as your user can't edit them.
- **Speaking is the same as typing.** What you say becomes a message, exactly as
  if you'd typed it; there's no voice shortcut for approvals or settings.

## Limits

- English only: the Parakeet v2 model and the voices are English.
- 2 minutes per recording; one recording at a time per browser, and at most
  two waiting to be written down.
- At most 4 sentences are read aloud at once across all open pages.
- If the live connection drops while you're talking, the recording is lost (the
  page says so).

## Troubleshooting

- **No mic button.** Voice mode is off, the speech service isn't answering
  (Settings → Voice says so), or the browser can't record here: it needs HTTPS
  and a current browser.
- **"The microphone is blocked."** Allow the microphone for the site in the
  browser's settings, then try again.
- **After a system Python upgrade.** The service's venv is built on the
  system's `/usr/bin/python3.12` itself; if an upgrade replaces that, the
  service stops starting until you re-run `sudo deploy/setup-speech.sh`.
- **The service.** `systemctl status signalbox-speech` and, as root,
  `curl -s --unix-socket /run/signalbox-speech.sock http://localhost/health`.
  At start it logs "Error in cpuinfo" because its sandbox hides
  `/proc/cpuinfo`; that's harmless.
