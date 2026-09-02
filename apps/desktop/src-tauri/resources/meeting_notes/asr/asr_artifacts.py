"""Pinned model download, progress reporting, and checksum verification."""

from __future__ import annotations

import hashlib
import threading
import time
from pathlib import Path
from typing import Any

from asr_protocol import emit


ASR_REPO = "mlx-community/Qwen3-ASR-0.6B-8bit"
DIAR_REPO = "mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16"
MODEL_REVISIONS = {
    ASR_REPO: "89e96d92ba34aca20b3e29fb10cc284097d1219f",
    DIAR_REPO: "e23e6404bd9859e93edbf94a740eb1c7fc58f12e",
}
MODEL_FILE_SHA256 = {
    ASR_REPO: {
        "chat_template.json": "75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff",
        "config.json": "5d104a945fed08728ab010f12bf3ce5ab4d0794bba276d81bff5bd83ae9d2be0",
        "generation_config.json": "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c",
        "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        "model.safetensors": "b5bfe4abc1b4c6e58b633096682ec2b6297298add1527119936107d211adf0e8",
        "model.safetensors.index.json": "caa32ece76c395ba241533eb4aceb0efbc72488ef3d8d2fd3c677ce068dad57d",
        "preprocessor_config.json": "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d",
        "tokenizer_config.json": "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
        "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    },
    DIAR_REPO: {
        "config.json": "17c9f943bed07b0593f2b8dca01e0be6a418053becc6148b01ecabdff9cbd84d",
        "model.safetensors": "3b60b8df29e59a8abaf8061ceeeae6e9284a68fbcd2e762c68f5e058bfceebfa",
    },
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
    if verify_model(target, repo):
        emit("download", progress=end, message=f"{message} · 검증 완료")
        return target
    files = snapshot_download(
        repo_id=repo,
        revision=MODEL_REVISIONS.get(repo),
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
    revision = MODEL_REVISIONS.get(repo)
    expected_files = MODEL_FILE_SHA256.get(repo)
    if not revision or not expected_files:
        return False
    return verify_model_files(target, revision, expected_files)


def verify_model_files(
    target: Path,
    revision: str,
    expected_files: dict[str, str],
) -> bool:
    metadata_dir = target / ".cache" / "huggingface" / "download"
    for filename, expected in expected_files.items():
        artifact = target / filename
        if not artifact.is_file():
            return False
        metadata = metadata_dir / f"{filename}.metadata"
        try:
            lines = metadata.read_text("utf-8").splitlines()
            downloaded_revision = lines[0].strip().lower()
            downloaded_hash = lines[1].strip().lower()
        except (OSError, IndexError):
            return False
        if downloaded_revision != revision:
            return False
        # Hugging Face metadata stores a SHA-256 for LFS files and a git blob
        # SHA-1 for small files. The committed SHA-256 below remains the
        # authoritative content check for both forms.
        if len(downloaded_hash) == 64 and downloaded_hash != expected:
            return False
        digest = hashlib.sha256()
        with artifact.open("rb") as source:
            for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected:
            return False
    return True
