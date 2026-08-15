import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const EXPECTED_ID = "com.kpk.unity-asset-links";
const EXPECTED_REPOSITORY = "kpkhxlgy0/unity-links-claude";
const EXPECTED_ICON = "./icon.png";
const EXPECTED_MIN_RUNTIME = "0.2.3";
const EXPECTED_CLAUDE_PLUSPLUS_COMMIT = "4f78b1f31c4075ab60d7d4e819476e24b00023ed";
const EXPECTED_SCOPE = "both";
const EXPECTED_MAIN = "index.js";
const EXPECTED_PERMISSIONS = ["ipc", "filesystem", "claude-sessions"];
const EXPECTED_COPYRIGHT = "Copyright (c) 2026 KPK";
const REQUIRED_FILES = [
  ".gitignore",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "icon.png",
  "index.js",
  "manifest.json",
  "package.json",
  "test/index.test.js",
  "scripts/compatibility/validate-claudeplusplus.mjs",
  "scripts/compatibility/validate-claudeplusplus.test.mjs",
  "scripts/release/validate-release.mjs",
  "scripts/release/validate-release.test.mjs",
  "scripts/send-open.js",
];
const ALLOWED_FILES = new Set([
  ".gitignore",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "icon.png",
  "index.js",
  "manifest.json",
  "package.json",
  "scripts/send-open.js",
]);
const ALLOWED_PREFIXES = [
  ".github/",
  "scripts/compatibility/",
  "scripts/release/",
  "test/",
];
const IGNORED_ENTRIES = new Set([".git", ".ci-tools", ".release-tools", "node_modules"]);

function readJson(repositoryRoot, relativePath, errors) {
  try {
    return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function listDistributionFiles(repositoryRoot) {
  const files = [];
  const visit = (directory, relativeDirectory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else files.push(relativePath);
    }
  };
  visit(repositoryRoot, "");
  return files.sort();
}

function isAllowedDistributionFile(relativePath) {
  return ALLOWED_FILES.has(relativePath)
    || ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export function validateRelease(repositoryRoot, requestedVersion) {
  const errors = [];
  if (!STABLE_VERSION.test(requestedVersion)) {
    errors.push(`version must be a stable MAJOR.MINOR.PATCH value without v: ${requestedVersion}`);
  }

  const tweakManifest = readJson(repositoryRoot, "manifest.json", errors);
  const tweakPackage = readJson(repositoryRoot, "package.json", errors);

  for (const [relativePath, json] of [
    ["manifest.json", tweakManifest],
    ["package.json", tweakPackage],
  ]) {
    if (json && json.version !== requestedVersion) {
      errors.push(`${relativePath}: version must be ${requestedVersion}, got ${String(json.version)}`);
    }
  }

  if (tweakManifest?.id !== EXPECTED_ID) {
    errors.push(`manifest.json: id must be ${EXPECTED_ID}`);
  }
  if (tweakManifest?.githubRepo !== EXPECTED_REPOSITORY) {
    errors.push(`manifest.json: githubRepo must be ${EXPECTED_REPOSITORY}`);
  }
  if (tweakManifest?.iconUrl !== EXPECTED_ICON) {
    errors.push(`manifest.json: iconUrl must be ${EXPECTED_ICON}`);
  }
  if (tweakManifest?.minRuntime !== EXPECTED_MIN_RUNTIME) {
    errors.push(`manifest.json: minRuntime must be ${EXPECTED_MIN_RUNTIME}`);
  }
  if (tweakManifest?.scope !== EXPECTED_SCOPE) {
    errors.push(`manifest.json: scope must be ${EXPECTED_SCOPE}`);
  }
  if (tweakManifest?.main !== EXPECTED_MAIN) {
    errors.push(`manifest.json: main must be ${EXPECTED_MAIN}`);
  }
  if (JSON.stringify(tweakManifest?.permissions) !== JSON.stringify(EXPECTED_PERMISSIONS)) {
    errors.push(`manifest.json: permissions must be ${JSON.stringify(EXPECTED_PERMISSIONS)}`);
  }
  if (tweakPackage?.license !== "MIT") {
    errors.push("package.json: license must be MIT");
  }

  if (!existsSync(resolve(repositoryRoot, "icon.png"))) {
    errors.push("icon.png: required tweak icon is missing");
  }

  try {
    const license = readFileSync(resolve(repositoryRoot, "LICENSE"), "utf8");
    if (!license.includes("MIT License")) errors.push("LICENSE: MIT License heading is missing");
    if (!license.includes(EXPECTED_COPYRIGHT)) errors.push(`LICENSE: ${EXPECTED_COPYRIGHT} is missing`);
  } catch (error) {
    errors.push(`LICENSE: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(resolve(repositoryRoot, relativePath))) {
      errors.push(`${relativePath}: required distribution file is missing`);
    }
  }
  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    try {
      const workflow = readFileSync(resolve(repositoryRoot, relativePath), "utf8");
      if (!workflow.includes(`ref: ${EXPECTED_CLAUDE_PLUSPLUS_COMMIT}`)) {
        errors.push(`${relativePath}: Claude++ ref must be ${EXPECTED_CLAUDE_PLUSPLUS_COMMIT}`);
      }
    } catch (error) {
      errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const ciWorkflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const validationCommand =
      `node ./scripts/release/validate-release.mjs $env:GITHUB_WORKSPACE ${requestedVersion}`;
    if (!ciWorkflow.includes(validationCommand)) {
      errors.push(`.github/workflows/ci.yml: release validation must use ${requestedVersion}`);
    }
  } catch (error) {
    errors.push(`.github/workflows/ci.yml: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    for (const relativePath of listDistributionFiles(repositoryRoot)) {
      if (!isAllowedDistributionFile(relativePath)) {
        errors.push(`${relativePath}: file is outside the public distribution allowlist`);
      }
    }
  } catch (error) {
    errors.push(`distribution: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { version: requestedVersion, tag: `v${requestedVersion}` };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const repositoryRoot = process.argv[2];
    const requestedVersion = process.argv[3];
    if (!repositoryRoot || !requestedVersion) {
      throw new Error("usage: validate-release.mjs <repository-root> <version>");
    }
    const result = validateRelease(repositoryRoot, requestedVersion);
    console.log(`release-validation=passed version=${result.version} tag=${result.tag}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
