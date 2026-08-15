import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateRelease } from "./validate-release.mjs";

const fixtureRoots = [];
const EXPECTED_CLAUDE_PLUSPLUS_COMMIT = "4f78b1f31c4075ab60d7d4e819476e24b00023ed";

function writeJson(root, relativePath, value) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(root, relativePath, value = "fixture\n") {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "unity-links-claude-release-"));
  fixtureRoots.push(root);
  writeJson(root, "manifest.json", {
    id: "com.kpk.unity-asset-links",
    name: "Unity Asset Links",
    version: "0.1.3",
    githubRepo: "kpkhxlgy0/unity-links-claude",
    homepage: "https://github.com/kpkhxlgy0/unity-links",
    iconUrl: "./icon.png",
    description:
      "Open Claude links under Assets, ProjectSettings, or Packages in the matching Unity Editor.",
    author: "KPK",
    tags: ["unity", "links", "workflow"],
    minRuntime: "0.2.3",
    scope: "both",
    main: "index.js",
    permissions: ["ipc", "filesystem", "claude-sessions"],
  });
  writeJson(root, "package.json", {
    name: "kpk-claude-unity-asset-links",
    version: "0.1.3",
    license: "MIT",
    private: true,
  });
  writeFileSync(join(root, "icon.png"), "test-icon");
  writeFileSync(join(root, "LICENSE"), "MIT License\n\nCopyright (c) 2026 KPK\n");
  for (const relativePath of [
    ".gitignore",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "README.md",
    "README.zh-CN.md",
    "index.js",
    "test/index.test.js",
    "scripts/compatibility/validate-claudeplusplus.mjs",
    "scripts/compatibility/validate-claudeplusplus.test.mjs",
    "scripts/release/validate-release.mjs",
    "scripts/release/validate-release.test.mjs",
    "scripts/send-open.js",
  ]) {
    writeText(root, relativePath);
  }
  writeText(root, ".github/workflows/ci.yml", [
    `ref: ${EXPECTED_CLAUDE_PLUSPLUS_COMMIT}`,
    "run: node ./scripts/release/validate-release.mjs $env:GITHUB_WORKSPACE 0.1.3",
    "",
  ].join("\n"));
  writeText(
    root,
    ".github/workflows/release.yml",
    `ref: ${EXPECTED_CLAUDE_PLUSPLUS_COMMIT}\n`,
  );
  return root;
}

function updateJson(root, relativePath, patch) {
  const target = join(root, relativePath);
  const current = JSON.parse(readFileSync(target, "utf8"));
  writeJson(root, relativePath, { ...current, ...patch });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("accepts the Claude tweak 0.1.3 release contract", () => {
  assert.deepEqual(validateRelease(fixtureRoot(), "0.1.3"), {
    version: "0.1.3",
    tag: "v0.1.3",
  });
});

test("rejects non-stable versions", () => {
  for (const version of ["v0.1.3", "0.1", "0.1.3-beta.1", "latest"]) {
    assert.throws(() => validateRelease(fixtureRoot(), version), /stable MAJOR\.MINOR\.PATCH/);
  }
});

test("rejects manifest and package version mismatches", () => {
  for (const relativePath of ["manifest.json", "package.json"]) {
    const root = fixtureRoot();
    updateJson(root, relativePath, { version: "0.1.0" });
    assert.throws(() => validateRelease(root, "0.1.3"), new RegExp(relativePath));
  }
});

test("rejects a manifest that drifts from the Claude++ contract", () => {
  for (const [patch, expected] of [
    [{ id: "example.wrong" }, /com\.kpk\.unity-asset-links/],
    [{ githubRepo: "kpkhxlgy0/unity-links-codex" }, /unity-links-claude/],
    [{ minRuntime: "0.2.1" }, /minRuntime/],
    [{ scope: "renderer" }, /scope/],
    [{ main: "other.js" }, /main/],
    [{ permissions: ["ipc"] }, /permissions/],
  ]) {
    const root = fixtureRoot();
    updateJson(root, "manifest.json", patch);
    assert.throws(() => validateRelease(root, "0.1.3"), expected);
  }
});

test("rejects missing or incorrect icon metadata", () => {
  const wrongUrl = fixtureRoot();
  updateJson(wrongUrl, "manifest.json", { iconUrl: "https://example.com/icon.png" });
  assert.throws(() => validateRelease(wrongUrl, "0.1.3"), /iconUrl/);

  const missingIcon = fixtureRoot();
  rmSync(join(missingIcon, "icon.png"));
  assert.throws(() => validateRelease(missingIcon, "0.1.3"), /icon\.png/);
});

test("rejects missing or incorrect MIT metadata", () => {
  const missingLicense = fixtureRoot();
  rmSync(join(missingLicense, "LICENSE"));
  assert.throws(() => validateRelease(missingLicense, "0.1.3"), /LICENSE/);

  const wrongCopyright = fixtureRoot();
  writeFileSync(join(wrongCopyright, "LICENSE"), "MIT License\nCopyright (c) 2026 Someone Else\n");
  assert.throws(() => validateRelease(wrongCopyright, "0.1.3"), /Copyright \(c\) 2026 KPK/);

  const wrongLicense = fixtureRoot();
  updateJson(wrongLicense, "package.json", { license: "Apache-2.0" });
  assert.throws(() => validateRelease(wrongLicense, "0.1.3"), /license must be MIT/);
});

test("rejects missing required distribution files", () => {
  for (const relativePath of [
    "index.js",
    "README.md",
    "README.zh-CN.md",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "scripts/compatibility/validate-claudeplusplus.mjs",
    "scripts/send-open.js",
  ]) {
    const root = fixtureRoot();
    rmSync(join(root, relativePath));
    assert.throws(() => validateRelease(root, "0.1.3"), new RegExp(relativePath.replace(".", "\\.")));
  }
});

test("rejects workflows pinned to another Claude++ release", () => {
  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    const root = fixtureRoot();
    writeText(root, relativePath, "ref: 9d4522e0bb5effd3722cca8a488bf0955e06ed0a\n");
    assert.throws(() => validateRelease(root, "0.1.3"), new RegExp(relativePath.replace(".", "\\.")));
  }
});

test("rejects CI validation pinned to another Tweak version", () => {
  const root = fixtureRoot();
  writeText(root, ".github/workflows/ci.yml", [
    `ref: ${EXPECTED_CLAUDE_PLUSPLUS_COMMIT}`,
    "run: node ./scripts/release/validate-release.mjs $env:GITHUB_WORKSPACE 0.1.2",
    "",
  ].join("\n"));
  assert.throws(() => validateRelease(root, "0.1.3"), /\.github\/workflows\/ci\.yml/);
});

test("rejects files outside the public distribution allowlist", () => {
  const root = fixtureRoot();
  writeText(root, "private-notes.txt");
  assert.throws(() => validateRelease(root, "0.1.3"), /private-notes\.txt/);
});

test("ignores the Git pointer file used by submodule checkouts", () => {
  const root = fixtureRoot();
  writeText(root, ".git", "gitdir: ../.git/modules/claude-tweak\n");
  assert.deepEqual(validateRelease(root, "0.1.3"), {
    version: "0.1.3",
    tag: "v0.1.3",
  });
});
