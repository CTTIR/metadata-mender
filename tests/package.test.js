const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

test("XPI builds reproducibly, matches source, and preserves earlier artifacts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-mender-package-"));
  try {
    const prior = path.join(directory, "metadata-mender-0.6.0.xpi");
    fs.writeFileSync(prior, "Prior reviewed artifact");
    const run = () => JSON.parse(execFileSync("python3", ["tools/build.py", "--output-dir", directory], { cwd: root, encoding: "utf8" }));
    const first = run();
    const bytes = fs.readFileSync(first.artifact);
    const second = run();
    assert.deepEqual(fs.readFileSync(second.artifact), bytes);
    assert.equal(first.sha256, second.sha256);
    assert.equal(fs.readFileSync(prior, "utf8"), "Prior reviewed artifact");
    const checked = JSON.parse(execFileSync("python3", ["tools/build.py", "--check", second.artifact], { cwd: root, encoding: "utf8" }));
    assert.equal(checked.source_matches, true);
    assert.equal(checked.version, "0.6.1");
    const update = JSON.parse(fs.readFileSync(path.join(root, "update.json"), "utf8"))
      .addons["metadata-mender@r-heller.github.io"].updates[0];
    assert.equal(update.version, checked.version);
    assert.equal(update.update_hash, `sha256:${checked.sha256}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
