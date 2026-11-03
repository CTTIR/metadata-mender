"""Build and inspect a deterministic XPI using only declared runtime files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def source_files():
    files = []

    def checked(path):
        if path.is_symlink():
            raise ValueError("Runtime symlinks must be replaced by reviewed package files")
        try:
            path.resolve().relative_to(ROOT.resolve())
        except ValueError as error:
            raise ValueError("Runtime source must remain inside the repository") from error
        if not path.is_file():
            raise ValueError(f"Required runtime file is missing: {path.relative_to(ROOT)}")
        files.append(path)

    for name in ("manifest.json", "bootstrap.js", "LICENSE"):
        checked(ROOT / name)
    for directory in ("content", "locale"):
        base = ROOT / directory
        if base.is_symlink() or not base.is_dir():
            raise ValueError(f"Runtime directory must be a real source directory: {directory}")
        for parent, directories, names in os.walk(base, followlinks=False):
            directories[:] = [name for name in directories if not name.startswith(".")]
            for name in directories:
                if (Path(parent) / name).is_symlink():
                    raise ValueError("Runtime directory symlinks are not permitted")
            for name in names:
                if not name.startswith("."):
                    checked(Path(parent) / name)
    return sorted(files)


def metadata():
    for name in ("manifest.json", "update.json"):
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Package metadata must be a real source file: {name}")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    version = manifest["version"]
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Manifest version must have the form X.Y.Z")
    application = manifest["applications"]["zotero"]
    updates = json.loads((ROOT / "update.json").read_text())["addons"][application["id"]]["updates"]
    matches = [entry for entry in updates if entry["version"] == version]
    if len(matches) != 1:
        raise ValueError("Exactly one update entry must match the manifest version")
    release = matches[0]
    for field in ("strict_min_version", "strict_max_version"):
        if release["applications"]["zotero"][field] != application[field]:
            raise ValueError("Manifest/update compatibility differs")
    expected_link = (f"https://github.com/CTTIR/metadata-mender/releases/download/v{version}/"
                     f"metadata-mender-{version}.xpi")
    if release["update_link"] != expected_link:
        raise ValueError("Update link must match the repository, release tag and artifact version")
    return manifest, release


def verify(path, check_update_hash=True):
    manifest, release = metadata()
    expected = {file.relative_to(ROOT).as_posix(): file.read_bytes() for file in source_files()}
    with zipfile.ZipFile(path) as archive:
        if set(archive.namelist()) != set(expected) or len(archive.namelist()) != len(expected):
            raise ValueError("Archive file list differs from declared runtime source")
        for name, body in expected.items():
            if archive.read(name) != body:
                raise ValueError(f"Archive differs from source: {name}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    hash_matches = release.get("update_hash") == "sha256:" + digest
    if check_update_hash and not hash_matches:
        raise ValueError("Update checksum differs from this XPI; review and refresh update.json before release")
    return {"artifact": str(path), "version": manifest["version"], "files": len(expected),
            "sha256": digest, "source_matches": True, "update_hash_matches": hash_matches}


def build(output):
    manifest, _ = metadata()
    source_files()  # Reject escaped source before creating an output directory.
    output = output.resolve()
    root = ROOT.resolve()
    if output != root and root in output.parents:
        raise ValueError("Output must be the repository root or a directory outside the source tree")
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"metadata-mender-{manifest['version']}.xpi"
    descriptor, name = tempfile.mkstemp(prefix=".metadata-mender-", suffix=".partial", dir=output)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for file in source_files():
                info = zipfile.ZipInfo(file.relative_to(ROOT).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        verify(Path(name), check_update_hash=False)
        try:
            # Atomic publication without replacing any existing path.
            os.link(name, destination)
        except FileExistsError:
            if (not stat.S_ISREG(destination.lstat().st_mode)
                    or destination.read_bytes() != Path(name).read_bytes()):
                raise FileExistsError(
                    f"Existing artifact differs and was preserved: {destination}. "
                    "Use a new output directory or increment the version.") from None
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return verify(destination, check_update_hash=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT)
    parser.add_argument("--check", type=Path, help="Verify an existing XPI against source and update checksum")
    args = parser.parse_args()
    result = verify(args.check) if args.check else build(args.output_dir)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
