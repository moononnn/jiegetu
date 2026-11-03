# 发布检查表

## v0.90.0 双版本交付

当前提供 Windows x64 安装版与免安装版候选，保持早期试用定位。公开发布不代表下面所有真实桌面验收都已完成。旧开发历史及旧 dist-review 成品不作发布物。

### 已完成的构建与静态检查

- [x] 项目根 LICENSE 与 package.json 的 license 已确定：免费使用（包括正常商业工作），禁止未经书面许可收费转售软件及修改版。
- [x] 图标来源由作者确认系 GPT 生成；已读取 OpenAI 公开条款全文并核对输出权利、人工审阅与 AI 来源披露。依据与范围见 assets/LICENSE.txt；不宣称排他权利、全面不侵权或已审计私人账户。
- [x] 版本为 0.90.0，顶层与 lock 根包一致。开发记录始于 2026-10-21，合并同轮实现与复测、排除重复与纯发布资料后估算约 80–100 轮，取 90 作为开发序列，不代表曾有 90 次公开发版。
- [x] 在独立的干净公开源码目录重新编译五个 helper；未结束开发机正在使用的截图进程。
- [x] 从同一份源码构建 NSIS Setup 与 Portable；保留 Electron/Chromium、gifenc 及项目自身许可。
- [x] 对两个 EXE 进行归档 CRC 检查和静态解包；逐文件核验内嵌运行载荷与 win-unpacked、来源代码和精确白名单。
- [x] 五个运行 helper 与主程序为 x64，包中不带诊断启动脚本、实验、测试、日志、用户数据、私人开发记录或备份。
- [x] 发布核验支持独立 release profile；只接受明确的元数据字段和五个 helper，不通过扩大文件白名单掩盖差异。

EXE 大小及 SHA-256 以 Release 的 SHA256SUMS.txt 为准。上传后另核对远端附件的大小与 SHA-256，上传前不把本地存在等同于已可下载。

### 仍待真实环境验收

- [ ] 在独立干净 Windows 环境实际安装、首次启动、截图、复制、保存、长图、GIF、退出、再次启动和卸载。
- [ ] 验证安装版／免安装版开机自启及移动后的路径、Run 项与卸载数据保留行为。
- [ ] 真实 SmartScreen／未知发布者提示、混合 DPI、任务栏、热键冲突、大长图性能。

上述未验项在 Release 中明确列出，不将静态解包、测试通过或既有开发机运行经验冒充为干净安装验证。候选保持预发布状态。两版无代码签名，不关闭系统防护、不伪造发布者身份。

## 本地打包与核验

先按 BUILDING.md 准备 Node、固定依赖、Electron 与五个原生组件。预检会在版本、许可、图标记录或必需组件不齐时阻断：

```powershell
node scripts/release-preflight.cjs
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm exec --yes --package=electron-builder@26.18.0 -- electron-builder --config electron-builder.release.json --win nsis portable --x64 --publish never
node scripts/verify-review-build.cjs --release
```

核验脚本的 release profile 对主程序、源文件、图标、五个 helper 和生产依赖逐项检查。builder 26.18.0 默认不复制依赖自己的 README.md，因此只对 gifenc 的这一个路径作明确排除；其 LICENSE.md、dist、src 不放宽。builder 还会清理依赖的 package.json，发布配置通过一个精确 extraFiles 原样保留 gifenc 元数据，继续使用逐字节核验。

最终交付文件：

- Jiegetu-0.90.0-Setup-x64.exe
- Jiegetu-0.90.0-Portable-x64.exe
- SHA256SUMS.txt

不上传 builder-debug.yml、latest.yml、中间压缩包、拆包目录或本地核验报告。设置仍在 AppData；免安装版不提供设置随 U 盘迁移的模式。配置为当前用户安装、安装完不自动启动、卸载保留 AppData；这些是配置结论，不代替实装结果。

发布配置使用 publish: []，构建命令明确 --publish never。builder 可能生成 app-update.yml，但应用未接入自动更新逻辑；此元数据不表示软件会自动联网更新。

## 公开仓库边界

公开源码用 scripts/prepare-public-source.cjs 白名单导出，并逐文件检查哈希和隐私。保留运行源码、原生 C#、构建／测试、锁文件、三个在用图标、两张已确认演示图、公共文档与许可。

不导出 .git、node_modules、native/*.exe、旧开发历史、日志、实验、备份或私人记录；源代码包需重新构建 native helper。开发专用诊断启动入口和仅测试这些入口的 diagnostic-launch*.test.cjs 留在开发仓，公开源码使用 npm start。

本次先建立源码 Release，随后补 EXE。为不改写已公开标签，v0.90.0 标签保留原快照；后补的打包核验、许可和说明见发布说明所链接的构建补充提交。业务源代码及图标像素与标签一致。复现二进制请检出该补充提交，不使用旧的诊断启动器或旧审查包。
