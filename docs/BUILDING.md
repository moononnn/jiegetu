# 构建与交付

## 前提

当前只准备 Windows x64 构建，不提供 macOS、Linux 或 ARM64 包。需要支持 Windows Graphics Capture 的 Windows、Node.js 22.12 或以上、npm，以及本机 .NET Framework 4.x 编译器、Windows 10 SDK 的 Windows.winmd 与相关系统程序集。

Node.js/npm 用于开发构建；最终用户运行发布 EXE 不需要安装 Node.js。原生脚本使用本机已有工具，缺少编译器或 SDK 时会报错，不自动安装系统组件。

## 从源码运行

在项目目录内使用 PowerShell：

```powershell
npm ci
npm run setup
npm run build:capture
node scripts/build-capture.cjs
node scripts/build-capture.cjs --record
node scripts/build-ocr-helper.cjs
node scripts/build-gif-clipboard.cjs
npm start
```

对应产物：

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run build:capture` | `native/gdi-capture.exe` | GDI 组件及验证 |
| `node scripts/build-capture.cjs` | `native/wgc-capture.exe` | 普通截图与长截图采集 |
| 加 `--record` | `native/wgc-record.exe` | GIF 连续采集，独立于截图暖源 |
| `node scripts/build-ocr-helper.cjs` | `native/ocr-helper.exe` | 可选的本地文字识别 |
| `node scripts/build-gif-clipboard.cjs` | `native/gif-clipboard.exe` | 动图文件复制 |

`native/*.exe`、`node_modules` 不进入源码仓库，新检出必须重新构建。OCR 还依赖 Windows 已安装的识别语言，可用 `native/ocr-helper.exe --languages` 查询。

`node scripts/build-dxgi-capture.cjs` 是实验采集候选，不是主链路构建前提。`--cursor-test` 仅供内部实验，不属于公开构建流程。

## 检查

```powershell
npm run check
node --test --test-concurrency=1 "test/*.test.cjs" "test/*.test.mjs"
```

这里使用串行测试以降低机器忙时的时序干扰；`npm test` 是并发度 2 的同一组测试。语法检查不替代功能测试；测试中原生编译/协议检查仍要求 Windows 工具链。测试产物不属于发布文件。桌面实机、安装和卸载应在单独环境里验证，不要用开发机的运行状态冒充干净安装结果。

## 安装版与免安装版

- 安装版使用 electron-builder 的 NSIS 目标，面向当前账户安装，提供卸载入口。
- 免安装版使用 portable 目标，启动时将运行文件解压到临时目录；设置和日志仍在 AppData，不是随身数据模式。
- 两种版本复用同一套数据和单实例锁。移动免安装 EXE 后，应重新设置开机自启；自启须指向外层 EXE，不能指向临时解压目录。
- 不做自动更新，也不在本地构建时发布到远端。

双交付使用 `electron-builder.release.json`，打包前执行 `scripts/release-preflight.cjs` 检查版本、项目与图标许可记录、五个 x64 helper 及固定依赖；元数据未齐时按设计阻断。命令和剩余门禁见[发布检查表](RELEASE_CHECKLIST.md)。现有 `electron-builder.json` 仍是本地审查包配置，不应将旧 `dist-review` 成品直接改名当作新版本发布。

首次正式打包前，先核实图标授权、确定候选版本，并对照根目录 `LICENSE` 复核允许的使用范围，构建全部必需原生组件，再核验最终文件白名单与 SHA-256。构建命令成功不等于安装版/免安装版已通过运行验证。

## 发布文件边界

运行包只需要生产源码、三个在用图标、所需原生 EXE、固定生产依赖 gifenc 与完整第三方许可。不要加入测试、实验、日志、用户设置、工作区路径、开发记录或备份。

Electron 运行时自带的 LICENSE 和 LICENSES.chromium.html 等版权声明必须保留。无代码签名时明确标注未知发布者，不关闭或绕过系统安全检查。
