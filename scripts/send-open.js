const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { __test } = require("../index.js");

async function main() {
  const parsed = __test.parseDestination(process.argv[2]);
  if (!parsed) throw new Error("Pass an absolute Windows asset path.");
  const target = __test.findUnityTarget(parsed.path, fs, path);
  if (!target.ok) throw new Error(target.code);
  const requestId = crypto.randomUUID();
  const pipeName = __test.pipeNameForProjectRoot(target.projectRoot, crypto, path);
  const response = await __test.sendPipeRequest(
    "\\\\.\\pipe\\" + pipeName,
    {
      version: 1,
      requestId,
      action: "openAsset",
      projectRoot: target.projectRoot,
      assetPath: target.assetPath,
      line: parsed.line,
      column: parsed.column,
    },
    { net, connectTimeoutMs: 300, responseTimeoutMs: 2500 },
  );
  process.stdout.write(JSON.stringify(response) + "\n");
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
