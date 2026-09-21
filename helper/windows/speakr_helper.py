"""Speakr Recorder helper for Windows: streams the computer's sound to the extension.

Chrome starts this as a native-messaging host (length-prefixed JSON on
stdin/stdout). It records the default output device through WASAPI loopback,
downmixed to mono, and sends 16-bit PCM back in ~250 ms messages. The
extension mixes in the microphone and does everything else.

Why it exists: Chrome's own system-audio capture fails with NotReadableError
when the output is 7.1 (a Logitech PRO X 2 with G HUB surround, 2026-09-21),
while WASAPI loopback through this library records it fine.
"""

import base64
import json
import os
import struct
import sys
import threading
import warnings

import numpy as np
import soundcard as sc

VERSION = "1.0.0"
BLOCK_SECONDS = 0.25

# soundcard warns on every buffer discontinuity; stdout belongs to Chrome.
warnings.filterwarnings("ignore")

_out = sys.stdout.buffer
_out_lock = threading.Lock()


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with _out_lock:
        try:
            _out.write(struct.pack("<I", len(data)) + data)
            _out.flush()
        except OSError:
            os._exit(0)  # Chrome went away


def read():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None  # Chrome closed the port
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def capture(sample_rate, stop):
    try:
        speaker = sc.default_speaker()
        loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        frames = int(sample_rate * BLOCK_SECONDS)
        with loopback.recorder(samplerate=sample_rate, channels=1) as rec:
            send({"type": "started", "device": speaker.name, "deviceChannels": speaker.channels,
                  "sampleRate": sample_rate})
            seq = 0
            while not stop.is_set():
                # soundcard returns zeros when nothing is playing, so this never stalls.
                block = rec.record(numframes=frames)[:, 0]
                pcm = (np.clip(block, -1.0, 1.0) * 32767).astype("<i2").tobytes()
                send({"type": "pcm", "seq": seq, "data": base64.b64encode(pcm).decode("ascii")})
                seq += 1
    except Exception as e:  # device unplugged, driver error, ...
        send({"type": "error", "message": f"{type(e).__name__}: {e}"})


def main():
    stop = threading.Event()
    worker = None
    while True:
        msg = read()
        if msg is None:
            break
        kind = msg.get("type")
        if kind == "hello":
            speaker = sc.default_speaker()
            send({"type": "hello", "version": VERSION, "platform": "windows",
                  "device": speaker.name, "deviceChannels": speaker.channels})
        elif kind == "start" and worker is None:
            worker = threading.Thread(target=capture, args=(int(msg.get("sampleRate", 48000)), stop), daemon=True)
            worker.start()
        elif kind == "stop":
            break
    stop.set()
    send({"type": "stopped"})
    # The capture thread may sit inside a WASAPI call; nothing left to flush.
    os._exit(0)


if __name__ == "__main__":
    main()
