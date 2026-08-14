# Claude++ Unity Asset Links

[English](README.md)

让 Claude Code Desktop 回复中的本地 Unity 项目链接在匹配的 Unity Editor 中打开。Tweak 支持 `Assets`、
`ProjectSettings` 和 `Packages`，不支持的链接继续使用 Claude 原行为。

本仓库是 [`kpkhxlgy0/unity-links`](https://github.com/kpkhxlgy0/unity-links) 的独立 Claude++ Tweak 组件，
不包含 Unity Editor 接收器和 junction 管理脚本。

## 环境要求

- Windows 10 或更新版本。
- 已安装 Claude Code Desktop 和 [Claude++](https://github.com/kpkhxlgy0/ClaudePlusPlus) v0.2.2 或更新版本。
- 每个需要接收链接的 Unity 项目都已安装 Unity Asset Links package。
- 使用 `unity-links` 总仓库提供的 junction 和 Unity Package 安装命令。

普通用户使用 Tweak 不需要 Node.js。只有开发和发布校验需要 Node.js 24。

## 安装

Claude++ 本体使用其正式 Windows 发布包中的 `install.ps1` 安装和维护。Unity Links 不 patch Claude Desktop，
也不维护 Claude++ 本体。

克隆总仓库和全部组件：

```powershell
git clone --recurse-submodules `
  git@github.com:kpkhxlgy0/unity-links.git D:\Tools\unity-links
```

只创建 Claude++ Tweak junction：

```powershell
pwsh -NoProfile -File D:\Tools\unity-links\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -NoProfile -File D:\Tools\unity-links\Inject-ClaudePlusPlus.ps1
```

然后为每个 Unity 项目安装共用接收器：

```powershell
pwsh -NoProfile -File D:\Tools\unity-links\Install-UnityPackage.ps1 `
  -UnityProject D:\Projects\YourUnityProject
```

junction 变化后需要手动重启 Claude。受支持的安装方式使用该 junction；发布流程不会把组件发布到
Claude++ Tweak Store。

## 使用行为

- 普通左键点击已存在的 `Assets` 文件时，通过 `AssetDatabase.OpenAsset` 打开。
- `ProjectSettings` 链接打开 Unity Project Settings。
- `Packages` 链接打开 Package Manager，并在可行时选中对应 package。
- 行号、列号和本机 `file:` URL 使用与 Codex++ Tweak 相同的解析规则。
- Claude 原生相对代码引用会通过当前会话工作区解析；存在歧义或无法解析的引用、带修饰键的点击、网页 URL、
  目录和受支持 Unity 目录外的文件保留 Claude 原行为。
- 匹配 Unity Editor 不可用时，只在 Explorer 中定位文件并显示短提示，不会启动 Unity。

## 安全边界

Renderer Tweak 只通过 Claude++ 的权限隔离 Claude Sessions 适配器解析当前会话的文件引用和工作区根。
Main Tweak 会规范化文件和项目根，拒绝词法穿越及 reparse-point 别名，再通过现有的按项目隔离 Windows
Named Pipe 发送一次有界请求。Unity Package 会再次校验请求。

Tweak 不注册 URL scheme、不修改注册表、不运行 localhost 服务、不安装 native host，也不控制 Claude 或
Unity 进程。

## 开发

运行独立测试：

```powershell
npm test
node .\scripts\release\validate-release.mjs $PWD 0.1.2
```

使用固定的 Claude++ v0.2.2 源码 checkout 验证：

```powershell
node --import file:///D:/Unity/ClaudePlusPlus/node_modules/tsx/dist/loader.mjs `
  .\scripts\compatibility\validate-claudeplusplus.mjs `
  D:\Unity\ClaudePlusPlus $PWD
```

兼容性校验会实际使用 Claude++ Renderer evaluator 和 Main API lease。Renderer 在没有 Node `require` 的环境中
求值；Main lease dispose 后必须移除 namespaced IPC handler，确保 reload 可以重新注册。

## 发布流程

手动 `Release` workflow 接受不带 `v` 的稳定版本。它要求从 `master` 运行，执行全部测试、校验公开分发文件、
验证 Claude++ v0.2.2 兼容性、创建或复用对应 tag，最后生成供审核的 Draft Release。它不会发布到 Claude++
Tweak Store。

## 开源协议

[MIT License](LICENSE)
