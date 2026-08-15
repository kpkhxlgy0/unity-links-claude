import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_RUNTIME_VERSION = "0.2.3";
const EXPECTED_CHANNEL = "claudepp:com.kpk.unity-asset-links:open-asset";

function silentLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function rendererApi(manifest) {
  return {
    manifest,
    process: "renderer",
    storage: {
      get: (_key, fallback) => fallback,
      set() {},
      delete() {},
      all: () => ({}),
    },
    log: silentLog(),
    ipc: {
      on: () => () => {},
      send() {},
      invoke: async () => ({ handled: false }),
    },
    fs: {
      dataDir: "<compatibility>",
      read: async () => "",
      write: async () => {},
      exists: async () => false,
    },
  };
}

function documentFixture() {
  const listeners = new Map();
  return {
    document: {
      addEventListener(name, handler) {
        const handlers = listeners.get(name) ?? new Set();
        handlers.add(handler);
        listeners.set(name, handlers);
      },
      removeEventListener(name, handler) {
        listeners.get(name)?.delete(handler);
      },
      createElement() {
        return {
          dataset: {},
          style: {},
          remove() {},
        };
      },
      body: { append() {} },
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

function mainIpcBridge() {
  const handlers = new Map();
  return {
    bridge: {
      on() {},
      removeListener() {},
      handle(channel, handler) {
        if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
      getWebContents: () => [],
    },
    handlerCount(channel) {
      return handlers.has(channel) ? 1 : 0;
    },
  };
}

function formatManifestErrors(errors) {
  return errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

export async function validateCompatibility({ manifest, source, tweakEntry, host }) {
  const validation = host.validateTweakManifest(manifest);
  if (!validation.ok) throw new Error(formatManifestErrors(validation.errors));
  if (host.runtimeVersion !== EXPECTED_RUNTIME_VERSION) {
    throw new Error(`Claude++ runtime must be ${EXPECTED_RUNTIME_VERSION}, got ${host.runtimeVersion}`);
  }

  const fixture = documentFixture();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fixture.document,
    writable: true,
  });
  try {
    const tweak = host.evaluateRendererTweak(source, tweakEntry, rendererApi(manifest));
    await tweak.start(rendererApi(manifest));
    assert.equal(fixture.listenerCount("click"), 1, "Renderer must register one click listener");
    await tweak.stop?.();
    assert.equal(fixture.listenerCount("click"), 0, "Renderer must remove its click listener");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }

  const userRoot = mkdtempSync(join(tmpdir(), "unity-links-claude-compatibility-"));
  try {
    const tweak = host.loadMainTweak(tweakEntry);
    const ipc = mainIpcBridge();
    const options = {
      manifest,
      userRoot,
      log: silentLog(),
      ipc: ipc.bridge,
    };

    const first = host.createMainTweakApiLease(options);
    tweak.__test.startMain(first.api, { compatibility: true });
    assert.equal(ipc.handlerCount(EXPECTED_CHANNEL), 1, "First lease must own one Main handler");
    await first.dispose();
    assert.equal(ipc.handlerCount(EXPECTED_CHANNEL), 0, "Disposed lease must remove its Main handler");

    const second = host.createMainTweakApiLease(options);
    tweak.__test.startMain(second.api, { compatibility: true });
    assert.equal(ipc.handlerCount(EXPECTED_CHANNEL), 1, "Second lease must re-register one Main handler");
    await second.dispose();
    assert.equal(ipc.handlerCount(EXPECTED_CHANNEL), 0, "Second disposed lease must remove its handler");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }

  return {
    runtimeVersion: host.runtimeVersion,
    tweakVersion: manifest.version,
  };
}

async function loadClaudeHost(claudeRoot) {
  const sdk = await import(pathToFileURL(resolve(claudeRoot, "packages/sdk/src/index.ts")));
  const rendererHost = await import(
    pathToFileURL(resolve(claudeRoot, "packages/runtime/src/preload/tweak-host.ts"))
  );
  const tweakApi = await import(
    pathToFileURL(resolve(claudeRoot, "packages/runtime/src/tweak-api.ts"))
  );
  const runtimePackage = JSON.parse(readFileSync(resolve(claudeRoot, "package.json"), "utf8"));
  return {
    runtimeVersion: runtimePackage.version,
    validateTweakManifest: sdk.validateTweakManifest,
    evaluateRendererTweak: rendererHost.evaluateRendererTweak,
    createMainTweakApiLease: tweakApi.createMainTweakApiLease,
    loadMainTweak: (entry) => createRequire(import.meta.url)(entry),
  };
}

export async function runCompatibility(claudeRoot, tweakRoot) {
  const tweakEntry = resolve(tweakRoot, "index.js");
  const manifest = JSON.parse(readFileSync(resolve(tweakRoot, "manifest.json"), "utf8"));
  const source = readFileSync(tweakEntry, "utf8");
  return validateCompatibility({
    manifest,
    source,
    tweakEntry,
    host: await loadClaudeHost(claudeRoot),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const claudeRoot = process.argv[2];
    const tweakRoot = process.argv[3];
    if (!claudeRoot || !tweakRoot) {
      throw new Error(
        "usage: validate-claudeplusplus.mjs <claude-plusplus-root> <tweak-root>",
      );
    }
    const result = await runCompatibility(claudeRoot, tweakRoot);
    console.log(
      `claudeplusplus-compatibility=passed runtime=${result.runtimeVersion} tweak=${result.tweakVersion}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
