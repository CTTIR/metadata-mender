"""Safety boundaries of the opt-in native host launcher; never starts Zotero."""
import argparse
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import sys
import os
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_runner", ROOT / "tools/test_zotero.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class NativeRunnerTests(unittest.TestCase):
    def test_existing_directory_and_contents_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            marker = output / "existing"
            marker.write_bytes(b"preserve this data")
            with self.assertRaisesRegex(ValueError, "new directory"):
                runner.validate_output(output)
            self.assertEqual(marker.read_bytes(), b"preserve this data")

    def test_dangling_output_symlink_is_preserved_and_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            alias = parent / "existing-link"
            alias.symlink_to(parent / "missing-target", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "new directory"):
                runner.validate_output(alias)
            self.assertTrue(alias.is_symlink())
            self.assertFalse((parent / "missing-target").exists())

    def test_default_data_and_profile_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            with patch.object(runner.Path, "home", return_value=home):
                for relative in ["Zotero/new", "Library/Application Support/Zotero/new",
                                 ".zotero/new", "AppData/Roaming/Zotero/new"]:
                    with self.assertRaisesRegex(ValueError, "default Zotero"):
                        runner.validate_output(home / relative)
            self.assertEqual(list(home.iterdir()), [])

    def test_symlink_cannot_route_output_into_default_library(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            (home / "Zotero").mkdir()
            (home / "alias").symlink_to(home / "Zotero", target_is_directory=True)
            with patch.object(runner.Path, "home", return_value=home):
                with self.assertRaisesRegex(ValueError, "default Zotero"):
                    runner.validate_output(home / "alias/new")
            self.assertFalse((home / "Zotero/new").exists())

    def test_custom_data_and_profile_markers_are_preserved_and_refused(self):
        for markers in [("zotero.sqlite",), ("prefs.js", "compatibility.ini"),
                        ("prefs.js", "extensions.json")]:
            with tempfile.TemporaryDirectory() as directory:
                parent = Path(directory)
                for marker in markers:
                    (parent / marker).write_bytes(b"do not inspect or alter")
                child = parent / "nested"
                child.mkdir()
                with self.assertRaisesRegex(ValueError, "existing Zotero"):
                    runner.validate_output(child / "new")
                self.assertFalse((child / "new").exists())
                for marker in markers:
                    self.assertEqual((parent / marker).read_bytes(), b"do not inspect or alter")

    def test_default_directory_filesystem_identity_is_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            protected, alias = home / "Zotero", home / "alternate-spelling"
            protected.mkdir(); alias.mkdir()
            real_samefile = os.path.samefile
            def samefile(first, second):
                if first == alias and second == protected:
                    return True
                return real_samefile(first, second)
            with patch.object(runner.Path, "home", return_value=home), \
                    patch.object(runner.os.path, "samefile", side_effect=samefile):
                with self.assertRaisesRegex(ValueError, "default Zotero"):
                    runner.validate_output(alias / "new")
            self.assertEqual(list(alias.iterdir()), [])

    def test_invalid_timeouts_cannot_launch_a_process(self):
        with patch.object(runner.subprocess, "Popen", side_effect=AssertionError("must not launch")):
            for timeout in [0, -1, float("inf"), float("nan"), 601]:
                with self.assertRaisesRegex(ValueError, "Timeout"):
                    runner.run(argparse.Namespace(timeout=timeout))

    @unittest.skipUnless(os.name == "posix", "POSIX process-group cleanup")
    def test_cleanup_stops_only_the_created_process_group(self):
        owned = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                 start_new_session=True)
        try:
            runner.stop_owned(owned)
            self.assertIsNotNone(owned.poll())
        finally:
            if owned.poll() is None:
                owned.kill(); owned.wait()

    def test_validation_does_not_create_a_new_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "new-evidence"
            self.assertEqual(runner.validate_output(output), output.resolve())
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
