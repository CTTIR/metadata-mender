"""Artifact preservation and package containment regressions, using synthetic copies."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
BUILDER = Path(os.environ.get("METADATA_MENDER_BUILD_SOURCE", SOURCE / "tools/build.py"))
spec = importlib.util.spec_from_file_location("package_builder", BUILDER)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PackageBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="metadata-mender-boundary-")
        self.base = Path(self.temp.name)
        self.root = self.base / "source"
        self.root.mkdir()
        for name in ("manifest.json", "bootstrap.js", "LICENSE", "update.json"):
            shutil.copy2(SOURCE / name, self.root / name)
        for name in ("content", "locale"):
            shutil.copytree(SOURCE / name, self.root / name)
        self.original_root = builder.ROOT
        builder.ROOT = self.root
        self.output = self.base / "output"

    def tearDown(self):
        builder.ROOT = self.original_root
        self.temp.cleanup()

    def test_identical_rebuild_is_idempotent_but_changed_artifact_is_preserved(self):
        first = builder.build(self.output)
        artifact = Path(first["artifact"])
        original = artifact.read_bytes()
        inode = artifact.stat().st_ino
        second = builder.build(self.output)
        self.assertEqual(second["sha256"], first["sha256"])
        self.assertEqual(artifact.read_bytes(), original)
        self.assertEqual(artifact.stat().st_ino, inode)
        sentinel = b"Previously reviewed same-version artifact"
        artifact.write_bytes(sentinel)
        with self.assertRaisesRegex(FileExistsError, "preserved"):
            builder.build(self.output)
        self.assertEqual(artifact.read_bytes(), sentinel)
        self.assertFalse(list(self.output.glob("*.partial")))
        self.assertFalse(list(self.output.glob(".*.partial")))

    def test_directory_symlinks_cannot_import_files_outside_source(self):
        external = self.base / "synthetic-external"
        external.mkdir()
        (external / "fixture.txt").write_text("Synthetic external bytes")
        shutil.rmtree(self.root / "content")
        (self.root / "content").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real source directory|symlink"):
            builder.build(self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual((external / "fixture.txt").read_text(), "Synthetic external bytes")

    def test_metadata_symlinks_and_nested_outputs_are_refused(self):
        with self.assertRaisesRegex(ValueError, "outside the source"):
            builder.build(self.root / "content")
        self.assertFalse(list((self.root / "content").glob("*.xpi")))
        external = self.base / "external-update.json"
        shutil.move(self.root / "update.json", external)
        (self.root / "update.json").symlink_to(external)
        before = external.read_bytes()
        with self.assertRaisesRegex(ValueError, "real source file"):
            builder.build(self.output)
        self.assertEqual(external.read_bytes(), before)

    def test_verification_checks_advertised_hash_and_exact_release_tag(self):
        result = builder.build(self.output)
        metadata = json.loads((self.root / "update.json").read_text())
        entry = next(iter(metadata["addons"].values()))["updates"][0]
        entry["update_hash"] = "sha256:" + result["sha256"]
        (self.root / "update.json").write_text(json.dumps(metadata))
        self.assertTrue(builder.verify(Path(result["artifact"]))["source_matches"])
        entry["update_hash"] = "sha256:" + "0" * 64
        (self.root / "update.json").write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "checksum"):
            builder.verify(Path(result["artifact"]))
        entry["update_link"] = entry["update_link"].replace("/download/v", "/download/older-v")
        (self.root / "update.json").write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "release tag"):
            builder.build(self.base / "other-output")


if __name__ == "__main__":
    unittest.main()
