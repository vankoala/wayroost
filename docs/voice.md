# Voice mode

Talk to your agents and hear their replies, on a phone or a desktop. Speech is
turned into text on your own PC. Parakeet and Kokoro stay the default; optional
ElevenLabs app read-aloud sends the text being read to ElevenLabs. Voice mode
is off until you set it up (below).

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
- **Voice and speed.** A paired desktop chooses the shared local voice and the
  provider for app read-aloud in Settings → Voice. Phones can listen to samples
  and see these choices but cannot change them. Speed and microphone preferences
  stay on each device. Existing `voice.json` picks are retained when saved in the
  new version 2 format.
- **Other outputs.** Hermes voice notes, the phone line and the car line stay
  local. Saving the shared local voice also updates the phone and car lines
  through the existing helper; a failed update shows a message. Selecting
  ElevenLabs changes only app read-aloud. Hermes voice notes stay unchanged.

Phones: iPhone and Android work in the browser and in the installed app while
it's open and the screen is on. Audio stops when the phone locks; background
listening would need a native app.

## How it works

1. The browser records 16 kHz mono 16-bit PCM in an AudioWorklet
   (`web/public/voice-worklet.js`, which filters and resamples the microphone)
   and streams 0.1-second frames over the live WebSocket. Each frame starts with
   the recording's number (1–255); a frame holding only the number ends it.
2. Wayroost collects one recording per browser (`VoiceSession` in
   `server/src/speech.ts`), at most 2 minutes, and passes it to the speech
   service. The text goes back to that browser only, as `voice` events.
3. Replies are read aloud by `POST /api/voice/speak` (text in, WAV out for legacy
   callers; `stream: true` returns newline-delimited audio frames). The
   browser cuts the streaming reply into sentences
   (`web/src/voice/text.ts`, with rules from an earlier, tested
   splitter) and asks for each one, two ahead of what's playing
   (`web/src/voice/reader.ts`). Only replies after your latest message count,
   so a reload that renames every message doesn't make it start over.
4. The speech service (`speech/signalbox-speech.py`) runs NVIDIA Parakeet TDT
   0.6B v2 (int8, English) for speech-to-text and Kokoro-82M for
   text-to-speech, through sherpa-onnx, on the CPU, 4 threads each.
5. With ElevenLabs selected for app read-aloud, the server asks a separate
   process on `/run/wayroost-voice-cloud/voice.sock`. That process requests the
   selected account voice and model from the ElevenLabs streaming endpoint.
   PCM at 24 kHz reaches the browser in frames and plays in small queued clips.
   Cloud PCM playback and buffered WAV responses use the device's selected
   speed, including 1.3×; local WAVs already have that speed applied during
   synthesis. The reader starts
   the next request eagerly and queues about 1.5 seconds of streaming audio.
   The process also supports `mp3_44100_128` for Unix-socket clients. Voice samples
   use synthesis through this same route; preview URLs are never fetched by
   the browser, server or process.
6. Any cloud failure replays the same text using the saved local voice and speed.
   A streaming response identifies the provider and voice in `start`/`end` frames;
   `reset` discards only that piece's partial cloud playback before the complete
   local rendering, preserving previous pieces. One fallback notice is shown per reply.
   Buffered responses identify them with `x-wayroost-voice-provider`,
   `x-wayroost-voice` and `x-wayroost-voice-fallback` headers. If local speech is
   also down, the page reports that it cannot read aloud.

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
  `signalbox-speech.service`, and a Wayroost drop-in
  (`signalbox.service.d/20-speech.conf`) that adds it to the group;
- sets `"speech": {"enabled": true}` in `/etc/signalbox/config.json` (backed up
  first), starts the service and restarts Wayroost.

Reload the page and the mic appears in every chat. To turn voice mode off:
`sudo deploy/setup-speech.sh --remove` (the venv and models stay in
`/opt/signalbox-speech` until you delete them).

`install.sh` installs the service's program with the rest of Wayroost, brings
its units up to date, and restarts the service only when the program or a unit
changed.

## Privacy and security

- **Local is the default.** Parakeet transcription and Kokoro output travel only
  between your browser, Wayroost and the sealed local speech service. Selecting
  ElevenLabs sends each piece of text requested for app read-aloud, including
  samples, to ElevenLabs. Microphone audio is never sent to ElevenLabs.
- **Nothing is kept or logged on your PC:** no audio, no transcripts, no text
  read aloud. A transcript you haven't sent yet sits in the message box's saved
  draft on your device, like anything you type, until you send or clear it.
- **The microphone is asked for only when voice mode is on.** Wayroost's
  `Permissions-Policy` says `microphone=()` until then, and `microphone=(self)`
  after, so only Wayroost's own page can ask, and the browser asks you first.
- **The speech service is boxed in.** It has no network at all
  (`PrivateNetwork=yes`) and runs as a throwaway system user. Its whole view of
  the system is an empty folder (`RootDirectory=/opt/signalbox-speech/root`)
  with only the system's programs and libraries, its own program and its
  models mounted in, read-only: no `/etc` (apart from the loader's cache),
  `/home`, `/root`, `/var`, `/run`,
  `/usr/local` or Windows drives. It listens only on
  `/run/signalbox-speech.sock`, which systemd creates (so nothing else can pose
  as the service), hands it already open, and lets only root and Wayroost
  open. Requests carry audio or text, never a file path.
- **Nobody but root can change what writes down your words:** its program, its
  Python packages (pinned by hash) and its models (checked by SHA-256) are all
  owned by root. An agent running as your user can't edit them.
- **Speaking is the same as typing.** What you say becomes a message, exactly as
  if you'd typed it; there's no voice shortcut for approvals or settings.
- **Separate cloud process.** `wayroost-voice-cloud.service` runs as a dynamic
  user with no home access, a read-only filesystem and a single writable runtime
  directory. Its group-only Unix socket is for Wayroost; it has no TCP listener.
  It has its own `wayroost-voice-cloud` group, which only the server joins;
  other Wayroost sockets, mounted drives and local/private network addresses
  are blocked. The resolver stub at 127.0.0.53 is the sole localhost exception.
  The installer resolves the validated Node executable and mounts just that
  file read-only at `/opt/wayroost/server/voice-node` for this unit, including
  when Node lives under the hidden `/usr/local` tree. The rest of that tree
  stays inaccessible; the installer does not copy the executable.
  Only this process receives the key through systemd `LoadCredential`. The
  server and browser never receive it. There are no API URLs or keys in the
  voice setting: the process fixes the destination to `https://api.elevenlabs.io`,
  validates every request URL and never follows redirects or uses proxy settings.
  This is an application egress allowlist, not a DNS-based system firewall.
  The existing local service and its no-network unit are unchanged.
- **Bounded cloud work.** Synthesis takes at most 1,000 characters, 16 KiB input,
  8 MiB audio, 30 seconds total and 2 seconds to connect/receive headers or
  between upstream chunks. The server also bounds first audio and stalled
  streams to 2 seconds, then aborts cloud work and falls back locally. After
  a failure it uses local speech for 60 seconds (5 minutes for auth or quota)
  before retrying. An older successful stream cannot clear a newer failure's
  cooldown. Concurrent failures preserve the longest deadline and its reason;
  a later failure can extend the cooldown. Closing a request cancels cloud work,
  including HTTPS requests still waiting for headers and either catalog request,
  without starting local fallback. Local synthesis already in progress keeps its concurrency slot
  until it finishes; at most four outputs synthesize at once. Catalog
  replies have a 1 MiB limit. Fixed error codes distinguish auth, quota,
  rate-limit, timeout and unreachable; remote error messages are never returned
  or logged. Catalog strings are scrubbed after JSON decoding, including
  escaped credential echoes in names, categories and identifiers. Ordinary
  voice-status checks, including phones, chats and shadow
  mode, never call ElevenLabs. Only a paired desktop deliberately opening the
  Voice page loads the catalog; results are cached for 5 minutes and failures
  for 60 seconds, with a 2-second total deadline. Explicit provider saves and
  read-aloud requests may use the cloud; shadow mode has no cloud probes,
  synthesis or refresh timers of its own.

## Optional ElevenLabs setup, rotation and removal

On the server, create `/etc/wayroost/elevenlabs-api-key` as a regular file owned
by root:root with mode 0600, and put just the API key in it using a trusted root
editor. Never put it in the browser, config, command-line arguments or environment.
Then re-run the built server installer:

```bash
sudo deploy/install-wayroost-server.sh
```

The installer checks file metadata only; it does not read, copy or print the
key. It installs and enables the cloud unit only when the protected file exists.
The process reads only `$CREDENTIALS_DIRECTORY/elevenlabs-api-key`, trims it,
validates printable ASCII, and keeps it in memory. It does not write or log it.
No dependency is added.
Local voice mode must already be configured; cloud output still needs local
speech for transcription and fallback.
When `speech.enabled` is true in the Wayroost config, the installer also gives
the Wayroost server membership in the existing `signalbox-voice` socket group.
It does not change or restart the local speech units.

Open Settings → Voice on a paired desktop, choose ElevenLabs for **App read-aloud**,
then pick an account voice (including cloned voices) and a model. Picking plays
a sample through the real synthesis path. The notice beside the choice says
that the text is sent to ElevenLabs. An unconfigured or unavailable process
leaves the local choice available.

To rotate the key, replace the contents of that same file with a trusted root
editor, retain mode 0600 and root:root ownership, and re-run the installer. Its
restart reloads the systemd credential; no key enters Wayroost's state files.
To remove cloud access, choose Local voice in Settings, delete only the
credential file as root, and re-run the installer. It stops and disables the
cloud unit and removes its installed unit file. A saved cloud selection also
falls back locally if the process is absent. Removing Wayroost itself preserves
the credential file; delete it explicitly when you want it removed.

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
