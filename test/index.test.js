const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { __test } = require("../index.js");

const windowsPath = path.win32;

function createVirtualFs({ files = [], directories = [] }) {
  const normalize = (value) => windowsPath.normalize(value).toLowerCase();
  const fileKeys = new Set(files.map(normalize));
  const directoryKeys = new Set(directories.map(normalize));
  for (const value of [...files, ...directories]) {
    let current = windowsPath.dirname(windowsPath.normalize(value));
    while (true) {
      directoryKeys.add(normalize(current));
      const parent = windowsPath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return {
    existsSync(value) {
      const key = normalize(value);
      return fileKeys.has(key) || directoryKeys.has(key);
    },
    realpathSync(value) {
      const normalized = windowsPath.normalize(value);
      const key = normalize(normalized);
      if (!fileKeys.has(key) && !directoryKeys.has(key)) throw new Error("Path not found");
      return normalized;
    },
    statSync(value) {
      const key = normalize(value);
      if (!fileKeys.has(key) && !directoryKeys.has(key)) throw new Error("Path not found");
      return { isFile: () => fileKeys.has(key) };
    },
    lstatSync(value) {
      const key = normalize(value);
      if (!fileKeys.has(key) && !directoryKeys.has(key)) throw new Error("Path not found");
      return { isSymbolicLink: () => false };
    },
  };
}

function createNativeReferenceClickFixture(
  text,
  entryId = null,
  matchingReferenceCount = 1,
  referenceOccurrence = 0,
) {
  const listeners = new Map();
  let entry;
  const button = {
    clicks: 0,
    click() {
      this.clicks += 1;
    },
    querySelector(selector) {
      if (selector === "code") return { textContent: text };
      return null;
    },
    closest(selector) {
      if (selector !== "[data-epitaxy-entry]" || entryId === null) return null;
      return entry;
    },
  };
  const matchingReferences = Array.from({ length: matchingReferenceCount }, () => ({
    querySelector(selector) {
      return selector === "code" ? { textContent: text } : null;
    },
  }));
  matchingReferences[referenceOccurrence] = button;
  entry = {
    getAttribute(name) {
      return name === "data-epitaxy-entry" ? entryId : null;
    },
    querySelectorAll(selector) {
      return selector === 'span[role="button"]' ? matchingReferences : [];
    },
  };
  const documentApi = {
    location: {
      href: "app://localhost/epitaxy/local-session-id",
    },
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === 'span[role="button"]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };
  return { button, documentApi, event, listeners };
}

test("parses Windows paths with line and column", () => {
  assert.deepEqual(
    __test.parseDestination("D:/Projects/ExampleUnityProject/Assets/GameEntry.cs:12:4"),
    {
      path: "D:\\Projects\\ExampleUnityProject\\Assets\\GameEntry.cs",
      line: 12,
      column: 4,
    },
  );
});

test("parses file URLs emitted by Markdown renderers", () => {
  assert.deepEqual(
    __test.parseDestination("file:///D:/Projects/ExampleUnityProject/Assets/Light.prefab"),
    {
      path: "D:\\Projects\\ExampleUnityProject\\Assets\\Light.prefab",
      line: 0,
      column: 0,
    },
  );
});

test("preserves line and column fragments from Markdown file URLs", () => {
  assert.deepEqual(
    __test.parseDestination(
      "file:///D:/Projects/ExampleUnityProject/Assets/GameEntry.cs#L54C7",
    ),
    {
      path: "D:\\Projects\\ExampleUnityProject\\Assets\\GameEntry.cs",
      line: 54,
      column: 7,
    },
  );
});

test("rejects web URLs and relative paths", () => {
  assert.equal(__test.parseDestination("https://example.com/Assets/a.prefab"), null);
  assert.equal(__test.parseDestination("Assets/a.prefab"), null);
});

test("extracts the Claude session id from an epitaxy route", () => {
  assert.equal(
    __test.parseClaudeSessionId("app://localhost/epitaxy/local_c13f9cc9-bd27-430f-afdc-5c03bdfa23b6"),
    "local_c13f9cc9-bd27-430f-afdc-5c03bdfa23b6",
  );
  assert.equal(__test.parseClaudeSessionId("app://localhost/settings/general"), null);
  assert.equal(__test.parseClaudeSessionId("https://example.com/epitaxy/session"), null);
});

test("recognizes supported Unity project folders only as complete segments", () => {
  assert.equal(__test.hasSupportedProjectSegment("D:\\p\\Assets\\a.prefab"), true);
  assert.equal(
    __test.hasSupportedProjectSegment("D:\\p\\ProjectSettings\\EditorBuildSettings.asset"),
    true,
  );
  assert.equal(__test.hasSupportedProjectSegment("D:\\p\\Packages\\manifest.json"), true);
  assert.equal(__test.hasSupportedProjectSegment("D:\\p\\AssetsBackup\\a.prefab"), false);
  assert.equal(__test.hasSupportedProjectSegment("D:\\p\\ProjectSettingsBackup\\a.asset"), false);
  assert.equal(__test.hasSupportedProjectSegment("D:\\p\\PackagesBackup\\manifest.json"), false);
});

test("accepts only an unmodified primary click", () => {
  assert.equal(
    __test.isEligibleClick({
      button: 0,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }),
    true,
  );
  assert.equal(
    __test.isEligibleClick({
      button: 0,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    }),
    false,
  );
});

test("builds a deterministic case-insensitive project Pipe name", () => {
  const actual = __test.pipeNameForProjectRoot(
    "D:\\Projects\\ExampleUnityProject\\",
    crypto,
    path.win32,
  );
  assert.equal(
    actual,
    "kpk-codex-unity-link-v1-562b1e523731c184d83aaafbb3ca32da391c438f759d8aacfbb2200d470b9bda",
  );
});

test("finds the nearest Unity root and produces an Assets path", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const data = windowsPath.join(assets, "Data");
  const file = windowsPath.join(data, "A.asset");
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({ files: [file, version], directories: [assets, data] });

  const result = __test.findUnityTarget(file, fsApi, windowsPath);

  assert.equal(result.ok, true);
  assert.equal(result.assetPath, "Assets/Data/A.asset");
});

test("finds the nearest Unity root and produces a ProjectSettings path", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const settings = windowsPath.join(root, "ProjectSettings");
  const file = windowsPath.join(settings, "EditorBuildSettings.asset");
  const version = windowsPath.join(settings, "ProjectVersion.txt");
  const fsApi = createVirtualFs({
    files: [file, version],
    directories: [assets, settings],
  });

  const result = __test.findUnityTarget(file, fsApi, windowsPath);

  assert.equal(result.ok, true);
  assert.equal(result.assetPath, "ProjectSettings/EditorBuildSettings.asset");
});

test("finds the nearest Unity root and produces a Packages path", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const packages = windowsPath.join(root, "Packages");
  const file = windowsPath.join(packages, "manifest.json");
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({
    files: [file, version],
    directories: [assets, packages],
  });

  const result = __test.findUnityTarget(file, fsApi, windowsPath);

  assert.equal(result.ok, true);
  assert.equal(result.assetPath, "Packages/manifest.json");
});

test("does not route a directory or a file outside supported Unity project folders", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const outside = windowsPath.join(root, "outside.txt");
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({ files: [outside, version], directories: [assets] });

  assert.equal(__test.findUnityTarget(assets, fsApi, windowsPath).code, "notAssetFile");
  assert.equal(__test.findUnityTarget(outside, fsApi, windowsPath).code, "notAssetFile");
});

test("does not route a path through a reparse-point alias inside a supported folder", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const aliasRoot = windowsPath.join(assets, "Alias");
  const aliasFile = windowsPath.join(aliasRoot, "A.asset");
  const targetRoot = windowsPath.join(assets, "Target");
  const targetFile = windowsPath.join(targetRoot, "A.asset");
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({
    files: [aliasFile, targetFile, version],
    directories: [assets, aliasRoot, targetRoot],
  });
  fsApi.realpathSync = (value) => (
    windowsPath.normalize(value).toLowerCase() === aliasFile.toLowerCase()
      ? targetFile
      : windowsPath.normalize(value)
  );
  fsApi.lstatSync = (value) => ({
    isSymbolicLink: () => (
      windowsPath.normalize(value).toLowerCase() === aliasRoot.toLowerCase()
    ),
  });

  const result = __test.findUnityTarget(aliasFile, fsApi, windowsPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, "notAssetFile");
});

test("does not route a path containing a lexical traversal segment", () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const packages = windowsPath.join(root, "Packages");
  const file = windowsPath.join(packages, "manifest.json");
  const traversing = root + "\\ProjectSettings\\..\\Packages\\manifest.json";
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({
    files: [file, version],
    directories: [assets, packages],
  });

  const result = __test.findUnityTarget(traversing, fsApi, windowsPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, "notAssetFile");
});

test("does not route a path through a Unity project-root junction", () => {
  const aliasRoot = "D:\\Projects\\AliasUnityProject";
  const realRoot = "D:\\Projects\\RealUnityProject";
  const aliasAssets = windowsPath.join(aliasRoot, "Assets");
  const realAssets = windowsPath.join(realRoot, "Assets");
  const aliasFile = windowsPath.join(aliasAssets, "A.asset");
  const realFile = windowsPath.join(realAssets, "A.asset");
  const aliasVersion = windowsPath.join(aliasRoot, "ProjectSettings", "ProjectVersion.txt");
  const realVersion = windowsPath.join(realRoot, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({
    files: [aliasFile, realFile, aliasVersion, realVersion],
    directories: [aliasAssets, realAssets],
  });
  const baseRealpathSync = fsApi.realpathSync;
  const baseLstatSync = fsApi.lstatSync;
  fsApi.realpathSync = (value) => {
    const normalized = windowsPath.normalize(value).toLowerCase();
    if (normalized === aliasFile.toLowerCase()) return realFile;
    if (normalized === aliasRoot.toLowerCase()) return realRoot;
    return baseRealpathSync(value);
  };
  fsApi.lstatSync = (value) => {
    if (windowsPath.normalize(value).toLowerCase() === aliasRoot.toLowerCase()) {
      return { isSymbolicLink: () => true };
    }
    return baseLstatSync(value);
  };

  const result = __test.findUnityTarget(aliasFile, fsApi, windowsPath);

  assert.equal(result.ok, false);
  assert.equal(result.code, "notAssetFile");
});

test("resolves unique Unity workspace references without Git metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-unity-workspace-"));
  try {
    mkdirSync(path.join(root, "Assets", "Scripts", "Deep"), { recursive: true });
    mkdirSync(path.join(root, "ProjectSettings"), { recursive: true });
    mkdirSync(path.join(root, "Packages"), { recursive: true });
    writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: test\n");
    for (const relativePath of [
      "Assets/Scripts/Deep/GameEntry.cs",
      "Assets/Light.prefab",
      "Assets/Battle_00001_Test.unity",
    ]) {
      const target = path.join(root, ...relativePath.split("/"));
      const contents = `fixture:${relativePath}\n`;
      writeFileSync(target, contents);
      const resolved = await __test.resolveUnityWorkspaceReference(
        root,
        path.basename(target),
        require("node:fs"),
        path,
      );
      assert.notEqual(resolved, null);
      assert.equal(readFileSync(resolved, "utf8"), contents);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not choose between duplicate Unity workspace filenames", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-unity-workspace-"));
  try {
    mkdirSync(path.join(root, "Assets", "A"), { recursive: true });
    mkdirSync(path.join(root, "Assets", "B"), { recursive: true });
    mkdirSync(path.join(root, "ProjectSettings"), { recursive: true });
    writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: test\n");
    writeFileSync(path.join(root, "Assets", "A", "Duplicate.prefab"), "a\n");
    writeFileSync(path.join(root, "Assets", "B", "Duplicate.prefab"), "b\n");

    assert.equal(
      await __test.resolveUnityWorkspaceReference(root, "Duplicate.prefab", require("node:fs"), path),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not match a partial Unity workspace filename suffix", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-unity-workspace-"));
  try {
    mkdirSync(path.join(root, "Assets"), { recursive: true });
    mkdirSync(path.join(root, "ProjectSettings"), { recursive: true });
    writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: test\n");
    writeFileSync(path.join(root, "Assets", "NotGameEntry.cs"), "fixture\n");

    assert.equal(
      await __test.resolveUnityWorkspaceReference(root, "GameEntry.cs", require("node:fs"), path),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("round trips one newline-delimited request over a Windows Pipe", async () => {
  const pipeName = "kpk-codex-unity-link-test-" + process.pid + "-" + Date.now();
  const pipePath = "\\\\.\\pipe\\" + pipeName;
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString("utf8").trim());
      socket.end(JSON.stringify({
        version: 1,
        requestId: request.requestId,
        ok: true,
        code: "opened",
        message: "",
      }) + "\n");
    });
  });
  await new Promise((resolve, reject) => server.listen(pipePath, resolve).once("error", reject));
  try {
    const response = await __test.sendPipeRequest(
      pipePath,
      { version: 1, requestId: "r1", action: "openAsset" },
      { net, connectTimeoutMs: 300, responseTimeoutMs: 1000 },
    );
    assert.equal(response.code, "opened");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("gracefully closes the Pipe after a successful response", async () => {
  const socket = new EventEmitter();
  let ended = false;
  let destroyed = false;
  socket.setEncoding = () => {};
  socket.write = () => {
    queueMicrotask(() => socket.emit("data", '{"ok":true,"code":"opened"}\n'));
  };
  socket.end = () => {
    ended = true;
  };
  socket.destroy = () => {
    destroyed = true;
  };
  const request = __test.sendPipeRequest(
    "fake-pipe",
    { version: 1, requestId: "r1", action: "openAsset" },
    {
      net: {
        createConnection() {
          queueMicrotask(() => socket.emit("connect"));
          return socket;
        },
      },
      connectTimeoutMs: 300,
      responseTimeoutMs: 1000,
    },
  );

  assert.equal((await request).code, "opened");
  assert.equal(ended, true);
  assert.equal(destroyed, false);
});

test("registers the two focused Main IPC handlers for every Claude++ API lease", () => {
  const key = Symbol.for("com.kpk.unity-asset-links.main-runtime");
  delete globalThis[key];
  let firstRegistrations = 0;
  let secondRegistrations = 0;
  const firstApi = {
    ipc: {
      handle() {
        firstRegistrations += 1;
      },
    },
  };
  const secondApi = {
    ipc: {
      handle() {
        secondRegistrations += 1;
      },
    },
  };

  __test.startMain(firstApi, {});
  __test.startMain(secondApi, {});

  assert.equal(firstRegistrations, 2);
  assert.equal(secondRegistrations, 2);
  delete globalThis[key];
});

test("reveals an asset when the matching Unity Pipe is unavailable", async () => {
  const root = "D:\\Projects\\ExampleUnityProject";
  const assets = windowsPath.join(root, "Assets");
  const file = windowsPath.join(assets, "A.asset");
  const version = windowsPath.join(root, "ProjectSettings", "ProjectVersion.txt");
  const fsApi = createVirtualFs({ files: [file, version], directories: [assets] });
  const revealed = [];
  const result = await __test.handleOpenAsset(
    { path: file, line: 0, column: 0 },
    {
      crypto,
      fs: fsApi,
      net,
      path: windowsPath,
      shell: {
        showItemInFolder(value) {
          revealed.push(value);
        },
        openPath: async () => "",
      },
      log: { warn() {} },
      sendPipeRequest: async () => {
        throw new Error("unavailable");
      },
    },
  );

  assert.equal(result.code, "unityUnavailable");
  assert.deepEqual(revealed, [file]);
});

test("renderer captures one eligible Assets link and cleans up", async () => {
  const listeners = new Map();
  const anchor = {
    getAttribute() {
      return "D:/Projects/ExampleUnityProject/Assets/Light.prefab";
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
    createElement() {
      return {
        dataset: {},
        style: {},
        remove() {},
      };
    },
  };
  const api = {
    ipc: {
      invoke: async () => ({ ok: true, handled: true, code: "opened" }),
    },
  };
  __test.startRenderer(api, documentApi);
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { closest: () => anchor },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };
  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true);
  __test.stopRenderer();
  assert.equal(listeners.has("click"), false);
});

test("renderer captures Claude file-reference buttons", async () => {
  const listeners = new Map();
  const button = {
    getAttribute(name) {
      if (name === "data-prompt-link-href") {
        return "D:/Projects/ExampleUnityProject/Assets/Light.prefab";
      }
      return null;
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  const opened = [];
  __test.startRenderer(
    {
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === '[data-file-reference="true"][data-prompt-link-href]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };

  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\Assets\\Light.prefab",
    line: 0,
    column: 0,
  }]);
  __test.stopRenderer();
});

test("renderer captures current Claude code file-reference buttons", async () => {
  const listeners = new Map();
  const code = {
    textContent: "D:\\Projects\\ExampleUnityProject\\Assets\\Light.prefab:12",
  };
  const button = {
    querySelector(selector) {
      if (selector === "code") return code;
      return null;
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  const opened = [];
  __test.startRenderer(
    {
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === 'span[role="button"]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };

  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\Assets\\Light.prefab",
    line: 12,
    column: 0,
  }]);
  __test.stopRenderer();
});

test("renderer leaves relative current Claude code references unchanged", async () => {
  const listeners = new Map();
  const button = {
    querySelector() {
      return { textContent: "Assets/Light.prefab" };
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  let invokeCount = 0;
  __test.startRenderer(
    { ipc: { invoke: async () => { invokeCount += 1; } } },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === 'span[role="button"]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };

  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.defaultPrevented, false);
  assert.equal(invokeCount, 0);
  __test.stopRenderer();
});

test("renderer resolves native Claude file references through the current session", async () => {
  for (const item of [
    {
      text: "GameEntry.cs:7",
      resolved: "D:\\Projects\\ExampleUnityProject\\Assets\\GameEntry.cs",
      line: 7,
    },
    {
      text: "Waiting.prefab",
      resolved: "D:\\Projects\\ExampleUnityProject\\Assets\\Waiting.prefab",
      line: 0,
    },
    {
      text: "GameEntry.unity",
      resolved: "D:\\Projects\\ExampleUnityProject\\Assets\\GameEntry.unity",
      line: 0,
    },
  ]) {
    const fixture = createNativeReferenceClickFixture(item.text, "resp-file-links");
    const recovered = [];
    const resolved = [];
    const opened = [];
    __test.startRenderer(
      {
        claude: {
          sessions: {
            resolveReference: async (sessionId, entryId, label, occurrence, visibleCount) => {
              recovered.push([sessionId, entryId, label, occurrence, visibleCount]);
              return null;
            },
            resolveFile: async (sessionId, filePath) => {
              resolved.push([sessionId, filePath]);
              return item.resolved;
            },
          },
        },
        ipc: {
          invoke: async (_channel, destination) => {
            opened.push(destination);
            return { ok: true, handled: true, code: "opened" };
          },
        },
      },
      fixture.documentApi,
    );

    fixture.listeners.get("click")(fixture.event);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fixture.event.defaultPrevented, true);
    assert.deepEqual(recovered, [[
      "local-session-id",
      "resp-file-links",
      item.text.replace(/:\d+$/, ""),
      0,
      1,
    ]]);
    assert.deepEqual(resolved, [["local-session-id", item.text.replace(/:\d+$/, "")]]);
    assert.deepEqual(opened, [{
      path: item.resolved,
      line: item.line,
      column: 0,
    }]);
    assert.equal(fixture.button.clicks, 0);
    __test.stopRenderer();
  }
});

test("renderer recovers a native Claude reference's original file URL and line", async () => {
  const fixture = createNativeReferenceClickFixture("SSAILogicComponent.cs", "resp-file-links");
  const recovered = [];
  const opened = [];
  __test.startRenderer(
    {
      claude: {
        sessions: {
          resolveReference: async (sessionId, entryId, label, occurrence, visibleCount) => {
            recovered.push([sessionId, entryId, label, occurrence, visibleCount]);
            return "file:///D:/Projects/ExampleUnityProject/Assets/SSAILogicComponent.cs#L54";
          },
          resolveFile: async () => assert.fail("the recovered destination must be preferred"),
        },
      },
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    fixture.documentApi,
  );

  fixture.listeners.get("click")(fixture.event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.event.defaultPrevented, true);
  assert.deepEqual(recovered, [[
    "local-session-id",
    "resp-file-links",
    "SSAILogicComponent.cs",
    0,
    1,
  ]]);
  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\Assets\\SSAILogicComponent.cs",
    line: 54,
    column: 0,
  }]);
  assert.equal(fixture.button.clicks, 0);
  __test.stopRenderer();
});

test("renderer selects an unnumbered duplicate prefab reference by visible occurrence", async () => {
  const fixture = createNativeReferenceClickFixture("Boss.prefab", "resp-file-links", 2, 1);
  const opened = [];
  __test.startRenderer(
    {
      claude: {
        sessions: {
          resolveReference: async (_sessionId, _entryId, _label, occurrence, visibleCount) => {
            assert.equal(occurrence, 1);
            assert.equal(visibleCount, 2);
            return "file:///D:/Projects/ExampleUnityProject/Assets/Prefabs/Boss.prefab";
          },
          resolveFile: async () => assert.fail("the selected transcript reference must be preferred"),
        },
      },
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    fixture.documentApi,
  );

  fixture.listeners.get("click")(fixture.event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\Assets\\Prefabs\\Boss.prefab",
    line: 0,
    column: 0,
  }]);
  assert.equal(fixture.button.clicks, 0);
  __test.stopRenderer();
});

test("renderer falls back to the session workspace when Claude cannot resolve a native reference", async () => {
  const fixture = createNativeReferenceClickFixture("SSAILogicComponent.cs:9", "resp-file-links");
  const invoked = [];
  __test.startRenderer(
    {
      log: { info() {}, warn() {} },
      claude: {
        sessions: {
          resolveReference: async () => { throw new Error("transcript unavailable"); },
          resolveFile: async () => null,
          getWorkspaceRoot: async () => "D:\\Projects\\ExampleUnityProject",
        },
      },
      ipc: {
        invoke: async (channel, request) => {
          invoked.push([channel, request]);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    fixture.documentApi,
  );

  fixture.listeners.get("click")(fixture.event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.event.defaultPrevented, true);
  assert.deepEqual(invoked, [["resolve-workspace-asset", {
    workspaceRoot: "D:\\Projects\\ExampleUnityProject",
    referencePath: "SSAILogicComponent.cs",
    line: 9,
    column: 0,
  }]]);
  assert.equal(fixture.button.clicks, 0);
  __test.stopRenderer();
});

test("renderer replays Claude's native reference when session resolution fails", async () => {
  const fixture = createNativeReferenceClickFixture("Missing.prefab", "resp-file-links");
  __test.startRenderer(
    {
      claude: {
        sessions: {
          resolveReference: async () => null,
          resolveFile: async () => null,
        },
      },
      ipc: { invoke: async () => assert.fail("unresolved paths must not reach Main") },
    },
    fixture.documentApi,
  );

  fixture.listeners.get("click")(fixture.event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.event.defaultPrevented, true);
  assert.equal(fixture.button.clicks, 1);
  __test.stopRenderer();
});

test("renderer captures ProjectSettings file-reference buttons", async () => {
  const listeners = new Map();
  const button = {
    getAttribute(name) {
      if (name === "data-prompt-link-href") {
        return "D:/Projects/ExampleUnityProject/ProjectSettings/EditorBuildSettings.asset:8";
      }
      return null;
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  const opened = [];
  __test.startRenderer(
    {
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === '[data-file-reference="true"][data-prompt-link-href]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };

  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\ProjectSettings\\EditorBuildSettings.asset",
    line: 8,
    column: 0,
  }]);
  __test.stopRenderer();
});

test("renderer captures Packages file-reference buttons", async () => {
  const listeners = new Map();
  const button = {
    getAttribute(name) {
      if (name === "data-prompt-link-href") {
        return "D:/Projects/ExampleUnityProject/Packages/manifest.json";
      }
      return null;
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  const opened = [];
  __test.startRenderer(
    {
      ipc: {
        invoke: async (_channel, destination) => {
          opened.push(destination);
          return { ok: true, handled: true, code: "opened" };
        },
      },
    },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {
      closest(selector) {
        if (selector === '[data-file-reference="true"][data-prompt-link-href]') return button;
        return null;
      },
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };

  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, [{
    path: "D:\\Projects\\ExampleUnityProject\\Packages\\manifest.json",
    line: 0,
    column: 0,
  }]);
  __test.stopRenderer();
});

test("renderer replays Claude behavior when main declines the path", async () => {
  const listeners = new Map();
  const anchor = {
    clicks: 0,
    getAttribute() {
      return "D:/Projects/ExampleUnityProject/Assets/Folder";
    },
    click() {
      this.clicks += 1;
    },
  };
  const documentApi = {
    body: { append() {} },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener() {},
    createElement() {
      return { dataset: {}, style: {}, remove() {} };
    },
  };
  __test.startRenderer(
    { ipc: { invoke: async () => ({ ok: false, handled: false }) } },
    documentApi,
  );
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { closest: () => anchor },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {},
  };
  listeners.get("click")(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.defaultPrevented, true);
  assert.equal(anchor.clicks, 1);
  __test.stopRenderer();
});
