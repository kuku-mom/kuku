import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASR_RESOURCES = (
    PROJECT_ROOT / "apps/desktop/src-tauri/resources/meeting_notes/asr"
)
BOOTSTRAP = ASR_RESOURCES / "bootstrap.sh"
RUNTIME_MANIFEST = ASR_RESOURCES / "runtime_manifest.txt"


class RuntimeBootstrapTests(unittest.TestCase):
    def prepare_fake_uv(self, root: Path) -> tuple[Path, Path]:
        tools = root / "ASR Tools"
        tools.mkdir()
        log = root / "uv.log"
        uv = tools / "uv-0.12.1"
        uv.write_text(
            """#!/bin/zsh
print -r -- \"$*\" >> \"$FAKE_UV_LOG\"
if [[ \"$1\" == \"venv\" ]]; then
  runtime_dir=\"${@: -1}\"
  /bin/mkdir -p \"$runtime_dir/bin\"
  /bin/cp /usr/bin/true \"$runtime_dir/bin/python3\"
fi
if [[ \"$1\" == \"pip\" && \"${FAKE_UV_FAIL_PIP:-0}\" == \"1\" ]]; then
  exit 42
fi
""",
            "utf-8",
        )
        uv.chmod(0o755)
        return uv, log

    def run_bootstrap(
        self, root: Path, log: Path, *, fail_pip: bool = False
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["FAKE_UV_LOG"] = str(log)
        environment["FAKE_UV_FAIL_PIP"] = "1" if fail_pip else "0"
        return subprocess.run(
            ["/bin/zsh", str(BOOTSTRAP), str(root / "ASR Runtime")],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_writes_the_current_marker_only_after_a_reinstall(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, log = self.prepare_fake_uv(root)

            result = self.run_bootstrap(root, log)

            self.assertEqual(result.returncode, 0, result.stderr)
            marker = root / "ASR Runtime/.kuku-meeting-ready"
            self.assertEqual(marker.read_bytes(), RUNTIME_MANIFEST.read_bytes())
            self.assertIn("pip install --reinstall", log.read_text("utf-8"))

    def test_failed_reinstall_removes_the_previous_ready_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, log = self.prepare_fake_uv(root)
            runtime = root / "ASR Runtime"
            (runtime / "bin").mkdir(parents=True)
            shutil.copy("/usr/bin/true", runtime / "bin/python3")
            marker = runtime / ".kuku-meeting-ready"
            marker.write_bytes(RUNTIME_MANIFEST.read_bytes())

            result = self.run_bootstrap(root, log, fail_pip=True)

            self.assertEqual(result.returncode, 42)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
