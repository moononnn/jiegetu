# 第三方组件与素材说明

本文件不替代项目自身的 LICENSE，也不为未确认来源的图标授予许可。公开发布前须完成素材授权和最终二进制内声明核验。

## gifenc 1.0.3

用途：GIF 编码。上游：https://github.com/mattdesl/gifenc 。许可：MIT。来源：锁定依赖中的 `node_modules/gifenc/LICENSE.md`，原文如下。生产包须保留该文件。

```text
The MIT License (MIT)
Copyright (c) 2017 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```

## Electron 44.9.2

用途：桌面运行时。上游：https://github.com/electron/electron 。Electron 自身许可：MIT；其捆绑 Chromium、Node.js 等组件有各自的声明，应以实际运行时附带的完整文件为准。本节不能替代运行包中的 LICENSE 与 LICENSES.chromium.html。

Electron LICENSE 原文：

```text
Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 构建工具

构建与测试使用的开发依赖以 `package-lock.json` 及固定的 electron-builder 版本为准，不把开发依赖目录整体放入运行包。分发的 Electron 运行时、NSIS 安装载荷及其许可应按最终成品逐项核验。

## 在用图标

`assets/app-icon.png`、`assets/app-icon.ico`、`assets/tray-scroll.png` 的原始素材来源和公开分发授权尚待确认，不因文件在仓库里就认定可公开。未使用的 `assets/tray-girl.png` 不进入公开源码目录或运行包。图标授权未确认前，不将候选目录标为可发布。
