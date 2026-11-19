# 发布检查表

## v0.91.1 · 图外起拖与关闭确认修复

本版仅包含编辑交互修复：框批注、提取文字、矩形（含实心遮盖）、关联框可以从工作区留白起拖；画笔与马赛克按图片内的真实路径绘制，离开再进入不跨接；关闭确认改为「继续编辑／放弃并关闭」。长截图浮动按钮、底部安全带和晕边实验均未合并。

- [x] 版本、package 与 lock 对齐 0.91.1，生产语法检查通过；完整测试 2147 项，2143 通过、0 失败、4 跳过（DXGI 实验组件未构建及三个旧基线缺失的对照测试）。
- [x] 六个 x64 helper 齐全，发布预检通过。
- [x] Setup 与 Portable 从同一源码构建，各 193 个运行文件、118 个应用载荷文件；CRC 与静态拆包通过，和 win-unpacked、源文件及精确白名单逐字节一致。
- [x] 独立核查最终载荷与验证证据通过，258 个公开源文件逐一对账，隐私扫描无命中；公开目录专项 59 项全部通过。
- 发布后另行回读 GitHub tag/Release/三附件，并全量回下载核对哈希；不以本地构建成功代替远端核验。

本版未重做真实安装/卸载、SmartScreen、混合 DPI 或真实窗口鼠标与像素验收。以下 v0.91.0 的本机实装结果仅对应当时版本，不代替本次安装包的实机验证。安装版和免安装版均未签名；配置保持当前用户安装、卸载保留 AppData，安装后不自动启动。未引入自动更新。

预期附件：`Jiegetu-0.91.1-Setup-x64.exe`、`Jiegetu-0.91.1-Portable-x64.exe`、`SHA256SUMS.txt`。校验值以 Release 附件为准。

## v0.91.0 双版本交付

当前提供 Windows x64 安装版与免安装版。公开发布不代表下面所有真实桌面验收都已完成。旧开发历史及旧 dist-review 成品不作发布物。

### 已完成的构建与静态检查

- [x] 版本为 0.91.0，顶层与 lock 根包两处一致；相对 0.90.1 为功能升级，覆盖 11-09 到 11-17 的批注、编辑与面向用户清理。
- [x] 合并提交 `f323c93` 把 11-16／11-17 修复链（dev.37-dev.43）合入 main，README 只保留一处行为描述冲突并以代码实际行为为准。
- [x] 五个原生 helper 在本树重新构建（wgc-capture、wgc-record、gdi-capture、gif-clipboard、ocr-helper），发布预检逐个体检 x64 通过。
- [x] `npm run check` 退出码 0；`npm test` 全量 2133 项通过、0 失败、0 跳过。
- [x] 从同一份源码构建 NSIS Setup 与 Portable；两个 EXE 各解出 192 个运行文件，逐文件大小与 SHA-256 等于 win-unpacked。
- [x] 两份 `resources/app` 的 117 个文件经 release profile 对源码、许可、精确白名单核验通过；主程序与五 helper 均 x64（machine 8664）。
- [x] 包中不带诊断启动脚本、实验、测试、日志、用户数据、私人开发记录或备份。

EXE 大小及 SHA-256 以 Release 的 SHA256SUMS.txt 为准：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| Jiegetu-0.91.0-Setup-x64.exe | 122081017 | d127449fd39ecd869730cb812ac48efef4194d6664c1f74620089ad670f73eae |
| Jiegetu-0.91.0-Portable-x64.exe | 110619788 | 7cfe83c5113c3d9f08a7240d7cd2511942387d9614ff02f7143c4aed428f2c43 |

### 本机实装验证（2026-11-17，已完成）

- [x] 安装版：Setup 安装 → 首次启动 → F1 框选截图 → 复制 → 托盘退出 → 再启动，全部通过。
- [x] 卸载：卸载器退出码 0，安装目录删除，AppData 完整保留（`settings.json` 哈希不变，剪贴板库与 215 个 blob 原样）。
- [x] 重装：六个 helper 齐，剪贴板监听起得来，旧历史 305→ 314 条可读并继续增长，设置未被改写。
- [x] 免安装版：Portable 解压到 `%TEMP%` 后启动，`packaged:true`、F1 注册成功、六个 helper 齐；与安装版共用同一份 AppData 与单实例锁。
- [x] 开机自启：Run 项从开发版 electron.exe 改为指向安装版 EXE。

### 仍待真实环境验收

- [ ] 另一台干净 Windows 上的安装、卸载与首次运行；本机实装不代替换机器验证。
- [ ] 便携版开机自启与移动外层 EXE 后的路径行为（本轮按决定不验）。
- [ ] 真实 SmartScreen／未知发布者提示、混合 DPI、任务栏、热键冲突、大长图性能。
- [ ] 本轮新增的批注成图、提取文字、选择工具与悬停样式只在离屏／假 DOM 用例下验过，未做本轮真实窗口手感验收（F1 截图本身已实测）。

上述未验项在 Release 中明确列出；本机实装结果不代替另一台干净机器的验证。v0.91.0 按正式 Release 发布，v0.90.1 与 v0.90.0 保留原标记作为历史条目。两版无代码签名，不关闭系统防护、不伪造发布者身份。

## v0.90.1 双版本交付（历史）

当前提供 Windows x64 安装版与免安装版。公开发布不代表下面所有真实桌面验收都已完成。旧开发历史及旧 dist-review 成品不作发布物。

### 已完成的构建与静态检查

- [x] 项目根 LICENSE 与 package.json 的 license 已确定：免费使用（包括正常商业工作），禁止未经书面许可收费转售软件及修改版。
- [x] 图标记录沿用 0.90.0 的有限范围复核：作者确认图标由 GPT 生成，依据与范围见 assets/LICENSE.txt；不宣称排他权利、全面不侵权或已审计私人账户。
- [x] 版本为 0.90.1，顶层与 lock 根包一致。相对 0.90.0 属小修：长截图分析协作式预算轮询与四阶段计时、背景延展超时保底、诊断计数在 clear 前取快照、裁切时分数视口滚动条反馈。功能升级留给 0.91.0。
- [x] 源码快照为公开提交 e60fdff，189 个文件的白名单导出经隐私通用形状扫描无命中；随后的版本文档提交只改版本号、README 版本链接和发布文档。
- [x] 五个原生 helper 使用本机既有构建产物（wgc-capture 自 10-30 未改动），未在现用截图进程占用期间重编；逐文件哈希记录在 dist-release/payload-verification.json。
- [x] 从同一份源码构建 NSIS Setup 与 Portable；保留 Electron/Chromium、gifenc 及项目自身许可。
- [x] 对两个 EXE 进行归档 CRC 检查和静态解包；逐文件核验内嵌运行载荷与 win-unpacked、来源代码和精确白名单。
- [x] 五个运行 helper 与主程序为 x64，包中不带诊断启动脚本、实验、测试、日志、用户数据、私人开发记录或备份。
- [x] 发布核验支持独立 release profile；只接受明确的元数据字段和五个 helper，不通过扩大文件白名单掩盖差异。

EXE 大小及 SHA-256 以 Release 的 SHA256SUMS.txt 为准。上传后另核对远端附件的大小与 SHA-256，上传前不把本地存在等同于已可下载。

### 仍待真实环境验收

- [ ] 在独立干净 Windows 环境实际安装、首次启动、截图、复制、保存、长图、GIF、退出、再次启动和卸载。
- [ ] 验证安装版／免安装版开机自启及移动后的路径、Run 项与卸载数据保留行为。
- [ ] 真实 SmartScreen／未知发布者提示、混合 DPI、任务栏、热键冲突、大长图性能。

上述未验项在 Release 中明确列出，不将静态解包、测试通过或既有开发机运行经验冒充为干净安装验证。v0.90.1 按正式 Release 发布，v0.90.0 保留原预发布标记作为历史条目。两版无代码签名，不关闭系统防护、不伪造发布者身份。

## 本地打包与核验

先按 BUILDING.md 准备 Node、固定依赖、Electron 与六个必需原生组件。预检会在版本、许可、图标记录或必需组件不齐时阻断：

```powershell
node scripts/release-preflight.cjs
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm exec --yes --package=electron-builder@26.18.0 -- electron-builder --config electron-builder.release.json --win nsis portable --x64 --publish never
node scripts/verify-review-build.cjs --release
node experiments/release-double-package-check.cjs .
```

最后一步要求先把两个 EXE 用 7za 解到 dist-release/verify-extract/{Setup,Portable}，并生成 double-package-verification.json 与 SHA256SUMS.txt。

核验脚本的 release profile 对主程序、源文件、图标、六个必需 helper 和生产依赖逐项检查。builder 26.18.0 默认不复制依赖自己的 README.md，因此只对 gifenc 的这一个路径作明确排除；其 LICENSE.md、dist、src 不放宽。builder 还会清理依赖的 package.json，发布配置通过一个精确 extraFiles 原样保留 gifenc 元数据，继续使用逐字节核验。

最终交付文件：

- Jiegetu-0.90.1-Setup-x64.exe
- Jiegetu-0.90.1-Portable-x64.exe
- SHA256SUMS.txt

不上传 builder-debug.yml、latest.yml、中间压缩包、拆包目录或本地核验报告。设置仍在 AppData；免安装版不提供设置随 U 盘迁移的模式。配置为当前用户安装、安装完不自动启动、卸载保留 AppData；这些是配置结论，不代替实装结果。

发布配置使用 publish: []，构建命令明确 --publish never。builder 可能生成 app-update.yml，但应用未接入自动更新逻辑；此元数据不表示软件会自动联网更新。

## 公开仓库边界

公开源码用 scripts/prepare-public-source.cjs 白名单导出，并逐文件检查哈希和隐私。保留运行源码、原生 C#、构建／测试、锁文件、三个在用图标、两张已确认演示图、公共文档与许可。

不导出 .git、node_modules、native/*.exe、旧开发历史、日志、实验、备份或私人记录；源代码包需重新构建 native helper。开发专用诊断启动入口和仅测试这些入口的 diagnostic-launch*.test.cjs 留在开发仓，公开源码使用 npm start。

0.90.1 的 tag 直接打在建出这两个包的版本文档提交上，源码与二进制同源，不再需要 0.90.0 那种“tag 不动、另指补充提交”的说明。0.90.0 的 tag、Release 与附件保持原样，不回改、不强推。
