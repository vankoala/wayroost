#!/usr/bin/env python3
"""Wayroost speech service: speech-to-text and text-to-speech on the CPU.

Voice mode in Signalbox sends what you say here to be written down, and sends
agents' replies here to be read aloud. Everything stays on this PC:

* Speech-to-text: NVIDIA Parakeet TDT 0.6B v2 (int8, English) through sherpa-onnx.
* Text-to-speech: Kokoro-82M (fp32) through sherpa-onnx.

It listens only on the Unix socket systemd hands it (signalbox-speech.socket,
which only root and the signalbox-voice group can open) and runs with no
network at all. Requests carry audio or text, never a file path. It keeps
nothing: no audio, no text, no logs of either.

  GET  /health  -> {"ok": true, "voices": [...], "defaultVoice": "af_heart"}
  POST /stt     body: 16 kHz mono 16-bit little-endian PCM, at most MAX_SECONDS
                -> {"text": "...", "ms": 123}
  POST /tts     body: {"text": "...", "voice": "af_heart", "speed": 1.0}
                -> audio/wav (24 kHz mono 16-bit), header X-Synth-Ms

Run by deploy/setup-speech.sh's unit with the root-owned venv in
/opt/signalbox-speech/venv. For a manual test: --socket /path/to.sock.
"""

import argparse
import io
import json
import math
import os
import re
import socket
import socketserver
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import sherpa_onnx

MODELS = Path(os.environ.get("SPEECH_MODELS", "/opt/signalbox-speech/models"))
STT_DIR = MODELS / "parakeet-tdt-0.6b-v2-int8"
TTS_DIR = MODELS / "kokoro-multi-lang-v1_0"
STT_THREADS = int(os.environ.get("SPEECH_STT_THREADS", "4"))
TTS_THREADS = int(os.environ.get("SPEECH_TTS_THREADS", "4"))
DEFAULT_VOICE = os.environ.get("SPEECH_DEFAULT_VOICE", "af_heart")

STT_RATE = 16000
TTS_RATE = 24000
MAX_SECONDS = 120
MAX_STT_BYTES = STT_RATE * 2 * MAX_SECONDS
MAX_TTS_BODY = 8 * 1024
MAX_TTS_CHARS = 1000
# English voices only: the model reads with an American English lexicon.
VOICE_NAME = re.compile(r"^[ab][fm]_[a-z]{2,20}$")
REQUEST_TIMEOUT = 30


# ---- Kokoro voice names, from the model's own metadata -----------------------

def _varint(f):
    value = 0
    for shift in range(0, 70, 7):
        b = f.read(1)
        if not b:
            raise ValueError("truncated ONNX metadata")
        value |= (b[0] & 127) << shift
        if b[0] < 128:
            return value
    raise ValueError("invalid protobuf varint")


def _fields(f, end):
    """Length-delimited protobuf fields up to `end`, without loading the ONNX graph."""
    while f.tell() < end:
        tag = _varint(f)
        wire, number = tag & 7, tag >> 3
        if wire == 2:
            size = _varint(f)
            offset = f.tell()
            if offset + size > end:
                raise ValueError("truncated ONNX field")
            yield number, offset, size
            f.seek(offset + size)
        elif wire == 0:
            _varint(f)
        elif wire in (1, 5):
            f.seek(8 if wire == 1 else 4, 1)
        else:
            raise ValueError("unsupported protobuf wire type")


def model_metadata(path):
    """ONNX ModelProto.metadata_props (field 14) as a dict."""
    result = {}
    with open(path, "rb") as f:
        end = os.fstat(f.fileno()).st_size
        for field, offset, size in _fields(f, end):
            if field != 14:
                continue
            entry = {}
            for number, _, length in _fields(f, offset + size):
                entry[number] = f.read(length).decode("utf-8")
            if 1 in entry and 2 in entry:
                result[entry[1]] = entry[2]
    return result


def voice_ids(model):
    meta = model_metadata(model)
    ids = {}
    if meta.get("speaker2id"):
        for pair in meta["speaker2id"].split(","):
            name, _, number = pair.partition("->")
            ids[name.strip()] = int(number)
    elif meta.get("speaker_names"):
        ids = {name.strip(): i for i, name in enumerate(meta["speaker_names"].split(","))}
    return {name: i for name, i in ids.items() if VOICE_NAME.match(name)}


# ---- Engines -----------------------------------------------------------------

class Speech:
    def __init__(self):
        self.stt_lock = threading.Lock()
        self.tts_lock = threading.Lock()
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            tokens=str(STT_DIR / "tokens.txt"),
            encoder=str(STT_DIR / "encoder.int8.onnx"),
            decoder=str(STT_DIR / "decoder.int8.onnx"),
            joiner=str(STT_DIR / "joiner.int8.onnx"),
            num_threads=STT_THREADS,
            provider="cpu",
            model_type="nemo_transducer",
        )
        model = TTS_DIR / "model.onnx"
        self.voices = voice_ids(model)
        if DEFAULT_VOICE not in self.voices:
            raise SystemExit(f"the Kokoro model has no voice {DEFAULT_VOICE}")
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(model),
                    voices=str(TTS_DIR / "voices.bin"),
                    tokens=str(TTS_DIR / "tokens.txt"),
                    data_dir=str(TTS_DIR / "espeak-ng-data"),
                    lexicon=str(TTS_DIR / "lexicon-us-en.txt"),
                    lang="en-us",
                ),
                num_threads=TTS_THREADS,
                provider="cpu",
                debug=False,
            ),
            max_num_sentences=1,
        )
        if not config.validate():
            raise SystemExit("invalid Kokoro configuration")
        self.tts = sherpa_onnx.OfflineTts(config)
        if self.tts.sample_rate != TTS_RATE:
            raise SystemExit(f"unexpected Kokoro sample rate {self.tts.sample_rate}")
        # The first run of each model is slow; pay for it before the first request.
        self.transcribe(bytes(STT_RATE * 2))
        self.synthesize("Ready.", DEFAULT_VOICE, 1.0)

    def transcribe(self, pcm):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if samples.size < STT_RATE // 5:  # under 0.2 s: nothing was said
            return ""
        with self.stt_lock:
            stream = self.recognizer.create_stream()
            stream.accept_waveform(STT_RATE, samples)
            self.recognizer.decode_stream(stream)
            return stream.result.text.strip()

    def synthesize(self, text, voice, speed):
        with self.tts_lock:
            audio = self.tts.generate(text, sid=self.voices[voice], speed=speed)
        samples = np.asarray(audio.samples, dtype=np.float32)
        if not samples.size:
            raise RuntimeError("no audio")
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TTS_RATE)
            w.writeframes(pcm)
        return out.getvalue()


# ---- HTTP over the Unix socket -----------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_TIMEOUT
    speech = None  # set in main()

    def address_string(self):
        return "local"

    def log_message(self, format, *args):  # never log requests: they carry what you said
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit):
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return None
        if n < 0 or n > limit:
            return None
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if self.path != "/health":
            return self._json(404, {"error": "not found"})
        self._json(200, {"ok": True, "voices": sorted(self.speech.voices), "defaultVoice": DEFAULT_VOICE})

    def do_POST(self):
        if self.path == "/stt":
            return self._stt()
        if self.path == "/tts":
            return self._tts()
        # Drain nothing: closing is cheaper than reading an unknown body.
        self.close_connection = True
        return self._json(404, {"error": "not found"})

    def _stt(self):
        pcm = self._body(MAX_STT_BYTES)
        if pcm is None or len(pcm) % 2:
            self.close_connection = True
            return self._json(400, {"error": f"send 16 kHz 16-bit mono PCM, at most {MAX_SECONDS} s"})
        started = time.perf_counter()
        try:
            text = self.speech.transcribe(pcm)
        except Exception as err:  # the model failed: say so without echoing input
            print(f"speech-to-text failed: {type(err).__name__}", file=sys.stderr, flush=True)
            return self._json(500, {"error": "speech-to-text failed"})
        self._json(200, {"text": text, "ms": round((time.perf_counter() - started) * 1000)})

    def _tts(self):
        raw = self._body(MAX_TTS_BODY)
        if raw is None:
            self.close_connection = True
            return self._json(400, {"error": "body too large"})
        try:
            spec = json.loads(raw)
            text = str(spec.get("text", "")).strip()
            voice = str(spec.get("voice") or DEFAULT_VOICE)
            speed = float(spec.get("speed", 1.0))
        except (ValueError, TypeError, AttributeError):
            return self._json(400, {"error": "invalid request"})
        if not text or len(text) > MAX_TTS_CHARS:
            return self._json(400, {"error": f"text must be 1 to {MAX_TTS_CHARS} characters"})
        if voice not in self.speech.voices:
            return self._json(400, {"error": "unknown voice"})
        if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
            return self._json(400, {"error": "speed must be between 0.5 and 2"})
        started = time.perf_counter()
        try:
            wav = self.speech.synthesize(text, voice, speed)
        except Exception as err:
            print(f"text-to-speech failed: {type(err).__name__}", file=sys.stderr, flush=True)
            return self._json(500, {"error": "text-to-speech failed"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("X-Synth-Ms", str(round((time.perf_counter() - started) * 1000)))
        self.end_headers()
        self.wfile.write(wav)


class UnixServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def __init__(self, sock):
        socketserver.BaseServer.__init__(self, "signalbox-speech", Handler)
        self.socket = sock
        self.server_name, self.server_port = "localhost", 0

    def server_bind(self):  # already bound by systemd (or by main)
        pass


def listening_socket(path):
    """The socket systemd passed (LISTEN_FDS), or a fresh one at `path` for a manual run."""
    if os.environ.get("LISTEN_PID") == str(os.getpid()) and os.environ.get("LISTEN_FDS") == "1":
        return socket.socket(fileno=3)
    if not path:
        raise SystemExit("no socket: run from signalbox-speech.socket, or pass --socket PATH")
    if os.path.exists(path):
        os.unlink(path)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(path)
    sock.listen(16)
    return sock


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--socket", help="listen here instead of on a socket from systemd (testing)")
    args = parser.parse_args()
    sock = listening_socket(args.socket)
    started = time.perf_counter()
    Handler.speech = Speech()
    print(
        f"ready in {time.perf_counter() - started:.1f} s: {len(Handler.speech.voices)} voices, "
        f"{STT_THREADS}+{TTS_THREADS} CPU threads",
        flush=True,
    )
    UnixServer(sock).serve_forever()


if __name__ == "__main__":
    main()
