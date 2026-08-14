import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateCompatibility } from "./validate-claudeplusplus.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const tweakRoot = resolve(scriptRoot, "../..");
const manifest = JSON.parse(readFileSync(resolve(tweakRoot, "manifest.json"), "utf8"));
const source = readFileSync(resolve(tweakRoot, "index.js"), "utf8");

function hostAdapter(overrides = {}) {
  return {
    runtimeVersion: "0.2.1",
    validateTweakManifest: () => ({ ok: true, errors: [], warnings: [] }),
    evaluateRendererTweak(value, filename, api) {
      const module = { exports: {} };
      const factory = new Function(
        "module",
        "exports",
        "console",
        "api",
        "require",
        `${value}\n//# sourceURL=${filename}`,
      );
      factory(module, module.exports, console, api, undefined);
      return module.exports;
    },
    createMainTweakApiLease(options) {
      const channels = new Set();
      return {
        api: {
          manifest: options.manifest,
          process: "main",
          storage: { get: (_key, fallback) => fallback, set() {}, delete() {}, all: () => ({}) },
          log: options.log,
          fs: {
            dataDir: "<test>",
            read: async () => "",
            write: async () => {},
            exists: async () => false,
          },
          ipc: {
            on: () => () => {},
            send() {},
            invoke: async () => { throw new Error("main cannot invoke renderer"); },
            handle(channel, handler) {
              const namespaced = `claudepp:${options.manifest.id}:${channel}`;
              options.ipc.handle(namespaced, handler);
              channels.add(namespaced);
            },
          },
        },
        async dispose() {
          for (const channel of channels) options.ipc.removeHandler(channel);
          channels.clear();
        },
      };
    },
    loadMainTweak: (entry) => createRequire(import.meta.url)(entry),
    ...overrides,
  };
}

test("validates renderer evaluation and Main lease cleanup through the Claude++ contract", async () => {
  const result = await validateCompatibility({
    manifest,
    source,
    tweakEntry: resolve(tweakRoot, "index.js"),
    host: hostAdapter(),
  });

  assert.deepEqual(result, {
    runtimeVersion: "0.2.1",
    tweakVersion: "0.1.0",
  });
});

test("rejects a manifest refused by the Claude++ SDK", async () => {
  await assert.rejects(
    () => validateCompatibility({
      manifest,
      source,
      tweakEntry: resolve(tweakRoot, "index.js"),
      host: hostAdapter({
        validateTweakManifest: () => ({
          ok: false,
          errors: [{ path: "permissions", message: "invalid" }],
          warnings: [],
        }),
      }),
    }),
    /permissions: invalid/,
  );
});

test("rejects a Claude++ runtime outside the pinned compatibility baseline", async () => {
  await assert.rejects(
    () => validateCompatibility({
      manifest,
      source,
      tweakEntry: resolve(tweakRoot, "index.js"),
      host: hostAdapter({ runtimeVersion: "0.2.2" }),
    }),
    /runtime must be 0\.2\.1/,
  );
});
