# Unity Asset Links for Claude++

[简体中文](README.zh-CN.md)

Open local Unity project links from Claude Code Desktop in the matching Unity Editor. The Tweak handles files under
`Assets`, `ProjectSettings`, and `Packages` while preserving Claude's normal behavior for unsupported links.

This repository is the standalone Claude++ Tweak component of
[`kpkhxlgy0/unity-links`](https://github.com/kpkhxlgy0/unity-links). It does not contain the Unity Editor receiver or
the junction management scripts.

## Requirements

- Windows 10 or newer.
- Claude Code Desktop with [Claude++](https://github.com/kpkhxlgy0/ClaudePlusPlus) v0.2.2 or newer installed.
- The Unity Asset Links package installed in each Unity project that should receive links.
- The umbrella `unity-links` repository for the supported junction and Unity Package installation commands.

End users do not need Node.js to use this Tweak. Node.js 24 is only required for development and release checks.

## Install

Claude++ itself is installed and maintained with the `install.ps1` shipped in its official Windows release. Unity
Links does not patch Claude Desktop or maintain Claude++.

Clone the umbrella repository with all components:

```powershell
git clone --recurse-submodules `
  git@github.com:kpkhxlgy0/unity-links.git D:\Tools\unity-links
```

Create only the Claude++ Tweak junction:

```powershell
pwsh -NoProfile -File D:\Tools\unity-links\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -NoProfile -File D:\Tools\unity-links\Inject-ClaudePlusPlus.ps1
```

Then install the shared Unity receiver in each project:

```powershell
pwsh -NoProfile -File D:\Tools\unity-links\Install-UnityPackage.ps1 `
  -UnityProject D:\Projects\YourUnityProject
```

Restart Claude manually after changing the junction. The supported install path uses this junction; the release
workflow does not publish the component to the Claude++ Tweak Store.

## Behavior

- A normal left-click on an existing `Assets` file opens it through `AssetDatabase.OpenAsset`.
- `ProjectSettings` links open Unity Project Settings.
- `Packages` links open Package Manager and select the package when possible.
- Line and column suffixes and local `file:` URLs use the same parsing rules as the Codex++ Tweak.
- Claude-native relative code references are resolved through the current session workspace. Ambiguous or unresolved
  references, modified clicks, web URLs, directories, and files outside supported Unity folders keep Claude's
  original behavior.
- If the matching Unity Editor is unavailable, the Tweak reveals the file in Explorer and shows a short notice. It
  never launches Unity.

## Security

The Renderer Tweak uses Claude++'s permission-scoped Claude Sessions adapter only to resolve the current session's
file reference and workspace root. The Main Tweak canonicalizes the file and project root, rejects lexical traversal
and reparse-point aliases, and sends one bounded request over the existing per-project Windows Named Pipe. The Unity
Package validates the request again.

The Tweak does not register URL schemes, edit the registry, run a localhost service, install a native host, or control
Claude or Unity processes.

## Development

Run the standalone tests:

```powershell
npm test
node .\scripts\release\validate-release.mjs $PWD 0.1.1
```

Validate against the pinned Claude++ v0.2.2 source checkout:

```powershell
node --import file:///D:/Unity/ClaudePlusPlus/node_modules/tsx/dist/loader.mjs `
  .\scripts\compatibility\validate-claudeplusplus.mjs `
  D:\Unity\ClaudePlusPlus $PWD
```

The compatibility check uses the real Claude++ Renderer evaluator and Main API lease implementation. Renderer code is
evaluated without Node `require`, and disposed Main leases must remove their namespaced IPC handlers before reload.

## Release Process

The manual `Release` workflow accepts a stable version without the `v` prefix. It requires `master`, runs all tests,
validates the public distribution, verifies Claude++ v0.2.2 compatibility, creates or reuses the matching tag, and
creates a Draft Release for review. It does not publish to the Claude++ Tweak Store.

## License

[MIT License](LICENSE)
