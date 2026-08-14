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
  api.ipc.handle("open-asset", (candidate) =>
    handleOpenAsset(
      candidate,
      Object.keys(injectedDeps || {}).length > 0 ? injectedDeps : defaultMainDeps(api),
    ));
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

function startRenderer(api, documentApi) {
  stopRenderer();
  const onClick = (event) => {
    if (!isEligibleClick(event)) return;
    const link = event.target && event.target.closest
      ? event.target.closest("a[href]")
        || event.target.closest('[data-file-reference="true"][data-prompt-link-href]')
      : null;
    if (!link || replayBypass.has(link)) return;
    const parsed = parseDestination(
      link.getAttribute("href")
        || link.getAttribute("data-prompt-link-href")
        || link.href,
    );
    if (!parsed || !hasSupportedProjectSegment(parsed.path)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void api.ipc.invoke("open-asset", parsed)
      .then((result) => {
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
      })
      .catch(() => {
        showNotice("Unity link handling failed.", documentApi);
      });
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
    hasSupportedProjectSegment,
    isEligibleClick,
    normalizeProjectRoot,
    pipeNameForProjectRoot,
    hasReparsePointSegment,
    findUnityTarget,
    sendPipeRequest,
    handleOpenAsset,
    startMain,
    showNotice,
    replayOriginalClick,
    startRenderer,
    stopRenderer,
  },
};
