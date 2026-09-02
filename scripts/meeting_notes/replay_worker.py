#!/usr/bin/env python3
"""Bounded, offline replay through the real meeting worker's production PCM protocol.

Requires the installed Kuku Python runtime/models and a 16 kHz, mono PCM16 WAV.
This tests inference/protocol/finalization, not macOS audio capture or permission.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import signal
import struct
import subprocess
import threading
import time
import wave


def replay(args):
    import numpy as np

    with wave.open(str(args.audio), "rb") as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (16000, 1, 2):
            raise ValueError("Expected 16 kHz mono PCM16 WAV")
        duration = source.getnframes() / 16000
    args.output.parent.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    for key in list(environment):
        if key.startswith(("KUKU_MEETING_ASR_", "ULPASO_ASR_")):
            environment.pop(key)
    environment.update(HF_HUB_OFFLINE="1", HF_HOME=str(args.models / ".hf-cache"),
                       PYTHONDONTWRITEBYTECODE="1", TOKENIZERS_PARALLELISM="false")
    events = queue.Queue()
    records = []
    started = time.monotonic()
    with args.output.with_suffix(".stderr.log").open("w") as errors:
        process = subprocess.Popen(
            [str(args.python), "-u", str(args.worker), "--model-dir", str(args.models),
             "--audio-path", str(args.audio), "--session-id", "stability-replay"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
            env=environment, start_new_session=True,
        )

        def read():
            try:
                for line in process.stdout:
                    events.put(json.loads(line))
            except Exception as error:
                events.put({"type": "error", "message": str(error)})
            finally:
                events.put({"type": "eof"})

        def feed():
            try:
                with wave.open(str(args.audio), "rb") as source:
                    while raw := source.readframes(32000):
                        pcm = (np.frombuffer(raw, dtype="<i2").astype("<f4") / 32768).tobytes()
                        process.stdin.write(b"\x01" + struct.pack("<I", len(pcm)) + pcm)
                        process.stdin.flush()
                process.stdin.write(b"\x02\0\0\0\0")
                process.stdin.flush()
                process.stdin.close()
            except Exception as error:
                events.put({"type": "error", "message": f"PCM feed: {error}"})

        threading.Thread(target=read, daemon=True).start()
        final = None
        try:
            while True:
                remaining = args.timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise TimeoutError("Worker replay deadline exceeded")
                event = events.get(timeout=remaining)
                records.append(event)
                kind = event.get("type")
                if kind == "ready":
                    print("Real models ready; streaming test WAV", flush=True)
                    threading.Thread(target=feed, daemon=True).start()
                elif kind in ("error", "eof"):
                    raise RuntimeError(f"Worker did not finalize: {event}")
                elif kind == "final":
                    final = event
                    break
                elif kind in ("loading", "finalizing"):
                    print(kind, flush=True)
            code = process.wait(timeout=10)
            if code != 0:
                raise RuntimeError(f"Worker exit code {code}")
            text = " ".join(str(final.get("text", "")).split())
            segments = " ".join(" ".join(segment.get("text", "").split())
                                for segment in final.get("segments", [])).strip()
            result = {"worker": str(args.worker), "audioSeconds": duration,
                      "elapsedSeconds": round(time.monotonic() - started, 2),
                      "final": final, "segmentsMatchFinal": text == segments,
                      "liveEvents": sum(event.get("type") == "transcript" for event in records)}
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps(result, ensure_ascii=False), flush=True)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            process.stdout.close()
            args.output.with_suffix(".events.json").write_text(
                json.dumps(records, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("python", "worker", "models", "audio", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=300)
    replay(parser.parse_args())
