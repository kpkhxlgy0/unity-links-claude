const PIPE_PREFIX = "kpk-codex-unity-link-v1-";
const SUPPORTED_ROOT_NAMES = ["Assets", "ProjectSettings", "Packages"];
let rendererCleanup;
const replayBypass = new WeakSet();
const notices = new Set();

function parseDestination(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let value = raw.trim();
  if (/^(https?|mailto):/i.test(value)) return null;

  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) {
        return null;
      }
      value = decodeURIComponent(url.pathname);
      const fragment = /^#L(\d+)(?:C(\d+))?$/i.exec(url.hash);
      if (fragment) {
        value += `:${fragment[1]}${fragment[2] ? `:${fragment[2]}` : ""}`;
      }
    } catch {
      return null;
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  value = value.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  const parsed = splitLineColumn(value);
  if (!/^[A-Za-z]:[\\/]/.test(parsed.path)) return null;
  return {
    path: parsed.path.replace(/\//g, "\\"),
    line: parsed.line,
    column: parsed.column,
  };
}

function splitLineColumn(value) {
  let match = /^(.*):(\d+):(\d+)$/.exec(value);
  if (match) {
    return {
      path: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
    };
  }
  match = /^(.*):(\d+)$/.exec(value);
  if (match) {
    return { path: match[1], line: Number(match[2]), column: 0 };
  }
  return { path: value, line: 0, column: 0 };
}

function parseClaudeSessionId(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "app:" || url.hostname !== "localhost") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const epitaxyIndex = segments.indexOf("epitaxy");
    if (epitaxyIndex < 0 || !segments[epitaxyIndex + 1]) return null;
    return decodeURIComponent(segments[epitaxyIndex + 1]);
  } catch {
    return null;
  }
}

function hasSupportedProjectSegment(filePath) {
  return /[\\/](?:Assets|ProjectSettings|Packages)[\\/]/i.test(filePath);
}

function isEligibleClick(event) {
  return event.button === 0
    && !event.defaultPrevented
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
}

function normalizeProjectRoot(projectRoot, pathApi) {
  const resolved = pathApi.resolve(projectRoot).replace(/\//g, "\\");
  return resolved.replace(/[\\]+$/, "").toLowerCase();
}

function pipeNameForProjectRoot(projectRoot, cryptoApi, pathApi) {
  const normalized = normalizeProjectRoot(projectRoot, pathApi);
  const digest = cryptoApi.createHash("sha256").update(normalized, "utf8").digest("hex");
  return PIPE_PREFIX + digest;
}

function hasTraversalSegment(candidatePath) {
  return candidatePath.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

function findUnityProjectRoot(filePath, fsApi, pathApi) {
  let current = pathApi.dirname(pathApi.resolve(filePath));
  while (true) {
    const assets = pathApi.join(current, "Assets");
    const version = pathApi.join(current, "ProjectSettings", "ProjectVersion.txt");
    if (fsApi.existsSync(assets) && fsApi.existsSync(version)) return current;
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findSupportedProjectPath(filePath, projectRoot, pathApi) {
  const resolved = pathApi.resolve(filePath);
  for (const rootName of SUPPORTED_ROOT_NAMES) {
    const supportedRoot = pathApi.join(projectRoot, rootName);
    const relative = pathApi.relative(supportedRoot, resolved);
    if (relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative)) {
      return { rootName, supportedRoot, relative };
    }
  }
  return null;
}

function hasReparsePointSegment(candidatePath, projectRoot, fsApi, pathApi) {
  const target = findSupportedProjectPath(candidatePath, projectRoot, pathApi);
  if (!target) return false;

  try {
    if (fsApi.lstatSync(projectRoot).isSymbolicLink()) return true;
    let current = target.supportedRoot;
    if (fsApi.lstatSync(current).isSymbolicLink()) return true;
    for (const segment of target.relative.split(pathApi.sep)) {
      current = pathApi.join(current, segment);
      if (fsApi.lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function findUnityTarget(candidatePath, fsApi, pathApi) {
  if (hasTraversalSegment(candidatePath)) {
    return { ok: false, handled: false, code: "notAssetFile" };
  }

  let absolute;
  try {
    absolute = fsApi.realpathSync(candidatePath);
    if (!fsApi.statSync(absolute).isFile()) {
      return { ok: false, handled: false, code: "notAssetFile" };
    }
  } catch {
    return {
      ok: false,
      handled: true,
      code: "fileMissing",
      message: "The linked file does not exist.",
    };
  }

  const projectRoot = findUnityProjectRoot(absolute, fsApi, pathApi);
  if (!projectRoot) {
    return { ok: false, handled: false, code: "notUnityProject" };
  }

  const originalProjectRoot = findUnityProjectRoot(candidatePath, fsApi, pathApi);
  if (!originalProjectRoot) {
    return { ok: false, handled: false, code: "notUnityProject" };
  }
  let canonicalOriginalProjectRoot;
  try {
    canonicalOriginalProjectRoot = fsApi.realpathSync(originalProjectRoot);
  } catch {
    return { ok: false, handled: false, code: "notUnityProject" };
  }
  if (normalizeProjectRoot(canonicalOriginalProjectRoot, pathApi)
      !== normalizeProjectRoot(projectRoot, pathApi)
      || !findSupportedProjectPath(candidatePath, originalProjectRoot, pathApi)
      || hasReparsePointSegment(candidatePath, originalProjectRoot, fsApi, pathApi)) {
    return { ok: false, handled: false, code: "notAssetFile" };
  }

  const target = findSupportedProjectPath(absolute, projectRoot, pathApi);
  if (!target) return { ok: false, handled: false, code: "notAssetFile" };
  return {
    ok: true,
    absolutePath: absolute,
    projectRoot,
    assetPath: target.rootName + "/" + target.relative.split(pathApi.sep).join("/"),
  };
}

function sendPipeRequest(pipePath, payload, deps) {
  const netApi = deps.net;
  const connectTimeoutMs = deps.connectTimeoutMs || 300;
  const responseTimeoutMs = deps.responseTimeoutMs || 2500;
  return new Promise((resolve, reject) => {
    const socket = netApi.createConnection(pipePath);
    let settled = false;
    let buffer = "";
    let responseTimer;
    const connectTimer = setTimeout(() => finish(new Error("unityUnavailable")), connectTimeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve(value);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => finish(new Error("unityUnavailable")), responseTimeoutMs);
      socket.write(JSON.stringify(payload) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        finish(new Error("responseTooLarge"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error("invalidResponse"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("unityUnavailable"));
    });
  });
}

async function handleOpenAsset(candidate, deps) {
  const target = findUnityTarget(candidate.path, deps.fs, deps.path);
  if (!target.ok) {
    if (target.code === "fileMissing") {
      const parent = deps.path.dirname(candidate.path);
      if (deps.fs.existsSync(parent)) void deps.shell.openPath(parent);
      deps.log.warn("file link rejected", target.code, candidate.path);
    }
    return target;
  }

  const requestId = deps.crypto.randomUUID();
  const pipeName = pipeNameForProjectRoot(target.projectRoot, deps.crypto, deps.path);
  const pipePath = "\\\\.\\pipe\\" + pipeName;
  const payload = {
    version: 1,
    requestId,
    action: "openAsset",
    projectRoot: target.projectRoot,
    assetPath: target.assetPath,
    line: candidate.line || 0,
    column: candidate.column || 0,
  };

  try {
    const transport = deps.sendPipeRequest || sendPipeRequest;
    const response = await transport(pipePath, payload, {
      net: deps.net,
      connectTimeoutMs: 300,
      responseTimeoutMs: 2500,
    });
    if (response.requestId !== requestId) throw new Error("responseMismatch");
    if (response.ok) return { ok: true, handled: true, code: response.code };
    deps.log.warn("Unity rejected asset link", response.code, target.assetPath);
    deps.shell.showItemInFolder(target.absolutePath);
    return {
      ok: false,
      handled: true,
      code: response.code || "openFailed",
      message: response.message || "Unity could not open this asset.",
    };
  } catch (error) {
    deps.log.warn("Unity asset link unavailable", String(error));
    deps.shell.showItemInFolder(target.absolutePath);
    return {
      ok: false,
      handled: true,
      code: "unityUnavailable",
      message: "The matching Unity project is not open. The file was revealed in Explorer.",
    };
  }
}

async function resolveUnityWorkspaceReference(workspaceRoot, referencePath, fsApi, pathApi) {
  if (typeof workspaceRoot !== "string"
      || typeof referencePath !== "string"
      || workspaceRoot.trim() === ""
      || referencePath.trim() === ""
      || !pathApi.isAbsolute(workspaceRoot)
      || pathApi.isAbsolute(referencePath)
      || hasTraversalSegment(referencePath)) {
    return null;
  }

  let canonicalRoot;
  try {
    const rootStats = await fsApi.promises.lstat(workspaceRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
    canonicalRoot = await fsApi.promises.realpath(workspaceRoot);
    const assets = await fsApi.promises.stat(pathApi.join(canonicalRoot, "Assets"));
    const projectVersion = await fsApi.promises.stat(
      pathApi.join(canonicalRoot, "ProjectSettings", "ProjectVersion.txt"),
    );
    if (!assets.isDirectory() || !projectVersion.isFile()) return null;
  } catch {
    return null;
  }

  const segments = referencePath.trim().split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  const firstSegment = segments[0].toLowerCase();
  const supportedRoot = SUPPORTED_ROOT_NAMES.find(
    (rootName) => rootName.toLowerCase() === firstSegment,
  );
  if (supportedRoot) {
    const direct = pathApi.join(canonicalRoot, supportedRoot, ...segments.slice(1));
    try {
      if ((await fsApi.promises.stat(direct)).isFile()) return direct;
    } catch {
      return null;
    }
    return null;
  }

  const suffix = segments.join("/").toLowerCase();
  let match = null;
  let ambiguous = false;

  async function visit(directory, relativeSegments) {
    if (ambiguous) return;
    let entries;
    try {
      const directoryStats = await fsApi.promises.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return;
      entries = await fsApi.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ambiguous) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = pathApi.join(directory, entry.name);
      const nextSegments = [...relativeSegments, entry.name];
      if (entry.isDirectory()) {
        await visit(absolute, nextSegments);
        continue;
      }
      const relativePath = nextSegments.join("/").toLowerCase();
      if (!entry.isFile()
          || (relativePath !== suffix && !relativePath.endsWith("/" + suffix))) {
        continue;
      }
      if (match && normalizeProjectRoot(match, pathApi) !== normalizeProjectRoot(absolute, pathApi)) {
        ambiguous = true;
        return;
      }
      match = absolute;
    }
  }

  for (const rootName of SUPPORTED_ROOT_NAMES) {
    await visit(pathApi.join(canonicalRoot, rootName), []);
    if (ambiguous) return null;
  }
  return match;
}

function defaultMainDeps(api) {
  return {
    crypto: require("node:crypto"),
    fs: require("node:fs"),
    net: require("node:net"),
    path: require("node:path"),
    shell: require("electron").shell,
    log: api.log,
  };
}

function startMain(api, injectedDeps) {
  const getDeps = () => Object.keys(injectedDeps || {}).length > 0
    ? injectedDeps
    : defaultMainDeps(api);
  api.ipc.handle("open-asset", (candidate) => handleOpenAsset(candidate, getDeps()));
  api.ipc.handle("resolve-workspace-asset", async (request) => {
    const deps = getDeps();
    const candidatePath = await resolveUnityWorkspaceReference(
      request?.workspaceRoot,
      request?.referencePath,
      deps.fs,
      deps.path,
    );
    if (!candidatePath) return { ok: false, handled: false, code: "fileUnresolved" };
    return handleOpenAsset({
      path: candidatePath,
      line: request.line,
      column: request.column,
    }, deps);
  });
}

function showNotice(message, documentApi) {
  const notice = documentApi.createElement("div");
  notice.dataset.codexUnityAssetLinkNotice = "true";
  notice.textContent = message;
  notice.style.position = "fixed";
  notice.style.right = "16px";
  notice.style.bottom = "16px";
  notice.style.zIndex = "2147483647";
  notice.style.maxWidth = "420px";
  notice.style.padding = "10px 12px";
  notice.style.borderRadius = "8px";
  notice.style.background = "var(--color-background-panel, #222)";
  notice.style.color = "var(--color-token-text-primary, #fff)";
  notice.style.boxShadow = "0 8px 28px rgba(0, 0, 0, 0.28)";
  documentApi.body.append(notice);
  notices.add(notice);
  const timer = setTimeout(() => {
    notices.delete(notice);
    notice.remove();
  }, 3500);
  return () => {
    clearTimeout(timer);
    notices.delete(notice);
    notice.remove();
  };
}

function replayOriginalClick(anchor) {
  replayBypass.add(anchor);
  try {
    anchor.click();
  } finally {
    replayBypass.delete(anchor);
  }
}

function handleOpenResult(result, documentApi, link) {
  if (!result || result.handled === false) {
    replayOriginalClick(link);
    return;
  }
  if (!result.ok) {
    showNotice(
      result.message || "Unity could not open this asset.",
      documentApi,
    );
  }
}

function openParsedAsset(api, documentApi, link, parsed) {
  return api.ipc.invoke("open-asset", parsed)
    .then((result) => {
      handleOpenResult(result, documentApi, link);
    })
    .catch(() => {
      showNotice("Unity link handling failed.", documentApi);
    });
}

async function openNativeReference(
  api,
  documentApi,
  link,
  sessionId,
  entryId,
  label,
  occurrence,
  visibleCount,
  relative,
) {
  const sessions = api.claude.sessions;
  if (entryId && occurrence >= 0 && typeof sessions.resolveReference === "function") {
    try {
      const recoveredDestination = await sessions.resolveReference(
        sessionId,
        entryId,
        label,
        occurrence,
        visibleCount,
      );
      const recovered = parseDestination(recoveredDestination);
      if (recovered && hasSupportedProjectSegment(recovered.path)) {
        if (recovered.line === 0) recovered.line = relative.line;
        if (recovered.column === 0) recovered.column = relative.column;
        await openParsedAsset(api, documentApi, link, recovered);
        return;
      }
    } catch {}
  }

  try {
    const resolvedPath = await sessions.resolveFile(sessionId, relative.path);
    const resolved = parseDestination(resolvedPath);
    if (resolved && hasSupportedProjectSegment(resolved.path)) {
      resolved.line = relative.line;
      resolved.column = relative.column;
      await openParsedAsset(api, documentApi, link, resolved);
      return;
    }
  } catch {}

  if (typeof sessions.getWorkspaceRoot !== "function") {
    replayOriginalClick(link);
    return;
  }

  let workspaceRoot;
  try {
    workspaceRoot = await sessions.getWorkspaceRoot(sessionId);
  } catch {
    replayOriginalClick(link);
    return;
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot === "") {
    replayOriginalClick(link);
    return;
  }

  try {
    const result = await api.ipc.invoke("resolve-workspace-asset", {
      workspaceRoot,
      referencePath: relative.path,
      line: relative.line,
      column: relative.column,
    });
    handleOpenResult(result, documentApi, link);
  } catch {
    showNotice("Unity link handling failed.", documentApi);
  }
}

function startRenderer(api, documentApi) {
  stopRenderer();
  const onClick = (event) => {
    if (!isEligibleClick(event)) return;
    const nativeReference = event.target && event.target.closest
      ? event.target.closest('span[role="button"]')
      : null;
    const link = event.target && event.target.closest
      ? event.target.closest("a[href]")
        || event.target.closest('[data-file-reference="true"][data-prompt-link-href]')
        || nativeReference
      : null;
    if (!link || replayBypass.has(link)) return;
    const rawDestination = link.getAttribute?.("href")
        || link.getAttribute?.("data-prompt-link-href")
        || link.href
        || (link === nativeReference ? nativeReference.querySelector?.("code")?.textContent : null);
    const parsed = parseDestination(rawDestination);
    if (parsed) {
      if (!hasSupportedProjectSegment(parsed.path)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      void openParsedAsset(api, documentApi, link, parsed);
      return;
    }

    if (link !== nativeReference || typeof rawDestination !== "string") return;
    const sessionId = parseClaudeSessionId(documentApi.location?.href);
    const resolveFile = api.claude?.sessions?.resolveFile;
    if (!sessionId || typeof resolveFile !== "function") return;
    const relative = splitLineColumn(rawDestination.trim());
    if (relative.path === "") return;
    const entry = link.closest?.("[data-epitaxy-entry]");
    const entryId = entry?.getAttribute?.("data-epitaxy-entry");
    const matchingReferences = Array.from(entry?.querySelectorAll?.('span[role="button"]') || [])
      .filter((candidate) => {
        const text = candidate.querySelector?.("code")?.textContent;
        return typeof text === "string"
          && splitLineColumn(text.trim()).path.toLowerCase() === relative.path.toLowerCase();
      });

    event.preventDefault();
    event.stopImmediatePropagation();
    void openNativeReference(
      api,
      documentApi,
      link,
      sessionId,
      entryId,
      relative.path,
      matchingReferences.indexOf(link),
      matchingReferences.length,
      relative,
    );
  };
  documentApi.addEventListener("click", onClick, true);
  rendererCleanup = () => documentApi.removeEventListener("click", onClick, true);
}

function stopRenderer() {
  if (rendererCleanup) {
    rendererCleanup();
    rendererCleanup = undefined;
  }
  for (const notice of notices) notice.remove();
  notices.clear();
}

function start(api) {
  if (api.process === "main") {
    startMain(api, {});
    return;
  }
  startRenderer(api, document);
}

function stop() {
  stopRenderer();
}

module.exports = {
  start,
  stop,
  __test: {
    parseDestination,
    splitLineColumn,
    parseClaudeSessionId,
    hasSupportedProjectSegment,
    isEligibleClick,
    normalizeProjectRoot,
    pipeNameForProjectRoot,
    hasReparsePointSegment,
    findUnityTarget,
    resolveUnityWorkspaceReference,
    sendPipeRequest,
    handleOpenAsset,
    startMain,
    showNotice,
    replayOriginalClick,
    startRenderer,
    stopRenderer,
  },
};
