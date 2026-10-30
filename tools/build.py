"""Build and inspect a deterministic XPI using only declared runtime files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def source_files():
    files = [ROOT / name for name in ("manifest.json", "bootstrap.js", "LICENSE")]
    for directory in ("content", "locale"):
        files.extend(path for path in (ROOT / directory).rglob("*")
                     if path.is_file() and not any(part.startswith(".") for part in path.relative_to(ROOT).parts))
    if any(path.is_symlink() for path in files):
        raise ValueError("Runtime symlinks must be replaced by reviewed package files")
    return sorted(files)


def metadata():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    application = manifest["applications"]["zotero"]
    updates = json.loads((ROOT / "update.json").read_text())["addons"][application["id"]]["updates"]
    release = next(entry for entry in updates if entry["version"] == manifest["version"])
    for field in ("strict_min_version", "strict_max_version"):
        if release["applications"]["zotero"][field] != application[field]:
            raise ValueError("Manifest/update compatibility differs")
    if not release["update_link"].endswith(f"/metadata-mender-{manifest['version']}.xpi"):
        raise ValueError("Update artifact version differs")
    return manifest


def verify(path):
    manifest = metadata()
    expected = {file.relative_to(ROOT).as_posix(): file.read_bytes() for file in source_files()}
    with zipfile.ZipFile(path) as archive:
        if set(archive.namelist()) != set(expected) or len(archive.namelist()) != len(expected):
            raise ValueError("Archive file list differs from declared runtime source")
        for name, body in expected.items():
            if archive.read(name) != body:
                raise ValueError(f"Archive differs from source: {name}")
    return {"artifact": str(path), "version": manifest["version"], "files": len(expected),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "source_matches": True}


def build(output):
    manifest = metadata()
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
        verify(Path(name))
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return verify(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT)
    parser.add_argument("--check", type=Path, help="Verify an existing XPI against current source")
    args = parser.parse_args()
    result = verify(args.check) if args.check else build(args.output_dir)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
