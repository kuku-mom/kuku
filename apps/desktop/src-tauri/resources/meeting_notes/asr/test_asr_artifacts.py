import hashlib
import tempfile
import unittest
from pathlib import Path

from asr_artifacts import verify_model_files


class ModelArtifactVerificationTests(unittest.TestCase):
    def create_artifact(self, root: Path, content: bytes, revision: str) -> dict[str, str]:
        filename = "model.safetensors"
        digest = hashlib.sha256(content).hexdigest()
        (root / filename).write_bytes(content)
        metadata = root / ".cache/huggingface/download"
        metadata.mkdir(parents=True)
        (metadata / f"{filename}.metadata").write_text(
            f"{revision}\n{digest}\n0\n",
            "utf-8",
        )
        return {filename: digest}

    def test_accepts_only_the_committed_revision_and_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.create_artifact(root, b"weights", "revision")
            self.assertTrue(verify_model_files(root, "revision", expected))
            self.assertFalse(verify_model_files(root, "different", expected))

    def test_rejects_a_locally_modified_weight_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.create_artifact(root, b"weights", "revision")
            (root / "model.safetensors").write_bytes(b"tampered")
            self.assertFalse(verify_model_files(root, "revision", expected))


if __name__ == "__main__":
    unittest.main()
