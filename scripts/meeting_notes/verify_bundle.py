"""Verify a local macOS bundle; does not sign, publish, launch, or record audio."""
import argparse
import plistlib
import subprocess
from pathlib import Path


def verify(bundle: Path) -> None:
    resources = bundle / "Contents/Resources"
    with (bundle / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    assert info["LSMinimumSystemVersion"] == "10.15", "Kuku's global minimum changed"
    binary = bundle / "Contents/MacOS" / info["CFBundleExecutable"]
    subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(bundle)],
        check=True,
        capture_output=True,
        text=True,
    )
    signature = subprocess.run(
        ["codesign", "--display", "--verbose=4", str(bundle)],
        check=True,
        capture_output=True,
        text=True,
    ).stderr
    assert f'Identifier={info["CFBundleIdentifier"]}' in signature, "Signed identifier must match Info.plist"
    assert "TeamIdentifier=not set" not in signature, "A stable signing identity is required for TCC permissions"
    assert "Signature=adhoc" not in signature, "Ad-hoc signing makes TCC permissions build-specific"
    loads = subprocess.check_output(["otool", "-l", str(binary)], text=True)
    capture = [block for block in loads.split("Load command ") if "ScreenCaptureKit" in block]
    assert len(capture) == 1 and "LC_LOAD_WEAK_DYLIB" in capture[0], "Capture framework must be weak-linked"
    for name in (
        "asr_worker.py", "asr_artifacts.py", "asr_protocol.py", "bootstrap.sh",
        "requirements.lock", "THIRD_PARTY_NOTICES.md",
    ):
        assert (resources / "resources/meeting_notes/asr" / name).is_file(), name
    assert (resources / "resources/meeting_notes/ULPASO_LICENSE").is_file()
    for locale in ("ko", "en", "ja"):
        assert (resources / f"{locale}.lproj/InfoPlist.strings").is_file(), locale
    assert not list(resources.rglob("test_*.py")), "Worker tests should not ship"
    assert not list(resources.rglob("*.safetensors")), "Models should be installed on demand"
    print(f"Meeting bundle verified: {bundle}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    verify(parser.parse_args().bundle)
