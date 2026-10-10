import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import struct

def write_frame(target, kind, payload=b""):
    target.write(bytes((kind,)) + struct.pack("<I", len(payload)) + payload)
    target.flush()


PROJECT_ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(
    os.environ.get(
        "KUKU_MEETING_WORKER_PATH",
        PROJECT_ROOT / "apps/desktop/src-tauri/resources/meeting_notes/asr/asr_worker.py",
    )
)
WORKER_PYTHON = os.environ.get("KUKU_MEETING_WORKER_PYTHON", sys.executable)


class WorkerProtocolEndToEndTests(unittest.TestCase):
    def test_mock_worker_process_completes_the_framed_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = subprocess.Popen(
                [
                    WORKER_PYTHON,
                    "-u",
                    str(WORKER),
                    "--model-dir",
                    str(root / "models"),
                    "--audio-path",
                    str(root / "meeting.wav"),
                    "--session-id",
                    "protocol-test",
                    "--mock",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.addCleanup(lambda: process.poll() is None and process.kill())
            assert process.stdin is not None
            assert process.stdout is not None

            initial = [json.loads(process.stdout.readline()) for _ in range(2)]
            self.assertEqual([event["type"] for event in initial], ["download", "ready"])

            write_frame(process.stdin, 1, b"\0" * 128)
            write_frame(process.stdin, 1, b"\0" * 128)
            write_frame(process.stdin, 2)
            process.stdin.close()

            events = []
            while True:
                line = process.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                if event.get("type") == "final":
                    break

            self.assertEqual(process.wait(timeout=5), 0)
            process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
            self.assertEqual(
                [event["type"] for event in events],
                ["transcript", "transcript", "finalizing", "final"],
            )
            final = events[-1]
            self.assertEqual(len(final["segments"]), 2)
            self.assertTrue(final["text"].startswith("미팅 노트 전사를 시작했습니다."))


if __name__ == "__main__":
    unittest.main()
