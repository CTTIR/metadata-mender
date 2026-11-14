"""Opt-in native Zotero checks in a new, disposable profile and data directory."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import zipfile

REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / '.'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_output(output):
    raw = Path(output).expanduser()
    if raw.exists() or raw.is_symlink():
        raise ValueError("Output must be a new directory; existing data is never reused")
    output = raw.resolve()
    home = Path.home().resolve()
    forbidden = [home / "Zotero", home / "Library/Application Support/Zotero",
                 home / ".zotero", home / "AppData/Roaming/Zotero"]
    if any(output == p or p in output.parents for p in forbidden):
        raise ValueError("Output must not be inside a default Zotero profile or data directory")
    # Check filesystem identity as well as spelling (notably on macOS).
    # Marker existence is sufficient: never open an existing user database.
    for ancestor in output.parents:
        for protected in forbidden:
            if protected.exists() and ancestor.exists() and os.path.samefile(ancestor, protected):
                raise ValueError("Output must not be inside a default Zotero profile or data directory")
        if (ancestor / "zotero.sqlite").exists() or (
                (ancestor / "prefs.js").exists() and
                ((ancestor / "compatibility.ini").exists() or
                 (ancestor / "extensions.json").exists())):
            raise ValueError("Output must not be inside an existing Zotero data or application profile directory")
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new directory; existing data is never reused")
    if not output.parent.is_dir():
        raise ValueError("Output parent directory must already exist")
    return output


def validate_artifact(path):
    manifest_bytes = (PLUGIN / "manifest.json").read_bytes()
    with zipfile.ZipFile(path) as archive:
        if archive.read("manifest.json") != manifest_bytes:
            raise ValueError("XPI manifest does not match this checkout")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("XPI contains duplicate entries")
        for name in names:
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts or "\\" in name:
                raise ValueError("XPI contains an unsafe member path")
            if name.endswith("/"):
                continue
            source = REPO / "LICENSE" if name == "LICENSE" else PLUGIN / relative
            if not source.is_file() or archive.read(name) != source.read_bytes():
                raise ValueError("XPI member differs from source: " + name)
    return json.loads(manifest_bytes)


def stop_owned(process):
    # start_new_session gives this child its own group. Never search for or stop
    # another Zotero instance; terminate only the group created by this runner.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)


def run(args):
    if os.name != "posix":
        raise ValueError("This runner currently supports macOS and Linux only")
    if not math.isfinite(args.timeout) or not 5 <= args.timeout <= 600:
        raise ValueError("Timeout must be finite and between 5 and 600 seconds")
    executable = Path(args.zotero).expanduser().resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("--zotero must name an executable Zotero binary")
    artifact = Path(args.xpi).expanduser().resolve()
    manifest = validate_artifact(artifact)
    output = validate_output(args.output)
    output.mkdir()
    profile, data = output / "profile", output / "data"
    profile.mkdir(); data.mkdir()
    temporary = output / "temporary"
    temporary.mkdir()
    prefs = {
        "extensions.zotero.dataDir": str(data), "extensions.zotero.useDataDir": True,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.zeroconf.server.enabled": False,
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.streaming.enabled": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.retractions.enabled": False,
        "extensions.zotero.firstRun2": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zoteroMacWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.update.enabled": False, "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15, "extensions.startupScanScopes": 15,
        "extensions.sideloadScopes": 15, "extensions.logging.enabled": True,
        "app.update.auto": False, "app.update.enabled": False,
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage_override.mstone": "ignore",
    }
    (profile / "user.js").write_text("\n".join(
        "user_pref(" + json.dumps(k) + ", " + json.dumps(v) + ");" for k, v in prefs.items()) + "\n")
    fixture = REPO / "tests/native/fixture.js"
    (output / "fixture.js").write_bytes(fixture.read_bytes())
    (output / "plugin.xpi").write_bytes(artifact.read_bytes())
    harness = output / "harness"
    harness.mkdir()
    harness_id = "native-fixture@local.invalid"
    (harness / "manifest.json").write_text(json.dumps({
        "manifest_version": 2, "name": "Disposable native fixture", "version": "0.0.1",
        "applications": {"zotero": {"id": harness_id, "strict_min_version": "9.0",
            "strict_max_version": "10.0.*", "update_url": "https://example.invalid/no-updates.json"}}}, indent=2))
    settings = {"profile": str(profile), "data": str(data), "root": str(output),
                "artifact": str(output / "plugin.xpi"), "fixture": (output / "fixture.js").as_uri(),
                "result": str(output / "result.json"), "pluginID": manifest["applications"]["zotero"]["id"]}
    bootstrap = (REPO / "tests/native/bootstrap.js").read_text().replace("__SETTINGS__", json.dumps(settings))
    (harness / "bootstrap.js").write_text(bootstrap)
    (profile / "extensions").mkdir()
    (profile / "extensions" / harness_id).write_text(str(harness))
    receipt = {"artifact_sha256": digest(artifact.read_bytes()), "fixture_sha256": digest(fixture.read_bytes()),
               "runner_sha256": digest(Path(__file__).read_bytes()),
               "bootstrap_sha256": digest((REPO / "tests/native/bootstrap.js").read_bytes()), "executable": str(executable),
               "settings": settings, "timeout_seconds": args.timeout}
    env = dict(os.environ); env["MOZ_NO_REMOTE"] = "1"
    env["TMPDIR"] = str(temporary)
    env["TMP"] = str(temporary)
    env["TEMP"] = str(temporary)
    command = [str(executable), "-no-remote", "-profile", str(profile), "-datadir", str(data), "-ZoteroDebugText"]
    process = None
    try:
        with (output / "host.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       env=env, start_new_session=True)
            receipt["owned_pid"] = process.pid
            deadline = time.monotonic() + args.timeout
            while not (output / "result.json").exists():
                if process.poll() is not None:
                    raise RuntimeError("Disposable Zotero exited before fixture evidence")
                if time.monotonic() >= deadline:
                    raise RuntimeError("Native fixture timed out; see host.log")
                time.sleep(0.2)
            result = json.loads((output / "result.json").read_text())
            if result.get("profile") != str(profile) or result.get("data") != str(data):
                raise RuntimeError("Actual host profile/data isolation did not match")
            if not result.get("passed") or not result.get("checks"):
                raise RuntimeError("Native fixture failed: " + str(result.get("error")))
            receipt["passed"] = True
            receipt["host_version"] = result["version"]
            receipt["assertions"] = len(result["checks"])
    finally:
        if process:
            stop_owned(process)
            receipt["owned_process_exit"] = process.poll()
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("PASS:", receipt["assertions"], "native assertions on Zotero", receipt["host_version"])
    print("Evidence:", output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zotero", required=True, help="Explicit desktop executable; no running instance is reused")
    parser.add_argument("--xpi", required=True, help="Built XPI matching every packaged source file in this checkout")
    parser.add_argument("--output", required=True, help="New evidence directory; must not already exist")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    try:
        run(args)
    except Exception as error:
        print("FAIL:", error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
