"""Pinned model download, progress reporting, and checksum verification."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any

from asr_protocol import emit


MODEL_MANIFEST = json.loads(
    Path(__file__).with_name("model_manifest.json").read_text("utf-8")
)
ASR_REPO = MODEL_MANIFEST["asr"]["repo"]
DIAR_REPO = MODEL_MANIFEST["diarization"]["repo"]
ASR_DIRECTORY = MODEL_MANIFEST["asr"]["directory"]
DIAR_DIRECTORY = MODEL_MANIFEST["diarization"]["directory"]
MODEL_REVISIONS = {
    model["repo"]: model["revision"] for model in MODEL_MANIFEST.values()
}
MODEL_FILE_SHA256 = {
    model["repo"]: model["files"] for model in MODEL_MANIFEST.values()
}
DOWNLOAD_PATTERNS = [
    "*.json",
    "*.safetensors",
    "*.txt",
    "*.model",
    "*.npz",
    "README.md",
    "LICENSE*",
]


def silent_tqdm_class():
    """Lazily resolves tqdm so importing worker helpers stays lightweight."""
    from tqdm.auto import tqdm

    class NoDisplayTqdm(tqdm):
        def display(self, *display_args: Any, **display_kwargs: Any) -> None:
            return None

    return NoDisplayTqdm


class DownloadReporter:
    def __init__(self, start: float, end: float, total_bytes: int, message: str):
        self.start = start
        self.end = end
        self.total_bytes = max(1, total_bytes)
        self.message = message
        self.completed_bytes = 0
        self.last_progress = -1.0
        self.last_emit_at = 0.0
        self.lock = threading.Lock()

    def progress(self, current_file_bytes: int = 0, force: bool = False) -> None:
        with self.lock:
            fraction = min(
                1.0,
                (self.completed_bytes + max(0, current_file_bytes)) / self.total_bytes,
            )
            progress = self.start + (self.end - self.start) * fraction
            now = time.monotonic()
            if (
                not force
                and progress - self.last_progress < 0.004
                and now - self.last_emit_at < 0.35
            ):
                return
            self.last_progress = progress
            self.last_emit_at = now
        emit("download", progress=progress, message=self.message)

    def finish_file(self, file_size: int) -> None:
        with self.lock:
            self.completed_bytes = min(
                self.total_bytes, self.completed_bytes + max(0, file_size)
            )
        self.progress(force=True)

    def tqdm_class(self):
        reporter = self
        from tqdm.auto import tqdm

        class ReportingTqdm(tqdm):
            def __init__(self, *args: Any, **kwargs: Any):
                super().__init__(*args, **kwargs)
                reporter.progress(int(self.n), force=True)

            def update(self, amount: int | float = 1):
                changed = super().update(amount)
                reporter.progress(int(self.n))
                return changed

            def display(self, *display_args: Any, **display_kwargs: Any) -> None:
                return None

        return ReportingTqdm


def prepare_model(repo: str, target: Path, start: float, end: float, message: str) -> Path:
    from huggingface_hub import hf_hub_download, snapshot_download

    target.mkdir(parents=True, exist_ok=True)
    emit("download", progress=start, message=message)
    revision, expected_files = model_spec(repo)
    invalid_files = invalid_model_files(target, revision, expected_files)
    if not invalid_files:
        emit("download", progress=end, message=f"{message} · 검증 완료")
        return target
    discard_model_files(target, invalid_files)
    files = snapshot_download(
        repo_id=repo,
        revision=revision,
        local_dir=str(target),
        allow_patterns=DOWNLOAD_PATTERNS,
        dry_run=True,
        tqdm_class=silent_tqdm_class(),
    )
    total_bytes = sum(int(file.file_size) for file in files)
    reporter = DownloadReporter(start, end, total_bytes, message)
    for file in files:
        if file.will_download:
            hf_hub_download(
                repo_id=repo,
                filename=file.filename,
                revision=file.commit_hash,
                local_dir=str(target),
                tqdm_class=reporter.tqdm_class(),
            )
        reporter.finish_file(int(file.file_size))
    if not verify_model(target, repo):
        raise RuntimeError(f"{repo} 모델의 체크섬 검증에 실패했습니다")
    emit("download", progress=end, message=message)
    return target


def verify_model(target: Path, repo: str) -> bool:
    try:
        revision, expected_files = model_spec(repo)
    except RuntimeError:
        return False
    return verify_model_files(target, revision, expected_files)


def model_spec(repo: str) -> tuple[str, dict[str, str]]:
    revision = MODEL_REVISIONS.get(repo)
    expected_files = MODEL_FILE_SHA256.get(repo)
    if not revision or not expected_files:
        raise RuntimeError(f"알 수 없는 모델 manifest입니다: {repo}")
    return revision, expected_files


def verify_model_files(
    target: Path,
    revision: str,
    expected_files: dict[str, str],
) -> bool:
    return not invalid_model_files(target, revision, expected_files)


def invalid_model_files(
    target: Path,
    revision: str,
    expected_files: dict[str, str],
) -> list[str]:
    metadata_dir = target / ".cache" / "huggingface" / "download"
    invalid: list[str] = []
    for filename, expected in expected_files.items():
        artifact = target / filename
        if not artifact.is_file():
            invalid.append(filename)
            continue
        metadata = metadata_dir / f"{filename}.metadata"
        try:
            lines = metadata.read_text("utf-8").splitlines()
            downloaded_revision = lines[0].strip().lower()
            downloaded_hash = lines[1].strip().lower()
        except (OSError, IndexError):
            invalid.append(filename)
            continue
        if downloaded_revision != revision or len(downloaded_hash) not in (40, 64):
            invalid.append(filename)
            continue
        # Hugging Face metadata stores a SHA-256 for LFS files and a git blob
        # SHA-1 for small files. The committed SHA-256 below remains the
        # authoritative content check for both forms.
        if len(downloaded_hash) == 64 and downloaded_hash != expected:
            invalid.append(filename)
            continue
        digest = hashlib.sha256()
        try:
            with artifact.open("rb") as source:
                for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    digest.update(block)
        except OSError:
            invalid.append(filename)
            continue
        if digest.hexdigest() != expected:
            invalid.append(filename)
    return invalid


def discard_invalid_model_files(target: Path, repo: str) -> None:
    revision, expected_files = model_spec(repo)
    discard_model_files(
        target, invalid_model_files(target, revision, expected_files)
    )


def discard_model_files(target: Path, filenames: list[str]) -> None:
    metadata_dir = target / ".cache" / "huggingface" / "download"
    for filename in filenames:
        (target / filename).unlink(missing_ok=True)
        (metadata_dir / f"{filename}.metadata").unlink(missing_ok=True)
