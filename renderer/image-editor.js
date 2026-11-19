/* Classic-script image editor. No capture, clipboard, IPC or external dependencies. */
(() => {
  'use strict';
  const LIMIT = Object.freeze({ pixels: 36000000, edge: 30000, operations: 1000, points: 200000, strokePoints: 20000 });
  window.createImageEditor = function createImageEditor({ root, onCommit = () => {}, onClose = () => {}, recognizeText = null, copyText = null, animation = false, onStateChange = () => {}, onMinimize = null,
    onPreviewRequest = null, onExitRequest = null, onSegmentRequest = null }) {
    if (!(root instanceof HTMLElement)) throw new TypeError('需要编辑器 root');
    // 可选 OCR 桥：宿主真的传了函数才可用；没传就只让用户手填目标文字，不做任何兜底抓图。
    const ocrRecognize = typeof recognizeText === 'function' ? recognizeText : null;
    const ocrCopy = typeof copyText === 'function' ? copyText : null;
    // 可选窗口能力：宿主（选区页）传了 onMinimize 才显示最小化按钮；GIF 编辑不传就不出现。
    const minimizeHandler = typeof onMinimize === 'function' ? onMinimize : null;
    root.classList.add('image-editor');
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '图片编辑');
    const colors=[['红色','#e53935'],['橙色','#f28c28'],['黄色','#f5c542'],['绿色','#2e9d58'],['蓝色','#2979ff'],['紫色','#8e52cc'],['黑色','#202520'],['白色','#ffffff']];
    // —— 画布光标：按工具区分的整套指针（预演已认可）——
    // 全部 32×32、viewBox 0 0 32 32、描边圆头圆角；只在这里构建一次，不在 pointermove 里反复造 SVG。
    const cursorSvg = (inner, x, y, fallback) =>
      `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${inner}</svg>`)}") ${x} ${y}, ${fallback}`;
    // 两 path：白底加粗描边 + 墨绿主线，同一 path、同一 fill。
    const outline = (d, fill = 'none', width = 1.2) => {
      const halo = Math.round((width + 2.2) * 100) / 100;
      return `<path d="${d}" fill="${fill}" stroke="#fff" stroke-width="${halo}" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<path d="${d}" fill="${fill}" stroke="#244e43" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    // 笔/直线：细笔尖落在 (5,25)，笔杆斜向右上；笔尖墨块与笔杆高光都是同一套造型的一部分。
    const penCursor = cursorSvg(
      outline('M5 25L7 18L22 3L27 8L12 23Z M7 18L12 23M20 5L25 10', '#f3f8ed', 1.15) +
      '<path d="M5 25L7 18L12 23Z" fill="#244e43"/>' +
      '<path d="M11 18L20 9" stroke="#9ab49e" stroke-width="1.1"/>', 5, 25, 'default');
    // A 方案的共同定位点：四向短十字 + 中心墨点（热点 8,8）。
    const pin = outline('M8 2V5M8 11V14M2 8H5M11 8H14', 'none', 1.2) +
      '<circle cx="8" cy="8" r=".9" fill="#244e43" stroke="#fff" stroke-width=".5"/>';
    // 矩形/框批注：定位点 + 空心框；箭头：定位点 + 小箭头。
    const rectCursor = cursorSvg(pin + outline('M18 17H29V28H18Z', 'none', 1.25), 8, 8, 'crosshair');
    const regionCursor = rectCursor;   // 框批注与矩形用同一套“定位点 + 空心框”
    const arrowCursor = cursorSvg(pin + outline('M18 28L29 17M22 17H29V24', 'none', 1.35), 8, 8, 'crosshair');
    // point 批注光标：一个清晰的对话气泡，热点就是气泡尾巴尖端（点哪就是哪）。
    const noteBubblePath='M5 3h22a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H14l-3 6-1-6H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z';
    const noteTailPath='M13 19 10 29 17 19';
    const noteHotspot={x:10,y:29};
    const noteSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="#f7faf6" stroke="white" stroke-width="4" stroke-linejoin="round"><path d="${noteBubblePath}"/><path d="${noteTailPath}"/></g><g fill="#f7faf6" stroke="#20382e" stroke-width="1.4" stroke-linejoin="round"><path d="${noteBubblePath}"/><path d="${noteTailPath}"/></g><g fill="none" stroke="#20382e" stroke-width="1.4" stroke-linecap="round"><path d="M9 9h14M9 13h9"/></g></svg>`;
    const noteCursor=`url("data:image/svg+xml,${encodeURIComponent(noteSvg)}") ${noteHotspot.x} ${noteHotspot.y}, crosshair`;
    // 轻量线稿图标：只借原型的分组与克制线条，不引外部资源。
    const ICONS = {
      select: '<path d="m4 4 7.07 17 2.51-7.39L21 11.07Z"/>',
      browse: '<path d="M8 12V6.5a1.8 1.8 0 0 1 3.6 0V11m0-4.5V5a1.8 1.8 0 0 1 3.6 0v6m0-5a1.8 1.8 0 0 1 3.6 0V16c0 3.4-2.4 5.5-6 5.5h-1.6c-1.7 0-2.9-.9-3.8-2.6l-3.2-5a1.8 1.8 0 0 1 2.9-2.1L8 13.5"/>',
      crop: '<path d="M7 3v14h14M3 7h14v14"/>',
      ocr: '<path d="M4 8V4h4m8 0h4v4M4 16v4h4m8 0h4v-4M8 8h8m-4 0v8m-3 0h6"/>',
      mosaic: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
      pen: '<path d="m5.5 15 9.5-9.5 3.5 3.5L9 18.5 4.5 19.5l1-4.5ZM13.5 7l3.5 3.5"/>',
      line: '<path d="M5 19 19 5"/>',
      rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
      arrow: '<path d="m5 19 14-14M9 5h10v10"/>',
      point: '<path d="M12 20.5s6.5-6.4 6.5-11.5a6.5 6.5 0 0 0-13 0c0 5.1 6.5 11.5 6.5 11.5Z"/><circle cx="12" cy="9" r="2.2"/>',
      // 连线：两头各一个小圈，中间一条弧；和像素「直线」明确不是一回事。
      connect: '<circle cx="5.5" cy="17.5" r="1.9"/><circle cx="18.5" cy="6.5" r="1.9"/><path d="M7.4 16.2c2.6-2.4 6.6-6.2 9.2-8.4"/>',
      region: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" stroke-dasharray="4 3"/><path d="M3.5 8V3.5H8m8 17h4.5V16"/>',
      minimize: '<rect x="4.5" y="6" width="15" height="12" rx="2"/><path d="M9 14h6"/>',
      undo: '<path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 6 6v3"/>',
      redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3"/>'
    };
    const icon = name => `<svg class="ie-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
    // 横排分组：查看｜批注｜画标记｜处理图片｜编辑历史；属性只跟当前工具走。
    // 形状（直线/矩形）暂不折进下拉：原生 details 与画布指针/键盘交互叠加成本高，先按同组保留。
    // 批注只有「点」「框」两个入口：想表达什么，靠圈、连、写，不靠先挑一个场景按钮。
    const TOOL_GROUPS = [
      ['查看', [['browse', '抓手'], ['select', '选择/调整']]],
      // 连线是批注之间的关系，和像素「直线」分开：三个相邻工具就是点、框、连线。
      ['批注', [['point', '点批注'], ['region', '框批注'], ['connect', '连线']]],
      ['画标记', [['pen', '画笔'], ['arrow', '箭头'], ['line', '直线'], ['rect', '矩形']]],
      ['处理图片', [['mosaic', '马赛克'], ['crop', '裁切'], ['ocr', '提取文字']]]
    ];
    // 唯一一套撤销/重做放在不滚动的顶栏（文档标题与导出区之间）：工具区窄到要滚时它们也随手可点。
    const historyHtml = `<div class="ie-history" role="group" aria-label="编辑历史"><button type="button" class="ie-tool" data-action="undo" title="撤销最近一次标注 · Ctrl+Z">${icon('undo')}<span>撤销</span></button><button type="button" class="ie-tool" data-action="redo" title="恢复刚撤销的标注 · Ctrl+Y 或 Ctrl+Shift+Z">${icon('redo')}<span>重做</span></button></div>`;
    const headerHtml = `<header class="ie-header"><div class="ie-document"><button type="button" class="ie-back" data-action="close">‹ 返回预览</button><strong class="ie-doc-title">图片编辑</strong><small class="ie-doc-size"></small><button type="button" class="ie-minimize" data-action="minimize" title="最小化到任务栏：编辑页不置顶，可以切到别的窗口" aria-label="最小化" hidden>${icon('minimize')}</button></div>${historyHtml}<div class="ie-exports" role="group" aria-label="输出"><button type="button" class="ie-outline" data-action="segments" title="按原分辨率把这张图切成几张 PNG（带已保存的批注与说明），原图不动；自己选文件夹">分段导出</button><button type="button" class="ie-outline" data-action="save-as" title="另存到指定位置，同时复制到剪贴板；图片保留所有马赛克/纯色遮盖和笔迹">另存并复制…</button><button type="button" class="ie-outline" data-action="save" title="保存到设置的文件夹，同时复制到剪贴板；图片保留所有马赛克/纯色遮盖和笔迹，并带上批注标记（框、编号、连线）">保存并复制</button><button type="button" class="ie-primary" data-action="copy" title="复制图片（保留所有遮盖和笔迹，并带上批注标记：框、编号、连线）并在下方附上批注说明；复制后可粘贴到其他应用">复制图片</button></div></header>`;
    const optionsHtml = `<div class="ie-options" role="group" aria-label="当前工具设置"><strong class="ie-tool-name"></strong>
      <span data-tools="browse">左键拖动画面 · 空格或中键临时拖动</span>
      <span data-tools="point">点一下就落一个可编辑标记，旁边的便签直接写；写完点便签底部的「完成」收起</span>
      <span data-tools="region">拖框圈住位置，右侧说明区直接写；框内拖动、手柄缩放</span>
      <span data-tools="select">选择/调整：单击点、框或连线；拖动移动，手柄缩放或改端点；Delete 删除</span>
      <span data-tools="connect">连线：按住拖过去，或依次点两处；空白会自动落点，Esc 取消</span>
      <button type="button" data-tools="select" data-action="shape-delete" title="删除选中的形状，可用撤销恢复">删除形状</button>
      <span data-tools="crop">框内拖动移动，四边四角手柄调整，框外重新拖框</span>
      <span data-tools="crop" class="ie-crop-size"></span>
      <span data-tools="ocr">拖框提取文字，核对后点「复制文字」；不添加批注，也不改变图片</span>
      <button type="button" data-tools="crop" data-action="crop-apply" class="ie-primary" title="把框选范围应用为新的画面；可用撤销恢复">应用裁切</button>
      <button type="button" data-tools="crop" data-action="crop-cancel" title="放弃这次未应用的裁切框">取消裁切</button>
      <div class="ie-colors" data-tools="pen line rect arrow select" role="group" aria-label="标注颜色"><span>颜色</span><div class="ie-swatches" role="group" aria-label="常用颜色">${colors.map(([name,color])=>`<button type="button" class="ie-swatch" data-color="${color}" aria-label="${name}" title="${name}" aria-pressed="false"><span aria-hidden="true"></span></button>`).join('')}</div><label title="自选其他颜色"><input data-setting="color" type="color" value="#e05278" aria-label="自选标注颜色"></label></div>
      <label data-tools="pen line rect arrow select" title="粗细按原图像素计算">粗细 <input data-range="width" type="range" min="1" max="128" value="6" aria-label="笔画粗细滑块"><input data-setting="width" type="number" min="1" max="128" value="6" aria-label="原图像素线宽"><span>px</span></label>
      <label data-tools="mosaic" title="调整涂抹范围，不改变马赛克颗粒">笔刷大小 <input data-range="diameter" type="range" min="4" max="128" value="20" aria-label="马赛克笔刷大小滑块"><input data-setting="diameter" type="number" min="4" max="128" value="20" aria-label="马赛克原像素笔径"><span>px</span></label>
      <label data-tools="mosaic" title="颗粒越大，细节越少；敏感信息优先使用矩形纯色遮盖">颗粒大小 <input data-setting="grain" type="number" min="4" max="128" value="12" aria-label="马赛克原像素颗粒"><span>px</span></label>
      <label data-tools="rect"><input data-setting="fill" type="checkbox">纯色填充</label>
      </div>`;
    const TOOL_TITLES = { select: '选择/调整：单击点、框或连线选中，拖动移动、手柄缩放；Delete 删除' };
    const toolbarHtml = `<div class="ie-toolbar" aria-label="工具">${TOOL_GROUPS.map(([label, tools]) => `<div class="ie-tool-group"><span class="ie-group-label">${label}</span><div class="ie-tools" role="group" aria-label="${label}">${tools.map(([id, text]) => `<button type="button" class="ie-tool" data-tool="${id}" aria-pressed="${id === 'browse'}" title="${TOOL_TITLES[id] || ''}">${icon(id)}<span>${text}</span></button>`).join('')}${label === '批注' ? '<button type="button" class="ie-tool ie-tool-quiet" data-action="comment" aria-expanded="false" title="写一段不针对某个点的总体说明（右侧面板）">补充说明</button>' : ''}</div></div>`).join('')}<button type="button" class="ie-help-toggle" data-action="help-toggle" aria-expanded="false" title="快捷键与工具说明">? 快捷键</button>${optionsHtml}</div>`;
    // 画布上的紧凑便签：贴着所选批注放，只有直接输入 + 「更多」 + 「删除」；
    // 不再有常驻说明侧栏、位置清单、关系清单和多选开关；高级字段收进「更多」并在内部滚动。
    // 连线共同说明也用同一种便签，动作叫「删线」；两端各自的文字仍然在各自批注里。
    const cardsHtml = `<div class="ie-note-layer" aria-label="批注说明">
        <section class="ie-note-card ie-note-bubble" role="group" aria-label="这条批注的意见" hidden>
          <div class="ie-card-head"><strong class="ie-bubble-title"></strong><span class="ie-card-actions"><button type="button" class="ie-quiet ie-more-toggle" data-action="bubble-more-toggle" aria-expanded="false" title="目标文字、局部放大、多个位置和已有关联都收在这里">更多</button><button type="button" class="ie-quiet ie-bubble-delete" data-action="bubble-delete" title="删除这条批注，可用撤销恢复">删除</button></span></div>
          <textarea class="ie-bubble-text" rows="2" placeholder="写一句说明…（走开也会记下）" aria-label="这条批注的意见"></textarea>
          <div class="ie-bubble-more" hidden>
            <div class="ie-field"><span class="ie-field-label">这条说明适用的位置</span><div class="ie-bubble-targets" role="group" aria-label="这条批注标记的位置"></div><div class="ie-bubble-links"><button type="button" data-action="bubble-add-point" title="在图上再点一个位置，让这条意见同时适用于几处">＋位置（点）</button><button type="button" data-action="bubble-add-region" title="在图上再框一块区域，让这条意见同时适用于几处">＋位置（框）</button></div><label class="ie-bubble-relation">多处之间 <select data-setting="relation" aria-label="同一条意见的多个位置之间的关系"><option value="same">多处同意见</option><option value="move">从A移到B</option><option value="reference">修改A，参考B</option></select></label></div>
            <div class="ie-field ie-bubble-relations-field" hidden><span class="ie-field-label">已有关联</span><div class="ie-bubble-relations" role="group" aria-label="这条批注牵着的关联"></div></div>
            <div class="ie-field ie-bubble-neighbors-field" hidden><span class="ie-field-label">压在一起的其它标记</span><div class="ie-bubble-neighbors" role="group" aria-label="与这处重叠的其它批注"></div></div>
            <label>目标文字 <input class="ie-target-text" type="text" aria-label="目标上的文字，可手填"></label><label class="ie-bubble-inset"><input type="checkbox" data-setting="inset">附局部放大（放在复制图下方）</label>
          </div>
          <div class="ie-card-foot"><button type="button" class="ie-done" data-action="note-done" title="收起这张便签；字已经记下，不点也不会丢">完成</button></div>
        </section>
        <section class="ie-note-card ie-relation-bubble" role="group" aria-label="连线说明" hidden>
          <div class="ie-card-head"><strong class="ie-panel-title">连线 <b class="ie-relation-number">1</b></strong><span class="ie-card-actions"><button type="button" class="ie-quiet" data-action="relation-delete" title="只删这条连线，两处批注和各自的字都留着，可用撤销恢复">删线</button></span></div>
          <p class="ie-relation-ends"></p>
          <textarea class="ie-relation-text" rows="2" maxlength="2000" placeholder="两处一起说…（走开也会记下）" aria-label="这条连线的共同说明"></textarea>
          <div class="ie-card-foot"><button type="button" class="ie-done" data-action="relation-done" title="收起这条线的说明；字已经记下，不点也不会丢">完成</button></div>
        </section>
        <section class="ie-note-card ie-comment-bubble" role="group" aria-label="补充说明" hidden>
          <div class="ie-card-head"><strong class="ie-bubble-title">补充说明</strong><span class="ie-card-actions"><button type="button" class="ie-quiet" data-action="comment-close">收起</button></span></div>
          <textarea class="ie-comment" rows="3" placeholder="想一起说的话，可以只写这一段" aria-label="这张图的总体说明"></textarea>
        </section>
      </div>`;
    const helpHtml = `<div class="ie-help" role="note" hidden><strong>快捷键与工具说明</strong><ul><li>滚轮上下查看 · Shift＋滚轮横移 · Ctrl＋滚轮缩放</li><li>空格或中键拖动画面；Esc 先退出当前编辑的说明，再收起裁切，最后关编辑器</li><li>批注：点或框选一处就成为可编辑标记，旁边的便签直接写；写完点便签底部的「完成」收起，不点也照样记着</li><li>连线：随时可用——从已有点或框起手就接上它，点在空白处会落一个新点；按住拖过去或点两下都行；线旁便签只写这一条共同说明，删线只删这根线，新落的点会留下可继续编辑</li><li>连线时按 Esc、切工具、图外松手都会取消这次手势；手势没完成前不会多出任何批注</li><li>要目标文字/局部放大/再加一处位置，展开该批注的「更多」</li><li>框批注：选中位置后可直接在框内拖动、拖 8 个手柄缩放</li><li>裁切：拖动边角调整范围，Enter 或「应用裁切」生效，Esc 取消</li><li>保存并复制 / 另存并复制 / 复制图片 用的是同一张完整成图：遮盖与笔迹都在，批注的框、编号与连线也画在图上，图上的编号与下方说明里的意见编号一一对应；存下来的文件与剪贴板内容一致；缩略图与 GIF 不附说明区</li><li>分段导出按原分辨率把这张长截图切成几张 PNG（带批注与说明），原图不动</li></ul></div>`;
    const footerHtml = `<footer class="ie-footer"><div class="ie-footer-info"><span class="ie-status" role="status" aria-live="polite"></span></div><div class="ie-view-actions" role="group" aria-label="预览缩放与预览标记"><button type="button" data-action="notes-toggle" aria-pressed="true" aria-label="显示或隐藏预览标记" title="只切换编辑器里的预览标记；保存并复制、复制图片与分段导出的成图都会带上批注标记（框、编号、连线），批注说明在下方">预览标记</button><button type="button" data-action="zoom-out" aria-label="缩小预览">−</button><output class="ie-zoom">100%</output><button type="button" data-action="zoom-in" aria-label="放大预览">＋</button><button type="button" data-action="fit">适合宽度</button><button type="button" data-action="fit-image" title="双维度适应整张图，四边留出可抓手柄的边距">适合整图</button><button type="button" data-action="actual">原尺寸</button></div></footer>`;
    root.innerHTML = `${headerHtml}
      ${toolbarHtml}
      <p class="ie-warning" role="note" hidden></p>
      <div class="ie-main"><div class="ie-workspace"><div class="ie-scroll" tabindex="0" aria-label="图片画布：滚轮上下、Shift 横移、Ctrl 滚轮缩放、空格或中键拖动画面"><div class="ie-spacer"></div></div><canvas class="ie-display" aria-hidden="true"></canvas><div class="ie-brush-cursor" aria-hidden="true" hidden></div><div class="ie-marker-layer" aria-label="批注编号"></div>${cardsHtml}<section class="ie-note-card ie-ocr-panel" aria-label="提取文字" hidden><div class="ie-card-head"><strong>提取文字</strong><button type="button" class="ie-quiet" data-action="ocr-close" aria-label="收起文字结果">收起</button></div><p class="ie-ocr-status" role="status"></p><textarea class="ie-ocr-result" rows="6" aria-label="识别结果，可以修改后复制" placeholder="识别结果会显示在这里"></textarea><div class="ie-card-foot"><button type="button" data-action="ocr-retry">重新识别</button><button type="button" data-action="ocr-copy" class="ie-primary">复制文字</button></div></section></div></div>
      ${helpHtml}
      ${footerHtml}`;
    const $ = s => root.querySelector(s);
    // 只有宿主传了 onMinimize 才把这个窗口按钮露出来（GIF 编辑不传 → 一直 hidden）。
    if (minimizeHandler) {
      const button = $('[data-action="minimize"]');
      if (button) button.hidden = false;
    }
    if (animation) {
      root.classList.add('ie-animation');
      // 动画模式没有任何截图输出：只留「应用编辑」；选择/删除与普通编辑同源（共享引擎），不额外放宽动画限制。
      for (const selector of ['[data-tool="point"]','[data-tool="region"]','[data-tool="connect"]','[data-tool="ocr"]','[data-action="comment"]','[data-action="save"]','[data-action="save-as"]','[data-action="notes-toggle"]']) {
        const node = $(selector);
        if (node) node.hidden = true;
      }
      $('[data-action="copy"]').textContent = '应用编辑';
      $('[data-action="copy"]').title = '对保留的全部帧应用编辑，生成 GIF';
    }
    let frameRevision = 0;
    function clearMosaics() { for (const value of mosaics.values()) value.width=value.height=0; mosaics.clear(); }
    function sourceSize(source) { return [source.displayWidth ?? source.width, source.displayHeight ?? source.height]; }
    root.querySelectorAll('[data-color]').forEach(el=>{el.firstElementChild.style.backgroundColor=el.dataset.color;});
    const scroller = $('.ie-scroll'), spacer = $('.ie-spacer'), display = $('.ie-display'), context = display.getContext('2d');
    let image = null, token, width = 0, height = 0, ops = [], cursor = 0, pointCount = 0;
    let opened = false, locked = false, loading = false, exporting = false, epoch = 0, zoom = 1, tool = 'browse', drag = null, frame = 0;
    // 真实渲染帧计数：只给只读诊断用，验收据此确认“建立关联后的下一帧就能看到线”。
    let renderCount = 0;
    // 只读预览：同一份文档/画布/历史，只收起工具栏与批注入口，只留浏览、缩放与输出。
    // 由宿主决定何时进入/退出（长截图结果页默认先进预览）；F1 唤回/同 token 重开不碰它。
    let previewMode = false;
    const previewHostRequest = typeof onPreviewRequest === 'function' ? onPreviewRequest : null;
    const exitHostRequest = typeof onExitRequest === 'function' ? onExitRequest : null;
    // 预览态下不允许改内容的按钮：工具栏与面板本身是隐藏的，这里再堵一层程序化点击。
    const PREVIEW_BLOCKED_ACTIONS = ['crop-apply', 'crop-cancel', 'undo', 'redo', 'comment', 'comment-close',
      'bubble-delete', 'bubble-add-point', 'bubble-add-region', 'bubble-more-toggle',
      'ocr-copy', 'ocr-retry', 'ocr-close', 'bubble-relation', 'bubble-neighbor', 'target-remove', 'target-select', 'marker', 'shape-delete',
      'relation-delete', 'note-done', 'relation-done'];
    let savedScroll = [0, 0], oldFocus = null;
    const workspace=$('.ie-workspace'), brushCursor=$('.ie-brush-cursor');
    let pointer=null;
    // 导航：中键拖拽 / 空格+左键临时平移；不换工具、不进历史。
    let pan = null, spaceDown = false;
    // 30000 高的长图也要能整张适应，最小缩放降到 0.001（不改图片容量限制）。
    const MIN_ZOOM = 0.001, MAX_ZOOM = 8;
    const clampZoom = value => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    // —— 批注（编号点 / 框）——
    // 批注作为 annotation op 进同一份 ops 历史：新增可撤销，删除是一条 tombstone（annotation-delete），
    // 撤销删除就恢复。文字和面板状态不进历史，所以改字不会被别的撤销带走。
    const annotationLimits = (window.Annotations && window.Annotations.LIMITS) || { annotations: 100, text: 2000, comment: 4000 };
    const noteTools = new Set(['point', 'region']);
    // 手绘几何只在装了 helper 时用；GIF 页不装也不会白屏（退回旧的规则框）。
    const visuals = window.AnnotationVisuals || null;
    function normalizeRelation(value) { return value === 'move' || value === 'reference' ? value : 'same'; }
    let annotationSeq = 0;
    // 选中态全是暂态：selectedTargets 是唯一的选择真相（稳定 {annotationId,targetId}），
    // selectedRelationId 与它互斥；noteState 是当前选中批注的工作副本（几何/细节），文字直接写回 op。
    // 落位即 commit，没有“先标着/完成”这道过路关；取消未完成的拖框才不落记录。
    let selectedTargets = [], selectedRelationId = null;
    let noteId = null, noteState = null, bubbleKey = '';
    let commentOpen = false;
    // 关联目标选择中：这一次点击/拖框只用来给当前批注加一个位置。
    let linkPick = null, bubbleMoreOpen = false;
    // 连线手势：已有端点只存稳定的 {annotationId,targetId} 引用；空白起手只暂存一个坐标（{point}），
    // 成功前不写正式批注，也不能拿临时坐标冒充真实端点传给 sameEnd／投影／端点有效性检查。
    // 暂态不存几何副本、不序列化、不进历史。
    // phase: press（还按着第一处）/ armed（已松开，等第二击）/ armed-pressed（第二处按下了，等松手判定）。
    let connect = null;
    const CONNECT_DRAG_THRESHOLD = 5;   // CSS px，缩放不改变
    // 两个临时端点至少隔这么远（CSS px）：同一处点两下不产生两个点、也不留半条线。
    const CONNECT_MIN_SPAN = 5;
    // 当前选中的框目标下标：只有它显示 8 个手柄、可框内拖动/手柄缩放。
    let frameIndex = null;
    // 像素 revision：任何进历史的图像变化都 +1；OCR 生成的文字绑定生成时的 revision。
    let pixelRevision = 0, ocrToken = 0, ocrPending = false;
    let ocrSelection = null, ocrResultRevision = null, ocrCopying = false;
    // 预览里是否显示批注（编号/引线/空心圈/框）：只影响屏幕预览和命中，任何导出的图片都不带批注标记。
    let notesVisible = true;
    // 分段导出：同一时刻只允许一条；导出中按钮变成「停止」，不改像素、不丢草稿。
    let segmentBusy = false, segmentCanceled = false, segmentSession = null;
    // —— 裁切 ——
    // 源图尺寸 width/height 永远不变；裁切作为 crop op 进同一份 ops 历史，
    // 当前画面（视窗）由 cursor 之前最后一条 crop 推导；cropDraft 是还没应用的框选（源图绝对坐标）。
    let cropDraft = null;
    // 8 个手柄：可见 10 CSS px，热区 14 CSS px（至少 8），不随 zoom 缩小。
    const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const CROP_HANDLE_SIZE = 10, CROP_HANDLE_HIT = 14;
    // 批注框的手柄比裁切框小一号；热区沿用同一套固定 CSS 像素（不随 zoom 缩水）。
    const FRAME_HANDLE_SIZE = 8, FRAME_MIN = 2;
    const CROP_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
    // —— 形状二次调整（矩形/直线/箭头）——
    // 只调未填充矩形与线/箭头：填充矩形是隐私遮盖，马赛克/画笔不参与。
    // 几何走 shape-update 快照进历史（不改旧 op），删除是 shape-delete tombstone；
    // compose 永远按创建槽位画当前有效版本，不会把更新的形状提到后画的遮盖之上。
    const SHAPE_TOOLS = new Set(['rect', 'line', 'arrow']);
    const SHAPE_HANDLE_SIZE = 8, SHAPE_HANDLE_HIT = 12, SHAPE_EDGE_HIT = 6, SHAPE_MIN = 1;
    let shapeSeq = 0, shapeSelected = null;
    function currentView() {
      for (let i = cursor - 1; i >= 0; i--) {
        const op = ops[i];
        if (op && op.tool === 'crop' && op.rect) return { x: op.rect.x, y: op.rect.y, width: op.rect.width, height: op.rect.height };
      }
      return { x: 0, y: 0, width, height };
    }
    // 只有“确实裁过”才对外报 crop；“裁成原尺寸”按无裁切处理，避免多带一个无意义字段。
    function cropField() {
      const view = currentView();
      return view.x || view.y || view.width !== width || view.height !== height ? { ...view } : undefined;
    }
    // 手势层夹回：贴边拖框时 x + width 可能因浮点舍入多出 1 个 ulp，而数据模型与主进程 core 都是严格比较。
    // 边界始终是当前视窗（裁切后的画面），不是源图。
    function fitRect(value) {
      const view = currentView(), right = view.x + view.width, bottom = view.y + view.height;
      let boxWidth = value.width, boxHeight = value.height;
      if (value.x + boxWidth > right) boxWidth = Math.max(0, boxWidth - Math.abs(boxWidth) * 2 * Number.EPSILON);
      if (value.y + boxHeight > bottom) boxHeight = Math.max(0, boxHeight - Math.abs(boxHeight) * 2 * Number.EPSILON);
      return { x: value.x, y: value.y, width: boxWidth, height: boxHeight };
    }
    // 批注按当前视窗筛选：点在内保留，框取正面积交集；按可见顺序重编号，但不改源 ops。
    function pointInside(point, view) {
      return point.x >= view.x && point.y >= view.y && point.x <= view.x + view.width && point.y <= view.y + view.height;
    }
    function rectOverlap(rect, view) {
      return rect.x < view.x + view.width && rect.x + rect.width > view.x &&
        rect.y < view.y + view.height && rect.y + rect.height > view.y;
    }
    // 一条批注最多 8 个目标：主目标 A + 最多 7 个关联目标 B..H。
    const MAX_TARGETS = 8;
    const TARGET_LETTERS = 'ABCDEFGH';
    // 关系：独立于批注的“两处有关”，端点只存稳定引用。
    const MAX_RELATIONS = 100;
    const RELATION_TEXT_LIMIT = 2000;
    let targetSeq = 0;
    const nextTargetId = () => { targetSeq += 1; return `t${targetSeq}`; };
    // 旧记录没有内部标识时，用“批注 id + 源槽位 + 源图几何”算一个确定性兼容标识。
    // 槽位保证同一条旧批注里几何完全相同的两处也能被分别引用；一旦物化就固化成显式 id，
    // 之后再删/移/主目标换位都不会变（不会拿每次现有数组下标重算）。
    const legacyTargetId = (annotationId, target, slot) => {
      const body = target.kind === 'point'
        ? `${target.point?.x},${target.point?.y}`
        : `${target.rect?.x},${target.rect?.y},${target.rect?.width},${target.rect?.height}`;
      return `legacy:${annotationId}:${slot}:${target.kind === 'point' ? 'p' : 'r'}:${body}`;
    };
    function targetLetter(index) { return TARGET_LETTERS[index] || '?'; }
    function cloneTargetOf(target) {
      const copy = target.kind === 'point'
        ? { kind: 'point', point: { x: target.point.x, y: target.point.y } }
        : { kind: 'region', rect: { x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height } };
      // 身份跟着目标走：复制几何可以，丢身份不行（关系靠它认人）。
      if (typeof target.targetId === 'string' && target.targetId) copy.targetId = target.targetId;
      return copy;
    }
    // 源记录 → 目标清单：第一位永远是主目标（旧数据只有它），related 是可选附加目标。
    // 每个目标都带稳定 targetId：新记录从写入时就有，旧记录缺的时候给出确定性兼容标识。
    function recordTargets(record) {
      const primaryBody = { kind: record.kind, point: record.point, rect: record.rect };
      const list = [{ ...primaryBody,
        targetId: typeof record.targetId === 'string' && record.targetId ? record.targetId : legacyTargetId(record.id, primaryBody, 0) }];
      if (Array.isArray(record.related)) {
        for (const extra of record.related) {
          if (list.length >= MAX_TARGETS) break;
          if (!extra || (extra.kind !== 'point' && extra.kind !== 'region')) continue;
          const slot = list.length;
          list.push({ kind: extra.kind, point: extra.point, rect: extra.rect,
            targetId: typeof extra.targetId === 'string' && extra.targetId ? extra.targetId : legacyTargetId(record.id, extra, slot) });
        }
      }
      return list;
    }
    // 框与当前画面取正面积交集；完全在外或贴成零面积都不算活。
    function clipRegion(rect, view) {
      if (!rect) return null;
      const x = Math.max(rect.x, view.x), y = Math.max(rect.y, view.y);
      const right = Math.min(rect.x + rect.width, view.x + view.width);
      const bottom = Math.min(rect.y + rect.height, view.y + view.height);
      return right - x > 0 && bottom - y > 0 ? { x, y, width: right - x, height: bottom - y } : null;
    }
    // 批注按「历史有效版本」解析：annotation-update 用完整快照覆盖，annotation-delete 让整条消失；
    // 撤销/重做只移动 cursor，所以看到的永远是这个时点有效的那一版。
    function annotationRecords() {      const order = [], map = new Map();
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op) continue;
        if (op.tool === 'annotation') {
          if (!map.has(op.id)) order.push(op.id);
          map.set(op.id, op);
        } else if (op.tool === 'annotation-update') {
          if (map.has(op.id)) map.set(op.id, op.snapshot);
        } else if (op.tool === 'annotation-delete') {
          map.delete(op.id);
          const at = order.indexOf(op.id);
          if (at >= 0) order.splice(at, 1);
        } else if (op.tool === 'annotation-relation' && Array.isArray(op.snapshots)) {
          // 建关系时物化的目标身份：与关系同一次事务、同一个光标位置。
          for (const snap of op.snapshots) if (snap && map.has(snap.id) && snap.record) map.set(snap.id, snap.record);
        }
      }
      return order.map(id => map.get(id)).filter(record => record && (record.kind === 'point' || record.kind === 'region'));
    }
    // 每个目标各自过裁切：点在外丢，框取交集；任一存活就保留这条，字母保留源次序（A 被裁掉可以只剩 B）。
    function annotationList() {
      const view = currentView(), alive = [];
      for (const record of annotationRecords()) {
        const targets = [];
        const source = recordTargets(record), sourceCount = source.length;
        source.forEach((target, index) => {
          if (target.kind === 'point') {
            if (!target.point || !pointInside(target.point, view)) return;
            targets.push({ index, letter: targetLetter(index), targetId: target.targetId, kind: 'point', point: { x: target.point.x, y: target.point.y } });
            return;
          }
          const rect = clipRegion(target.rect, view);
          if (rect) targets.push({ index, letter: targetLetter(index), targetId: target.targetId, kind: 'region', rect });
        });
        if (!targets.length) continue;
        const primary = targets[0];
        alive.push({ id: record.id, number: alive.length + 1, kind: primary.kind,
          ...(primary.kind === 'point' ? { point: primary.point } : { rect: primary.rect }),
          text: typeof record.text === 'string' ? record.text : '', targets, targetCount: recordTargets(record).length, mainDead: primary.index !== 0, sourceCount,
          relation: sourceCount === 2 ? normalizeRelation(record.relation) : 'same',
          // 只有用户实际从画布连过的分组才画指向线；旧 same 多框记录没有这个标记。
          linked: record.linked === true,
          targetText: typeof record.targetText === 'string' ? record.targetText : '',
          targetTextAuto: record.targetTextAuto === true,
          targetTextRevision: Number.isSafeInteger(record.targetTextRevision) ? record.targetTextRevision : 0,
          inset: record.inset === true,
          details: { action: typeof record.details?.action === 'string' ? record.details.action : '',
            current: typeof record.details?.current === 'string' ? record.details.current : '',
            expected: typeof record.details?.expected === 'string' ? record.details.expected : '' } });
      }
      return alive;
    }
    // 导出投影（只给导出用，不改源 ops）：annotationList 给的已是源坐标交集，这里只减视窗原点。
    function projectedNotes(notes, view) {
      const shift = target => (target.kind === 'point'
        ? { ...target, point: { x: target.point.x - view.x, y: target.point.y - view.y } }
        : { ...target, rect: { x: target.rect.x - view.x, y: target.rect.y - view.y,
          width: target.rect.width, height: target.rect.height } });
      return notes.map(note => ({ ...note,
        ...(note.kind === 'point' ? { point: { x: note.point.x - view.x, y: note.point.y - view.y } }
          : { rect: { x: note.rect.x - view.x, y: note.rect.y - view.y,
            width: note.rect.width, height: note.rect.height } }),
        targets: (note.targets || []).map(shift) }));
    }
    // —— 关系：独立于批注的“两处有关”，端点只存 {annotationId, targetId} ——
    // 字母与下标只用于显示/定位；删掉前一个目标后幸存目标的身份不变。
    let relationSeq = 0;
    const nextRelationId = () => { relationSeq += 1; return `r${relationSeq}`; };
    function relationRecords() {
      const map = new Map(), order = [];
      const drop = id => {
        if (!map.has(id)) return;
        map.delete(id);
        const at = order.indexOf(id);
        if (at >= 0) order.splice(at, 1);
      };
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op) continue;
        if (op.tool === 'annotation-relation') {
          if (!map.has(op.id)) order.push(op.id);
          map.set(op.id, { id: op.id, a: op.a, b: op.b, text: typeof op.text === 'string' ? op.text : '' });
          continue;
        }
        if (op.tool === 'annotation-relation-update') {
          const record = map.get(op.id);
          if (record) map.set(op.id, { ...record, text: typeof op.text === 'string' ? op.text : record.text });
          continue;
        }
        if (op.tool === 'annotation-relation-delete') { drop(op.id); continue; }
        // 删目标/删批注连带删关系：与那条变更同一次事务、同一个光标位置。
        if ((op.tool === 'annotation-update' || op.tool === 'annotation-delete') && Array.isArray(op.relationDeletes)) {
          for (const relationId of op.relationDeletes) drop(relationId);
        }
      }
      return order.map(id => map.get(id)).filter(Boolean);
    }
    // 端点解析到当前画面还看得见的目标：裁掉/删掉的一端解析不出来，关系就是“不完整”。
    function relationList() {
      const notes = annotationList();
      const byId = new Map(notes.map(note => [note.id, note]));
      const resolve = end => {
        const note = end ? byId.get(end.annotationId) : undefined;
        const target = note && note.targets.find(item => item.targetId === end.targetId);
        if (!target) return undefined;
        return { annotationId: note.id, number: note.number, targetId: target.targetId,
          kind: target.kind, point: target.point, rect: target.rect };
      };
      return relationRecords().map(record => {
        const a = resolve(record.a), b = resolve(record.b);
        return { id: record.id, text: record.text, a, b, complete: Boolean(a && b) };
      });
    }
    function relationsTouching(annotationId, targetId) {
      return relationRecords().filter(record =>
        (record.a.annotationId === annotationId && record.a.targetId === targetId) ||
        (record.b.annotationId === annotationId && record.b.targetId === targetId));
    }
    function relationsOfAnnotation(annotationId) {
      return relationRecords().filter(record =>
        record.a.annotationId === annotationId || record.b.annotationId === annotationId);
    }
    // 旧记录缺 targetId 时，在“建关系”这一次事务里把身份物化写进快照；不重写无关联的旧记录。
    function materializeSnapshot(annotationId) {
      const record = annotationRecords().find(item => item.id === annotationId);
      if (!record) return undefined;
      const targets = recordTargets(record);
      const missing = !(typeof record.targetId === 'string' && record.targetId) ||
        (Array.isArray(record.related) && record.related.some(extra => !(extra && typeof extra.targetId === 'string' && extra.targetId)));
      if (!missing) return undefined;
      const rebuilt = { ...record, targetId: targets[0].targetId };
      if (targets.length > 1) {
        rebuilt.related = targets.slice(1).map(target => ({
          ...(target.kind === 'point' ? { kind: 'point', point: { ...target.point } } : { kind: 'region', rect: { ...target.rect } }),
          targetId: target.targetId
        }));
      } else {
        delete rebuilt.related;
      }
      return { id: rebuilt.id, record: rebuilt };
    }
    function findTargetRecord(annotationId, targetId) {
      const record = annotationRecords().find(item => item.id === annotationId);
      if (!record) return undefined;
      const target = recordTargets(record).find(item => item.targetId === targetId);
      return target ? { record, target } : undefined;
    }
    const relationPairKey = (a, b) => [`${a.annotationId}:${a.targetId}`, `${b.annotationId}:${b.targetId}`].sort().join('|');
    // 建关系：先校验，再把身份物化与关系写成同一条 op（一次撤销就全回）。
    function createRelation(a, b, text = '') {
      if (!findTargetRecord(a.annotationId, a.targetId) || !findTargetRecord(b.annotationId, b.targetId)) {
        status('这一端已经不在了，关系没建立');
        return undefined;
      }
      if (a.annotationId === b.annotationId && a.targetId === b.targetId) {
        status('两处不能是同一处');
        return undefined;
      }
      if (relationRecords().length >= MAX_RELATIONS) { status(`关系最多 ${MAX_RELATIONS} 条`); return undefined; }
      const key = relationPairKey(a, b);
      if (relationRecords().some(record => relationPairKey(record.a, record.b) === key)) {
        status('这两处已经有关联了');
        return undefined;
      }
      const body = typeof text === 'string' ? text : '';
      if (Array.from(body).length > RELATION_TEXT_LIMIT) { status(`关系说明超过 ${RELATION_TEXT_LIMIT} 字`); return undefined; }
      const snapshots = [];
      for (const end of [a, b]) {
        const snap = materializeSnapshot(end.annotationId);
        if (snap && !snapshots.some(item => item.id === snap.id)) snapshots.push(snap);
      }
      const id = nextRelationId();
      const op = { tool: 'annotation-relation', id,
        a: { annotationId: a.annotationId, targetId: a.targetId },
        b: { annotationId: b.annotationId, targetId: b.targetId }, text: body };
      if (snapshots.length) op.snapshots = snapshots;
      commitOp(op);
      return id;
    }
    function updateRelationText(id, text) {
      const record = relationRecords().find(item => item.id === id);
      if (!record) return false;
      const body = typeof text === 'string' ? text : '';
      if (Array.from(body).length > RELATION_TEXT_LIMIT) { status(`关系说明超过 ${RELATION_TEXT_LIMIT} 字`); return false; }
      if (body === record.text) return true;
      commitOp({ tool: 'annotation-relation-update', id, text: body });
      return true;
    }
    function deleteRelation(id) {
      if (!relationRecords().some(item => item.id === id)) return false;
      commitOp({ tool: 'annotation-relation-delete', id });
      return true;
    }

    // 最新有效版本（可写）：纯改字仍然就地写回这一版，撤销别的操作不会把文字带走。
    // 与 annotationRecords 同一套历史顺序：建关系时物化的身份快照也要认，但只覆盖当前仍存在的记录，
    // 不从“已删除”状态复活一条批注。
    function opById(id) {
      let record;
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op) continue;
        if (op.tool === 'annotation' && op.id === id) record = op;
        else if (op.tool === 'annotation-update' && op.id === id) record = op.snapshot;
        else if (op.tool === 'annotation-delete' && op.id === id) record = undefined;
        else if (op.tool === 'annotation-relation' && Array.isArray(op.snapshots)) {
          for (const snap of op.snapshots) if (snap && snap.id === id && snap.record && record) record = snap.record;
        }
      }
      return record;
    }
    // 批注与关系都不改像素：撤销/重做它们不能让 OCR 目标文字过期。
    const RELATION_TOOLS = new Set(['annotation-relation', 'annotation-relation-update', 'annotation-relation-delete']);
    const isNonPixelOp = tool => tool === 'annotation' || tool === 'annotation-update' || tool === 'annotation-delete' || RELATION_TOOLS.has(tool);
    // 一次连线如果顺手新建了 0～2 个空点，这几个相邻 op 属于同一次动作：
    // 只在本地 ops 上挂一个不可枚举的分组标记（不进 JSON、不输出、不持久化、不改 schema），
    // history 撤销/重做跨同组连续 op 一次走完，不会先撤走一个点却把线留着。
    const HISTORY_GROUP = Symbol('historyGroup');
    let historyGroupSeq = 0;
    function markHistoryGroup(from, to) {
      const group = (historyGroupSeq += 1);
      for (let i = from; i < to; i += 1) {
        const op = ops[i];
        if (op && typeof op === 'object') {
          Object.defineProperty(op, HISTORY_GROUP, { value: group, configurable: true, writable: true });
        }
      }
      return group;
    }
    // 撤销/重做要落到的光标：落在同组连续 op 的边界上，绝不半组。
    function historyStep(delta) {
      if (delta > 0) {
        let next = Math.min(ops.length, cursor + delta);
        const group = ops[cursor] ? ops[cursor][HISTORY_GROUP] : undefined;
        if (group != null) while (next < ops.length && ops[next] && ops[next][HISTORY_GROUP] === group) next += 1;
        return next;
      }
      let next = Math.max(0, cursor + delta);
      const group = cursor > 0 && ops[cursor - 1] ? ops[cursor - 1][HISTORY_GROUP] : undefined;
      if (group != null) while (next > 0 && ops[next - 1] && ops[next - 1][HISTORY_GROUP] === group) next -= 1;
      return next;
    }
    function commitOp(op) {
      ops = ops.slice(0, cursor); ops.push(op); cursor += 1;
      // 只有真的改了像素（笔迹/遮盖/裁切）才推进 revision；批注本身不改像素，
      // 所以「先 OCR 再保存这条批注」不能把自己的目标文字作废。
      if (op.tool !== 'annotation' && op.tool !== 'annotation-update' && op.tool !== 'annotation-delete' &&
          op.tool !== 'annotation-relation' && op.tool !== 'annotation-relation-update' && op.tool !== 'annotation-relation-delete') pixelRevision += 1;
    }
    function nextAnnotationId() { annotationSeq += 1; return `a${annotationSeq}`; }
    // —— 形状（矩形/直线/箭头）的当前有效版本 ——
    // 创建顺序就是 z-order；更新只在原槽位换一张快照，不重新插入、不重排，也永远不后画到遮挡之上。
    // 只有未填充矩形与线/箭头可调：填充矩形是隐私遮盖，马赛克/画笔不参与。
    const shapeAdjustable = op => Boolean(op) && (op.tool === 'line' || op.tool === 'arrow' ||
      (op.tool === 'rect' && op.fill === false));
    const nextShapeId = () => { shapeSeq += 1; return `s${shapeSeq}`; };
    function cloneShape(op) {
      return { ...op, points: op.points.map(p => ({ x: p.x, y: p.y })) };
    }
    // 按历史顺序解析每个形状的最新快照：update 换版本、delete 摘除，其余保持原创建位置。
    function shapeVersions() {
      const map = new Map();
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op) continue;
        if (op.tool === 'shape-update') { if (map.has(op.id)) map.set(op.id, op.snapshot); }
        else if (op.tool === 'shape-delete') map.delete(op.id);
        else if (op.id && SHAPE_TOOLS.has(op.tool)) map.set(op.id, op);
      }
      return map;
    }
    function hasSelectableContent() {
      return Array.from(shapeVersions().values()).some(shapeAdjustable) ||
        annotationRecords().length > 0 || relationRecords().length > 0;
    }
    function resolvedShape(id) {
      const op = shapeVersions().get(id);
      return shapeAdjustable(op) ? op : null;
    }
    function selectedShape() { return shapeSelected ? resolvedShape(shapeSelected) : null; }
    // 拖拽中的屏幕几何：手柄/高亮跟草稿走（像素仍是顶层 compose 的事，且只限 live 帧）。
    function liveShape() {
      const op = selectedShape();
      if (!op) return null;
      return drag?.shapeId === op.id && drag.draft ? drag.draft : op;
    }
    // 累计到全局上限后不再允许新的形状变更；选择与取消不受影响。
    function shapeBudgetFull() { return cursor >= LIMIT.operations || pointCount >= LIMIT.points; }
    function sameShape(a, b) {
      if (!a || !b) return false;
      return a.color === b.color && a.width === b.width && Boolean(a.fill) === Boolean(b.fill) &&
        a.points.length === b.points.length && a.points.every((p, i) => p.x === b.points[i].x && p.y === b.points[i].y);
    }
    function commentField() { return $('.ie-comment'); }
    function markerRadius() {
      const view = currentView();
      return Math.max(9, Math.min(28, Math.round(Math.min(view.width, view.height) / 60)));
    }
    function noteRingRadius() { return Math.max(3, Math.round(markerRadius() * 0.45)); }
    // 批注图形：落点（真实坐标）只留一个小空心圈，实心编号往图内侧偏出去，再用一条细引线连回来。
    // 只在自己的落点和图边界之间挑方向，不做编号之间的避让引擎；贴边就向内收，极小图夹在边界内。
    // anchor / bounds 使用同一套单位：canvas 用原图像素，DOM 预览用屏幕 CSS 像素。
    function noteFigure(anchor, ringRadius, badgeRadius, bounds) {
      const gap = Math.max(2, badgeRadius * 0.45), distance = ringRadius + gap + badgeRadius;
      const sx = anchor.x - bounds.x <= bounds.x + bounds.width - anchor.x ? 1 : -1;
      const sy = anchor.y - bounds.y <= bounds.y + bounds.height - anchor.y ? 1 : -1;
      const clampAxis = (value, low, high, radius) => high - low <= radius * 2
        ? (low + high) / 2 : Math.min(high - radius, Math.max(low + radius, value));
      let best = null;
      for (const [sideX, sideY] of [[sx, sy], [-sx, sy], [sx, -sy], [-sx, -sy]]) {
        const x = clampAxis(anchor.x + sideX * distance, bounds.x, bounds.x + bounds.width, badgeRadius);
        const y = clampAxis(anchor.y + sideY * distance, bounds.y, bounds.y + bounds.height, badgeRadius);
        const clear = Math.hypot(x - anchor.x, y - anchor.y) - ringRadius - badgeRadius;
        // 先要「不盖住落点」，再要「挪得最少」：贴边拉回来时也尽量保住引线。
        const score = (clear >= gap * 0.5 ? 1000 : 0) - Math.abs(x - (anchor.x + sideX * distance)) - Math.abs(y - (anchor.y + sideY * distance));
        if (!best || score > best.score) best = { x, y, score };
      }
      const dx = best.x - anchor.x, dy = best.y - anchor.y, span = Math.hypot(dx, dy) || 1;
      const ux = dx / span, uy = dy / span;
      // 引线只连接两个图形的边缘：圈外沿 → 徽章外沿，不压落点也不穿进编号里。
      return { badge: { x: best.x, y: best.y },
        x1: anchor.x + ux * ringRadius, y1: anchor.y + uy * ringRadius,
        x2: best.x - ux * badgeRadius, y2: best.y - uy * badgeRadius };
    }
    // drawNote 只画屏幕预览里的框批注边框：一条干净细实线，一次 strokeRect 画完，
    // 不抖动、不垫纸底、不双描；只有「还没定下来」的草稿用短虚线提示。
    // 编号/引线/空心圈在屏幕上是 DOM 标记层；复制成图的框由共享 helper 另画，这里不动那条路径。
    // dashed 只在本函数里设置，画完 save/restore 一并清掉，不让虚线漏到后面的框/笔迹上。
    function drawNote(ctx, target, options = {}) {
      const rect = target?.rect;
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      const preview = options.preview === true;
      const relation = normalizeRelation(options.relation);
      const index = Number.isInteger(options.index) ? options.index : 0;
      // 线宽按屏幕 CSS 像素折算成原图像素（zoom 有上下界，必为正）：放大多少倍，屏幕上都是 2px 细线。
      const width = 2 / zoom;
      const color = visuals ? visuals.boxColor(relation, index) : '#20382e';
      ctx.save();
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      // 实线也要先把 dash 清空：不能继承调用者留下的虚线；草稿才换成短虚线。
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash(preview ? [6 / zoom, 4 / zoom] : []);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
      ctx.restore();
    }
    // 关系框的固定短标签（原位置 / 移到这里 / 要改 / 参考）：画在框内左上角，不靠颜色单独表达含义。
    // 屏幕用 zoom 换算字号与笔宽，导出行传固定值，两边都从同一份关系数据来。
    function drawRelationTags(ctx, note, options = {}) {
      if (!visuals || !visuals.isRelation(note?.relation)) return;
      const fontSize = options.fontSize || Math.max(9, Math.min(28, Math.round(13 / zoom)));
      const width = options.width || Math.max(1, 2 / zoom);
      const targets = note.targets || [];
      for (const target of targets) {
        if (target.kind !== 'region') continue;
        const text = visuals.targetLabel(note.relation, target.index);
        if (!text) continue;
        const rect = target.rect;
        if (rect.width < fontSize * 1.4 || rect.height < fontSize * 1.6) continue;
        visuals.drawLabel(ctx, text, { x: rect.x + 2, y: rect.y + 2 }, {
          fontSize, width, bounds: { x: rect.x + 3, y: rect.y + 3, width: Math.max(0, rect.width - 6), height: Math.max(0, rect.height - 6) },
          color: visuals.PALETTE.inkDeep, border: visuals.boxColor(note.relation, target.index) });
      }
    }
    // 独立关系（两处有关）的曲线：两端都用当前几何算，端点移动/缩放/取消裁切都会跟着变。
    function relationCurvePoints(a, b, bend = 0.14) {
      if (!visuals || !a || !b) return null;
      const from = visuals.targetAnchor(a, visuals.targetCenter(b));
      const to = visuals.targetAnchor(b, visuals.targetCenter(a));
      if (!from || !to) return null;
      const dx = to.x - from.x, dy = to.y - from.y;
      if (Math.hypot(dx, dy) < 0.5) return null;
      const mid = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend };
      const points = [];
      for (let i = 0; i <= 18; i += 1) {
        const t = i / 18, k = 1 - t;
        points.push({ x: k * k * from.x + 2 * k * t * mid.x + t * t * to.x,
          y: k * k * from.y + 2 * k * t * mid.y + t * t * to.y });
      }
      return { points, from, to };
    }
    function drawRelationLines(ctx, relation, options = {}) {
      if (!visuals || !relation || !relation.complete) return;
      const curve = relationCurvePoints(relation.a, relation.b);
      if (!curve) return;
      const color = options.selected ? visuals.PALETTE.pink
        : options.preview ? visuals.PALETTE.mint : visuals.PALETTE.inkDeep;
      const base = options.width || Math.max(1, 2 / zoom);
      visuals.strokeRelationLine(ctx, curve, { width: options.selected ? base * 1.8 : base, color });
      if (!options.preview && relation.text && typeof visuals.drawLabel === 'function') {
        const view = currentView();
        const mid = curve.points[Math.floor(curve.points.length / 2)];
        const units = Array.from(String(relation.text));
        // 字号/线宽可以由调用方给（导出行用固定值，不跟屏幕缩放走）；预览仍用原来的 zoom 换算。
        visuals.drawLabel(ctx, units.slice(0, 16).join('') + (units.length > 16 ? '…' : ''), mid,
          { fontSize: options.fontSize || Math.max(12, Math.round(13 / zoom)),
            width: options.labelWidth || Math.max(1, 1.2 / zoom),
            bounds: { x: view.x, y: view.y, width: view.width, height: view.height } });
      }
    }
    // 通用连接线：A 到每个关联目标一条手绘指向线。缺端点（裁切后裁掉 A）就不画，
    // 不把剩下的 B 冒充成主目标。只画几何与指向，不写任何业务语义。
    function drawLinkLines(ctx, note, options = {}) {
      if (!visuals || !visuals.linkReady(note)) return;
      const width = options.width || Math.max(1, 2 / zoom);
      const color = options.color || visuals.PALETTE.inkDeep;
      for (const curve of visuals.linkCurves(note)) visuals.strokeRelationLine(ctx, curve, { width, color });
    }
    // 关系进行态不再需要屏幕上的拉线图层：建立关联时直接入历史并选中关系。
    // 当前画面里还看得见的已提交目标（带源坐标几何）。
    function projectedTargets() {
      const list = [];
      for (const note of annotationList()) for (const target of note.targets) {
        list.push({ annotationId: note.id, number: note.number, targetId: target.targetId,
          kind: target.kind, point: target.point, rect: target.rect, index: target.index });
      }
      return list;
    }
    function projectedTargetByEnd(end) {
      return projectedTargets().find(target => target.annotationId === end.annotationId && target.targetId === end.targetId);
    }
    // —— 选择与关联：选择态是暂态（不序列化），落位与建关系都直接进 ops ——
    // 目标命中：点 > 框边线 > 框内部（面积小的优先），与画布一直以来的命中直觉一致。
    function annotationHitAt(at) {
      const tolerance = Math.max(3, 8 / zoom);
      const candidates = [];
      for (const target of projectedTargets()) {
        if (target.kind === 'point') {
          const distance = Math.hypot(at.x - target.point.x, at.y - target.point.y);
          if (distance <= tolerance * 3) candidates.push({ target, rank: 0, metric: distance });
          continue;
        }
        const { x, y, width, height } = target.rect;
        if (at.x < x - tolerance || at.x > x + width + tolerance || at.y < y - tolerance || at.y > y + height + tolerance) continue;
        const edge = Math.min(Math.abs(at.x - x), Math.abs(at.x - (x + width)), Math.abs(at.y - y), Math.abs(at.y - (y + height)));
        const onBorder = edge <= tolerance;
        candidates.push({ target, rank: onBorder ? 1 : 2, metric: onBorder ? edge : width * height });
      }
      candidates.sort((a, b) => a.rank - b.rank || a.metric - b.metric);
      return candidates[0];
    }
    // 关系线命中：复用同一份曲线几何，按屏幕像素给一个有界热区；缺端关系由关系清单兜底。
    function relationAt(at) {
      const tolerance = Math.max(4, 9 / zoom);
      let best = null;
      for (const relation of relationList()) {
        if (!relation.complete) continue;
        const curve = relationCurvePoints(relation.a, relation.b);
        if (!curve) continue;
        for (let i = 1; i < curve.points.length; i += 1) {
          const distance = distanceToSegment(at.x, at.y, curve.points[i - 1], curve.points[i]);
          if (distance <= tolerance && (!best || distance < best.distance)) best = { id: relation.id, distance };
        }
      }
      return best ? best.id : null;
    }
    const endKeyOf = end => `${end.annotationId}:${end.targetId}`;
    const sameEnd = (left, right) => Boolean(left && right) &&
      left.annotationId === right.annotationId && left.targetId === right.targetId;
    // 选中位置的可读标签：清单/已选列表共用一份，不另存几何副本。
    function endLabel(end) {
      const note = annotationList().find(item => item.id === end.annotationId);
      const target = note && note.targets.find(item => item.targetId === end.targetId);
      if (!note || !target) return '这一处已不在当前画面';
      const letter = note.targets.length > 1 ? `${targetLetter(target.index)} ` : '';
      return `第 ${note.number} 条 ${letter}${targetText(target)}`;
    }
    function selectedKeys() { return new Set(selectedTargets.map(endKeyOf)); }
    // 连线便签上的两端摘要：只用人话（编号 + chip 里同一套方位）；
    // endLabel / targetText 也只用编号、字母与方位，不再回显坐标。
    function endSummary(end) {
      const note = annotationList().find(item => item.id === end.annotationId);
      const target = note && note.targets.find(item => item.targetId === end.targetId);
      if (!note || !target) return '另一端不在当前画面';
      const letter = note.targets.length > 1 ? targetLetter(target.index) : '';
      return `批注${note.number}${letter}·${targetZone(target)}`;
    }
    // 高亮来源：当前选择 + 正在进行的连线手势两端（暂态，不入选择、不入历史）。
    function highlightKeys() {
      const keys = selectedKeys();
      if (connect) {
        const start = connectStartEnd();
        if (start) keys.add(endKeyOf(start));
        if (connect.hover && !(start && sameEnd(connect.hover, start))) keys.add(endKeyOf(connect.hover));
      }
      return keys;
    }
    // 当前选中批注的工作副本：只用来接几何/细节改动，文字直接写回 op。
    function loadNoteState() {
      noteState = null; noteId = null; frameIndex = null;
      if (selectedTargets.length !== 1) return;
      const end = selectedTargets[0];
      const op = opById(end.annotationId);
      if (!op) return;
      noteId = end.annotationId;
      bubbleKey = '';
      noteState = stateFromRecord(op);
      const index = noteState.targets.findIndex(target => target.targetId === end.targetId);
      frameIndex = index >= 0 && noteState.targets[index].kind === 'region' ? index : null;
    }
    // 画布命中一处：普通单击替换选择；先收口上一条的文字与连线。
    function pickHitTarget(target, event) {
      if (!flushAll()) return;
      event.preventDefault();
      selectTarget({ annotationId: target.annotationId, targetId: target.targetId });
    }
    // 普通单击替换选择（稳定 {annotationId,targetId}）；连线是独立工具，不再靠多选拼两处。
    function selectTarget(end) {
      selectedTargets = [{ annotationId: end.annotationId, targetId: end.targetId }];
      selectedRelationId = null;
      shapeSelected = null;
      loadNoteState();
      notesVisible = true;
      syncBubble();
      sync();
    }
    function selectRelation(id) {
      if (!relationRecords().some(record => record.id === id)) return;
      selectedRelationId = id; selectedTargets = []; noteId = null; noteState = null; frameIndex = null;
      shapeSelected = null;
      notesVisible = true;
      syncBubble();
      sync();
      const field = $('.ie-relation-text');
      try { field?.focus({ preventScroll: true }); } catch { /* 拿不到焦点也能点按钮。 */ }
    }
    // 取消选择不是删除：标记、文字、关系全部留着。
    function clearSelection() {
      selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
      linkPick = null;
      syncBubble();
      sync();
    }
    // 从选中的正好两处建立关联：当次入历史并选中这条关系；已存在就定位旧的，不清它的字。
    // 关系文字：与批注纯改字一致，写回当前有效关系对应的最近一条 create/update op，不 push 新历史。
    function writeRelationText(id, text) {
      const record = relationRecords().find(item => item.id === id);
      if (!record) return false;
      const body = typeof text === 'string' ? text : '';
      if (Array.from(body).length > RELATION_TEXT_LIMIT) { status(`关系说明超过 ${RELATION_TEXT_LIMIT} 字`); return false; }
      if (body === record.text) return true;
      for (let i = cursor - 1; i >= 0; i -= 1) {
        const op = ops[i];
        if (op && (op.tool === 'annotation-relation' || op.tool === 'annotation-relation-update') && op.id === id) {
          op.text = body;
          return true;
        }
      }
      return false;
    }
    // 同一对批注是否已经连过：命中就不重复建，直接定位原来那条。
    function relationIdForPair(a, b) {
      const key = relationPairKey(a, b);
      const existing = relationRecords().find(record => relationPairKey(record.a, record.b) === key);
      return existing ? existing.id : null;
    }
    // 关系编辑区：两端定位 + 共同意见（两处各自的文字仍在各自便签里）；缺端也可以直接删线。
    function syncRelation() {
      const section = $('.ie-relation-bubble');
      if (!section) return;
      const list = relationList();
      const index = list.findIndex(relation => relation.id === selectedRelationId);
      const relation = index >= 0 ? list[index] : null;
      section.hidden = !relation;
      if (!relation) { if (selectedRelationId) selectedRelationId = null; return; }
      const number = $('.ie-relation-number');
      if (number) number.textContent = String(index + 1);
      const ends = $('.ie-relation-ends');
      if (ends) {
        if (relation.complete) {
          ends.textContent = `${endSummary(relation.a)} ↔ ${endSummary(relation.b)}`;
          ends.title = `${endLabel(relation.a)} ↔ ${endLabel(relation.b)}`;
        } else {
          const known = relation.a || relation.b;
          ends.textContent = `缺一端：${known ? endSummary(known) : '这一端'} ↔ 另一端不在当前画面；`
            + '撤销裁切可以恢复这一端，也可以直接删线';
          ends.title = `${known ? endLabel(known) : '两端都不在当前画面'} ↔ 另一端不在当前画面`;
        }
      }
      const field = $('.ie-relation-text');
      if (field && field.value !== relation.text && document.activeElement !== field) field.value = relation.text;
      const remove = $('[data-action="relation-delete"]');
      if (remove) remove.disabled = blocked() || !image;
      const done = $('[data-action="relation-done"]');
      if (done) done.disabled = blocked() || !image;
    }
    // —— 标记层：真实 button，只活在编辑器预览里 ——
    // 编号只活在编辑器预览里：保存/缩略图/GIF/复制成图都不带框、编号、引线。
    // DOM 这一份是屏幕上带引线的编号：
    // 落点小空心圈 + 偏移的实心编号 + 引线。zoom 很小（例如 5760 宽原图 fit 到 960 CSS px，
    // 约 0.16）时编号仍保底 22 CSS px，偏移也按实际显示大小重新避让。
    const markerFigures = new Map();
    let markerSignatureValue = '';
    function imageScreenRect() {
      const o = origin(), view = currentView();
      return { x: o.x + view.x * zoom, y: o.y + view.y * zoom, width: view.width * zoom, height: view.height * zoom };
    }
    // 正在编辑的那条按工作副本里的几何显示（拖框时不能把旧框叠着画两份）。
    function stagedTargetsOf(item) {
      if (!noteState || noteId !== item.id) return null;
      const view = currentView(), out = [];
      noteState.targets.forEach((target, index) => {
        if (target.kind === 'point') {
          if (pointInside(target.point, view)) out.push({ index, letter: targetLetter(index), kind: 'point', point: { x: target.point.x, y: target.point.y } });
          return;
        }
        const rect = clipRegion(target.rect, view);
        if (rect) out.push({ index, letter: targetLetter(index), kind: 'region', rect });
      });
      return out;
    }
    // 一条批注有几个目标就有几个编号：多目标显示 1A/1B，单目标仍显示原编号。
    function markerEntries() {
      const items = annotationList(), entries = [];
      for (const item of items) {
        const targets = stagedTargetsOf(item) || item.targets;
        // 字母标记按「源目标组」算：A 被裁掉只剩 B 时仍然显示 1B，不把 B 当成新的 A。
        const group = noteState && noteId === item.id ? noteState.targets.length : item.sourceCount;
        const multi = group > 1;
        for (const [position, target] of targets.entries()) {
          // 一条意见只在一处贴文字预览（第一个还看得见的目标），不在每个目标下重复同一句。
          entries.push({ key: `${item.id}#${target.index}`, id: item.id, target, number: item.number, multi,
            showText: position === 0, text: item.text,
            selected: highlightKeys().has(`${item.id}:${target.targetId}`) ||
              (selectedRelationId != null && relationList().some(relation => relation.id === selectedRelationId &&
                [relation.a, relation.b].some(end => end && end.annotationId === item.id && end.targetId === target.targetId))) });
        }
      }
      return entries;
    }
    function markerLabel(entry) { return entry.multi ? `${entry.number}${entry.target.letter}` : String(entry.number); }
    function markerSignature() {
      return markerEntries().map(entry => `${entry.key}:${entry.target.kind}:${entry.multi ? 'm' : 's'}`).join(',');
    }
    function makeMarkerItem(entry) {
      const figure = document.createElement('div');
      figure.className = 'ie-marker-figure';
      const ring = document.createElement('span');
      ring.className = 'ie-marker-ring'; ring.setAttribute('aria-hidden', 'true');
      const leader = document.createElement('span');
      leader.className = 'ie-marker-leader'; leader.setAttribute('aria-hidden', 'true');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ie-marker';
      button.dataset.action = 'marker'; button.dataset.annotationId = entry.id;
      button.dataset.targetIndex = String(entry.target.index);
      // 图上简短文字预览：不是按钮，不接指针；全文在说明区，这里只帮眼睛定位。
      const note = document.createElement('span');
      note.className = 'ie-marker-note'; note.setAttribute('aria-hidden', 'true');
      figure.append(ring, leader, button, note);
      return { figure, ring, leader, button, note };
    }
    function placeMarker(node, entry, label) {
      const target = entry?.target;
      if (!target) return;
      const at = target.kind === 'region' ? { x: target.rect.x, y: target.rect.y } : target.point;
      const o = origin();
      const anchor = { x: o.x + at.x * zoom, y: o.y + at.y * zoom };
      const ringRadius = Math.max(3, noteRingRadius() * zoom);
      const badgeRadius = Math.max(11, markerRadius() * zoom);
      const figure = noteFigure(anchor, ringRadius, badgeRadius, imageScreenRect());
      node.ring.style.width = node.ring.style.height = `${Math.round(ringRadius * 2)}px`;
      node.ring.style.left = `${Math.round(anchor.x - ringRadius)}px`;
      node.ring.style.top = `${Math.round(anchor.y - ringRadius)}px`;
      const length = Math.max(0, Math.hypot(figure.badge.x - anchor.x, figure.badge.y - anchor.y) - ringRadius - badgeRadius);
      node.leader.hidden = length < 0.5;
      // 引线是旋转的一条细线，从圈外沿指向编号外沿。
      node.leader.style.width = `${Math.round(length * 10) / 10}px`;
      node.leader.style.left = `${Math.round(figure.x1 * 10) / 10}px`;
      node.leader.style.top = `${Math.round(figure.y1 * 10) / 10}px`;
      node.leader.style.transform = `rotate(${Math.round(Math.atan2(figure.y2 - figure.y1, figure.x2 - figure.x1) * 1800 / Math.PI) / 10}deg)`;
      const size = Math.round(badgeRadius * 2);
      node.button.style.width = node.button.style.height = `${size}px`;
      node.button.style.left = `${Math.round(figure.badge.x - badgeRadius)}px`;
      node.button.style.top = `${Math.round(figure.badge.y - badgeRadius)}px`;
      // 字号、纸色内圈都跟着尺寸走；保底 22px 时字号也保底 12px 可读。
      node.button.style.fontSize = `${Math.max(12, Math.round(size * 0.55))}px`;
      node.button.style.boxShadow = `inset 0 0 0 ${Math.max(1, Math.round(size / 12))}px #f7faf6`;
      const text = label == null ? '' : String(label);
      if (node.button.textContent !== text) node.button.textContent = text;
      // 文字预览贴编号下方；长文单行省略，全文仍在说明区，不算“截掉内容”。
      // 位置夹在当前画面内，缩放/滚动后也不会被推到看不见的地方。
      const preview = entry.showText ? String(entry.text || '').replace(/\s+/g, ' ').trim() : '';
      node.note.hidden = !preview;
      if (preview) {
        if (node.note.textContent !== preview) node.note.textContent = preview;
        const bounds = imageScreenRect();
        const clampX = value => Math.min(Math.max(bounds.x + 8, value), bounds.x + bounds.width - 8);
        const clampY = value => Math.min(Math.max(bounds.y + 8, value), bounds.y + bounds.height - 8);
        node.note.style.left = `${Math.round(clampX(figure.badge.x))}px`;
        node.note.style.top = `${Math.round(clampY(figure.badge.y + badgeRadius + 4))}px`;
        node.note.style.maxWidth = `${Math.max(80, Math.round(badgeRadius * 12))}px`;
      }
    }
    function renderMarkers() {
      const layer = $('.ie-marker-layer');
      if (!layer) return;
      const visible = Boolean(opened && image) && notesVisible;
      // 正在选关联目标时编号不接指针，点击直接落到画布上（否则选不中已有标记旁边的位置）。
      workspace.classList.toggle('ie-markers-live', visible && !blocked() && !linkPick && (noteTools.has(tool) || tool === 'select'));
      // 隐藏预览批注：编号、引线、空心圈和它们的点击目标一起收掉（马赛克/笔迹不受影响）。
      layer.hidden = !visible;
      if (!visible) return;
      const entries = markerEntries();
      const signature = markerSignature();
      if (signature !== markerSignatureValue) {
        markerSignatureValue = signature;
        layer.textContent = '';
        markerFigures.clear();
        for (const entry of entries) {
          const node = makeMarkerItem(entry);
          layer.append(node.figure); markerFigures.set(entry.key, node);
        }
      }
      for (const entry of entries) {
        const node = markerFigures.get(entry.key);
        if (!node) continue;
        node.button.disabled = blocked() || !image;
        node.button.classList.toggle('is-selected', entry.selected === true);
        const label = markerLabel(entry);
        // 文字和编号每帧都同步：改完旧意见后，标记的 title 不能是旧的。
        const aria = `第 ${entry.number} 条批注${entry.multi ? `（目标 ${entry.target.letter}）` : ''}，点击修改`;
        if (node.button.getAttribute('aria-label') !== aria) node.button.setAttribute('aria-label', aria);
        const title = entry.text ? `第 ${entry.number} 条：${entry.text.slice(0, 30)}` : `第 ${entry.number} 条批注`;
        if (node.button.title !== title) node.button.title = title;
        placeMarker(node, entry, label);
      }
    }
    // —— 便签：贴着所选批注/连线放，不占画布列；换对象只换内容与位置 ——
    function noteBubble() { return $('.ie-note-bubble'); }
    function bubbleField() { return $('.ie-bubble-text'); }
    function bubbleValue() { const field = bubbleField(); return field ? field.value : ''; }
    function focusBubble() { try { bubbleField()?.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响批注。 */ } }
    // overflow:hidden 的容器仍然可以被程序化滚动：聚焦时浏览器会把画布区滚走，强制回到原点。
    function keepWorkspaceFixed() {
      if (workspace.scrollLeft) workspace.scrollLeft = 0;
      if (workspace.scrollTop) workspace.scrollTop = 0;
    }
    // 便签位置：批注旁边、连线旁边；夹在可见画布内，开合不动画布尺寸/缩放/滚动。
    function noteScreenAnchor() {
      const item = noteId ? annotationList().find(note => note.id === noteId) : null;
      const target = item && item.targets[0];
      if (!target) return null;
      const o = origin();
      if (target.kind === 'point') {
        const left = o.x + target.point.x * zoom, top = o.y + target.point.y * zoom;
        return { left, top, right: left, bottom: top };
      }
      const left = o.x + target.rect.x * zoom, top = o.y + target.rect.y * zoom;
      return { left, top, right: left + target.rect.width * zoom, bottom: top + target.rect.height * zoom };
    }
    function relationScreenAnchor() {
      const relation = selectedRelationId ? relationList().find(item => item.id === selectedRelationId) : null;
      if (!relation || !relation.complete) return null;
      const curve = relationCurvePoints(relation.a, relation.b);
      if (!curve) return null;
      const mid = curve.points[Math.floor(curve.points.length / 2)], o = origin();
      const left = o.x + mid.x * zoom, top = o.y + mid.y * zoom;
      return { left: left + 14, top: top + 12, right: left + 14, bottom: top + 12 };
    }
    function overlapsRect(a, b) {
      return Boolean(a && b) && a.left < b.left + b.width && a.left + a.width > b.left &&
        a.top < b.top + b.height && a.top + a.height > b.top;
    }
    function placeCards() {
      if (!opened) return;
      const width = workspace.clientWidth || scroller.clientWidth;
      const height = workspace.clientHeight || scroller.clientHeight;
      if (!(width > 0 && height > 0)) return;
      const margin = 8;
      const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
      const sizeOf = (node, fallback) => ({ width: node.offsetWidth || fallback.width, height: node.offsetHeight || fallback.height });
      // 先试批注右侧，放不下改左侧，再不行放到下方；最后一律夹回可见区。
      const placeBeside = (node, anchor, size) => {
        const maxLeft = Math.max(margin, width - size.width - margin);
        const maxTop = Math.max(margin, height - size.height - margin);
        let left = anchor.right + 10, top = anchor.top;
        if (left + size.width > width - margin) left = anchor.left - size.width - 10;
        if (left < margin) { left = anchor.left; top = anchor.bottom + 10; }
        const rect = { left: Math.round(clamp(left, margin, maxLeft)), top: Math.round(clamp(top, margin, maxTop)),
          width: size.width, height: size.height };
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        return rect;
      };
      let noteRect = null;
      const note = noteBubble();
      if (note && !note.hidden) {
        const anchor = noteScreenAnchor();
        if (anchor) noteRect = placeBeside(note, anchor, sizeOf(note, { width: 232, height: 132 }));
      }
      const relation = $('.ie-relation-bubble');
      if (relation && !relation.hidden) {
        const anchor = relationScreenAnchor();
        if (anchor) {
          const size = sizeOf(relation, { width: 232, height: 104 });
          const rect = placeBeside(relation, anchor, size);
          // 和批注便签错开：重叠就往下（夹在画布内）再放一次。
          if (overlapsRect(rect, noteRect)) {
            const top = Math.round(clamp(noteRect.top + noteRect.height + 8, margin, Math.max(margin, height - size.height - margin)));
            relation.style.top = `${top}px`;
          }
        }
      }
      const comment = $('.ie-comment-bubble');
      if (comment && !comment.hidden) {
        const size = sizeOf(comment, { width: 232, height: 116 });
        comment.style.left = `${margin}px`;
        comment.style.top = `${Math.round(Math.max(margin, height - size.height - margin))}px`;
      }
    }
    // 便签各段按选中态开合；画布区域、缩放与滚动都不因便签开合而改变。
    function syncPanel() {
      const note = noteBubble(), comment = $('.ie-comment-bubble');
      if (note) note.hidden = !noteState;
      if (comment) comment.hidden = !commentOpen;
      syncRelation();
      placeCards();
    }
    // —— 气泡里的一条可编辑副本：目标清单 + 可选目标文字/局部放大/操作-当前-期望 ——
    // 只有「保存批注」才把目标/可选字段写回 ops；纯改字仍按原规则就地写回、不进历史。
    const DETAIL_KEYS = [['action', '操作'], ['current', '当前'], ['expected', '期望']];
    function emptyBubbleState() {
      return { targets: [], relation: 'same', linked: false, targetText: '', targetTextAuto: false, targetTextRevision: 0,
        inset: false, details: { action: '', current: '', expected: '' } };
    }
    function stateFromRecord(record) {
      const state = emptyBubbleState();
      if (record && (record.kind === 'point' || record.kind === 'region')) state.targets = recordTargets(record).map(cloneTargetOf);
      state.relation = normalizeRelation(record?.relation);
      // 通用连接标记：旧记录没有这个字段就是 false（不凭空画箭头）。
      state.linked = record?.linked === true;
      state.targetText = typeof record?.targetText === 'string' ? record.targetText : '';
      state.targetTextAuto = record?.targetTextAuto === true;
      state.targetTextRevision = Number.isSafeInteger(record?.targetTextRevision) ? record.targetTextRevision : 0;
      state.inset = record?.inset === true;
      for (const [key] of DETAIL_KEYS) state.details[key] = typeof record?.details?.[key] === 'string' ? record.details[key] : '';
      return state;
    }
    function bubbleState() { return noteState; }
    function sameTarget(left, right) {
      if (!left || !right || left.kind !== right.kind) return false;
      if (left.kind === 'point') return left.point.x === right.point.x && left.point.y === right.point.y;
      return left.rect.x === right.rect.x && left.rect.y === right.rect.y &&
        left.rect.width === right.rect.width && left.rect.height === right.rect.height;
    }
    // 目标/可选字段有没有被改过：改过就必须走「保存」（可撤销的 annotation-update 快照）。
    function stateDiffers(state, record) {
      if (!state) return false;
      const base = stateFromRecord(record);
      if (state.targets.length !== base.targets.length) return true;
      for (let i = 0; i < state.targets.length; i += 1) if (!sameTarget(state.targets[i], base.targets[i])) return true;
      if (normalizeRelation(state.relation) !== normalizeRelation(base.relation)) return true;
      if (Boolean(state.linked) !== Boolean(base.linked)) return true;
      if (state.targetText !== base.targetText) return true;
      if (state.inset !== base.inset) return true;
      return DETAIL_KEYS.some(([key]) => state.details[key] !== base.details[key]);
    }
    function hasOptionalFields(state) {
      if (!state) return false;
      return state.targets.length > 1 || Boolean(state.targetText) || state.inset ||
        DETAIL_KEYS.some(([key]) => Boolean(state.details[key]));
    }
    // 要写回 ops 的完整记录：主几何仍然只有一个合法 point/rect，附加目标进 related。
    function recordFromState(state, text) {
      const primary = state.targets[0];
      const record = { tool: 'annotation', kind: primary.kind };
      if (primary.kind === 'point') record.point = { x: primary.point.x, y: primary.point.y };
      else record.rect = { ...primary.rect };
      // 目标的内部身份要跟着一起写回去，否则一次保存就会换一批 id、把关系串到别处。
      record.targetId = typeof primary.targetId === 'string' && primary.targetId ? primary.targetId : nextTargetId();
      record.text = text;
      const related = state.targets.slice(1, MAX_TARGETS).map(target => {
        const copy = cloneTargetOf(target);
        if (!copy.targetId) copy.targetId = nextTargetId();
        return copy;
      });
      if (related.length) record.related = related;
      // 同一条批注里的目标身份必须唯一：重复就重新发一个，不让两处抢同一个身份。
      const usedIds = new Set();
      const uniqueIdOf = (current, assign) => {
        let id = current;
        while (!id || usedIds.has(id)) id = assign();
        usedIds.add(id);
        return id;
      };
      record.targetId = uniqueIdOf(record.targetId, nextTargetId);
      if (record.related) for (const item of record.related) item.targetId = uniqueIdOf(item.targetId, nextTargetId);
      const relation = normalizeRelation(state.relation);
      if (related.length === 1 && relation !== 'same') record.relation = relation;
      // 用户从画布把手实际连过才写这个标记；旧 move/reference 记录不靠它。
      if (state.linked === true && related.length) record.linked = true;
      if (state.targetText) {
        record.targetText = state.targetText;
        if (state.targetTextAuto) { record.targetTextAuto = true; record.targetTextRevision = state.targetTextRevision; }
      }
      if (state.inset) record.inset = true;
      const details = {};
      for (const [key] of DETAIL_KEYS) if (state.details[key].trim()) details[key] = state.details[key];
      if (Object.keys(details).length) record.details = details;
      return record;
    }
    function bubbleTargetList() {
      const state = bubbleState();
      return state ? state.targets.map((target, index) => ({ index, letter: targetLetter(index), ...cloneTargetOf(target) })) : [];
    }
    // 目标在人话里的样子：点/框 + 方位。精确坐标是内部数据，不再摆给人看。
    function targetText(target) {
      return `${target.kind === 'point' ? '点' : '框'} · ${targetZone(target)}`;
    }
    // 一条批注在图上与说明区共用的身份：单目标就是编号，多目标带字母（意见1、意见1A、意见1B）。
    function noteIsMulti(note) { return (note.sourceCount || note.targetCount || 1) > 1; }
    function noteTargetLabel(note, target) {
      return `意见${note.number}${noteIsMulti(note) ? target.letter : ''}`;
    }
    function noteIdentityLabels(note) {
      return (note.targets || []).map(target => noteTargetLabel(note, target));
    }
    // 被裁掉的目标：说明区里只说它没画在图上，不再给它的坐标。
    function missingTargetLabels(note) {
      const count = note.sourceCount || note.targetCount || 0;
      const visible = new Set((note.targets || []).map(target => target.index));
      const labels = [];
      for (let index = 0; index < count; index += 1) {
        if (visible.has(index)) continue;
        labels.push(`意见${note.number}${noteIsMulti(note) ? targetLetter(index) : ''}`);
      }
      return labels;
    }
    function targetInView(target) {
      const view = currentView();
      return target.kind === 'point' ? pointInside(target.point, view) : Boolean(clipRegion(target.rect, view));
    }
    // 人类可读的位置描述：不摆坐标清单，重叠目标靠字母 + 方位也能分开（点子/框块）。
    function targetZone(target) {
      const view = currentView();
      const center = target.kind === 'point' ? target.point
        : { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 };
      const third = (value, start, size) => value < start + size / 3 ? 0 : value > start + size * 2 / 3 ? 2 : 1;
      const row = ['上', '', '下'][third(center.y, view.y, view.height)];
      const column = ['左', '', '右'][third(center.x, view.x, view.width)];
      return `${row}${column}` || '居中';
    }
    let bubbleTargetsSignature = '';
    // 目标清单/关联清单/可选字段的 UI 同步：只在内容变化时重建 chips，避免每帧抢走焦点。
    function syncBubbleExtras() {
      const state = bubbleState();
      if (!state) {
        // 没有选中时不能在 DOM 里留一份旧位置行：它们会被当成“现在的位置”。
        const stale = $('.ie-bubble-targets');
        if (stale && stale.children.length) { stale.textContent = ''; bubbleTargetsSignature = ''; }
        return;
      }
      const list = bubbleTargetList();
      const currentNote = noteId ? annotationList().find(note => note.id === noteId) : null;
      const noteNumber = currentNote ? currentNote.number : 0;
      const signature = `${noteId}:${noteNumber}|` + list.map(target =>
        `${target.letter}${target.kind}${targetZone(target)}${targetInView(target) ? '' : '!'}`).join('|');
      const container = $('.ie-bubble-targets');
      if (container && signature !== bubbleTargetsSignature) {
        bubbleTargetsSignature = signature;
        container.textContent = '';
        // 悬停只说人话：批注编号 + 字母 + 方位。精确坐标不再摆给人看。
        const multi = (currentNote ? currentNote.sourceCount : 0) > 1 || list.length > 1;
        for (const target of list) {
          const chip = document.createElement('span');
          chip.className = 'ie-target-chip';
          chip.dataset.targetIndex = String(target.index);
          chip.title = `${noteNumber ? `第 ${noteNumber} 条 ` : ''}${multi ? `${target.letter} ` : ''}${targetText(target)}`;
          const badge = document.createElement('b');
          badge.textContent = target.letter;
          const label = document.createElement('span');
          label.className = 'ie-target-label';
          label.textContent = `${target.kind === 'point' ? '点' : '框'} · ${targetZone(target)}${targetInView(target) ? '' : '（已裁掉）'}`;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.dataset.action = 'target-remove';
          remove.dataset.targetIndex = String(target.index);
          remove.textContent = '移除';
          chip.append(badge, label);
          // 每个目标都有「选中」：重叠目标靠这里逐个选（框选中后图上直接是 8 个手柄）。
          const frame = document.createElement('button');
          frame.type = 'button';
          frame.className = 'ie-target-frame';
          frame.dataset.action = 'target-select';
          frame.dataset.targetIndex = String(target.index);
          frame.textContent = '选中';
          chip.append(frame, remove);
          container.append(chip);
        }
      }
      for (const chip of (container ? [...container.children] : [])) {
        const remove = chip.querySelector?.('[data-action="target-remove"]');
        if (remove) {
          remove.title = list.length > 1 ? `移除目标 ${targetLetter(Number(chip.dataset.targetIndex))}` : '一条批注至少保留一个目标';
          remove.disabled = blocked() || list.length < 2;
        }
        const frame = chip.querySelector?.('[data-action="target-select"]');
        if (frame) {
          const index = Number(chip.dataset.targetIndex);
          const isFrame = index === frameIndex;
          const label = list[index] && list[index].kind === 'region';
          frame.setAttribute('aria-pressed', String(isFrame));
          frame.title = isFrame
            ? (label ? '这个框已在图上选中：拖框内移动，拖 8 个手柄缩放' : '这个点已在图上选中')
            : `选中位置 ${targetLetter(index)}${label ? ' 的框，在图上拖动或缩放' : ''}`;
          frame.disabled = blocked() || Boolean(linkPick);
        }
      }
      const relationRow = $('.ie-bubble-relation'), relation = $('[data-setting="relation"]');
      if (relationRow) relationRow.hidden = list.length < 2;
      if (relation) {
        const value = normalizeRelation(state.relation);
        relation.value = value;
        relation.disabled = blocked() || list.length !== 2;
      }
      const more = $('.ie-bubble-more');
      if (more) more.hidden = !bubbleMoreOpen;
      const toggle = $('[data-action="bubble-more-toggle"]');
      if (toggle) toggle.setAttribute('aria-expanded', String(bubbleMoreOpen));
      const targetField = $('.ie-target-text');
      if (targetField && targetField.value !== state.targetText) targetField.value = state.targetText;
      for (const [key] of DETAIL_KEYS) {
        const input = $(`.ie-details-${key}`);
        if (input && input.value !== state.details[key]) input.value = state.details[key];
      }
      const insetBox = $('[data-setting="inset"]');
      if (insetBox) insetBox.checked = state.inset;
      const full = list.length >= MAX_TARGETS;
      for (const node of [$('[data-action="bubble-add-point"]'), $('[data-action="bubble-add-region"]')]) {
        if (node) node.disabled = blocked() || full;
      }
      syncBubbleRelations();
      syncBubbleNeighbors();
    }
    // 两个可见目标是否压在一起：点重合/框相交/点在框内都算，给重叠标记留一个人话入口。
    function targetsOverlap(a, b) {
      if (!a || !b) return false;
      if (a.kind === 'point' && b.kind === 'point') return Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) <= 2;
      if (a.kind === 'region' && b.kind === 'region') {
        return a.rect.x < b.rect.x + b.rect.width && a.rect.x + a.rect.width > b.rect.x &&
          a.rect.y < b.rect.y + b.rect.height && a.rect.y + a.rect.height > b.rect.y;
      }
      const point = a.kind === 'point' ? a.point : b.point;
      const rect = a.kind === 'region' ? a.rect : b.rect;
      return point.x >= rect.x - 4 && point.x <= rect.x + rect.width + 4 &&
        point.y >= rect.y - 4 && point.y <= rect.y + rect.height + 4;
    }
    // 与当前批注叠在一起的其它批注：画布上只能点到最上面那个，重叠的其余几处在这里能逐个选。
    function syncBubbleNeighbors() {
      const box = $('.ie-bubble-neighbors');
      if (!box) return;
      const current = noteId ? annotationList().find(note => note.id === noteId) : null;
      const list = [];
      if (current) {
        for (const note of annotationList()) {
          if (note.id === current.id) continue;
          for (const target of note.targets) {
            if (current.targets.some(mine => targetsOverlap(mine, target))) {
              list.push({ note, target });
              break;
            }
          }
        }
      }
      const field = $('.ie-bubble-neighbors-field');
      if (field) field.hidden = list.length === 0;
      const signature = list.map(({ note, target }) => `${note.id}:${target.targetId}`).join('|');
      if (box.dataset.signature === signature) return;
      box.dataset.signature = signature;
      box.textContent = '';
      for (const { note, target } of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ie-bubble-relation-item';
        button.dataset.action = 'bubble-neighbor';
        button.dataset.annotationId = note.id;
        button.dataset.targetIndex = String(target.index);
        button.disabled = blocked() || !image;
        button.textContent = `第 ${note.number} 条 · ${target.kind === 'point' ? '点' : '框'} · ${targetZone(target)}`;
        box.append(button);
      }
    }
    // 这条批注牵着的连线：缺端的也有就近入口（这里写清“另一端不在当前画面”），不用去翻坐标清单。
    function syncBubbleRelations() {
      const box = $('.ie-bubble-relations');
      if (!box) return;
      const list = noteId ? relationList().map((relation, index) => ({ relation, number: index + 1 }))
        .filter(({ relation }) => relation.a?.annotationId === noteId || relation.b?.annotationId === noteId) : [];
      const field = $('.ie-bubble-relations-field');
      if (field) field.hidden = list.length === 0;
      const signature = list.map(({ relation, number }) =>
        `${relation.id}:${number}:${relation.complete ? 1 : 0}:${relation.text.trim() ? 1 : 0}`).join('|');
      if (box.dataset.signature === signature) return;
      box.dataset.signature = signature;
      box.textContent = '';
      for (const { relation, number } of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ie-bubble-relation-item';
        button.dataset.action = 'bubble-relation';
        button.dataset.relationId = relation.id;
        button.setAttribute('aria-pressed', String(relation.id === selectedRelationId));
        button.disabled = blocked() || !image;
        button.textContent = `连线 ${number} · ${relation.complete
          ? (relation.text.trim() ? '两处一起说' : '还没写共同说明')
          : '另一端不在当前画面'}`;
        box.append(button);
      }
    }
    // 说明区内容同步：只在换绑另一条批注时回写 textarea，避免重建而打断输入法组合串。
    function syncBubble() {
      const field = bubbleField();
      if (!field) return;
      const key = noteId ? `note:${noteId}` : '';
      const rebound = key !== bubbleKey;
      if (rebound) {
        bubbleKey = key;
        bubbleTargetsSignature = '';
        const op = noteId ? opById(noteId) : undefined;
        field.value = op && typeof op.text === 'string' ? op.text : '';
        field.placeholder = '写一句说明…（走开也会记下）';
        bubbleMoreOpen = noteState ? hasOptionalFields(noteState) : false;
      }
      if (!noteId || !noteState) { syncPanel(); schedule(); return; }
      const item = annotationList().find(entry => entry.id === noteId);
      const title = $('.ie-bubble-title');
      if (title) title.textContent = item ? `第 ${item.number} 条批注` : '这条批注';
      field.disabled = blocked() || !image;
      const done = $('[data-action="note-done"]');
      if (done) done.disabled = field.disabled;
      syncBubbleExtras();
      syncPanel();
      schedule();
    }
    // —— 落位即提交：点/框一落位就是正式标记（允许空字），随后选中编辑 ——
    // 取消未完成的拖框不 commit；取消工具或离开编辑不等于删除，删除必须有明确动作。
    function createAnnotation(kind, geometry) {
      if (previewMode || blocked() || !image) return false;
      if (annotationList().length >= annotationLimits.annotations) { status(`批注最多 ${annotationLimits.annotations} 条`); return false; }
      closeComment();
      notesVisible = true;
      const state = emptyBubbleState();
      state.targets = [{ kind, targetId: nextTargetId(),
        ...(kind === 'point' ? { point: { ...geometry.point } } : { rect: { ...geometry.rect } }) }];
      const record = recordFromState(state, '');
      record.id = nextAnnotationId();
      commitOp(record);
      pointCount = ops.reduce((sum, op) => sum + (op.points?.length ?? 0), 0);
      selectedTargets = [{ annotationId: record.id, targetId: record.targetId }];
      selectedRelationId = null;
      shapeSelected = null;
      loadNoteState();
      bubbleTargetsSignature = '';
      status('位置已记下 · 在说明区写一句；不写就是空标记，导出前会被拦下');
      syncBubble();
      sync();
      focusBubble();
      return true;
    }
    // 选中一条已有批注（点编号、清单或画布命中都走这里）；可以指定先选哪个框。
    function selectNote(id, targetIndex) {
      const op = opById(id);
      if (!op) return false;
      closeComment();
      const targets = recordTargets(op);
      const index = Number.isInteger(targetIndex) && targets[targetIndex] ? targetIndex : 0;
      selectedTargets = [{ annotationId: id, targetId: targets[index].targetId }];
      selectedRelationId = null;
      shapeSelected = null;
      notesVisible = true;
      loadNoteState();
      if (Number.isInteger(targetIndex) && targets[index].kind === 'region') frameIndex = index;
      bubbleTargetsSignature = '';
      syncBubble();
      sync();
      focusBubble();
      return true;
    }
    // 纯改字不进历史：写回这条批注在所有历史版本里的文字，撤销几何步时不会把字丢掉。
    // （文字本身不是历史的一部分；几何/位置才是。）
    function writeNoteText(id, text) {
      for (const op of ops) {
        if (!op) continue;
        if (op.tool === 'annotation' && op.id === id) op.text = text;
        else if (op.tool === 'annotation-update' && op.id === id && op.snapshot) op.snapshot.text = text;
        // 旧记录建关系时物化过的身份快照也是这条批注的历史载体：面板上改了字，它能整条覆盖，
        // 所以导出/重解历史时不能被旧快照把字改回去。
        else if (op.tool === 'annotation-relation' && Array.isArray(op.snapshots)) {
          for (const snap of op.snapshots) if (snap && snap.id === id && snap.record) snap.record.text = text;
        }
      }
    }
    // 文字直接写回 op（不进历史：连续打字不会拆成一串撤销步）；几何/细节改动走一次 annotation-update。
    function commitNoteState() {
      const op = noteId ? opById(noteId) : undefined;
      if (!op || !noteState) return false;
      const text = bubbleValue();
      if (!stateDiffers(noteState, op)) { if (op.text !== text) op.text = text; return false; }
      const snapshot = recordFromState(noteState, text);
      snapshot.id = noteId;
      writeNoteText(noteId, text);
      // 被移掉的位置如果还牵着关系，就在同一条快照里一并删掉（一次撤销全回）。
      const kept = new Set(noteState.targets.map(target => target.targetId));
      const removed = recordTargets(op).filter(target => !kept.has(target.targetId));
      const relationDeletes = [...new Set(removed.flatMap(target =>
        relationsTouching(noteId, target.targetId).map(record => record.id)))];
      commitOp({ tool: 'annotation-update', id: noteId, snapshot,
        ...(relationDeletes.length ? { relationDeletes } : {}) });
      if (relationDeletes.length) status(`已更新这条批注，并解除 ${relationDeletes.length} 条牵着被删位置的关系；可用撤销恢复`);
      return true;
    }
    // 离开当前编辑（换选择/换工具/导出/关窗）前统一收口：校验失败保留输入与原选择，不先清后报。
    function flushNote() {
      if (!noteId) return true;
      const op = opById(noteId);
      if (!op) { noteId = null; noteState = null; selectedTargets = []; frameIndex = null; return true; }
      const text = bubbleValue();
      const count = Array.from(text).length;
      if (count > annotationLimits.text) {
        status(`这条说明 ${count} 字，超过 ${annotationLimits.text} 字上限：先精简，编辑和位置都不会丢`);
        focusBubble();
        return false;
      }
      commitNoteState();
      return true;
    }
    function flushRelation() {
      if (!selectedRelationId) return true;
      const field = $('.ie-relation-text');
      if (!field) return true;
      const record = relationRecords().find(item => item.id === selectedRelationId);
      if (!record) { selectedRelationId = null; return true; }
      const text = field.value;
      const count = Array.from(text).length;
      if (count > RELATION_TEXT_LIMIT) {
        status(`关系说明 ${count} 字，超过 ${RELATION_TEXT_LIMIT} 字上限：先精简，这条关系不会丢`);
        try { field.focus({ preventScroll: true }); } catch { /* 忽略。 */ }
        return false;
      }
      writeRelationText(selectedRelationId, text);
      return true;
    }
    function flushAll() { return flushRelation() && flushNote(); }
    // 收口失败时的具体原因（只在超长时出现），导出/预览/关窗直接说清楚。
    function flushMessage() {
      if (selectedRelationId) {
        const count = Array.from(String($('.ie-relation-text')?.value ?? '')).length;
        if (count > RELATION_TEXT_LIMIT) return `关系说明 ${count} 字，超过 ${RELATION_TEXT_LIMIT} 字上限；先精简再导出`;
      }
      if (noteId) {
        const count = Array.from(bubbleValue()).length;
        if (count > annotationLimits.text) return `第 ${annotationList().find(item => item.id === noteId)?.number || ''} 条说明 ${count} 字，超过 ${annotationLimits.text} 字上限；先精简再导出`;
      }
      return '';
    }
    // 选另一处/换工具之前先收口；能失败（超长）就不换，留在原选择上。
    function leaveNote() { return flushNote(); }
    // —— 便签底部的「完成」：只做收口反馈，不新增「已确认」业务字段 ——
    // 字本来就已经写回 op（边写边记不变），这里只先跑原有的 flushAll 校验：
    // 校验不过（超长）就留在原选择与原输入上，不收起也不报已完成；
    // 过了就按现有的 clearSelection 路径放下选中与便签，工具/批注/关系/像素都不动。
    function completeNote() {
      if (!noteId || blocked() || previewMode) return;
      if (!flushAll()) return;
      // 判空只看 trim：纯空格/换行算「还没写」，但原样保留，不改存进去的原文。
      const empty = bubbleValue().trim() === '';
      dropConnect();
      clearSelection();
      try { scroller.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响收口。 */ }
      status(empty ? '这条批注还没写说明，位置留着，回头再补一句' : '批注已记下');
    }
    function completeRelation() {
      if (!selectedRelationId || blocked() || previewMode) return;
      if (!flushAll()) return;
      const empty = String($('.ie-relation-text')?.value ?? '').trim() === '';
      dropConnect();
      clearSelection();
      try { scroller.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响收口。 */ }
      status(empty ? '这条连线还没写共同说明，线留着，回头再补一句' : '连线说明已记下');
    }

    // —— 连线手势：按住拖与两次点击走同一条路径；已有端点用稳定引用，空白处暂存坐标 ——
    // 暂态只放稳定 {annotationId,targetId} 或一个临时 {point}、当前指针与阶段；不存几何副本、不序列化、不进历史。
    const endOfTarget = target => ({ annotationId: target.annotationId, targetId: target.targetId });
    // 起点是不是真实端点：临时坐标没有 annotationId，不能拿去 sameEnd／投影／端点有效性检查。
    function connectStartEnd() {
      return connect && connect.start && typeof connect.start.annotationId === 'string' ? connect.start : null;
    }
    function connectStartPoint() {
      return connect && connect.start && !connect.start.annotationId && connect.start.point ? connect.start.point : null;
    }
    const sameAsStart = target => { const start = connectStartEnd(); return Boolean(start) && sameEnd(target, start); };
    function focusRelationField() { try { $('.ie-relation-text')?.focus({ preventScroll: true }); } catch { /* 拿不到焦点也能点按钮。 */ } }
    // 清暂态：不删原批注、不写历史、不作废 OCR；同步用外层 sync() 收口。
    function dropConnect(message = '') {
      if (!connect) return false;
      const pointerId = connect.pointerId;
      connect = null;
      if (pointerId != null && scroller.hasPointerCapture?.(pointerId)) scroller.releasePointerCapture(pointerId);
      if (message) status(message);
      return true;
    }
    function cancelConnect(message = '') { if (!dropConnect(message)) return; sync(); schedule(); }
    // 命中只认批注（点优先、小框优先）；批注都命中不了时再认已有的线。
    function connectTargetAt(at) { const hit = annotationHitAt(at); return hit ? hit.target : null; }
    // 连线只认画面里的原始指针位置：letterbox（图外）和原生滚动条都不算画布输入。
    // 不动全局 point() 的 clamp（绘图/裁切还依赖它），只给连线输入加一道门禁。
    function connectPointInCanvas(e) {
      const bounds = scroller.getBoundingClientRect();
      if (e.clientX < bounds.left || e.clientY < bounds.top
        || e.clientX >= bounds.left + scroller.clientWidth || e.clientY >= bounds.top + scroller.clientHeight) return false;
      return inImage(e);
    }
    function connectPrompt() {
      if (!connect) return '连线：点任意一处起手——有批注就接上，空白处会落一个小点';
      if (connect.hover) return connect.phase === 'armed' ? '点一下这一处就接上' : '松手就接上这一处';
      return connect.phase === 'armed' ? '起点在这：再点另一处，或按住拖过去（空白也行）' : '拖到另一处（空白也行），或松开再点另一处';
    }
    // 空白端点成功后才成为普通空文字点批注；这里不做选择/焦点那类 UI 副作用（那是 createAnnotation 的事）。
    function createEmptyPointEnd(point) {
      const state = emptyBubbleState();
      state.targets = [{ kind: 'point', targetId: nextTargetId(), point: { x: point.x, y: point.y } }];
      const record = recordFromState(state, '');
      record.id = nextAnnotationId();
      commitOp(record);
      return { annotationId: record.id, targetId: record.targetId };
    }
    // 一次连线：两端已有就用引用；空白端在同一同步段里先落成普通空文字点，再建原来那条关系。
    // 先统一预校验（端点/批注数/关系数/操作数），中途失败就把 ops/cursor 与编号序号回滚到动手之前，
    // 临时点取消后不留正式记录，也不留半条线。
    function connectEndPoints(start, end) {
      const startEnd = start.end || null, endEnd = end.end || null;
      const startPt = start.point || null, endPt = end.point || null;
      if (startEnd && !findTargetRecord(startEnd.annotationId, startEnd.targetId)) {
        status('起点已经不在了，这次连线没建立'); return undefined;
      }
      if (endEnd && !findTargetRecord(endEnd.annotationId, endEnd.targetId)) {
        status('这一端已经不在了，这次连线没建立'); return undefined;
      }
      if (startEnd && endEnd && sameEnd(startEnd, endEnd)) { status('两处不能是同一处'); return undefined; }
      if (startPt && endPt && Math.hypot(startPt.x - endPt.x, startPt.y - endPt.y) * zoom < CONNECT_MIN_SPAN) {
        status('两处挨得太近，这次没有连线'); return undefined;
      }
      const newPoints = (startEnd ? 0 : 1) + (endEnd ? 0 : 1);
      if (annotationList().length + newPoints > annotationLimits.annotations) {
        status(`批注最多 ${annotationLimits.annotations} 条，这次连线没建立`); return undefined;
      }
      if (relationRecords().length >= MAX_RELATIONS) {
        status(`关系最多 ${MAX_RELATIONS} 条，这次连线没建立`); return undefined;
      }
      if (cursor + newPoints + 1 > LIMIT.operations) {
        status('编辑步数已到上限，请导出后重新编辑 · 这次连线没建立'); return undefined;
      }
      const savedOps = ops.slice(), savedCursor = cursor;
      const savedAnnotationSeq = annotationSeq, savedTargetSeq = targetSeq;
      const from = startEnd || createEmptyPointEnd(startPt);
      const to = endEnd || createEmptyPointEnd(endPt);
      const id = createRelation(from, to, '');
      if (!id) {
        // 恢复成动手前的样子：不半成品、不留单边新点、不推像素 revision。
        ops = savedOps; cursor = savedCursor; annotationSeq = savedAnnotationSeq; targetSeq = savedTargetSeq;
        return undefined;
      }
      // 只有本次真的自动新建了点才需要局部历史组；只连已有端点仍是一条普通关系 op。
      if (newPoints) markHistoryGroup(savedCursor, cursor);
      return id;
    }
    function startConnectDown(e) {
      if (blocked() || !image || pan || spaceDown) return;
      // 起手必须在当前画面里：图外按下既不起手，也不当成第二击。
      if (!connectPointInCanvas(e)) return;
      if (!flushAll()) return;
      e.preventDefault();
      try { scroller.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响连线。 */ }
      closeComment();
      const at = point(e);
      const target = connectTargetAt(at);
      // 批注优先（点/框原排序）；都没命中时再认已有的线：连线模式下直接点线就能改共同说明或删线，
      // 不用先切到选择工具。
      if (!target) {
        const lineId = relationAt(at);
        if (lineId) {
          dropConnect();
          selectRelation(lineId);
          status('选中的是这条线：就地改共同说明，或用「删线」');
          return;
        }
      }
      if (!connect) {
        // 起点：已有点/框用它们的稳定引用；空白处只暂存一个坐标，成功前不写正式批注。
        connect = { start: target ? endOfTarget(target) : { point: { x: at.x, y: at.y } },
          phase: 'press', pointerId: e.pointerId,
          startClient: { x: e.clientX, y: e.clientY }, cur: at, hover: null, pressed: null };
        selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
        try { scroller.setPointerCapture?.(e.pointerId); } catch { /* 捕获失败也能靠坐标 */ }
        status(target ? '起点是这一处：拖到另一处，或松开再点另一处'
          : '从这里起一条线：拖到另一处，或松开再在那里点一下（空白也行）');
        sync(); schedule();
        return;
      }
      // 等第二次点击：先记下按在哪里，但最后仍按松手坐标判定（拖到别处不能误连按下的这一处）。
      if (target && sameAsStart(target)) { status('同一处连不起来，换一处'); return; }
      connect.pressed = target ? endOfTarget(target) : null;
      connect.phase = 'armed-pressed';
      connect.pointerId = e.pointerId;
      connect.cur = at;
      connect.hover = target ? connect.pressed : null;
      try { scroller.setPointerCapture?.(e.pointerId); } catch { /* 捕获失败也能靠坐标 */ }
      schedule();
      status('松手就接上这一处');
    }
    function updateConnectMove(e) {
      if (!connect) return;
      if (e.pointerId !== undefined && connect.pointerId !== undefined && e.pointerId !== connect.pointerId) return;
      // 图外移动不清高亮：point() 会把坐标 clamp 到画面边缘，不能让它吸附贴边批注。
      const inside = connectPointInCanvas(e);
      connect.cur = point(e);
      const target = inside ? connectTargetAt(connect.cur) : null;
      const next = target && !sameAsStart(target) ? endOfTarget(target) : null;
      const changed = Boolean(next) !== Boolean(connect.hover) ||
        (next && connect.hover && !sameEnd(next, connect.hover));
      connect.hover = next;
      if (changed) status(connectPrompt());
      schedule();
    }
    function finishConnectGesture(e) {
      if (!connect) return;
      const at = point(e);
      const moved = Math.hypot(e.clientX - connect.startClient.x, e.clientY - connect.startClient.y);
      const target = connectTargetAt(at);
      const other = target && !sameAsStart(target) ? endOfTarget(target) : null;
      const startEnd = connectStartEnd(), startPoint = connectStartPoint();
      // 第一下几乎没动：只记起点，等第二击；动过了就按松手坐标判一次。
      if (connect.phase === 'press' && moved < CONNECT_DRAG_THRESHOLD) {
        connect.phase = 'armed';
        connect.pressed = null;
        connect.cur = at;
        connect.hover = other;
        status(other ? '这一处已经能连：再点一下就接上'
          : (startEnd ? '起点选好了：再点另一处，或按住拖过去（空白也行）'
            : '起点在这：再点另一处，或按住拖过去（空白也行）'));
        sync(); schedule();
        return;
      }
      // 同一处：松手又回到起点（拖圈/拖回）不算连接。
      if (target && sameAsStart(target)) {
        dropConnect('同一处连不起来，这次没有连线');
        sync(); schedule();
        return;
      }
      // 两个临时端点靠得太近（<5 CSS px）：不产生两个点，也不留半条线。
      if (!other && startPoint && Math.hypot(at.x - startPoint.x, at.y - startPoint.y) * zoom < CONNECT_MIN_SPAN) {
        dropConnect('两处挨得太近，这次没有连线');
        sync(); schedule();
        return;
      }
      // 同一对已有端点：定位原来那条，不重复、不清字。
      if (startEnd && other) {
        const existing = relationIdForPair(startEnd, other);
        if (existing) {
          dropConnect();
          selectedTargets = []; selectedRelationId = existing; noteId = null; noteState = null; frameIndex = null;
          status('这两处已经连过了，选中的是原来那条线');
          sync(); focusRelationField();
          return;
        }
      }
      // 终点：命中已有批注就用它的稳定引用；图内空白松手就是一个新端点坐标（成功后才落成空文字点）。
      const created = connectEndPoints(startEnd ? { end: startEnd } : { point: { ...startPoint } },
        other ? { end: other } : { point: { x: at.x, y: at.y } });
      dropConnect();
      if (!created) { sync(); return; }
      notesVisible = true;
      selectedTargets = []; selectedRelationId = created; noteId = null; noteState = null; frameIndex = null;
      status('连上了：在便签里写这一条共同说明；两端没单独写的，这一句就够');
      sync(); schedule(); focusRelationField();
    }
    // 预览曲线：和成图的关系线同一套弧线样式，只是虚线跟随指针。
    function connectPreviewCurve(from, to) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const bend = Math.min(30, length * 0.14);
      const control = { x: (from.x + to.x) / 2 - dy / length * bend, y: (from.y + to.y) / 2 + dx / length * bend };
      const points = [];
      for (let i = 0; i <= 16; i += 1) {
        const t = i / 16, k = 1 - t;
        points.push({ x: k * k * from.x + 2 * k * t * control.x + t * t * to.x,
          y: k * k * from.y + 2 * k * t * control.y + t * t * to.y });
      }
      return { points };
    }
    function drawConnectPreview(ctx) {
      const startEnd = connectStartEnd(), startPoint = connectStartPoint();
      const start = startEnd ? projectedTargetByEnd(startEnd) : null;
      // 真实端点被裁掉/删掉就什么都不画；空白起手用那个临时坐标当起点。
      if (startEnd && !start) return;
      if (!start && !startPoint) return;
      const hover = connect.hover ? projectedTargetByEnd(connect.hover) : null;
      const centerOf = target => (target.kind === 'point' ? target.point
        : { x: target.rect.x + target.rect.width / 2, y: target.rect.y + target.rect.height / 2 });
      const from = start
        ? (visuals ? visuals.targetAnchor(start, hover ? visuals.targetCenter(hover) : connect.cur) : centerOf(start))
        : { x: startPoint.x, y: startPoint.y };
      let to = connect.cur;
      if (hover) to = (visuals ? visuals.targetAnchor(hover, start ? visuals.targetCenter(start) : from) : null) || centerOf(hover);
      if (!from) return;
      const curve = connectPreviewCurve(from, to);
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(curve.points[0].x, curve.points[0].y);
        for (const item of curve.points.slice(1)) ctx.lineTo(item.x, item.y);
        ctx.stroke();
      };
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([Math.max(3, 5 / zoom), Math.max(3, 4 / zoom)]);
      ctx.strokeStyle = visuals ? visuals.PALETTE.paper : '#f7faf6';
      ctx.lineWidth = Math.max(1, 4 / zoom); trace();
      ctx.strokeStyle = '#c2536f';
      ctx.lineWidth = Math.max(1, 2 / zoom); trace();
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
      // 空白起手的小点：起手就能看见“这里会落一个点”，成功前它还不是正式批注。
      if (!start) {
        ctx.beginPath(); ctx.arc(from.x, from.y, Math.max(3, 4.5 / zoom), 0, Math.PI * 2);
        ctx.fillStyle = visuals ? visuals.PALETTE.paper : '#f7faf6'; ctx.fill();
        ctx.lineWidth = Math.max(1, 1.6 / zoom); ctx.strokeStyle = '#c2536f'; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(to.x, to.y, Math.max(2, 3.5 / zoom), 0, Math.PI * 2);
      ctx.fillStyle = '#c2536f'; ctx.fill();
      ctx.restore();
    }

    // —— 给同一条说明再加一处位置：从属性区发起，落位后立即形成一次可撤销变更 ——
    function startLinkPick(kind) {
      if (blocked() || !image || !noteState || drag || pan) return;
      if (noteState.targets.length >= MAX_TARGETS) { status(`一条说明最多 ${MAX_TARGETS} 个位置`); return; }
      linkPick = { kind };
      notesVisible = true;
      status(kind === 'point' ? '在图上点一下要加的位置 · Esc 只取消这次选点' : '在图上拖一个框作为要加的位置 · Esc 只取消这次框选');
      sync();
    }
    function endLinkPick(message = '') {
      if (!linkPick) return;
      linkPick = null;
      if (message) status(message);
      sync();
      focusBubble();
    }
    // 追加位置：先改工作副本，再立即提交一次 annotation-update；撤销只退这次追加，原位置与已写的字都保留。
    function finishLinkPick(geometry) {
      if (!noteState) { linkPick = null; sync(); return; }
      if (noteState.targets.length >= MAX_TARGETS) { endLinkPick(`一条说明最多 ${MAX_TARGETS} 个位置`); return; }
      const geometryWithId = cloneTargetOf(geometry);
      if (!geometryWithId.targetId) geometryWithId.targetId = nextTargetId();
      if (noteState.targets.some(target => sameTarget(target, geometryWithId))) {
        endLinkPick('这一处已经在这条说明里了');
        return;
      }
      noteState.targets.push(geometryWithId);
      // 只有恰好两处时才谈得上移动/参考；加出第三处就退回「多处同意见」，不留非法关系。
      const relation = normalizeRelation(noteState.relation);
      const broken = relation !== 'same' && noteState.targets.length !== 2;
      if (broken) noteState.relation = 'same';
      linkPick = null;
      notesVisible = true;
      const total = noteState.targets.length;
      const saved = commitNoteState();
      const op = opById(noteId);
      if (op) noteState = stateFromRecord(op);
      // 新加上的框直接成为当前框，可以接着拖；加的是点就不抢当前框。
      if (geometry.kind === 'region' && noteState) {
        const added = noteState.targets.find(target => target.kind === 'region' && target.targetId === geometryWithId.targetId);
        if (added) selectedTargets = [{ annotationId: noteId, targetId: added.targetId }];
      }
      loadSelectionEnds();
      bubbleTargetsSignature = '';
      syncBubble();
      sync();
      focusBubble();
      status(`已加一处位置${broken ? '；移动/参考只支持两处，已改为「多处同意见」' : ''}${saved ? ' · 可用撤销退掉这次追加' : ''}`);
    }
    function removeBubbleTarget(index) {
      const state = noteState;
      if (!state || !Number.isInteger(index) || index < 0 || index >= state.targets.length) return;
      if (state.targets.length < 2) { status('一条说明至少保留一个位置'); return; }
      state.targets.splice(index, 1);
      // 选中下标跟着移；被移除的那块不再可调。
      if (frameIndex != null) frameIndex = frameIndex === index ? null : frameIndex > index ? frameIndex - 1 : frameIndex;
      // 主位置换人了：之前从旧 A 识别的文字不能跟着新 A 走。
      const primaryChanged = index === 0;
      const droppedOcr = primaryChanged && state.targetTextAuto;
      if (droppedOcr) { state.targetText = ''; state.targetTextAuto = false; state.targetTextRevision = 0; }
      const broken = normalizeRelation(state.relation) !== 'same' && state.targets.length !== 2;
      if (broken) state.relation = 'same';
      // 移除也是一次可撤销变更（牵扯的关系在同一条快照里一并解除）。
      const removedCount = commitNoteState();
      const op = opById(noteId);
      if (op) noteState = stateFromRecord(op);
      loadSelectionEnds();
      bubbleTargetsSignature = '';
      sync();
      status(`已移除位置 ${targetLetter(index)}${removedCount ? ' · 可用撤销恢复' : ''}${droppedOcr ? '；之前的识别文字来自旧目标 A，已一并作废' : ''}${broken ? '；移动/参考只支持两处，已改为「多处同意见」' : ''}`);
    }
    function setRelation(value) {
      const state = noteState;
      if (!state) return;
      const next = normalizeRelation(value);
      if (next !== 'same' && state.targets.length !== 2) {
        status(`${next === 'move' ? '「从A移到B」' : '「修改A，参考B」'}只支持恰好两个位置（当前 ${state.targets.length} 个），没有改成这个关系`);
        syncBubbleExtras();
        return;
      }
      if (normalizeRelation(state.relation) === next) return;
      state.relation = next;
      if (commitNoteState()) status('已更新多处之间的关系 · 可用撤销恢复');
      syncBubbleExtras(); sync();
    }
    // 选中态里失效的引用要随时清掉（撤销/删除/裁切后）。
    function pruneSelection() {
      const live = new Set(projectedTargets().map(target => `${target.annotationId}:${target.targetId}`));
      const alive = (end) => live.has(`${end.annotationId}:${end.targetId}`);
      selectedTargets = selectedTargets.filter(alive);
      if (selectedRelationId && !relationRecords().some(record => record.id === selectedRelationId)) selectedRelationId = null;
      const op = noteId ? opById(noteId) : undefined;
      if (noteId && !op) { noteId = null; noteState = null; frameIndex = null; }
      else if (noteId && op) {
        // 撤销/重做可能换掉当前有效版本：工作副本必须跟着历史走，不能拿旧几何冒充现在。
        noteState = stateFromRecord(op);
        const ids = new Set(recordTargets(op).map(target => target.targetId));
        selectedTargets = selectedTargets.filter(end => end.annotationId === noteId && ids.has(end.targetId));
        if (!selectedTargets.length) {
          // 选中的那处被撤销/删除/裁掉：回到这条批注当前画面里还看得见的一处，不把整条选中态也丢掉；
          // 整条都被裁走就清掉选择，不把选择指到一个看不见的目标上。
          const visible = annotationList().find(note => note.id === noteId);
          const first = visible && visible.targets[0];
          selectedTargets = first ? [{ annotationId: noteId, targetId: first.targetId }] : [];
          bubbleTargetsSignature = '';
        }
        if (!selectedTargets.length) { noteId = null; noteState = null; frameIndex = null; }
        else if (selectedTargets.length === 1) {
          const index = noteState.targets.findIndex(target => target.targetId === selectedTargets[0].targetId);
          frameIndex = index >= 0 && noteState.targets[index].kind === 'region' ? index : null;
        }
      }
      if (shapeSelected && !resolvedShape(shapeSelected)) shapeSelected = null;
      // 连线手势的端点被删/被裁/被撤销：暂态当场退出，不删任何批注、不写历史。
      // 空白起手的临时坐标没有真实引用，不参与这里的有效性检查。
      if (connect) {
        const aliveEnd = end => live.has(`${end.annotationId}:${end.targetId}`);
        const startEnd = connectStartEnd();
        if ((startEnd && !aliveEnd(startEnd)) || (connect.pressed && !aliveEnd(connect.pressed))) {
          dropConnect('连线的端点已经不在了，这次连线取消了');
        }
      }
    }
    // 工作副本重建后，把“已选的一处”重新对齐到新副本（身份不变，下标可能变）。
    function loadSelectionEnds() {
      if (!noteState || selectedTargets.length !== 1) return;
      const end = selectedTargets[0];
      const index = noteState.targets.findIndex(target => target.targetId === end.targetId);
      if (index < 0) { selectedTargets = [{ annotationId: noteId, targetId: noteState.targets[0].targetId }]; return; }
      frameIndex = noteState.targets[index].kind === 'region' ? index : null;
    }
    function closeComment() {
      commentOpen = false;
      const toggle = $('[data-action="comment"]');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      syncPanel();
    }
    function syncComment() {
      const toggle = $('[data-action="comment"]');
      if (toggle) toggle.setAttribute('aria-expanded', String(commentOpen));
      const field = commentField();
      if (field) field.disabled = blocked() || !image;
      syncPanel();
      if (!commentOpen) return;
      try { field?.focus({ preventScroll: true }); } catch { /* 忽略。 */ }
    }
    function deleteAnnotation(id) {
      if (blocked() || drag) return;
      if (!annotationList().some(item => item.id === id)) return;
      const doomed = relationsOfAnnotation(id).map(record => record.id);
      // 删之前先放下这条的工作副本，不能再用它回写快照。
      if (noteId === id) { noteId = null; noteState = null; frameIndex = null; selectedTargets = []; bubbleKey = ''; }
      if (doomed.includes(selectedRelationId)) selectedRelationId = null;
      commitOp({ tool: 'annotation-delete', id, ...(doomed.length ? { relationDeletes: doomed } : {}) });
      pruneSelection();
      syncBubble();
      status(doomed.length
        ? `已删除该条批注，连同它牵着的 ${doomed.length} 条关系；可用撤销恢复`
        : '已删除该条批注，可用撤销恢复');
      sync();
    }
    function toggleNotes() {
      // 只影响编辑器预览：保存、复制与分段导出的成图都会带上批注标记，不跟着这个开关变。
      if (!flushAll()) return;
      notesVisible = !notesVisible;
      if (!notesVisible) { selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null; }
      status(notesVisible ? '预览已显示批注标记（只影响编辑器里的显示）' : '预览已隐藏批注标记；保存与复制的成图仍然带标记，说明区仍保留编号说明');
      sync(); schedule();
    }
    function cancelCrop(message = '已取消未应用的裁切') {
      const cropGesture = drag && (drag.mode === 'crop' || drag.mode === 'crop-resize' || drag.mode === 'crop-move');
      if (!cropDraft && !cropGesture) return;
      if (cropGesture) cancel();
      cropDraft = null;
      status(message);
      sync(); schedule();
    }
    // 应用裁切：crop op 存源图绝对整数矩形，必须严格落在当前视窗内；只裁小不放大。
    function applyCrop() {
      if (blocked() || !image || !cropDraft) return;
      // 手势/平移未结束不能确认：避免提交后旧 drag 继续移动出一个新草稿。
      if (drag) { status('请先松开鼠标再应用裁切'); return; }
      if (pan) { status('平移中，松开后再应用裁切'); return; }
      const view = currentView(), rect = cropDraft;
      const integral = [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger);
      const inside = rect.x >= view.x && rect.y >= view.y &&
        rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height;
      if (!integral || rect.width < 1 || rect.height < 1 || !inside) { status('裁切范围必须在当前画面内'); return; }
      // 范围就是当前画面：不追加无意义的 crop，避免把 redo 历史截断。
      if (rect.x === view.x && rect.y === view.y && rect.width === view.width && rect.height === view.height) {
        cropDraft = null;
        tool = 'browse'; fitImage();
        status('裁切范围没有变化，已回到抓手查看整图');
        sync(); schedule(); return;
      }
      commitOp({ tool: 'crop', rect: { ...rect } });
      cropDraft = null;
      // 裁切改变画面就保守收起形状选中（工具本来也已不是选择）。
      shapeSelected = null;
      // 裁切会把落在新画面外的目标整条拿掉：选中不能停在已经不存在的目标上。
      pruneSelection();
      tool = 'browse'; fitImage();
      status(`已裁切为 ${rect.width} × ${rect.height} 像素 · 可撤销恢复`);
      syncBubble();
      sync();
    }
    function syncColors() {
      root.querySelectorAll('[data-color]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.color===setting('color').value)));
    }
    // 当前工具对应的整套指针；关联选择时按实际 linkPick.kind 用 point/region 图标（取消后自动回原工具）。
    function toolCursor() {
      if (linkPick) return linkPick.kind === 'point' ? noteCursor : regionCursor;
      if (tool === 'point') return noteCursor;
      if (tool === 'region') return regionCursor;
      if (tool === 'connect' || tool === 'ocr') return 'crosshair';
      if (tool === 'rect') return rectCursor;
      if (tool === 'arrow') return arrowCursor;
      return penCursor;            // pen / line 共用一个细笔尖
    }
    function updateCursor() {
      const inside=opened && image && !blocked() && pointer && inImage(pointer);
      // 光标与图外起拖范围一致；忙碌、滚动条和单点操作不开放。
      const outsideStart = opened && image && !blocked() && pointer && allowsOutsideStart() && !inImage(pointer) && inScrollArea(pointer);
      // 平移/空格时隐藏马赛克笔刷，改用抓手；手柄显示对应方向的 resize 光标。
      const panning = Boolean(pan) || spaceDown;
      brushCursor.hidden = panning || !(tool==='mosaic' && inside && pointer.pointerType!=='touch');
      const handle = tool==='crop' && cropDraft && pointer ? cropHandleAt(pointer) : null;
      const overDraft = tool==='crop' && cropDraft && pointer ? cropContainsPoint(pointer) : false;
      // 当前可调的批注框：手柄给方向性 resize 光标，框内给 move；其它工具/无选中都不受影响。
      const frameHandle = pointer && !pan && !spaceDown ? frameHandleAt(pointer) : null;
      const overFrame = pointer && !pan && !spaceDown ? frameContainsPoint(pointer) : false;
      // 选择工具：手柄给方向光标/十字，边线或线身给移动光标。
      const shapeHandle = pointer && tool === 'select' && !pan && !spaceDown ? shapeHandleAt(pointer) : null;
      const overShape = pointer && tool === 'select' && !pan && !spaceDown && !shapeHandle ? Boolean(topShapeAt(pointer)) : false;
      scroller.style.cursor = pan ? 'grabbing' : spaceDown ? 'grab' : frameHandle ? CROP_CURSORS[frameHandle] : overFrame ? 'move' : linkPick ? (pointer&&!inside&&!outsideStart ? 'default' : toolCursor()) : tool==='browse' ? (drag?'grabbing':'grab') : tool==='mosaic' ? (brushCursor.hidden ? (outsideStart ? 'crosshair' : 'default') : 'none') : tool==='crop' ? (handle ? CROP_CURSORS[handle] : overDraft ? 'move' : (pointer&&!inside ? 'default' : 'crosshair')) : tool==='select' ? (shapeHandle ? (shapeHandle.kind === 'resize' ? CROP_CURSORS[shapeHandle.handle] : 'crosshair') : overShape ? 'move' : 'default') : pointer&&!inside&&!outsideStart ? 'default' : toolCursor();
      // 选择工具：悬到点/框/关系线上给 pointer，提示“这里可点”；连线时同样只在批注上给 pointer。
      if (pointer && !pan && !spaceDown && (tool === 'select' || tool === 'connect')) {
        const at = point(pointer);
        if (tool === 'select') {
          if (annotationHitAt(at) || relationAt(at)) scroller.style.cursor = 'pointer';
        } else if (annotationHitAt(at)) scroller.style.cursor = 'pointer';
      }
      if (!brushCursor.hidden) {
        const rect=workspace.getBoundingClientRect(),diameter=number('diameter',20,4,128)*zoom;
        brushCursor.style.width=brushCursor.style.height=`${diameter}px`;
        brushCursor.style.transform=`translate(${pointer.clientX-rect.left}px,${pointer.clientY-rect.top}px) translate(-50%,-50%)`;
      }
    }
    function trackPointer(e) {pointer={clientX:e.clientX,clientY:e.clientY,pointerType:e.pointerType};updateCursor();}
    scroller.addEventListener('pointerenter',trackPointer);
    scroller.addEventListener('pointermove',trackPointer);
    scroller.addEventListener('pointerleave',()=>{pointer=null;updateCursor();});
    function stopPan() {
      if (!pan) return;
      const id = pan.id;
      pan = null;
      if (scroller.hasPointerCapture?.(id)) scroller.releasePointerCapture(id);
      updateCursor();
    }
    // 中键拖拽 / 空格+左键临时平移：capture 阶段拦下来，标记层按钮不能截走手势；不改 tool、不进历史。
    workspace.addEventListener('pointerdown', e => {
      if (blocked() || !image || drag || pan) return;
      const middle = e.button === 1;
      const spaceLeft = e.button === 0 && spaceDown;
      if (!middle && !spaceLeft) return;
      if (e.target?.closest?.('.ie-toolbar,.ie-bubble,.ie-note-card,.ie-view-actions')) return;
      // 原生滚动条上的按下归滚动条，不当临时平移。
      const bounds = scroller.getBoundingClientRect();
      if (e.clientX >= bounds.left + scroller.clientWidth || e.clientY >= bounds.top + scroller.clientHeight) return;
      // 中键默认自动滚动/粘贴都要拦住。
      e.preventDefault(); e.stopPropagation();
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, mask: middle ? 4 : 1 };
      try { scroller.setPointerCapture?.(e.pointerId); } catch { /* 捕获失败不影响平移。 */ }
      updateCursor();
    }, true);
    const mosaics = new Map();
    function status(message = '') { $('.ie-status').textContent = String(message); }
    function warning(message = '') {
      const node=$('.ie-warning'); node.textContent=String(message); node.hidden=!node.textContent;
    }
    function blocked() { return locked || loading || exporting; }
    // 最小化只是窗口动作：失败只报状态，不提交、不关闭、也不动草稿。
    function awaitMinimize() {
      if (!minimizeHandler || blocked()) return;
      const failed = error => status(`没能最小化窗口：${error?.message || error}`);
      try { Promise.resolve(minimizeHandler()).catch(failed); } catch (error) { failed(error); }
    }
    function sync() {
      root.setAttribute('aria-busy', String(blocked()));
      root.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = blocked() || !image; });
      $('[data-action="undo"]').disabled = blocked() || !cursor;
      $('[data-action="redo"]').disabled = blocked() || cursor >= ops.length;
      const selectButton = $('[data-tool="select"]'), selectable = hasSelectableContent();
      selectButton.disabled = blocked() || !image || previewMode || !selectable;
      selectButton.title = selectable
        ? '调整已添加的批注、连线、空心矩形、直线或箭头：拖动移动，手柄调整，Delete 删除'
        : '还没有可调整的标记。先添加批注、连线、空心矩形、直线或箭头；画笔、马赛克和遮盖不支持单独调整';
      // 选中形状的删除入口：只在选择工具且真选中时可点，预览只读。
      const removeShape = $('[data-action="shape-delete"]');
      if (removeShape) removeShape.disabled = blocked() || previewMode || !(tool === 'select' && selectedShape());
      // 预览只读：历史/裁切/批注入口全关（工具栏与面板本身也隐藏），只留浏览、缩放与输出。
      if (previewMode) for (const action of ['undo', 'redo', 'crop-apply', 'crop-cancel']) {
        const button = $(`[data-action="${action}"]`);
        if (button) button.disabled = true;
      }
      // 裁切：未应用的框只能预览；有草稿时「保存/复制」按钮直接禁用，不靠导出报错兜底。
      const cropPending = Boolean(cropDraft), view = currentView();
      const cropSize = $('.ie-crop-size');
      if (cropSize) cropSize.textContent = cropPending
        ? `保留 ${cropDraft.width} × ${cropDraft.height} 像素` : `当前画面 ${view.width} × ${view.height} 像素`;
      for (const action of ['crop-apply', 'crop-cancel']) {
        const button = $(`[data-action="${action}"]`);
        if (button) button.disabled = blocked() || !image || !cropPending;
      }
      $('[data-action="save"]').disabled = blocked() || !image || cropPending;
      const saveAs = $('[data-action="save-as"]');
      if (saveAs) saveAs.disabled = blocked() || !image || cropPending;
      $('[data-action="copy"]').disabled = blocked() || !image || cropPending;
      const docSize = $('.ie-doc-size');
      if (docSize) docSize.textContent = `${view.width} × ${view.height} 像素`;
      syncPanel();
      const notesToggle = $('[data-action="notes-toggle"]');
      if (notesToggle) notesToggle.setAttribute('aria-pressed', String(notesVisible));
      root.querySelectorAll('[data-tool]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.tool === tool)));
      // 连线入口随时可用：起手可以选已有点/框，也可以落在空白处（成功后才变成空文字点）。
      const connectButton = $('[data-tool="connect"]');
      if (connectButton) {
        connectButton.disabled = blocked() || !image || previewMode;
        connectButton.title = '从任意一处连到另一处：按住拖过去，或点两下；空白处会落一个新点';
      }
      // 图没了（换图/关闭）就退出连线手势；批注有几条不影响连线可用性。
      if (connect && !image) dropConnect('图片不在了，这次连线取消了');
      root.querySelectorAll('[data-tools]').forEach(el => { el.hidden=!el.dataset.tools.split(' ').includes(tool); });
      $('.ie-tool-name').textContent = `${$(`[data-tool="${tool}"]`).textContent}设置`;
      root.querySelectorAll('[data-range]').forEach(el => { el.value=setting(el.dataset.range).value; });
      syncColors();updateCursor();renderMarkers();syncBubbleExtras();
      const segmentButton = $('[data-action="segments"]');
      if (segmentButton) {
        segmentButton.textContent = segmentBusy ? '停止分段导出' : '分段导出';
        segmentButton.title = segmentBusy
          ? '停止这次分段导出：已经写好的图片留在目标文件夹，不删除'
          : '按原分辨率把这张图切成几张 PNG（带已保存的批注与说明），原图不动；自己选文件夹';
        segmentButton.disabled = segmentBusy ? false : (blocked() || !image || cropPending);
      }
      syncOcrResult();
      $('.ie-zoom').textContent = `${Math.round(zoom * 100)}%`;
      // 给宿主一个「状态可能变了」的通知（GIF 编辑器用它刷新自己的时间栏）；
      // 宿主回调抛错绝不能打断原编辑器，也不回写编辑器状态。
      try { onStateChange(); } catch { /* 宿主回调失败不影响编辑器本身。 */ }
      // 选择/关系/文字任何一处变了都要重画：画布上的关系线、选中高亮和中间标签都在 render 里。
      // 只在这里统一排一次，靠 schedule 自己的 frame/opened 去重；render 不回调 sync，不会互相触发。
      schedule();
    }
    function origin() {
      const view = currentView();
      // 源图 (0,0) 的屏幕位置 = 当前视窗可见左上位置 − 视窗原点×zoom；布局仍居中当前视窗。
      return { x: Math.max(16, (scroller.clientWidth - view.width * zoom) / 2) - scroller.scrollLeft - view.x * zoom,
        y: 16 - scroller.scrollTop - view.y * zoom };
    }
    function layout() {
      keepWorkspaceFixed();
      const view = currentView();
      // spacer 只表达图像的自然 extent（含四边 16px 手柄余量）；可视区由 CSS min-width/min-height:100% 填满。
      // 不再用取整后的 clientWidth/Height 反向撑容器，避免分数 DPI/滚动条出现时整数尺寸与真实 content box 互相触发。
      spacer.style.width = `${view.width * zoom + 32}px`;
      spacer.style.height = `${view.height * zoom + 32}px`;
      sync(); schedule();
    }
    // 视窗变小后把滚动位置夹回合法范围（不靠异步回流）。
    function maxScroll() {
      const view = currentView();
      return { left: Math.max(0, view.width * zoom + 32 - scroller.clientWidth),
        top: Math.max(0, view.height * zoom + 32 - scroller.clientHeight) };
    }
    function clampScroll() {
      const max = maxScroll();
      scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollLeft, max.left));
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop, max.top));
    }
    // 滚轮/平移统一直接设原生 scrollLeft/Top：自己夹到合法范围，不依赖浏览器或夹具默认行为。
    function scrollByPixels(dx, dy) {
      const max = maxScroll();
      scroller.scrollLeft = Math.max(0, Math.min(max.left, scroller.scrollLeft + dx));
      scroller.scrollTop = Math.max(0, Math.min(max.top, scroller.scrollTop + dy));
      updateCursor(); schedule();
    }
    // 双维度适应整图：四边至少 16 CSS px，让 8 个手柄能抓到；水平居中，竖向留上边距。
    function fitImage() {
      if (pan) return;
      const view = currentView();
      const availableWidth = Math.max(1, scroller.clientWidth - 32);
      const availableHeight = Math.max(1, scroller.clientHeight - 32);
      zoom = clampZoom(Math.min(availableWidth / view.width, availableHeight / view.height));
      layout();
      scroller.scrollLeft = 0; scroller.scrollTop = 0;
      schedule();
    }
    function mosaic(grain) {
      if (mosaics.has(grain)) return mosaics.get(grain);
      // Integer grains 4..128: at most 125 grids, <5M cached pixels under LIMIT.
      // Keep each grid until reset: eviction would rebuild whole grids every frame with mixed grains.
      const small = document.createElement('canvas'); small.width = Math.ceil(width / grain); small.height = Math.ceil(height / grain);
      small.getContext('2d').drawImage(image, 0, 0, width / grain, height / grain);
      mosaics.set(grain, small); return small;
    }
    function path(ctx, points) {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (i === 0 || p.move) {
          ctx.moveTo(p.x, p.y);
          if (i === points.length - 1 || points[i + 1].move) ctx.lineTo(p.x + 0.001, p.y);
        } else ctx.lineTo(p.x, p.y);
      }
    }
    function paint(ctx, op) {
      // 只有带点位的笔迹/形状能画；shape-update/delete 这类元数据记录即便被误传也不进绘制。
      if (!op || !Array.isArray(op.points) || op.points.length === 0) return;
      const a = op.points[0], b = op.points[op.points.length - 1];
      ctx.save(); ctx.strokeStyle = ctx.fillStyle = op.color; ctx.lineWidth = op.width; ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath();
      if (op.tool === 'mosaic') {
        // One global grid, selected by capsules along the complete path: no gaps between input events.
        const small = mosaic(op.grain), r = op.diameter / 2;
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        for (let i = 1; i < op.points.length; i++) {
          const p = op.points[i - 1], q = op.points[i], angle = Math.atan2(q.y - p.y, q.x - p.x), dx = Math.sin(angle) * r, dy = Math.cos(angle) * r;
          if (!q.move) {
            ctx.moveTo(p.x + dx, p.y - dy); ctx.lineTo(q.x + dx, q.y - dy); ctx.lineTo(q.x - dx, q.y + dy); ctx.lineTo(p.x - dx, p.y + dy); ctx.closePath();
          }
          ctx.moveTo(q.x + r, q.y); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        }
        ctx.clip('nonzero'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width * op.grain, small.height * op.grain);
      } else if (op.tool === 'rect') {
        const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y), w = Math.abs(b.x-a.x), h = Math.abs(b.y-a.y);
        if (op.fill) ctx.fillRect(x,y,w,h); else ctx.strokeRect(x,y,w,h);
      } else if (op.tool === 'arrow') {
        const length=Math.hypot(b.x-a.x,b.y-a.y);
        if (length<0.5) { ctx.arc(a.x,a.y,op.width/2,0,Math.PI*2); ctx.fill(); }
        else {
          // A single filled outline keeps the shaft from poking through the sharp tip.
          const ux=(b.x-a.x)/length,uy=(b.y-a.y)/length,nx=-uy,ny=ux;
          const head=Math.min(length*0.55,Math.max(14,op.width*3.2));
          const halfShaft=Math.min(op.width/2,length*0.12),halfHead=Math.max(halfShaft,Math.min(op.width*1.5,head*0.5));
          const x=b.x-ux*head,y=b.y-uy*head;
          ctx.moveTo(a.x+nx*halfShaft,a.y+ny*halfShaft);
          ctx.lineTo(x+nx*halfShaft,y+ny*halfShaft);ctx.lineTo(x+nx*halfHead,y+ny*halfHead);
          ctx.lineTo(b.x,b.y);ctx.lineTo(x-nx*halfHead,y-ny*halfHead);
          ctx.lineTo(x-nx*halfShaft,y-ny*halfShaft);ctx.lineTo(a.x-nx*halfShaft,a.y-ny*halfShaft);
          ctx.closePath();ctx.fill();
        }
      } else { path(ctx, op.points); ctx.stroke(); }
      ctx.restore();
    }
    // 8 个手柄画在屏幕坐标里（不随 zoom 缩小）：白底 + 墨色描边，可见 10 CSS px。
    function drawCropHandles(dpr) {
      const overlay = cropOverlay();
      drawHandleSquares(dpr, overlay, CROP_HANDLE_SIZE);
    }
    // 当前可调的批注框：强调边框 + 8 个更小的手柄；全部只画在屏幕帧，不进任何导出。
    function drawFrameHandles(dpr) {
      const overlay = frameOverlay();
      if (!overlay) return;
      const box = overlay.box;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.save();
      context.lineWidth = 3; context.strokeStyle = '#ffffff';
      context.strokeRect(box.left, box.top, box.width, box.height);
      context.lineWidth = 1.5; context.strokeStyle = '#e89bb0';
      context.strokeRect(box.left, box.top, box.width, box.height);
      context.restore();
      drawHandleSquares(dpr, overlay, FRAME_HANDLE_SIZE);
    }
    function drawHandleSquares(dpr, overlay, size) {
      if (!overlay) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.save();
      for (const key of CROP_HANDLES) {
        const [x, y] = overlay.centers[key], half = size / 2;
        context.fillStyle = '#ffffff';
        context.fillRect(x - half, y - half, size, size);
        context.lineWidth = 1;
        context.strokeStyle = '#20382e';
        context.strokeRect(x - half, y - half, size, size);
      }
      context.restore();
    }
    // 选中的形状：强调边框 + 手柄（矩形 8 个，线/箭头只两端点）。
    // 只画在屏幕帧，导出/缩略图/GIF 帧全部走 compose，不会带手柄。
    function drawShapeSelection(dpr) {
      // 只在选择工具且真选中时画；预览态不露手柄。拖拽中按草稿几何画，手柄跟手。
      if (previewMode) return;
      const op = liveShape();
      if (!op) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.save();
      if (op.tool === 'rect') {
        const box = shapeScreenBox(op);
        context.lineWidth = 3; context.strokeStyle = '#ffffff';
        context.strokeRect(box.left, box.top, box.width, box.height);
        context.lineWidth = 1.5; context.strokeStyle = '#e89bb0';
        context.strokeRect(box.left, box.top, box.width, box.height);
        context.restore();
        drawHandleSquares(dpr, handleOverlayFor(box), SHAPE_HANDLE_SIZE);
        return;
      }
      const [a, b] = shapeScreenEnds(op);
      context.lineWidth = 3; context.strokeStyle = '#ffffff';
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      context.lineWidth = 1.5; context.strokeStyle = '#e89bb0';
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      context.restore();
      for (const end of [a, b]) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.save();
        const half = SHAPE_HANDLE_SIZE / 2;
        context.fillStyle = '#ffffff';
        context.fillRect(end.x - half, end.y - half, SHAPE_HANDLE_SIZE, SHAPE_HANDLE_SIZE);
        context.lineWidth = 1; context.strokeStyle = '#20382e';
        context.strokeRect(end.x - half, end.y - half, SHAPE_HANDLE_SIZE, SHAPE_HANDLE_SIZE);
        context.restore();
      }
    }
    // 未应用的裁切框：框外压暗遮罩 + 虚线边框，只画在屏幕帧里（导出不会看到）。
    function drawCropDraft(ctx, rect, view) {
      const right = view.x + view.width, bottom = view.y + view.height;
      ctx.save();
      ctx.fillStyle = 'rgba(20, 32, 27, 0.45)';
      ctx.fillRect(view.x, view.y, view.width, rect.y - view.y);
      ctx.fillRect(view.x, rect.y + rect.height, view.width, bottom - (rect.y + rect.height));
      ctx.fillRect(view.x, rect.y, rect.x - view.x, rect.height);
      ctx.fillRect(rect.x + rect.width, rect.y, right - (rect.x + rect.width), rect.height);
      const dash = Math.max(4, Math.round(markerRadius() / 2));
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([dash, Math.max(3, Math.round(dash * 0.6))]);
      ctx.lineWidth = Math.max(1, Math.round(markerRadius() / 3));
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
      ctx.restore();
    }
    // 只有屏幕渲染帧（pending=true）且预览开着批注时才画框批注的边框；
    // 点批注的编号/引线/空心圈只由 DOM 标记层画。保存 / 缩略图 / 识别局部图都不带批注标记；
    // 保存 / 缩略图 / 识别局部图 / 复制成图都不带批注标记；复制成图只在主图下方附说明区与局部放大。
    // 导出时把视窗原点搬到 (0,0)；屏幕帧用 origin() 已有的平移。两边都严格 clip 当前视窗。
    function compose(ctx, pending = false) {
      const view = currentView(), live = pending === true;
      ctx.save();
      if (!live) ctx.translate(-view.x, -view.y);
      ctx.beginPath(); ctx.rect(view.x, view.y, view.width, view.height); ctx.clip();
      ctx.drawImage(image,0,0);
      // Filters affect only the base image. Annotations always stay above them,
      // so later mosaic strokes cannot reveal source pixels under opaque covers.
      for (const mosaicLayer of [true,false]) {
        // 形状按“当前有效版本”在原创建槽位画：更新不会多画一份，也不会跳到后面的遮盖上方。
        const versions = shapeVersions();
        for (let i = 0; i < cursor; i++) {
          const op = ops[i];
          // 批注、关联更新、裁切、关系与形状的更新/删除记录都不是笔迹：进历史、可撤销，但不直接进像素。
          if (!op || op.tool === 'annotation' || op.tool === 'annotation-update' || op.tool === 'annotation-delete' ||
              op.tool === 'annotation-relation' || op.tool === 'annotation-relation-update' || op.tool === 'annotation-relation-delete' ||
              op.tool === 'crop' || op.tool === 'shape-update' || op.tool === 'shape-delete') continue;
          let paintOp = op;
          if (op.id && SHAPE_TOOLS.has(op.tool)) {
            // 未提交的草稿只进屏幕帧（live），导出/缩略图/GIF 帧一律用已提交版本。
            paintOp = (live && drag?.shapeId === op.id && drag.draft) ? drag.draft : versions.get(op.id);
            if (!paintOp) continue;   // 已删除的形状
          }
          if ((op.tool === 'mosaic') === mosaicLayer) paint(ctx, paintOp);
        }
        const pendingOp = drag?.op;
        if (live && pendingOp && pendingOp.tool !== 'annotation' && pendingOp.tool !== 'annotation-delete' &&
            (pendingOp.tool === 'mosaic') === mosaicLayer) paint(ctx,pendingOp);
      }
      if (live && notesVisible) {
        // 一条批注的每个框目标都画预览边框（它们共用同一条意见）。
        // 正在编辑的那条用气泡里的暂存几何：拖框时不能把旧框叠着画两份。
        for (const note of annotationList()) {
          const targets = stagedTargetsOf(note) || note.targets;
          for (const target of targets) if (target.kind === 'region') {
            drawNote(ctx, target, { relation: note.relation, index: target.index, seed: `${note.id}:${target.index}` });
          }
          // 移动/参考关系：两端都在才画方向箭头，缺一个端点就只留框。
          if (visuals && visuals.relationReady(note)) {
            const curve = visuals.relationCurve(note);
            if (curve) visuals.strokeRelationLine(ctx, curve, { width: Math.max(1, 2.5 / zoom), color: visuals.PALETTE.inkDeep });
            drawRelationTags(ctx, note);
          } else if (visuals && visuals.linkReady(note)) {
            // 通用连接：只画指向，不贴「移动/参考」语义标签。
            drawLinkLines(ctx, note, { width: Math.max(1, 2.5 / zoom) });
          }
        }
        // 独立关系（两处有关）：两端都在当前画面才画；缺一端不画，也不把另一端冒充成它。
        if (visuals) {
          for (const relation of relationList()) {
            drawRelationLines(ctx, relation, { width: Math.max(1, 2.5 / zoom),
              selected: relation.id === selectedRelationId });
          }
        }
        // 连线手势的预览：虚线跟指针，命中另一处时端点贴到那一处；不写任何像素/历史。
        if (connect) drawConnectPreview(ctx);
        // 正在拖的新框、正在拖的关联框和还没保存的框草稿都用虚线，提示“还没定下来”。
        const pendingRegion = drag?.op?.tool === 'annotation' && drag.op.kind === 'region' ? drag.op : null;
        const pendingLink = drag?.mode === 'link-region' ? drag.rect : null;
        if (pendingLink && pendingLink.width > 0 && pendingLink.height > 0) drawNote(ctx, { rect: pendingLink }, { preview: true, seed: 'link-preview' });
        if (pendingRegion) drawNote(ctx, pendingRegion, { preview: true, seed: 'region-preview' });
      }
      if (live && cropDraft && tool === 'crop') drawCropDraft(ctx, cropDraft, view);
      if (live && tool === 'ocr') {
        const rect = drag?.mode === 'ocr-region' ? drag.rect : ocrSelection;
        if (rect && rect.width > 0 && rect.height > 0) drawNote(ctx, { rect }, { preview: true, seed: 'ocr-selection' });
      }
      ctx.restore();
    }
    function render() {
      frame = 0; if (!opened || !image) return;
      renderCount += 1;
      const dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(8000000 / Math.max(1,scroller.clientWidth*scroller.clientHeight)));
      const w = Math.max(1,Math.round(scroller.clientWidth*dpr)), h = Math.max(1,Math.round(scroller.clientHeight*dpr));
      if (display.width !== w || display.height !== h) { display.width = w; display.height = h; }
      display.style.width = `${scroller.clientWidth}px`; display.style.height = `${scroller.clientHeight}px`;
      context.setTransform(1,0,0,1,0,0); context.clearRect(0,0,w,h);
      const o = origin(); context.setTransform(dpr*zoom,0,0,dpr*zoom,o.x*dpr,o.y*dpr);
      compose(context,true);
      if (tool === 'crop' && cropDraft) {
        drawCropHandles(dpr);
        // 手柄用设备像素画，画完把坐标变换恢复，后续帧/读数仍以图像变换为准。
        context.setTransform(dpr*zoom,0,0,dpr*zoom,o.x*dpr,o.y*dpr);
      } else if (frameOverlay()) {
        drawFrameHandles(dpr);
        context.setTransform(dpr*zoom,0,0,dpr*zoom,o.x*dpr,o.y*dpr);
      } else if (tool === 'select' && selectedShape()) {
        drawShapeSelection(dpr);
        context.setTransform(dpr*zoom,0,0,dpr*zoom,o.x*dpr,o.y*dpr);
      }
      // 标记层跟着同一帧的 zoom/scroll 重算；便签贴批注定位，都不参与画布尺寸。
      keepWorkspaceFixed();
      renderMarkers();
      placeCards();
      context.setTransform(dpr*zoom,0,0,dpr*zoom,o.x*dpr,o.y*dpr);
    }
    function schedule() { if (!frame && opened) frame = requestAnimationFrame(render); }
    function cancel() {
      const previous = drag; drag = null;
      // 框调整被中断（Esc/pointercancel/lostcapture/blur/关窗）时，几何退回按下那一刻；正常松手已标记 kept。
      if (previous && !previous.kept && (previous.mode === 'frame-move' || previous.mode === 'frame-resize')) restoreFrameDrag(previous);
      // 拉线手势被打断：只退本次手势，已圈的范围和已写的字都不动。
      if (previous && previous.mode === 'link-drag' && previous.snap) previous.snap = null;
      if (previous && scroller.hasPointerCapture(previous.id)) scroller.releasePointerCapture(previous.id);
      sync(); schedule();
    }
    function rawPoint(e) {
      const rect = scroller.getBoundingClientRect(), o = origin();
      return { x: (e.clientX-rect.left-o.x)/zoom, y: (e.clientY-rect.top-o.y)/zoom };
    }
    function point(e) {
      const { x, y } = rawPoint(e), view = currentView();
      return { x: Math.max(view.x, Math.min(view.x + view.width, x)), y: Math.max(view.y, Math.min(view.y + view.height, y)) };
    }
    // 笔刷裁真实路径段，不能把图外采样逐点压到边缘，否则会蹭出长道。
    function clipBrushSegment(a, b) {
      const view = currentView();
      let enter = 0, exit = 1;
      for (const [start, end, low, high] of [
        [a.x, b.x, view.x, view.x + view.width],
        [a.y, b.y, view.y, view.y + view.height]
      ]) {
        const delta = end - start;
        if (delta === 0) { if (start < low || start > high) return null; continue; }
        const t0 = (low - start) / delta, t1 = (high - start) / delta;
        enter = Math.max(enter, Math.min(t0, t1));
        exit = Math.min(exit, Math.max(t0, t1));
        if (enter > exit) return null;
      }
      const at = t => ({
        x: Math.max(view.x, Math.min(view.x + view.width, a.x + (b.x - a.x) * t)),
        y: Math.max(view.y, Math.min(view.y + view.height, a.y + (b.y - a.y) * t))
      });
      return [at(enter), at(exit)];
    }
    function inImage(e) {
      const rect = scroller.getBoundingClientRect(), o = origin(), view = currentView();
      const x=e.clientX-rect.left-o.x-view.x*zoom, y=e.clientY-rect.top-o.y-view.y*zoom;
      return x>=0 && y>=0 && x<=view.width*zoom && y<=view.height*zoom;
    }
    // 滚动内容区（不含原生滚动条）：图外留白起拖与图外光标都用这一条判据。
    function inScrollArea(e) {
      const bounds = scroller.getBoundingClientRect();
      return e.clientX >= bounds.left && e.clientY >= bounds.top &&
        e.clientX < bounds.left + scroller.clientWidth && e.clientY < bounds.top + scroller.clientHeight;
    }
    function allowsOutsideStart() {
      if (linkPick) return linkPick.kind === 'region';
      return tool === 'region' || tool === 'rect' || tool === 'ocr' || tool === 'pen' || tool === 'mosaic';
    }
    function setting(name) { return $(`[data-setting="${name}"]`); }
    function number(name, fallback, min, max) { return Math.max(min,Math.min(max,Number(setting(name).value)||fallback)); }
    // 裁切框落成源图整数像素（1:1，不重采样）：反拖同样支持；宽高可能为 0，由松手判定是否有效。
    function cropRectFrom(start, end) {
      const left = Math.round(Math.min(start.x, end.x)), top = Math.round(Math.min(start.y, end.y));
      const right = Math.round(Math.max(start.x, end.x)), bottom = Math.round(Math.max(start.y, end.y));
      return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }
    // 裁切框在屏幕上的框与 8 个手柄：手柄固定 CSS 尺寸，不随 zoom 变小；热区 14px（至少 8）。
    function cropScreenRect(rect) {
      const o = origin();
      return { left: o.x + rect.x * zoom, top: o.y + rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
    }
    // 8 个手柄在屏幕上的位置与热区：裁切框和批注框共用同一套几何。
    function handleOverlayFor(box) {
      const right = box.left + box.width, bottom = box.top + box.height;
      const midX = (box.left + right) / 2, midY = (box.top + bottom) / 2;
      const centers = { nw: [box.left, box.top], n: [midX, box.top], ne: [right, box.top], e: [right, midY],
        se: [right, bottom], s: [midX, bottom], sw: [box.left, bottom], w: [box.left, midY] };
      const hits = {};
      for (const key of CROP_HANDLES) {
        const [x, y] = centers[key];
        hits[key] = { left: x - CROP_HANDLE_HIT / 2, top: y - CROP_HANDLE_HIT / 2,
          right: x + CROP_HANDLE_HIT / 2, bottom: y + CROP_HANDLE_HIT / 2 };
      }
      return { box, centers, hits };
    }
    function cropOverlay() { return handleOverlayFor(cropScreenRect(cropDraft)); }
    function localPointer(e) {
      const bounds = scroller.getBoundingClientRect();
      return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
    }
    function cropHandleAt(e) {
      if (!cropDraft) return null;
      return handleAtFor(e, cropOverlay());
    }
    // 命中集合取离手柄中心最近的那个：窄到 1px 多的长图框上，顶部中心不能输给左上角。
    function handleAtFor(e, overlay) {
      const at = localPointer(e), box = overlay.box;
      // 中心内核让给“移动”：距四边都大于 inset 时不归手柄（小框中心也能拖，而不是永远 resize）。
      const inset = Math.min(7, box.width / 3, box.height / 3);
      if (box.width > inset * 2 && box.height > inset * 2 &&
          at.x > box.left + inset && at.x < box.left + box.width - inset &&
          at.y > box.top + inset && at.y < box.top + box.height - inset) return null;
      let best = null, bestDistance = Infinity;
      for (const key of CROP_HANDLES) {
        const hit = overlay.hits[key];
        if (at.x < hit.left || at.x > hit.right || at.y < hit.top || at.y > hit.bottom) continue;
        const [cx, cy] = overlay.centers[key];
        const distance = Math.hypot(at.x - cx, at.y - cy);
        if (distance < bestDistance) { bestDistance = distance; best = key; }
      }
      return best;
    }
    function cropContainsPoint(e) {
      if (!cropDraft) return false;
      const at = localPointer(e), box = cropScreenRect(cropDraft);
      return at.x >= box.left && at.x <= box.left + box.width && at.y >= box.top && at.y <= box.top + box.height;
    }
    // —— 批注框调整：只改气泡里的暂存几何，不进 ops、不进像素历史 ——
    // 当前框是否真的可以调：批注工具、气泡里有一条草稿/正在改的批注、预览没被藏、且不在选关联目标。
    // 命中、光标、手柄绘制、拖动入口全走这一个门槛，不显示“看得见但点不了”的手柄。
    function frameAdjustable() {
      // 连线手势里不调框、不露手柄：只能选两端，不能把旧的当前框拖跑。
      return (noteTools.has(tool) || tool === 'select') && tool !== 'connect' && !linkPick && notesVisible && !blocked() && Boolean(bubbleState()) && frameIndex != null;
    }
    function activeFrameRect() {
      if (!frameAdjustable()) return null;
      const state = bubbleState();
      const target = state.targets[frameIndex];
      return target && target.kind === 'region' ? target.rect : null;
    }
    // 当前可调框的目标身份：命中、拖框、选择优先级都用它，不拿坐标比。
    function activeFrameEnd() {
      if (!frameAdjustable()) return null;
      const target = bubbleState()?.targets?.[frameIndex];
      return target ? { annotationId: noteId, targetId: target.targetId } : null;
    }
    function frameOverlay() {
      const rect = activeFrameRect();
      return rect ? handleOverlayFor(cropScreenRect(rect)) : null;
    }
    function frameHandleAt(e) {
      const overlay = frameOverlay();
      return overlay ? handleAtFor(e, overlay) : null;
    }
    function frameContainsPoint(e) {
      const rect = activeFrameRect();
      if (!rect) return false;
      const at = localPointer(e), box = cropScreenRect(rect);
      return at.x >= box.left && at.x <= box.left + box.width && at.y >= box.top && at.y <= box.top + box.height;
    }
    // 框几何：夹在当前裁切视窗内，至少 2px；并消掉 zoom 换算带来的 1e-14 级尾数（精确到 0.01 源像素），
    // 否则 x + width 会比视窗多出一个 ulp，数据模型与主进程的严格比较就会拒。
    function clampFrame(value) {
      const view = currentView(), right = view.x + view.width, bottom = view.y + view.height;
      const x = Math.min(Math.max(view.x, value.x), right - FRAME_MIN);
      const y = Math.min(Math.max(view.y, value.y), bottom - FRAME_MIN);
      const boxWidth = Math.min(right - x, Math.max(FRAME_MIN, value.width));
      const boxHeight = Math.min(bottom - y, Math.max(FRAME_MIN, value.height));
      const round = number => Math.round(number * 100) / 100;
      const box = { x: Math.max(view.x, round(x)), y: Math.max(view.y, round(y)),
        width: round(boxWidth), height: round(boxHeight) };
      // 舍入后可能又向外飘 0.01：向内收，绝不越过当前画面。
      if (box.x + box.width > right) box.width = Math.max(FRAME_MIN, Math.floor((right - box.x) * 100) / 100);
      if (box.y + box.height > bottom) box.height = Math.max(FRAME_MIN, Math.floor((bottom - box.y) * 100) / 100);
      return box;
    }
    // 移动只平移，绝不改宽高：先按原尺寸算出合法区间，再把位移夹进去。
    // （以前的做法是先加位移再夹边，贴到右/下边时会把框压成 2px。）
    function moveFrame(rect, dx, dy) {
      const view = currentView(), right = view.x + view.width, bottom = view.y + view.height;
      const round = number => Math.round(number * 100) / 100;
      const lowX = view.x, highX = Math.max(lowX, right - rect.width);
      const lowY = view.y, highY = Math.max(lowY, bottom - rect.height);
      let x = Math.min(Math.max(lowX, round(rect.x + dx)), highX);
      let y = Math.min(Math.max(lowY, round(rect.y + dy)), highY);
      // 舍入后仍不允许越过当前画面；宽高原样带回去。
      if (x + rect.width > right) x = right - rect.width;
      if (y + rect.height > bottom) y = bottom - rect.height;
      return { x, y, width: rect.width, height: rect.height };
    }
    function sameFrameRect(left, right) {
      return Boolean(left && right) && ['x', 'y', 'width', 'height'].every(key => left[key] === right[key]);
    }
    function startFrameDrag(e, handle) {
      const state = bubbleState(), target = state?.targets?.[frameIndex];
      if (!target || target.kind !== 'region') return false;
      e.preventDefault(); scroller.focus(); closeComment();
      // 只有改主目标 A 的几何才需要作废在途识别（A 是识别的对象）；动 B 不能把 A 的识别打掉。
      // 作废时待一并清 ocrPending：旧请求的 finally 只认 token，不清就会永久卡在“正在识别”。
      if (frameIndex === 0) { ocrPending = false; ocrToken += 1; syncBubbleExtras(); }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: handle ? 'frame-resize' : 'frame-move',
        handle, frameIndex, origin: { ...target.rect }, startClient: { x: e.clientX, y: e.clientY } };
      scroller.setPointerCapture(e.pointerId); sync(); schedule();
      return true;
    }
    // 中断（Esc / pointercancel / lostpointercapture / blur / 关窗）：几何回到按下那一刻，文字与其它框都不动。
    function restoreFrameDrag(interrupted) {
      const state = bubbleState(), target = state?.targets?.[interrupted?.frameIndex];
      if (!target || target.kind !== 'region' || !interrupted.origin) return;
      target.rect = { ...interrupted.origin };
      bubbleTargetsSignature = '';
      syncBubbleExtras();
    }
    // 松手就把几何提交成一条 annotation-update：一次拖动就是一次可撤销变更，不需要再点「完成」。
    function finishFrameDrag() {
      const state = bubbleState(), target = state?.targets?.[drag.frameIndex];
      if (!target || target.kind !== 'region') return;
      const label = `位置 ${targetLetter(drag.frameIndex)} 的框`;
      if (sameFrameRect(drag.origin, target.rect)) { status(`没有改动 ${label}`); return; }
      // 主目标 A 的自动识别文字来自旧几何：留着就会和现在的框对不上。
      if (drag.frameIndex === 0 && state.targetTextAuto) {
        state.targetText = ''; state.targetTextAuto = false; state.targetTextRevision = 0;
        bubbleTargetsSignature = '';
      }
      const saved = commitNoteState();
      const op = opById(noteId);
      if (op) noteState = stateFromRecord(op);
      syncBubbleExtras(); sync();
      status(`${label}已改 ${targetText(target)}${saved ? ' · 可用撤销恢复' : ''}${drag.frameIndex === 0 && state.targetTextAuto === false && !state.targetText ? '（旧框的识别文字已清空，需要就重新识别或手填）' : ''}`);
    }
    function updateFrameDrag(e) {
      const state = bubbleState(), target = state?.targets?.[drag?.frameIndex];
      if (!target || target.kind !== 'region' || !drag?.origin) return;
      const rect = drag.origin;
      if (drag.mode === 'frame-move') {
        const dx = (e.clientX - drag.startClient.x) / zoom, dy = (e.clientY - drag.startClient.y) / zoom;
        target.rect = moveFrame(rect, dx, dy);
      } else {
        const handle = drag.handle, right = rect.x + rect.width, bottom = rect.y + rect.height, p = point(e);
        let x1 = rect.x, y1 = rect.y, x2 = right, y2 = bottom;
        if (handle.includes('w')) x1 = Math.min(p.x, right - FRAME_MIN);
        if (handle.includes('e')) x2 = Math.max(p.x, x1 + FRAME_MIN);
        if (handle.includes('n')) y1 = Math.min(p.y, bottom - FRAME_MIN);
        if (handle.includes('s')) y2 = Math.max(p.y, y1 + FRAME_MIN);
        target.rect = clampFrame({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      }
      // 说明区坐标跟着几何变：清签名，让 chips、标记与气泡在本帧内重画。
      bubbleTargetsSignature = '';
      syncBubbleExtras(); schedule();
    }
    // 拖手柄只改预览（整数源坐标，不越出当前画面）；至少保持 1px；拖动框时整体夹在画面内。
    function updateCropDrag(e) {
      if (!cropDraft || !drag?.origin) return;
      const view = currentView(), rect = drag.origin;
      if (drag.mode === 'crop-move') {
        const dx = Math.round((e.clientX - drag.startClient.x) / zoom);
        const dy = Math.round((e.clientY - drag.startClient.y) / zoom);
        cropDraft = {
          x: Math.max(view.x, Math.min(view.x + view.width - rect.width, rect.x + dx)),
          y: Math.max(view.y, Math.min(view.y + view.height - rect.height, rect.y + dy)),
          width: rect.width, height: rect.height };
        schedule(); return;
      }
      const handle = drag.handle, right = rect.x + rect.width, bottom = rect.y + rect.height;
      let x1 = rect.x, y1 = rect.y, x2 = right, y2 = bottom;
      const p = point(e), px = Math.round(p.x), py = Math.round(p.y);
      if (handle.includes('w')) x1 = Math.max(view.x, Math.min(right - 1, px));
      if (handle.includes('e')) x2 = Math.min(view.x + view.width, Math.max(x1 + 1, px));
      if (handle.includes('n')) y1 = Math.max(view.y, Math.min(bottom - 1, py));
      if (handle.includes('s')) y2 = Math.min(view.y + view.height, Math.max(y1 + 1, py));
      cropDraft = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      schedule();
    }
    // —— 形状选中/命中/拖拽 ——
    // 命中全部在 CSS 像素里算（不随 zoom 缩水）：矩形只看四条边（中间留空，能点到下层），
    // 线/箭头看线身（粗细的一半，最少 6px）；手柄热区 12px。
    function shapeBox(op) {
      const a = op.points[0], b = op.points[op.points.length - 1];
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    }
    function shapeScreenBox(op) { return cropScreenRect(shapeBox(op)); }
    function shapeScreenEnds(op) {
      const o = origin();
      return [op.points[0], op.points[op.points.length - 1]].map(p => ({ x: o.x + p.x * zoom, y: o.y + p.y * zoom }));
    }
    function distanceToSegment(px, py, a, b) {
      const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
      if (lengthSq === 0) return Math.hypot(px - a.x, py - a.y);
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq));
      return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    }
    function shapeHitAt(at, op) {
      if (op.tool === 'rect') {
        const box = shapeScreenBox(op), pad = SHAPE_EDGE_HIT;
        if (at.x < box.left - pad || at.x > box.left + box.width + pad ||
            at.y < box.top - pad || at.y > box.top + box.height + pad) return false;
        // 只认边线：内部留空，让底下被盖住的形状还能选到（但已填充的遮盖根本不进这个函数）。
        const dx = Math.min(Math.abs(at.x - box.left), Math.abs(at.x - (box.left + box.width)));
        const dy = Math.min(Math.abs(at.y - box.top), Math.abs(at.y - (box.top + box.height)));
        return dx <= pad || dy <= pad;
      }
      const [a, b] = shapeScreenEnds(op);
      const half = Math.max(SHAPE_EDGE_HIT, (op.width * zoom) / 2);
      return distanceToSegment(at.x, at.y, a, b) <= half;
    }
    // 按创建顺序列出形状（含不可调的纯色遮盖）：更新用快照、删除摘除，保持原 z-order。
    // mosaic/pen 不进这个列表：compose 本来就把马赛克画在所有形状下面，不能当上层屏障。
    function shapePaintOrder() {
      const versions = shapeVersions(), seen = new Set(), list = [];
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op || !SHAPE_TOOLS.has(op.tool)) continue;
        if (!op.id) { list.push(op); continue; }          // 未填充以外的矩形（纯色遮盖）没有 id
        if (seen.has(op.id)) continue;
        seen.add(op.id);
        const live = versions.get(op.id);
        if (live) list.push(live);
      }
      return list;
    }
    // 点在屏幕上是否被某个纯色填充矩形盖住。
    function coverHit(at, op) {
      if (!op || op.tool !== 'rect' || op.fill !== true) return false;
      const box = shapeScreenBox(op);
      return at.x >= box.left && at.x <= box.left + box.width && at.y >= box.top && at.y <= box.top + box.height;
    }
    // 该形状上方（后画）是否有纯色遮盖盖住这个屏幕点：手柄不能绕开遮挡。
    function shapeCoveredAbove(id, at) {
      const list = shapePaintOrder();
      const index = list.findIndex(op => op.id === id);
      if (index < 0) return false;
      for (let i = index + 1; i < list.length; i += 1) if (coverHit(at, list[i])) return true;
      return false;
    }
    // 最上面（最后创建且还活着）的那个命中形状；后画的纯色遮盖会挡住下面的透明形状。
    function topShapeAt(e) {
      if (!image || !opened) return null;
      const at = localPointer(e), list = shapePaintOrder();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const op = list[i];
        if (coverHit(at, op)) return null;              // 隐私遮盖屏障：不穿透选到下面
        if (shapeAdjustable(op) && shapeHitAt(at, op)) return op;
      }
      return null;
    }
    // 只有已选中的形状露手柄：矩形 8 个，线/箭头是两个端点。
    function shapeHandleAt(e) {
      const op = liveShape();
      if (!op) return null;
      if (shapeCoveredAbove(op.id, localPointer(e))) return null;
      if (op.tool === 'rect') {
        const key = handleAtFor(e, handleOverlayFor(shapeScreenBox(op)));
        return key ? { shape: op, kind: 'resize', handle: key } : null;
      }
      const at = localPointer(e), half = SHAPE_HANDLE_HIT / 2, ends = shapeScreenEnds(op);
      for (const [index, pointScreen] of [[0, ends[0]], [op.points.length - 1, ends[1]]]) {
        if (Math.abs(at.x - pointScreen.x) <= half && Math.abs(at.y - pointScreen.y) <= half) {
          return { shape: op, kind: 'endpoint', index };
        }
      }
      return null;
    }
    function startShapeDrag(e, shape, handle) {
      if (!shape) return false;
      e.preventDefault(); scroller.focus(); closeComment();
      const mode = !handle ? 'shape-move' : handle.kind === 'resize' ? 'shape-resize' : 'shape-endpoint';
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode, shapeId: shape.id,
        handle: handle?.handle, endpoint: handle?.index,
        origin: cloneShape(shape), draft: cloneShape(shape), startClient: { x: e.clientX, y: e.clientY } };
      scroller.setPointerCapture(e.pointerId); sync(); schedule();
      return true;
    }
    // 拖动只改屏幕草稿；松手才进历史。贴边只夹整体位置，不把宽高挤瘦。
    // 零屏幕位移一律回到 origin：裁切可能让形状一半在视窗外，点一下不能把它夹回视窗里跳位。
    function updateShapeDrag(e) {
      const origin = drag?.origin;
      if (!origin) return;
      if (e.clientX === drag.startClient.x && e.clientY === drag.startClient.y) {
        drag.draft = cloneShape(origin);
        schedule();
        return;
      }
      const view = currentView(), right = view.x + view.width, bottom = view.y + view.height;
      const round = value => Math.round(value * 100) / 100;
      const next = cloneShape(origin);
      const box = shapeBox(origin);
      if (drag.mode === 'shape-move') {
        const dx = (e.clientX - drag.startClient.x) / zoom, dy = (e.clientY - drag.startClient.y) / zoom;
        // 合法区间必须包含原位置：已经在视窗外的部分可以留在原地、也可以往里移，不继续往外逃；
        // 大于视窗的形状同样只夹位置、宽高始终不变。
        const lowX = Math.min(view.x, box.x), highX = Math.max(right - box.width, box.x);
        const lowY = Math.min(view.y, box.y), highY = Math.max(bottom - box.height, box.y);
        const x = Math.min(Math.max(lowX, round(box.x + dx)), highX);
        const y = Math.min(Math.max(lowY, round(box.y + dy)), highY);
        const shiftX = x - box.x, shiftY = y - box.y;
        next.points = origin.points.map(p => ({ x: round(p.x + shiftX), y: round(p.y + shiftY) }));
      } else if (drag.mode === 'shape-resize') {
        const p = point(e), handle = drag.handle;
        let x1 = box.x, y1 = box.y, x2 = box.x + box.width, y2 = box.y + box.height;
        // 可拖范围同样把原有边界包含进来（裁切跨过形状时不会一跳就把边吸回视窗）。
        if (handle.includes('w')) x1 = Math.max(Math.min(view.x, box.x), Math.min(p.x, x2 - SHAPE_MIN));
        if (handle.includes('e')) x2 = Math.min(Math.max(right, x2), Math.max(p.x, x1 + SHAPE_MIN));
        if (handle.includes('n')) y1 = Math.max(Math.min(view.y, box.y), Math.min(p.y, y2 - SHAPE_MIN));
        if (handle.includes('s')) y2 = Math.min(Math.max(bottom, y2), Math.max(p.y, y1 + SHAPE_MIN));
        next.points = [{ x: round(x1), y: round(y1) }, { x: round(x2), y: round(y2) }];
      } else if (drag.mode === 'shape-endpoint') {
        // 端点自由走（可交叉/翻转方向），只夹在当前画面内；长度为 0 也不报错。
        const p = point(e);
        next.points[drag.endpoint] = { x: round(p.x), y: round(p.y) };
      }
      drag.draft = next; schedule();
    }
    function finishShapeDrag() {
      if (!drag?.draft || !drag.origin || !drag.shapeId) return;
      if (sameShape(drag.draft, drag.origin)) { status('形状没有变化'); return; }
      if (shapeBudgetFull()) { status('形状已到编辑上限，请导出后重新编辑 · 本次调整未保存'); return; }
      commitOp({ tool: 'shape-update', id: drag.shapeId, snapshot: cloneShape(drag.draft) });
      status('形状已调整 · Ctrl+Z 撤销这次调整');
    }
    function deleteSelectedShape() {
      const shape = selectedShape();
      if (!shape || previewMode) return false;
      if (shapeBudgetFull()) { status('形状已到编辑上限，请导出后重新编辑 · 未删除'); return false; }
      commitOp({ tool: 'shape-delete', id: shape.id });
      shapeSelected = null;
      status('形状已删除 · Ctrl+Z 恢复');
      sync(); schedule();
      return true;
    }
    // 选中后改颜色/粗细：一次 change 一条 shape-update，可撤销，不改旧 op。
    function applySelectionStyle(patch) {
      const shape = selectedShape();
      if (!shape || previewMode || blocked()) return false;
      const next = cloneShape(shape);
      if (patch.color !== undefined) next.color = patch.color;
      if (patch.width !== undefined) next.width = patch.width;
      if (sameShape(next, shape)) return false;
      if (shapeBudgetFull()) { status('形状已到编辑上限，请导出后重新编辑 · 本次样式未保存'); return false; }
      commitOp({ tool: 'shape-update', id: shape.id, snapshot: next });
      status('已更新选中形状');
      sync(); schedule();
      return true;
    }
    // 把选中形状的颜色/粗细同步回属性区：撤销颜色/粗细后 UI 不能还停在旧值。
    function syncShapeStyle(shape) {
      if (!shape) return;
      setting('color').value = shape.color;
      setting('width').value = String(shape.width);
      const range = root.querySelector('[data-range="width"]');
      if (range) range.value = String(shape.width);
      syncColors();
    }
    function selectShape(id) {
      const op = id ? resolvedShape(id) : null;
      shapeSelected = op ? op.id : null;
      syncShapeStyle(op);
      sync(); schedule();
      return shapeSelected;
    }
    scroller.addEventListener('pointerdown', e => {
      if (e.button !== 0 || blocked() || !image || drag) return;
      const bounds=scroller.getBoundingClientRect();
      // 1) 原生滚动条区域归滚动条，优先级最高。
      if (e.clientX>=bounds.left+scroller.clientWidth || e.clientY>=bounds.top+scroller.clientHeight) return;
      // 连线工具：不移动框、不直接新建点，只接连线手势（空白端在成功后才落成普通空文字点）。
      if (tool === 'connect' && !spaceDown && !pan) { startConnectDown(e); return; }
      // 2) 裁切手柄 / 当前批注框手柄命中优先于“图外拒绝”：
      //    框贴边时手柄有一半在图外，不能因为 inImage 为假就抓不到；
      //    原生滚动条已经在 1) 拦过，这里吞不到它。
      const cropHandle = tool === 'crop' ? cropHandleAt(e) : null;
      const frameHandle = !linkPick && frameAdjustable() ? frameHandleAt(e) : null;
      // 面积框与笔刷允许从工作区留白起拖；单点、连线等仍要求明确落点。
      const outsideStart = allowsOutsideStart() && inScrollArea(e);
      if (tool !== 'browse' && tool !== 'crop' && tool !== 'select' && !inImage(e) && !frameHandle && !outsideStart) return;
      // 给同一条说明再加一处位置：这一次左键只加一个位置，不动别的批注也不丢字。
      if (linkPick) {
        if (spaceDown || pan || (!inImage(e) && !outsideStart)) return;
        e.preventDefault(); scroller.focus(); closeComment();
        const start = point(e);
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY,
          mode: linkPick.kind === 'point' ? 'link-point' : 'link-region', start };
        if (drag.mode === 'link-region') drag.rect = { x: start.x, y: start.y, width: 0, height: 0 };
        scroller.setPointerCapture(e.pointerId); sync(); schedule(); return;
      }
      // 当前批注框：手柄缩放优先，其次是框内移动；Shift 开着时不抢目标选择。
      // 选择工具要走点 > 框边 > 框内部的命中优先级，那段在下面的选择分支里。
      if (tool !== 'select' && frameAdjustable() && !spaceDown && !e.shiftKey) {
        if (frameHandle || frameContainsPoint(e)) {
          if (startFrameDrag(e, frameHandle)) return;
        }
      }
      // 选择工具：手柄→缩放/端点；点、框边、框内与关系线→选中；空白→清除选中。
      // 关系线只在这个工具里接点击，画笔/遮盖/裁切不受影响；预览只读不接。
      if (tool === 'select' && !previewMode && !spaceDown && !pan) {
        const at = point(e);
        const hit = annotationHitAt(at);
        // 旧框的移动/缩放只在“确实点当前框自己的边/内部、没有多选意图、也没有更优先的别处命中”时接手。
        const multiIntent = e.shiftKey === true;
        const frameHit = frameAdjustable() && !multiIntent && (frameHandle || frameContainsPoint(e));
        if (frameHit && (!hit || sameEnd(hit.target, activeFrameEnd()))) {
          if (startFrameDrag(e, frameHandle)) return;
        }
        const handle = shapeHandleAt(e);
        if (handle) { if (!flushAll()) return; startShapeDrag(e, handle.shape, handle); return; }
        if (hit && hit.rank <= 1) { pickHitTarget(hit.target, e); return; }
        const relationId = relationAt(at);
        if (relationId) { if (!flushAll()) return; e.preventDefault(); selectRelation(relationId); return; }
        if (hit) { pickHitTarget(hit.target, e); return; }
        const shape = topShapeAt(e);
        if (shape) {
          if (!flushAll()) return;
          selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
          if (shape.id !== shapeSelected) selectShape(shape.id);
          startShapeDrag(e, shape, null);
          sync();
          return;
        }
        e.preventDefault();
        // 取消选择也要先把当前文字/关系收口：校验失败就留在原选择与原输入上。
        if (!flushAll()) return;
        selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
        if (shapeSelected) selectShape(null);
        sync();
        return;
      }
      // 画布上的新动作先收拢已开着的说明：文字就地写回、几何细节提交，绝不悄悄丢字。
      if (!flushAll()) return;
      e.preventDefault(); scroller.focus(); closeComment();
      drag = { id:e.pointerId, x:e.clientX, y:e.clientY, startedOutside: !inImage(e) };
      if (tool === 'ocr') {
        if (!ocrRecognize || ocrPending) { drag = null; status(ocrPending ? '正在提取文字，请稍候' : '当前无法使用文字识别'); return; }
        clearOcrResult();
        drag.mode = 'ocr-region'; drag.start = point(e); drag.rect = { ...drag.start, width: 0, height: 0 };
      } else if (tool !== 'browse') {
        if (cursor >= LIMIT.operations || pointCount >= LIMIT.points) { drag=null; status('笔迹达到上限，请导出后重新编辑'); return; }
        if (tool === 'crop') {
          // 8 个手柄优先，其次是框内移动；都不在就视为在框外重新拖一个新框（旧框丢弃）。
          if (cropDraft) {
            if (cropHandle) { drag.mode = 'crop-resize'; drag.handle = cropHandle; drag.origin = { ...cropDraft }; }
            else if (cropContainsPoint(e)) { drag.mode = 'crop-move'; drag.origin = { ...cropDraft }; drag.startClient = { x: e.clientX, y: e.clientY }; }
            else { drag.mode = 'crop'; drag.start = point(e); cropDraft = null; }
          } else { drag.mode = 'crop'; drag.start = point(e); }
        } else if (noteTools.has(tool)) {
          if (annotationList().length >= annotationLimits.annotations) { drag=null; status(`批注最多 ${annotationLimits.annotations} 条`); return; }
          // 开始框/点就把预览切回显示：正在拉的这个框要看得见（导出的图片本来就不画这些标记）。
          notesVisible = true;
          const start = point(e);
          if (tool === 'point') {
            // 点一下就落位成正式标记（可撤销），随即选中编辑；不等 pointerup。
            drag.mode = 'point';
            createAnnotation('point', { point: start });
          } else {
            drag.start = start;
            drag.op = { tool:'annotation', kind:'region', id:'', text:'',
              rect: { x:start.x, y:start.y, width:0, height:0 } };
          }
        } else {
          const brush = tool === 'pen' || tool === 'mosaic';
          drag.op = { tool, color:setting('color').value, width:number('width',6,1,128), diameter:number('diameter',20,4,128), grain:Math.round(number('grain',12,4,128)), fill:setting('fill').checked, points: brush && drag.startedOutside ? [] : [point(e)] };
          if (brush) { drag.brushLast = rawPoint(e); drag.brushBreak = drag.startedOutside; }
          // 只有可调形状拿 id（未填充矩形 / 线 / 箭头）；填充矩形是隐私遮盖，不进选中体系。
          if (SHAPE_TOOLS.has(tool) && (tool !== 'rect' || drag.op.fill === false)) drag.op.id = nextShapeId();
        }
      }
      scroller.setPointerCapture(e.pointerId); sync(); schedule();
    });
    function move(e) {
      // 临时平移优先：不碰 tool、不产生任何 op；只看起始那个按钮是否还按着。
      if (pan && pan.id === e.pointerId) {
        scrollByPixels(pan.x - e.clientX, pan.y - e.clientY);
        pan.x = e.clientX; pan.y = e.clientY;
        if (e.type === 'pointermove' && e.buttons !== undefined && !(e.buttons & pan.mask)) stopPan();
        return;
      }
      // 连线：预览跟手，命中另一处时高亮；不移动框、不新建点。
      if (tool === 'connect') { updateConnectMove(e); return; }
      if (!drag || drag.id !== e.pointerId) return;
      // pointerup normally reports buttons=0; its final sample must still be kept.
      if (e.type === 'pointermove' && !(e.buttons & 1)) { cancel(); return; }
      // 点的位置由按下那一刻定，不跟着指针漂（就不会因为“没拖动”而过不了闸）。
      if (drag.mode === 'point' || drag.mode === 'link-point') return;
      if (drag.mode === 'link-region' || drag.mode === 'ocr-region') {
        const p = point(e);
        drag.rect = fitRect({ x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y),
          width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y) });
        schedule(); return;
      }
      if (drag.mode === 'crop') { cropDraft = cropRectFrom(drag.start, point(e)); schedule(); return; }
      if (drag.mode === 'crop-resize' || drag.mode === 'crop-move') { updateCropDrag(e); return; }
      if (drag.mode === 'frame-move' || drag.mode === 'frame-resize') { updateFrameDrag(e); return; }
      if (drag.mode === 'shape-move' || drag.mode === 'shape-resize' || drag.mode === 'shape-endpoint') { updateShapeDrag(e); return; }
      if (!drag.op) {
        scroller.scrollLeft = Math.max(0,scroller.scrollLeft + drag.x-e.clientX);
        scroller.scrollTop = Math.max(0,scroller.scrollTop + drag.y-e.clientY);
        drag.x=e.clientX; drag.y=e.clientY; return;
      }
      const op=drag.op;
      if (op.tool === 'annotation') {
        const p = point(e);
        if (op.kind === 'point') op.point = p;
        else op.rect = fitRect({ x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y),
          width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y) });
        schedule(); return;
      }
      const coalesced = e.getCoalescedEvents?.();
      for (const event of (coalesced?.length ? [...coalesced, e] : [e])) {
        if (op.tool === 'pen' || op.tool === 'mosaic') {
          const raw = rawPoint(event), segment = clipBrushSegment(drag.brushLast, raw);
          if (segment) {
            for (let i = 0; i < segment.length; i++) {
              const p = segment[i], last = op.points[op.points.length - 1];
              const restart = i === 0 && drag.brushBreak && op.points.length > 0;
              if (last && !restart && Math.hypot(p.x - last.x, p.y - last.y) < 0.25) continue;
              if (op.points.length >= LIMIT.strokePoints || pointCount + op.points.length >= LIMIT.points) {
                cancel(); status('本笔达到点数上限，已取消；请缩短笔画'); return;
              }
              op.points.push(restart ? { ...p, move: true } : p);
            }
          }
          drag.brushLast = raw;
          drag.brushBreak = !inImage(event);
          continue;
        }
        const p=point(event), last=op.points[op.points.length-1];
        if (Math.hypot(p.x-last.x,p.y-last.y)<0.25) continue;
        if (['line','rect','arrow'].includes(op.tool)) op.points[1]=p;
        else if (op.points.length < LIMIT.strokePoints && pointCount + op.points.length < LIMIT.points) op.points.push(p);
        else { cancel(); status('本笔达到点数上限，已取消；请缩短笔画'); return; }
      }
      schedule();
    }
    scroller.addEventListener('pointermove', move);
    // 选第二处时，悬停到已有点/框上把光标改成 pointer（提示这里能点），不改任何状态。
    scroller.addEventListener('pointermove', e => {
      if (drag || pan || tool !== 'select') return;
      const at = point(e);
      if (annotationHitAt(at) || relationAt(at)) e.target && (scroller.style.cursor = 'pointer');
    });
    scroller.addEventListener('pointerup', e => {
      if (pan && pan.id === e.pointerId) { stopPan(); return; }
      // 连线手势：拖与两次点击都只在这里判定一次（按当前坐标重新命中，不看 e.target）。
      // 只由发起这次手势的主键指针完成：右键/别的指针松手不能把“等第二击”提交成线。
      if (tool === 'connect' && connect) {
        if (e.button !== 0) return;
        if (e.pointerId !== undefined && connect.pointerId !== undefined && e.pointerId !== connect.pointerId) return;
        // 图外（letterbox）松手：清暂态、不建线、不写历史，不拿贴边批注误连。
        if (!connectPointInCanvas(e)) {
          dropConnect('这里没有另一处批注，这次没有连线');
          sync(); schedule();
          return;
        }
        finishConnectGesture(e); return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      move(e); if (!drag) return;
      if (drag.mode === 'ocr-region') {
        const rect = drag.rect ? { ...drag.rect } : null;
        cancel();
        if (!rect || rect.width < 2 || rect.height < 2) { status('范围太小，请重新框选文字'); return; }
        ocrSelection = rect;
        recognizeSelectionText(); return;
      }
      if (drag.mode === 'link-point') { finishLinkPick({ kind: 'point', point: { ...drag.start } }); cancel(); return; }
      if (drag.mode === 'link-region') {
        const box = drag.rect;
        if (!box || box.width < 2 || box.height < 2) { status('框太小，请重新拖框；Esc 返回这条批注'); cancel(); return; }
        finishLinkPick({ kind: 'region', rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
        cancel(); return;
      }
      if (drag.mode === 'frame-move' || drag.mode === 'frame-resize') {
        // 松手只留草稿：几何写进暂存状态，保存批注才入历史（一次可撤销）。
        finishFrameDrag();
        drag.kept = true;
        cancel(); return;
      }
      if (drag.mode === 'crop' || drag.mode === 'crop-resize' || drag.mode === 'crop-move') {
        // 未确认就只留预览：松手只定框，尺寸和遮罩还在，等「应用裁切」或 Enter。
        const rect = cropDraft;
        if (!rect || rect.width < 1 || rect.height < 1) { cropDraft = null; status('裁切框太小，请重新拖框'); }
        else status(`裁切范围 ${rect.width} × ${rect.height} 像素 · 点「应用裁切」或 Enter 生效，Esc 取消`);
        cancel(); return;
      }
      if (drag.mode === 'shape-move' || drag.mode === 'shape-resize' || drag.mode === 'shape-endpoint') {
        // 松手一次性进历史（一次可撤销）；没改动就不落 op，选中状态保留。
        finishShapeDrag();
        drag.kept = true;
        cancel(); return;
      }
      if (drag.op) {
        if (drag.op.tool === 'annotation') {
          const box = drag.op.rect;
          if (box.width < 2 || box.height < 2) status('框太小，没有创建批注');
          else createAnnotation('region', { rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
        } else {
          const op = drag.op;
          // 留白里空拖不写历史；矩形只有与画面相交出面积才落位。
          if (!op.points.length || (op.tool === 'rect' && drag.startedOutside &&
              (op.points.length < 2 || op.points[0].x === op.points[1].x || op.points[0].y === op.points[1].y))) {
            cancel(); return;
          }
          // 零长的线/箭头松手时可能只有一个点：补成两端同坐标，否则选中后没法再拉长。
          if (SHAPE_TOOLS.has(drag.op.tool) && drag.op.points.length === 1) drag.op.points.push({ ...drag.op.points[0] });
          commitOp(drag.op);
          pointCount=ops.reduce((n,op)=>n+(op.points?.length ?? 0),0); status('');
          // 画完可调形状就自动选中并切到选择工具，抬手后直接能微调；再画要明确点绘图工具。
          // GIF 与普通截图共用同一套（同一引擎），不给动画另开一套规则。
          if (drag.op.id && SHAPE_TOOLS.has(drag.op.tool)) {
            tool = 'select';
            selectShape(drag.op.id);
            status('已选中刚画的形状 · 拖动移动、手柄缩放；Esc 取消选中，再画请点绘图工具');
          }
        }
      }
      cancel();
    });
    scroller.addEventListener('pointercancel', e => { if (pan?.id === e.pointerId) stopPan(); if (connect?.pointerId === e.pointerId) cancelConnect('这次连线取消了，原来的批注都还在'); if (drag?.id === e.pointerId) cancel(); });
    scroller.addEventListener('lostpointercapture', e => {
      if (pan?.id === e.pointerId) stopPan();
      // 第一下松手后浏览器会自动释放捕获：那时手势已经进入“等第二击”（armed），不能当成取消。
      if (connect?.pointerId === e.pointerId && connect.phase !== 'armed') cancelConnect('这次连线取消了，原来的批注都还在');
      if (drag?.id === e.pointerId) cancel();
    });
    window.addEventListener('blur', ()=>{ pointer=null; spaceDown=false; stopPan(); cancelConnect(); cancel(); });
    scroller.addEventListener('scroll', ()=>{ updateCursor(); schedule(); });
    function scale(next, x=scroller.clientWidth/2, y=scroller.clientHeight/2) {
      // 平移期间不缩放：pan 记的是屏幕起点，改 zoom 会让后续 delta 错位。
      if (pan) return;
      const o=origin(), view=currentView(), px=(x-o.x)/zoom, py=(y-o.y)/zoom;
      zoom=clampZoom(next); layout();
      const ox=Math.max(16,(scroller.clientWidth-view.width*zoom)/2);
      scroller.scrollLeft=ox-view.x*zoom+px*zoom-x; scroller.scrollTop=16-view.y*zoom+py*zoom-y; schedule();
    }
    scroller.addEventListener('wheel', e => {
      if (blocked()) { e.preventDefault(); return; }
      // 绘制/拖框/连线进行中禁轮：避免遥相连接误画。
      if (drag || connect) { e.preventDefault(); return; }
      if (!image) return;
      // 工具设置区/便签里的输入框滚动不拦。
      if (e.target?.closest?.('textarea,input,select,.ie-bubble,.ie-note-card,.ie-toolbar,.ie-view-actions')) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      const dx = (e.deltaX || 0) * unit, dy = (e.deltaY || 0) * unit;
      if (!dx && !dy) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (!dy) { scrollByPixels(dx, 0); return; }
        const r = scroller.getBoundingClientRect();
        scale(zoom * Math.exp(-dy * 0.002), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      // 普通滚轮竖向；Shift 横移；纯 deltaX（触控板横扫）也直接横移。
      if (e.shiftKey) { scrollByPixels(dx || dy, 0); return; }
      scrollByPixels(dx, dy);
    }, { passive:false });
    // 像素状态的快照：非批注 op 的数量 + 当前视窗。撤销/重做只有这两项变了才算像素真的变了。
    function pixelStamp() {
      let count = 0;
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (op && !isNonPixelOp(op.tool)) count += 1;
      }
      const view = currentView();
      return `${count}:${view.x},${view.y},${view.width},${view.height}`;
    }
    function history(delta) {
      if (previewMode) return;
      if (blocked() || drag) return;
      // 平移还活着时不改历史（也不改视窗），避免 pan 锚点错位。
      if (pan) return;
      // 还没落位的位置选择先收：只取消这次选点，不动已写的字。
      if (linkPick) { endLinkPick('已退出这次选位置'); return; }
      // 还没完成的连线手势：第一次撤销只取消手势，不越过它删前面的批注。
      if (connect) { cancelConnect('已取消这次连线，前面的批注和字都没动'); return; }
      // 文字就地写回、几何细节落成可撤销快照；超长校验失败就留在原选择上，不动历史。
      if (!flushAll()) return;
      const before = currentView(), beforeStamp = pixelStamp();
      const nextCursor=historyStep(delta);
      if (nextCursor === cursor) return;
      cursor=nextCursor;
      // 撤销/重做后重新解析当前选择：形状被撤掉/删掉就取消选中；还在就把颜色/粗细回归到恢复后的版本。
      if (shapeSelected) {
        const shape = selectedShape();
        if (!shape) shapeSelected = null;
        else syncShapeStyle(shape);
      }
      // 撤销/重做批注本身不改像素，不能把 OCR 文字连带作废。
      if (pixelStamp() !== beforeStamp) pixelRevision += 1;
      const after = currentView();
      // 撤销/重做改变了视窗（裁切）：未应用的框不再对应当前画面；马赛克缓存仍是源图坐标，不重建。
      if (before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height) {
        cropDraft = null;
        // 形状整个落到新画面之外就不留悬浮选中（保守处理，不画看不见的手柄）。
        const shape = selectedShape();
        if (shape) {
          const box = shapeBox(shape);
          const outside = box.x + box.width < after.x || box.x > after.x + after.width ||
            box.y + box.height < after.y || box.y > after.y + after.height;
          if (outside) shapeSelected = null;
        }
        clampScroll(); layout();
      }
      // 撤销/重做后清理失效引用：被撤掉/删除的批注、目标、关系都不能继续选中。
      pruneSelection();
      syncBubble();
      sync(); schedule();
    }
    root.addEventListener('input', e => {
      if (blocked()) return;
      // 说明文字：唯一来源就是这一个 textarea，输入即写回（不进历史，不拆成一串撤销步）。
      if (e.target?.classList?.contains('ie-bubble-text')) {
        if (noteId) writeNoteText(noteId, e.target.value);
        // 只排一帧重画（画布上的说明文字/关系标签），不整表 sync 重绑 textarea，免得打断输入法组合。
        schedule();
        return;
      }
      // 关系说明：同样写回当前有效关系的 create/update op，不 push 全局 update 历史。
      if (e.target?.classList?.contains('ie-relation-text')) {
        if (selectedRelationId) writeRelationText(selectedRelationId, e.target.value);
        schedule();
        return;
      }
      if (e.target?.classList?.contains('ie-comment')) return;
      // 目标文字：用户手改后就算手填（不再受 OCR 生成时的 revision 限制）。
      if (e.target?.classList?.contains('ie-target-text')) {
        const state = bubbleState();
        if (state) { state.targetText = e.target.value; state.targetTextAuto = false; state.targetTextRevision = 0; }
        return;
      }
      const detail = e.target?.dataset?.detail;
      if (detail) {
        const state = bubbleState();
        if (state && Object.prototype.hasOwnProperty.call(state.details, detail)) state.details[detail] = e.target.value;
        return;
      }
      if (e.target?.dataset?.setting === 'inset') {
        const state = bubbleState();
        if (state) state.inset = Boolean(e.target.checked);
        return;
      }
      if (e.target.dataset.range) setting(e.target.dataset.range).value=e.target.value;
      else if (e.target.dataset.setting && e.target.value!=='') {
        const range=root.querySelector(`[data-range="${e.target.dataset.setting}"]`);
        if (range) range.value=e.target.value;
      }
      syncColors();updateCursor();
    });
    root.addEventListener('change', e => {
      if (blocked()) return;
      if (e.target?.dataset?.setting === 'relation') { setRelation(e.target.value); return; }
      // 选中形状后改颜色/粗细：一条 change 一条 shape-update（可撤销），不改旧 op。
      if (e.target?.dataset?.setting === 'color' || e.target?.dataset?.setting === 'width' || e.target?.dataset?.range === 'width') {
        if (tool === 'select' && shapeSelected) {
          applySelectionStyle(e.target.dataset.setting === 'width' || e.target.dataset.range === 'width'
            ? { width: number('width', 6, 1, 128) } : { color: setting('color').value });
        }
        return;
      }
      if (e.target?.dataset?.setting === 'inset') {
        const state = bubbleState();
        if (state) state.inset = Boolean(e.target.checked);
      }
    });
    root.addEventListener('click', e => {
      const button=e.target.closest('button'); if (!button) return;
      // 分段导出期间唯一还能点的就是「停止」：只置取消标记，不改任何像素、不丢草稿。
      if (button.dataset.action === 'segments' && segmentBusy) {
        if (!segmentCanceled) {
          segmentCanceled = true;
          button.disabled = true;
          button.textContent = '正在停止…';
          status('正在停止分段导出：已经写好的图片留在目标文件夹');
        }
        return;
      }
      if (blocked()) return;
      // 预览态只读：工具切换与一切会改内容的按钮都不接（工具栏/面板已隐藏，这里再堵程序化点击）。
      if (previewMode && (button.dataset.tool || PREVIEW_BLOCKED_ACTIONS.includes(button.dataset.action))) return;
      if (animation && (noteTools.has(button.dataset.tool) || ['connect', 'ocr'].includes(button.dataset.tool))) return;
      if (button.dataset.tool) {
        const nextTool = button.dataset.tool;
        if (nextTool === 'select' && !hasSelectableContent()) return;
        // 鼠标/指针点工具后把焦点交给画布，Space 才能立即当抓手；键盘触发（detail 0）保留按钮焦点。
        const pointerClick = e.detail === undefined ? true : e.detail !== 0;
        if (pointerClick) { try { scroller.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响切工具。 */ } }
        // 平移还活着时不切工具（视图不变）。
        if (pan) return;
        // 重复点同一个工具按钮不能重置正在调整的框/缩放。
        if (nextTool === tool) return;
        // 换工具前先把写的字收拢（文字就地写回、几何细节提交），未确认的裁切也一起取消。
        if (linkPick) endLinkPick('已取消本次选位置');
        if (!flushAll()) return;
        if (cropDraft) { cropDraft = null; status('已取消未应用的裁切'); }
        closeComment(); dropConnect(); cancel(); clearOcrResult(); tool=nextTool;
        // 换走选择/连线就不留悬浮选中（回到画布也不抢焦点）；只清选中，不删标记。
        if (tool !== 'select') {
          shapeSelected = null;
          selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
        }
        // 进裁切先双维度适应整图，并把当前画面作为初始全选框（可直接拖手柄缩小）。
        if (tool === 'crop') { fitImage(); cropDraft = { ...currentView() }; }
        if (tool === 'ocr') status('拖框选中要提取的文字');
        if (tool === 'select') notesVisible = true;
        // 进连线：先点或按住一处，拖动/再点一处；取消或成功后都不悄悄回绘图模式。
        if (tool === 'connect') { notesVisible = true; status('连线：先点或按住一处批注，再点另一处或拖过去'); }
        sync(); schedule(); return;
      }
      if (button.dataset.color) {setting('color').value=button.dataset.color;syncColors();applySelectionStyle({ color: button.dataset.color });return;}
      if (animation && ['comment','save','save-as','notes-toggle','bubble-ocr'].includes(button.dataset.action)) return;
      switch(button.dataset.action) {
        case 'close': requestClose(); break;
        case 'help-toggle': {
          const help = $('.ie-help');
          const open = help ? help.hidden : false;
          if (help) help.hidden = !open;
          button.setAttribute('aria-expanded', String(open));
          break;
        }
        case 'minimize': awaitMinimize(); break;
        case 'relation-delete': {
          if (!selectedRelationId) break;
          const id = selectedRelationId;
          selectedRelationId = null;
          if (deleteRelation(id)) {
            status('已删掉这条线；两处批注和各自的说明都还在，可用撤销恢复');
            sync();
          }
          break;
        }
        case 'bubble-relation': {
          if (!flushAll()) break;
          selectRelation(button.dataset.relationId);
          break;
        }
        case 'bubble-neighbor': {
          if (!flushAll()) break;
          selectNote(button.dataset.annotationId, Number(button.dataset.targetIndex));
          break;
        }
        case 'target-select': {
          const index = Number(button.dataset.targetIndex);
          if (!noteState || !noteState.targets[index]) break;
          // 选中后直接在图上拖框内/手柄；点目标只能定位（没有可拖几何）。
          selectedTargets = [{ annotationId: noteId, targetId: noteState.targets[index].targetId }];
          selectedRelationId = null;
          frameIndex = noteState.targets[index].kind === 'region' ? index : null;
          bubbleTargetsSignature = ''; syncBubbleExtras(); sync();
          status(noteState.targets[index].kind === 'region'
            ? `已选中位置 ${targetLetter(index)} 的框：框内拖动移动，8 个手柄缩放`
            : `已选中位置 ${targetLetter(index)} 的点`);
          break;
        }
        case 'comment':
          if (!flushAll()) break;
          commentOpen = !commentOpen;
          if (commentOpen) syncComment();
          else { closeComment(); scroller.focus(); }
          break;
        case 'comment-close': closeComment(); scroller.focus(); break;
        case 'marker':
          // 正在选位置时编号不接点击（避免选到一半又跳去改别的批注）。
          if (linkPick) break;
          {
            const id = button.dataset.annotationId;
            const index = Number(button.dataset.targetIndex);
            const note = annotationList().find(item => item.id === id);
            const target = note && note.targets.find(item => item.index === index);
            if (!target) break;
            if (!flushAll()) break;
            selectTarget({ annotationId: id, targetId: target.targetId });
            if (noteState) focusBubble();
          }
          break;
        case 'bubble-delete': if (noteId) deleteAnnotation(noteId); break;
        case 'bubble-add-point': startLinkPick('point'); break;
        case 'bubble-add-region': startLinkPick('region'); break;
        case 'bubble-more-toggle': bubbleMoreOpen = !bubbleMoreOpen; syncBubbleExtras(); placeCards(); schedule(); break;
        case 'note-done': completeNote(); break;
        case 'relation-done': completeRelation(); break;
        case 'ocr-retry': recognizeSelectionText(); break;
        case 'ocr-copy': copyOcrResult(); break;
        case 'ocr-close': clearOcrResult(); sync(); schedule(); break;
        case 'target-remove': removeBubbleTarget(Number(button.dataset.targetIndex)); break;
        case 'notes-toggle': toggleNotes(); break;
        case 'segments':
          if (typeof onSegmentRequest !== 'function') { status('这个窗口不支持分段导出'); break; }
          if (!flushAll()) break;
          cancel();
          Promise.resolve(onSegmentRequest()).catch(error => status(`分段导出未完成：${error?.message || error}`));
          break;
        case 'crop-apply': applyCrop(); break;
        case 'crop-cancel': cancelCrop(); break;
        case 'shape-delete': deleteSelectedShape(); break;
        case 'undo': history(-1); break;
        case 'redo': history(1); break;
        case 'fit': if (!drag) scale(Math.min(1,(scroller.clientWidth-32)/currentView().width),16,16); break;
        case 'fit-image': if (!drag) fitImage(); break;
        case 'actual': if (!drag) scale(1); break;
        case 'zoom-in': if (!drag) scale(zoom*1.2); break;
        case 'zoom-out': if (!drag) scale(zoom/1.2); break;
        case 'save': case 'save-as': case 'copy':
          // 保存并复制 = 存到设好的文件夹并复制同一张成图；另存并复制 = 弹出保存位置并复制；复制 = 只把成图放进剪贴板。
          cancel();
          Promise.resolve().then(() => onCommit(button.dataset.action === 'save' ? 'save-quick'
            : button.dataset.action === 'save-as' ? 'save' : 'copy')).catch(error=>status(error.message || error));
          break;
      }
    });
    // 输入框/按钮/工具条焦点优先：这些地方的键盘操作不被画布快捷捷走。
    function interactiveTarget(e) {
      const target = e.target;
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest('input,textarea,select,button,[contenteditable="true"],.ie-toolbar'));
    }
    // 关系下拉：气泡里唯一的原生 select（base-select 弹层）。命中就返回那个节点，其他控件不受影响。
    function relationSelectOf(target) {
      if (!target || typeof target.closest !== 'function' || !root.contains(target)) return null;
      return target.closest('select[data-setting="relation"]');
    }
    function selectMenuOpen(select) {
      try { return Boolean(select.matches(':open')); } catch { return false; }
    }
    // Capture at window before document-level selection shortcuts. Enter retains native button activation.
    window.addEventListener('keydown', e => {
      if (!opened) return;
      if (animation && !root.contains(e.target)) return;
      // 关系下拉的键盘全归原生 select：方向/Home/End/Enter/空格 用来选值，弹层打开时 Esc/Tab 先由浏览器收菜单。
      // 只挡下游画布快捷键、不 preventDefault，保留原生选择与默认动作；关闭状态下的 Esc/Tab 仍走下面的旧语义。
      const relationSelect = relationSelectOf(e.target);
      if (relationSelect) {
        if (e.isComposing || e.keyCode === 229) { e.stopImmediatePropagation(); return; }
        const pickKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '];
        const menuKeys = selectMenuOpen(relationSelect) ? ['Escape', 'Tab'] : [];
        if (pickKeys.includes(e.key) || e.code === 'Space' || menuKeys.includes(e.key)) { e.stopImmediatePropagation(); return; }
      }
      // 关系说明输入：Enter 离开输入框（已经同步写回）、Esc 也只离开；都不删关系。
      const relationInput = Boolean(e.target && typeof e.target.classList?.contains === 'function' && e.target.classList.contains('ie-relation-text'));
      if (relationInput) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!blocked() && flushRelation()) scroller.focus();
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopImmediatePropagation();
          // 一次 Esc 就收起这条线的便签：先收口，超限时原字、原选择与焦点都留在原处。
          if (!blocked() && flushRelation()) { clearSelection(); scroller.focus(); }
        }
        return;
      }
      // 正在选位置：Esc 只取消这一次选点/框选，回到同一条说明（不改任何已写文字）。
      if (linkPick && e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!blocked()) endLinkPick('已取消本次选位置，回到这条说明');
        return;
      }
      // 连线手势：Esc 只取消这次手势，不入历史、不删任何批注。
      if (connect && e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!blocked()) cancelConnect('已取消这次连线，原来的批注都还在');
        return;
      }
      // 文本输入优先：Enter/空格/方向键/输入法/Ctrl+Z 都归输入框，画布快捷键不抢。
      const typing = e.target && root.contains(e.target) && e.target.closest && e.target.closest('textarea');
      if (typing) {
        // 输入法组合中的按键全部留给输入框：Enter 是上屏，Esc 是取消候选。
        if (e.isComposing || e.keyCode === 229) return;
        const inBubble = Boolean(e.target.classList?.contains('ie-bubble-text'));
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (blocked()) return;
          // 退出文字编辑不等于删除：收口后只放下选中，标记和文字都还在。
          if (inBubble) { if (flushNote()) clearSelection(); } else closeComment();
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (blocked()) return;
          if (inBubble) { if (flushNote()) scroller.focus(); } else closeComment();
          return;
        }
        return;
      }
      // Space 临时抓手：画布目标先拦下原生翻页，再看当前状态否可用；已开始画不转平移。
      // 选位置时也允许 Space/中键临时平移（不会误加位置）。
      if ((e.key === ' ' || e.code === 'Space') && !interactiveTarget(e)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (blocked() || !image || drag || commentOpen || ((noteState || selectedRelationId) && !linkPick)) return;
        if (!spaceDown) spaceDown = true;
        updateCursor();
        return;
      }
      // 裁切框方向键：1px，Shift 10px；不越出当前画面。输入/按钮/工具条焦点优先，不抢。
      if (!interactiveTarget(e) && tool === 'crop' && cropDraft && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (blocked() || drag) return;
        const step = e.shiftKey ? 10 : 1, view = currentView();
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const x = Math.max(view.x, Math.min(view.x + view.width - cropDraft.width, cropDraft.x + dx));
        const y = Math.max(view.y, Math.min(view.y + view.height - cropDraft.height, cropDraft.y + dy));
        cropDraft = { ...cropDraft, x, y };
        status(`裁切框 ${cropDraft.width} × ${cropDraft.height} · 位置 (${x}, ${y})`);
        sync(); schedule(); return;
      }
      if (!interactiveTarget(e) && (drag || blocked() || noteState || selectedRelationId || commentOpen) && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (blocked()) return;
        // 预览态没有草稿可取消：Esc 直接向宿主申请退出（图仍留在屏上等确认）。
        if (previewMode) { requestExitFromHost(); return; }
        if (tool === 'ocr') { cancel(); clearOcrResult(); tool = 'browse'; sync(); schedule(); status('已退出文字提取'); return; }
        // 正在连线：只收这一次手势，不动已标的批注。
        if (connect) { cancelConnect('已取消这次连线，原来的批注都还在'); return; }
        // 正在选位置：只收这一次选点，不动已写的字。
        if (linkPick) { endLinkPick('已取消本次选位置'); return; }
        // 形状调整中：先回原几何；已经选中的：再取消选中；都不会退出页面。
        if (drag?.mode === 'shape-move' || drag?.mode === 'shape-resize' || drag?.mode === 'shape-endpoint') {
          cancel(); status('已取消这次调整'); return;
        }
        if (shapeSelected && tool === 'select') { selectShape(null); status('已取消选中'); return; }
        // 正在拖框：Esc 只中断这次调整，几何退回拖动前，说明与文字都留着。
        if (drag?.mode === 'frame-move' || drag?.mode === 'frame-resize') {
          cancel();
          status('已取消这次框调整，几何回到拖动前');
          return;
        }
        // 帮助开着时 Esc 先收帮助。
        const help = $('.ie-help');
        if (help && !help.hidden) {
          help.hidden = true;
          const toggle = $('[data-action="help-toggle"]');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
          return;
        }
        // 退出说明编辑：先收口文字/几何，再放下选中；标记与文字都不删。
        if (noteState || selectedRelationId || selectedTargets.length) {
          if (flushAll()) { clearSelection(); status('已退出说明编辑（标记和文字都保留，要删请用删除/移除）'); }
          return;
        }
        if (commentOpen) { closeComment(); scroller.focus(); return; }
        if (cropDraft || drag?.mode === 'crop' || drag?.mode === 'crop-resize' || drag?.mode === 'crop-move') { cancelCrop('已取消未应用的裁切'); return; }
        requestClose();
        return;
      }
      // 选中形状后 Delete/Backspace 删：只认画布焦点，输入框/输入法/忙碌/预览一概不抢。
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (previewMode || blocked() || e.isComposing || e.keyCode === 229) return;
        if (document.activeElement !== scroller || interactiveTarget(e)) return;
        if (!shapeSelected || tool !== 'select') return;
        e.preventDefault(); e.stopImmediatePropagation();
        deleteSelectedShape();
        return;
      }
      // 裁切：Enter 应用（焦点在按钮上时保留按钮自己的 Enter 行为）。
      if (e.key === 'Enter' && !interactiveTarget(e) && tool === 'crop' && cropDraft) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!blocked()) applyCrop();
        return;
      }
      if (e.key === 'Enter') {
        const button=e.target.closest?.('button');
        if (button && root.contains(button) && !button.disabled && !blocked()) return;
        e.stopImmediatePropagation(); e.preventDefault(); return;
      }
      if (e.key === 'Tab') {
        const focusRoot=animation ? (root.parentElement || root) : root;
        const focusable=[...focusRoot.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);
        const i=focusable.indexOf(document.activeElement), next=e.shiftKey ? (i<=0 ? focusable.length-1 : i-1) : (i+1)%focusable.length;
        e.preventDefault(); e.stopImmediatePropagation(); (focusable[next] || root).focus(); return;
      }
      if ((e.ctrlKey || e.metaKey) && ['z','y'].includes(e.key.toLowerCase())) {
        if (previewMode) return;
        e.preventDefault(); e.stopImmediatePropagation(); history(e.key.toLowerCase()==='y' || e.shiftKey ? 1 : -1);
      }
    },true);
    // Space 松开只清位键状态，不结束已在进行的平移：平移要等指针松开才完成。
    window.addEventListener('keyup', e => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      if (!spaceDown) return;
      spaceDown = false;
      updateCursor();
    }, true);
    // Do not let selection's drawing handlers see editor gestures.
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel','click','dblclick','contextmenu','wheel','keydown','keyup','keypress']) root.addEventListener(type,e=> { e.stopPropagation(); if(type==='contextmenu') e.preventDefault(); });
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      if (opened && !resizeFrame) resizeFrame=requestAnimationFrame(() => { resizeFrame=0; if (opened) layout(); });
    }); resize.observe(scroller);
    function release() {
      spaceDown=false; previewMode=false; root.classList.remove('ie-preview');
      shapeSelected=null; shapeSeq=0;
      if (pan) stopPan();
      for (const value of mosaics.values()) value.width=value.height=0;
      mosaics.clear(); image?.close(); image=null; token=undefined; width=height=0; ops=[]; cursor=pointCount=0; warning();
      display.width=display.height=0; savedScroll=[0,0];pointer=null;brushCursor.hidden=true;
      // 新 token / reset：批注、选中态、总体意见和便签一起清空（同 token 重开不清）。
      annotationSeq=0; linkPick=null; connect=null; ocrPending=false; ocrToken+=1; pixelRevision+=1;
      clearOcrResult();
      selectedTargets=[]; selectedRelationId=null; noteId=null; noteState=null; bubbleKey=''; frameIndex=null;
      closeComment(); notesVisible=true; cropDraft=null;
      // 换图：旧便签的位置与内容一起收起，不把上一张的说明带到新图上。
      for (const selector of ['.ie-relation-bubble', '.ie-comment-bubble']) {
        const node = $(selector); if (node) node.hidden = true;
      }
      const relationTextField = $('.ie-relation-text'); if (relationTextField) relationTextField.value = '';
      const relationsBox = $('.ie-bubble-relations'); if (relationsBox) { relationsBox.textContent = ''; relationsBox.dataset.signature = ''; }
      // 换文档：旧图的在途分段画布当场作废，不给下一张图留下旧产物。
      discardSegmentSession();
      const comment=commentField(); if (comment) comment.value='';
      const layer=$('.ie-marker-layer'); if (layer) { layer.textContent=''; layer.hidden=false; }
      markerFigures.clear(); markerSignatureValue=''; bubbleTargetsSignature=''; bubbleMoreOpen=false;
      const targetsBox=$('.ie-bubble-targets'); if (targetsBox) targetsBox.textContent='';
      renderMarkers();
    }
    // 导出统一走这一条：只从当前 compose 画布取图（含所有可见马赛克/纯色/笔迹，不含批注标记），
    // 绝不回交原始 dataUrl 或位图。保存、复制、缩略图的像素源完全相同。
    async function encodePng() {
      const canvas=document.createElement('canvas'), request=epoch, view=currentView();
      try {
        canvas.width=view.width; canvas.height=view.height; const ctx=canvas.getContext('2d'); if (!ctx) throw new Error('无法分配导出画布');
        compose(ctx);
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error('PNG 编码失败')),'image/png'));
        const bytes=new Uint8Array(await blob.arrayBuffer());
        if(request!==epoch) throw new Error('导出已取消');
        return bytes;
      } finally { canvas.width=canvas.height=0; }
    }
    // —— 批注说明拼装：目标、关系、目标文字和可选细节都按明确标签并进这一条的说明文字 ——
    // 交出去的仍是 {id, kind, point|rect, text} 这一层；2000 字上限不放宽，超限明确报错，不截字。
    function flattenNoteText(note, revision) {
      const extras = [];
      // 源记录有多个目标时保留目标身份；被裁掉的目标单独提示。
      if (note.targetCount > 1 || note.targets.length > 1 || note.mainDead) {
        // 只说身份与状态，不回显坐标：意见1A、意见1B 这种编号已经能对应到图上的标记。
        const missing = missingTargetLabels(note);
        if (missing.length) extras.push(`[提示] ${missing.join('、')} 已裁掉，没有画在图上；涉及它的关系需重新确认`);
        if (note.targets.length > 1) {
          const relation = normalizeRelation(note.relation);
          const labels = noteIdentityLabels(note);
          // 通用连线不写语义：用户写「这块放到这边」还是「两处一样」由文字自己说，
          // 这里只补身份，不替用户把一根指向线解释成移动/参考/同意见。
          if (note.linked && relation === 'same') { /* 只留身份，不写语义 */ }
          else extras.push(note.targets.length !== 2 || relation === 'same' ? `[关系] ${labels.join('、')} 是同一条意见`
            : relation === 'move' ? `[关系] 从${labels[0]}移到${labels[1]}` : `[关系] 修改${labels[0]}，参考${labels[1]}（${labels[1]}不动）`);
        }
      }
      if (note.mainDead) extras.push('[提示] 主目标不在当前画面：目标文字与局部放大已略过');
      else if (note.targetText) {
        // OCR 自动生成的文字绑定生成时的像素 revision：之后图像改过就不再导出这段旧文字。
        if (note.targetTextAuto && note.targetTextRevision !== revision) extras.push('[提示] 目标文字来自较早的图像状态，已略过');
        else extras.push(`[目标文字] ${note.targetText}`);
      }
      for (const [key, label] of DETAIL_KEYS) {
        const value = note.details?.[key];
        if (typeof value === 'string' && value.trim()) extras.push(`[${label}] ${value}`);
      }
      const body = typeof note.text === 'string' ? note.text : '';
      const text = body ? (extras.length ? `${body}\n${extras.join('\n')}` : body) : extras.join('\n');
      const count = Array.from(text).length;
      if (count > annotationLimits.text) {
        throw new Error(`第 ${note.number} 条批注连同目标/说明共 ${count} 字，超过 ${annotationLimits.text} 字上限；请精简后重试`);
      }
      return text;
    }
    // 复制成图会把已提交的批注标记（框、编号、连线）画在主图上，批注文字、关系语义与提示归入下方说明区。
    // 完成度与格式化文本分开判：flattenNoteText 里的 [关系]/[提示] 是自动元数据，不算正文。
    function noteHasBody(note) {
      if (typeof note.text === 'string' && note.text.trim()) return true;
      const details = note.details || {};
      return DETAIL_KEYS.some(([key]) => String(details[key] || '').trim());
    }
    const targetKeyOf = (noteId, targetId) => `${noteId}:${targetId}`;
    function completeTextRelations() {
      return relationList().filter(relation => relation.complete && relation.text.trim());
    }
    function coveredTargetKeys() {
      const keys = new Set();
      for (const relation of completeTextRelations()) {
        for (const end of [relation.a, relation.b]) if (end) keys.add(targetKeyOf(end.annotationId, end.targetId));
      }
      return keys;
    }
    function prepareNotes(notes, revision) {
      const relations = relationList();
      const emptyRelations = relations.map((relation, index) => ({ relation, number: index + 1 }))
        .filter(item => !item.relation.text.trim());
      if (emptyRelations.length) {
        throw new Error(`关系 ${emptyRelations.map(item => `关系${item.number}`).join('、')} 还没写共同说明：成品不能带空关系，写完或撤销它`);
      }
      const incomplete = relations.map((relation, index) => ({ relation, number: index + 1 }))
        .filter(item => !item.relation.complete);
      const covered = coveredTargetKeys();
      const missing = [];
      for (const note of notes) {
        // 有真实正文或有效 details：这一条的所有目标就算说明过（旧“多处同意见”语义保留）。
        if (noteHasBody(note)) continue;
        for (const target of (note.targets || [])) {
          if (covered.has(targetKeyOf(note.id, target.targetId))) continue;
          missing.push(`第 ${note.number} 条的${target.kind === 'point' ? '点' : '框'}`);
        }
      }
      if (missing.length) {
        const extra = incomplete.length
          ? `（${incomplete.map(item => `关系${item.number}`).join('、')} 的另一端不在当前画面，不能当作已说明）`
          : '';
        throw new Error(`这些位置既没正文、也没被有效关系覆盖：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ` 等 ${missing.length} 处` : ''}${extra}；补一句或让两端共同的关系说清后再导出`);
      }
      return notes.map(note => {
        const body = flattenNoteText(note, revision);
        if (String(body || '').trim()) {
          return { id: note.id, kind: note.kind,
            ...(note.kind === 'point' ? { point: note.point } : { rect: note.rect }), text: body };
        }
        const covering = relationsCoveringTargets(note.id, (note.targets || []).map(target => target.targetId));
        return { id: note.id, kind: note.kind,
          ...(note.kind === 'point' ? { point: note.point } : { rect: note.rect }),
          text: `［说明］这处没单独写，见 ${covering.map(number => `关系${number}`).join('、')}` };
      });
    }
    // 逐目标算覆盖：只有两端都在、文字非空的关系，才算覆盖它实际连到的那一个目标。
    function relationsCoveringTargets(noteId, targetIds) {
      const ids = new Set((targetIds || []).filter(Boolean));
      if (!ids.size) return [];
      return relationList().map((relation, index) => ({ relation, number: index + 1 }))
        .filter(({ relation }) => relation.complete && relation.text.trim()
          && [relation.a, relation.b].some(end => end && end.annotationId === noteId && ids.has(end.targetId)))
        .map(({ number }) => number);
    }
    // 完全覆盖：这一条每个可见目标都被“两端有效、文字非空”的关系连到。
    // —— 局部放大（只放在复制图下方）：源像素只取 compose 之后的当前画面 ——
    // 固定 2×：以前按 480×240 面板适配，宽一点的框只剩 0.82×，写着「放大」实际在缩小。
    // 放不下的情况由复制画布加宽（并在 clipboardSize 里声明 insetWidth）承担，不降倍率、不裁内容。
    const INSET_PANEL = Object.freeze({ scale: 2, pointWidth: 96, pointHeight: 64, gap: 16 });
    function insetSpecs(notes, view) {
      const specs = [];
      for (const note of notes) {
        // 局部放大绑定主目标 A：A 被裁掉就略过，不拿 B 冒充。
        if (!note.inset || note.mainDead) continue;
        const main = note.targets.find(target => target.index === 0);
        if (!main) continue;
        let source;
        if (main.kind === 'region') source = { ...main.rect };
        else {
          const width = Math.min(INSET_PANEL.pointWidth, view.width), height = Math.min(INSET_PANEL.pointHeight, view.height);
          source = { width, height,
            x: Math.max(0, Math.min(view.width - width, main.point.x - width / 2)),
            y: Math.max(0, Math.min(view.height - height, main.point.y - height / 2)) };
        }
        if (!(source.width >= 1 && source.height >= 1)) continue;
        const drawWidth = Math.max(1, Math.round(source.width * INSET_PANEL.scale));
        const drawHeight = Math.max(1, Math.round(source.height * INSET_PANEL.scale));
        // 小数 ROI 像素取整后可能不是整 2×：标签按实际倍率说话，不假称 2×。
        const exact = drawWidth === source.width * INSET_PANEL.scale && drawHeight === source.height * INSET_PANEL.scale;
        specs.push({ note, source,
          label: `局部放大 · ${noteTargetLabel(note, main)} · 放大 ${exact ? '' : '约 '}${INSET_PANEL.scale}×`,
          drawWidth, drawHeight });
      }
      return specs;
    }
    // —— OCR：只在用户点「识别目标文字（A）」时，把目标 A 的局部图（compose 之后、已含遮盖）交给宿主 ——
    // 不自己抓屏、不联网、不落盘；临时 PNG 用完即弃，不回传原始位图或 dataUrl。
    const OCR_LIMIT = Object.freeze({ edge: 2048, pixels: 4000000, bytes: 8 * 1024 * 1024 });
    function clearOcrResult() {
      ocrToken += 1; ocrSelection = null; ocrResultRevision = null; ocrCopying = false;
      $('.ie-ocr-result').value = ''; $('.ie-ocr-status').textContent = '';
      $('.ie-ocr-panel').hidden = true;
    }
    function syncOcrResult() {
      const field = $('.ie-ocr-result');
      $('.ie-ocr-panel').hidden = !ocrSelection || tool !== 'ocr' || previewMode || animation || !image;
      const busy = blocked() || Boolean(ocrPending) || ocrCopying;
      $('[data-tool="ocr"]').disabled = blocked() || previewMode || animation || !image || !ocrRecognize;
      field.disabled = busy;
      $('[data-action="ocr-copy"]').disabled = busy || !ocrCopy || !field.value.trim() || ocrResultRevision !== pixelRevision;
      $('[data-action="ocr-retry"]').disabled = busy || !ocrSelection || !ocrRecognize;
      if (ocrResultRevision !== null && ocrResultRevision !== pixelRevision) $('.ie-ocr-status').textContent = '图片已改变，请重新识别';
    }
    $('.ie-ocr-result').addEventListener('input', syncOcrResult);
    async function copyOcrResult() {
      const text = $('.ie-ocr-result').value;
      if (!ocrCopy || blocked() || ocrPending || ocrCopying || tool !== 'ocr' || previewMode || animation ||
          ocrResultRevision !== pixelRevision || !text.trim()) return;
      const request = ocrToken, revision = pixelRevision, documentEpoch = epoch;
      ocrCopying = true; syncOcrResult();
      const current = () => request === ocrToken && revision === pixelRevision && documentEpoch === epoch && tool === 'ocr' && !previewMode;
      try {
        await ocrCopy({ token, text });
        if (current()) { $('.ie-ocr-status').textContent = '已复制文字'; status('已复制提取的文字'); }
      } catch (error) {
        if (current()) { $('.ie-ocr-status').textContent = `复制失败：${error?.message || error}`; status('文字复制失败，结果仍保留，可重试'); }
      } finally { if (current()) { ocrCopying = false; syncOcrResult(); } }
    }
    function ocrRegion() {
      const view = currentView(), rect = ocrSelection && clipRegion(ocrSelection, view);
      return rect ? { x: rect.x - view.x, y: rect.y - view.y, width: rect.width, height: rect.height } : null;
    }
    async function recognizeSelectionText() {
      if (!ocrRecognize || ocrPending || blocked() || !image || tool !== 'ocr' || previewMode || animation) return;
      const region = ocrRegion();
      if (!region) { status('请先拖框选中要提取的文字'); return; }
      const request = ++ocrToken, documentEpoch = epoch, revision = pixelRevision;
      const stale = () => request !== ocrToken || documentEpoch !== epoch || revision !== pixelRevision || tool !== 'ocr' || previewMode || animation;
      ocrPending = request; ocrResultRevision = null;
      $('.ie-ocr-result').value = ''; $('.ie-ocr-status').textContent = '正在提取文字…';
      status('正在提取框选区域的文字…'); syncOcrResult();
      let source = null, crop = null;
      try {
        source = document.createElement('canvas');
        source.width = currentView().width; source.height = currentView().height;
        const sourceContext = source.getContext('2d');
        if (!sourceContext) throw new Error('无法分配识别画布');
        compose(sourceContext);
        // 先把局部缩到识别上限：最长边 ≤2048、总计 ≤400 万像素；PNG 还有 8 MiB 上限。
        const scale = Math.min(1, OCR_LIMIT.edge / Math.max(region.width, region.height),
          Math.sqrt(OCR_LIMIT.pixels / (region.width * region.height)));
        crop = document.createElement('canvas');
        // 抵消缩放投影的浮点误差，避免整像素范围误缩一行或一列。
        crop.width = Math.max(1, Math.floor(region.width * scale + 1e-8));
        crop.height = Math.max(1, Math.floor(region.height * scale + 1e-8));
        const cropContext = crop.getContext('2d');
        if (!cropContext) throw new Error('无法分配识别画布');
        cropContext.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
        const size = { width: crop.width, height: crop.height };
        const blob = await new Promise((resolve, reject) => crop.toBlob(value => value ? resolve(value) : reject(new Error('识别图编码失败')), 'image/png'));
        const png = new Uint8Array(await blob.arrayBuffer());
        if (png.byteLength > OCR_LIMIT.bytes) throw new Error('识别用的局部图超过 8 MiB，请缩小范围');
        if (stale()) return;
        const result = await ocrRecognize({ token, png, width: size.width, height: size.height });
        // 只接受仍属于当前文档、区域与像素状态的识别结果。
        if (stale()) return;
        const text = typeof result?.text === 'string' ? result.text : '';
        $('.ie-ocr-result').value = text;
        ocrResultRevision = pixelRevision;
        $('.ie-ocr-status').textContent = text.trim() ? '可核对、修改后复制' : '没有识别到文字，请重新框选或重试';
        status(text.trim() ? '文字已提取，核对后可复制' : '没有识别到文字，请重新框选');
      } catch (error) {
        // 过期任务的错误不写入当前编辑器的状态栏。
        if (!stale()) { $('.ie-ocr-status').textContent = `识别失败：${error?.message || error}`; status(`文字识别失败：${error?.message || error}；可以重新框选或重试`); }
      } finally {
        if (source) source.width = source.height = 0;
        if (crop) crop.width = crop.height = 0;
        if (ocrPending === request) { ocrPending = false; syncOcrResult(); }
      }
    }
    // —— 复制说明区 ——
    // 批注不能只复制编号：有批注或总体说明时，把「编号 → 原始坐标 + 全文」画在图片下方，
    // 粘到任何对话里都能直接读懂。上方图片仍是不带悬浮标记的编辑图（保留遮盖与笔迹）；
    // 没批注就仍是原尺寸成图，不额外分配画布。
    // 说明区基准尺寸。所有数值以 1568 宽的图为准：平台的图片入站上限就是长边 1568，
    // 再大的图会被缩到那个尺寸，所以“在 1568 宽下看得清”才是真的看得清。
    const NOTE_BASE = Object.freeze({ minWidth: 720, gap: 24, margin: 20, bodyMax: 1200, lineHeight: 30, itemGap: 8, fontSize: 20 });
    // 4K 截图上 20px 的字压缩到 1568 只剩 8px，谁都读不出来；字号必须跟着图宽走。
    // 1568 宽以下维持原样（本来就没被压），图越宽字越大，保证压缩后仍有 20px 的观感。
    function notePanelFor(width) {
      const scale = Math.max(1, (Number(width) || 0) / 1568);
      const fontSize = Math.round(NOTE_BASE.fontSize * scale);
      return {
        minWidth: NOTE_BASE.minWidth,
        gap: Math.round(NOTE_BASE.gap * scale),
        margin: Math.round(NOTE_BASE.margin * scale),
        bodyMax: Math.round(NOTE_BASE.bodyMax * scale),
        lineHeight: Math.round(fontSize * 1.5),
        itemGap: Math.round(NOTE_BASE.itemGap * scale),
        fontSize,
        font: `${fontSize}px 'Microsoft YaHei UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif`
      };
    }
    function noteRows(notes, sources, commentText, view, panel = NOTE_BASE, relationLines = []) {
      // 说明区只说给人听的话：编号 + 原文。图像尺寸、坐标原点与 xywh 协议头都不再输出。
      const rows = [{ text: '【截图批注说明】', gap: 0 },
        { text: '图上的编号与下面的意见编号一一对应；每条意见后面就是它的原文。', gap: 0 }];
      notes.forEach((note, index) => {
        const source = sources[index];
        const prefix = source ? noteIdentityLabels(source).join('、') || `意见${note.number}` : `意见${note.number}`;
        rows.push({ text: `${prefix}：${note.text}`, gap: panel.itemGap });
      });
      // 独立关系：两端都用意见编号 + 原关系全文；缺一端就明说“未画线”，不假装完整。
      for (const line of relationLines) rows.push({ text: line, gap: panel.itemGap });
      if (commentText.trim()) rows.push({ text: `总体说明：${commentText}`, gap: panel.itemGap });
      return rows;
    }
    // 只按字宽折行：原文的空格/换行/超长单字都原样保留，不 trim、不截断、不改坐标。
    function wrapLines(ctx, text, maxWidth) {
      const out = [];
      for (const paragraph of String(text).split(/\r\n|\r|\n/)) {
        let line = '';
        for (const char of paragraph) {
          if (line && ctx.measureText(line + char).width > maxWidth) { out.push(line); line = char; }
          else line += char;
        }
        out.push(line);
      }
      return out;
    }
    // 先量后画：行位置和最终高度全在分配大画布之前算定（高度超限就在这里失败，不缩放、不截断）。
    function notesLayout(ctx, rows, bodyWidth, top, panel = NOTE_BASE) {
      const lines = [];
      let y = top + panel.gap;
      for (const row of rows) {
        y += row.gap;
        for (const text of wrapLines(ctx, row.text, bodyWidth)) { lines.push({ text, y }); y += panel.lineHeight; }
      }
      return { lines, height: Math.ceil(y + panel.margin) };
    }
    function requestClose() {
      // 宿主提供了“回同窗预览”的入口就先回预览（长截图结果页）；否则保持原收起/关窗语义。
      if (previewHostRequest) {
        try { Promise.resolve(previewHostRequest()).catch(error => status(error?.message || error)); }
        catch (error) { status(error?.message || error); }
        return;
      }
      api.close();
    }
    function requestExitFromHost() {
      if (!exitHostRequest) return;
      try { Promise.resolve(exitHostRequest()).catch(error => status(error?.message || error)); }
      catch (error) { status(error?.message || error); }
    }
    // 只读预览开关：进入时先把开着的气泡按保存处理、丢掉未应用的裁切，与「返回预览」同语义，不静默丢字。
    // 退出预览只恢复工具栏，图像、历史、草稿一概不动。返回切换后的实际状态。
    function setPreviewMode(value) {
      const on = Boolean(value);
      if (previewMode === on) return previewMode;
      if (on) {
        if (blocked() || !image || drag) return previewMode;
        linkPick = null; dropConnect(); ocrPending = false; ocrToken += 1;
        if (!flushAll()) { syncBubble(); return previewMode; }
        if (commentOpen) closeComment();
        if (cropDraft) { cropDraft = null; status('已取消未应用的裁切'); }
        spaceDown = false; stopPan(); clearOcrResult(); tool = 'browse';
        // 预览只读：不留形状选中，也不留说明/连线编辑态。
        shapeSelected = null;
        selectedTargets = []; selectedRelationId = null; noteId = null; noteState = null; frameIndex = null;
        syncBubble();
      }
      previewMode = on;
      root.classList.toggle('ie-preview', on);
      root.setAttribute('aria-label', on ? '截图预览' : '图片编辑');
      layout(); sync();
      return previewMode;
    }
    // 释放分段导出的整张画布：成功、取消、换图都走这里，不把一个 32M 像素的画布留到下一次。
    function discardSegmentSession() {
      const session=segmentSession; segmentSession=null;
      if (session && session.canvas) session.canvas.width=session.canvas.height=0;
    }
    // —— 导出的批注标记：主图上直接画出已提交的框、点、编号与连线 ——
    // 尺寸只看画面大小，不看当前缩放：换个缩放再导出，标记一样粗、一样大。
    // 只画已提交的批注（正式记录）：草稿、选中态、预览开关都不影响成图。
    function exportMarkerStyle() {
      const radius = markerRadius();
      return { radius, ring: noteRingRadius(), width: Math.max(2, Math.round(radius / 6)) };
    }
    function drawExportMarkers(ctx, view) {
      const notes = annotationList();
      if (!notes.length) return;
      // 有标记但没有共享绘制组件时明确失败；只有总体说明时无需绘制标记。
      if (!visuals) throw new Error('批注标记组件未加载，不能导出带标记的成图');
      const style = exportMarkerStyle();
      const bounds = { x: view.x, y: view.y, width: view.width, height: view.height };
      ctx.save();
      try {
        // 源坐标 → 成图坐标：视窗原点搬到 (0,0)，与 compose 的导出分支同一套平移。
        ctx.translate(-view.x, -view.y);
        for (const note of notes) {
          const multi = noteIsMulti(note);
          for (const target of note.targets) {
            const color = visuals.boxColor(note.relation, target.index);
            const seed = `${note.id}:${target.index}`;
            if (target.kind === 'region') visuals.strokeNoteBox(ctx, target.rect, { width: style.width, color, seed });
            else visuals.strokeNoteDot(ctx, target.point, style.ring, { width: style.width, color, seed });
            // 编号与说明区里的意见编号一致：多目标带字母（1A / 1B）。
            const label = multi ? `${note.number}${target.letter}` : String(note.number);
            const anchor = target.kind === 'region' ? { x: target.rect.x, y: target.rect.y } : target.point;
            const spot = visuals.badgeSpot(anchor, style.radius, bounds);
            visuals.drawBadge(ctx, label, spot, { radius: style.radius });
          }
          // 同一条意见内部的指向线：缺主目标就不画，不拿剩下的目标冒充。
          if (visuals.relationReady(note)) {
            const curve = visuals.relationCurve(note);
            if (curve) visuals.strokeRelationLine(ctx, curve, { width: style.width, color: visuals.PALETTE.inkDeep });
          } else if (visuals.linkReady(note)) {
            for (const curve of visuals.linkCurves(note)) visuals.strokeRelationLine(ctx, curve, { width: style.width, color: visuals.PALETTE.inkDeep });
          }
        }
        // 独立关系（两处有关）：两端都在才画线；缺端不画，文字提示留在说明区。
        for (const relation of relationList()) {
          drawRelationLines(ctx, relation, { width: style.width, labelWidth: style.width,
            fontSize: Math.max(12, Math.round(style.radius * 0.9)) });
        }
      } finally {
        ctx.restore();
      }
    }
    // 复制成图 / 分段导出共用的排版：白底 + 当前画面（含所有遮盖/笔迹）+ 批注标记 + 说明区 + 局部放大。
    // 批注框、编号与连线只在编辑器预览里用 DOM 画；成图里由 drawExportMarkers 用同一套几何画一次。
    // 没有批注也没有总体说明时返回 null（此时“复制成图”就是当前画面本身）。
    // 像素只从同一条 compose 来，绝不回取原始位图；不缩放主图、不截说明、不丢意见。
    function buildCopyCanvas() {
      const view=currentView();
      const currentNotes=projectedNotes(annotationList(), view), currentComment=commentField()?.value ?? '';
      if (!currentNotes.length && !currentComment.trim()) return null;
      // 说明区尺寸跟着这张图的宽度走：图被平台缩到 1568 后，说明文字仍然看得清。
      const NOTE_PANEL=notePanelFor(view.width);
      const model=window.Annotations;
      if (!model) throw new Error('批注模型未加载');
      // 目标/目标文字/模板先按明确标签拼进 text 再过 prepare：交给说明区的仍是这一层结构。
      const prepared=model.prepare({ width:view.width, height:view.height, annotations:prepareNotes(currentNotes, pixelRevision), comment:currentComment });
      const notes=prepared.annotations, commentText=prepared.comment;
      // 关系条目进说明区：两端都用意见编号（与图上的编号一致），缺一端就写明未画线。
      const relationLines = relationList().map((relation, index) => {
        const label = end => {
          if (!end) return '（另一端不在当前画面，未画线）';
          const note = currentNotes.find(item => item.id === end.annotationId);
          const target = note && (note.targets || []).find(item => item.targetId === end.targetId);
          if (!note || !target) return '（另一端不在当前画面，未画线）';
          return noteTargetLabel(note, target);
        };
        return `关系${index + 1}（两处有关）：${label(relation.a)} ↔ ${label(relation.b)}：${relation.text || '（还没写关系说明）'}`;
      });
      // 先算局部放大：它们决定画布要不要更宽（固定 2×，不降倍率）。
      const insets=insetSpecs(currentNotes, view);
      const insetWidth=insets.reduce((widest, spec) => Math.max(widest, spec.drawWidth), 0);
      const baseWidth=Math.max(view.width, NOTE_PANEL.minWidth);
      const canvasWidth=Math.max(baseWidth, insetWidth ? insetWidth + NOTE_PANEL.margin*2 : 0);
      // 只有真被放大图撑宽时才声明 insetWidth（左右 margin 20 已含在画布宽里）；其余情况旧输出形状不变。
      const declaredInsetWidth=insetWidth && canvasWidth > baseWidth ? insetWidth : 0;
      // 先用 1 像素高量字（行宽、行数、总高），确认放得下再分配真正的大画布。
      const canvas=document.createElement('canvas'); canvas.width=canvasWidth; canvas.height=1;
      let insetSource=null;
      try {
        const measure=canvas.getContext('2d');
        if (!measure) throw new Error('无法分配说明画布');
        measure.font=NOTE_PANEL.font;
        // 行宽跟着新画布宽走：放大图撑宽后，说明文字也用上多出来的宽度。
        const bodyWidth=Math.min(canvasWidth - NOTE_PANEL.margin*2, NOTE_PANEL.bodyMax);
        const rows=notesLayout(measure, noteRows(notes, currentNotes, commentText, view, NOTE_PANEL, relationLines), bodyWidth, view.height, NOTE_PANEL);
        // 放大图接在说明文字后面：先算总高（不缩主图、不截说明），放不下就明确失败。
        let total=Math.max(view.height, rows.height - NOTE_PANEL.margin);
        for (const spec of insets) {
          spec.lines=wrapLines(measure, spec.label, bodyWidth);
          spec.top=total + INSET_PANEL.gap;
          total=spec.top + spec.lines.length*NOTE_PANEL.lineHeight + spec.drawHeight;
        }
        const height=Math.ceil(total + NOTE_PANEL.margin);
        // 预算检查放在分配大画布与 compose 之前：超限就明确失败，不偷偷降倍率、不截内容、不丢意见。
        if (canvasWidth>LIMIT.edge || height>LIMIT.edge || canvasWidth*height>LIMIT.pixels) {
          throw new Error(insets.length
            ? `局部放大后成图 ${canvasWidth} × ${height} 像素，超过复制上限（边长 ${LIMIT.edge}、总计 ${LIMIT.pixels} 像素）；请缩小框选范围或关闭「附局部放大」后重试，不会自动降倍率、截内容或丢意见`
            : `批注说明要 ${canvasWidth} × ${height} 像素，超过复制上限（边长 ${LIMIT.edge}、总计 ${LIMIT.pixels} 像素）；可关闭「附局部放大」或缩短说明后重试，或缩小选区范围后重试`);
        }
        canvas.height=height;
        const ctx=canvas.getContext('2d');
        if (!ctx) throw new Error('无法分配说明画布');
        // 局部放大的像素也只从 compose 画布来（已含马赛克/纯色遮盖），绝不回取原始位图或 dataUrl。
        if (insets.length) {
          insetSource=document.createElement('canvas');
          insetSource.width=view.width; insetSource.height=view.height;
          const sourceContext=insetSource.getContext('2d');
          if (!sourceContext) throw new Error('无法分配说明画布');
          compose(sourceContext);
        }
        // 白底铺满：窄图右侧多出来的地方是白的，当前画面仍在 (0, 0)，不缩放、不移动。
        ctx.fillStyle='#ffffff'; ctx.fillRect(0, 0, canvasWidth, height);
        // 当前画面的边缘粗笔迹只留在截图内，不溢入右侧补白与下方说明区。
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, view.width, view.height); ctx.clip();
        compose(ctx);
        // 已提交的批注标记画在主图上：框、点、编号与连线。编号与下方说明里的意见编号一一对应。
        drawExportMarkers(ctx, view);
        ctx.restore();
        ctx.fillStyle='#111111'; ctx.font=NOTE_PANEL.font; ctx.textAlign='left'; ctx.textBaseline='top';
        for (const line of rows.lines) ctx.fillText(line.text, NOTE_PANEL.margin, line.y);
        for (const spec of insets) {
          let y=spec.top;
          for (const line of spec.lines) { ctx.fillText(line, NOTE_PANEL.margin, y); y+=NOTE_PANEL.lineHeight; }
          ctx.drawImage(insetSource, spec.source.x, spec.source.y, spec.source.width, spec.source.height,
            NOTE_PANEL.margin, y, spec.drawWidth, spec.drawHeight);
        }
        return { canvas, width: canvasWidth, height, insetWidth: declaredInsetWidth };
      } catch (error) {
        canvas.width=canvas.height=0; throw error;
      } finally {
        // 局部放大只是排版时的临时源图，画完就释放；返回出去的整张画布归调用方所有。
        if (insetSource) insetSource.width=insetSource.height=0;
      }
    }
    const api = {
      // 只读诊断：关系与目标的当前状态，供隐藏窗口验收核对；不修改任何东西。
      debug: () => ({
        notes: annotationList().map(note => ({ id: note.id, text: note.text, number: note.number, kind: note.kind,
          ...(note.kind === 'point' ? { point: { ...note.point } } : { rect: { ...note.rect } }),
          targets: note.targets.map(target => ({ targetId: target.targetId, kind: target.kind,
            letter: target.letter, index: target.index,
            ...(target.kind === 'point' ? { point: { ...target.point } } : { rect: { ...target.rect } }) })) })),
        relations: relationList().map(relation => ({ id: relation.id, text: relation.text, complete: relation.complete,
          a: relation.a ? { annotationId: relation.a.annotationId, targetId: relation.a.targetId } : null,
          b: relation.b ? { annotationId: relation.b.annotationId, targetId: relation.b.targetId } : null,
          curve: (() => { const curve = relationCurvePoints(relation.a, relation.b); return curve ? curve.points : null; })() })),
        // 瞬时只读状态供几何回归测试使用，不写入后台记录。
        editingTargets: bubbleTargetList().map(target => cloneTargetOf(target)),
        cursor, ops: ops.length,
        frames: renderCount,
        tool, drag: drag ? drag.mode : undefined, draft: false, editing: Boolean(noteState),
        selectedTargets: selectedTargets.map(end => ({ annotationId: end.annotationId, targetId: end.targetId })),
        selectedRelationId, connect: connect ? { phase: connect.phase,
          start: { ...connect.start }, pressed: connect.pressed ? { ...connect.pressed } : null,
          hover: connect.hover ? { ...connect.hover } : null } : null, noteId, relationCount: relationList().length,
        preview: previewMode, busy: blocked(),
        origin: origin(), zoom, view: currentView(),
        paint: ops.slice(0, cursor).filter(op => op && (Array.isArray(op.points) || op.rect))
          .map(op => {
            const points = op.points ? op.points.map(point => ({ x: point.x, y: point.y, ...(point.move ? { move: true } : {}) })) : undefined;
            let rect = op.rect ? { ...op.rect } : undefined;
            if (!rect && points && points.length >= 2) {
              const xs = points.map(point => point.x), ys = points.map(point => point.y);
              rect = { x: Math.min(...xs), y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
            }
            return { tool: op.tool, fill: op.fill === true, points, rect };
          })
      }),
      async open(source) {
        if (blocked()) throw new Error('编辑器忙，请稍后重试');
        if (!source || source.token == null) throw new TypeError('图片来源或 token 无效');
        if (image && source.token === token) {
          if (source.warning) warning(source.warning);
          // 同一份文档重开：位置与参数保留。
          cancel();
          if (opened) savedScroll=[scroller.scrollLeft,scroller.scrollTop];
          else oldFocus=document.activeElement;
          opened=true; root.hidden=false; layout(); scroller.scrollLeft=savedScroll[0]; scroller.scrollTop=savedScroll[1]; scroller.focus(); syncBubble(); sync(); return;
        }
        if (typeof source.dataUrl !== 'string' || !source.dataUrl.startsWith('data:image/')) throw new TypeError('新图片需要有效 dataUrl');
        const w=source.width,h=source.height, docToken=source.token, docWarning=String(source.warning ?? '');
        if (!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>LIMIT.edge||h>LIMIT.edge||w*h>LIMIT.pixels) throw new RangeError('图片超过限制：边长 30000 像素、总计 3600 万像素');
        const request=++epoch; loading=true; cancel(); sync();
        const loaded=new Image(); let bitmap=null;
        try {
          // img-src data: works with the selection page's restrictive CSP; fetch(data:) would not.
          loaded.src=source.dataUrl; source=null; await loaded.decode();
          if (request!==epoch) throw new Error('图片加载已取消');
          if (loaded.naturalWidth!==w || loaded.naturalHeight!==h) throw new Error('图片尺寸与来源声明不符');
          bitmap=await createImageBitmap(loaded);
          if (request!==epoch) throw new Error('图片加载已取消');
          release(); image=bitmap; bitmap=null; width=w; height=h; token=docToken; warning(docWarning);
          oldFocus=document.activeElement; opened=true; root.hidden=false; zoom=clampZoom(Math.min(1,(scroller.clientWidth-32)/currentView().width));
          status(''); layout(); scroller.scrollLeft=scroller.scrollTop=0; scroller.focus();
        } catch(error) { status(error.message); throw error; }
        finally {
          bitmap?.close(); loaded.removeAttribute('src');
          if (request===epoch) { loading=false; sync(); }
        }
      },
      async replaceFrame(source) {
        if (!animation || !image || loading || exporting || drag || cropDraft) throw new Error('请先完成当前操作');
        const request = epoch, revision = ++frameRevision;
        let bitmap = await createImageBitmap(source);
        try {
          if (request !== epoch || revision !== frameRevision || !opened || drag || cropDraft) return false;
          if (bitmap.width !== width || bitmap.height !== height) throw new Error('动画帧尺寸不一致');
          clearMosaics(); image.close(); image = bitmap; bitmap = null; pixelRevision += 1; schedule(); return true;
        } finally { bitmap?.close(); }
      },
      renderFrame(source) {
        if (!animation || !image || loading || exporting || drag || cropDraft) throw new Error('请先应用或取消裁切，并完成绘制');
        const [w,h] = sourceSize(source);
        if (w !== width || h !== height) throw new Error('动画帧尺寸不一致');
        const original=image, view=currentView(), canvas=document.createElement('canvas');
        try {
          image=source; clearMosaics(); canvas.width=view.width; canvas.height=view.height;
          const ctx=canvas.getContext('2d'); compose(ctx);
          return { width:canvas.width, height:canvas.height, rgba:ctx.getImageData(0,0,canvas.width,canvas.height).data };
        } finally { image=original; clearMosaics(); canvas.width=canvas.height=0; }
      },
      async exportPNG() {
        if (animation) throw new Error('动画请使用应用编辑');
        if (!image) throw new Error('尚未加载图片');
        if (cropDraft) throw new Error('裁切框还没应用：请先点「应用裁切」，或按 Esc 取消');
        // locked is an external UI lock, not an export lock: host locks before saving/copying.
        if (loading || exporting || drag) throw new Error('请先完成当前操作');
        // 保存/复制前先把说明区收口：文字就地写回、几何细节提交；超长校验失败保留输入与原选择。
        if (!flushAll()) throw new Error(flushMessage() || '说明还没写完');
        // 校验过了才收手势：未完成的连线手势不能跟着这次输出流出去（导出 API 可能不走按钮路径）。
        dropConnect();
        closeComment();
        exporting=true; sync();
        try { return await encodePng(); } finally { exporting=false; sync(); }
      },
      // 复制出口：有批注或总体说明就把说明区附在图片下方一起复制（复制后自行粘贴到其他应用），
      // 上方图片仍不含悬浮标记；没有批注时仍是原尺寸成图。像素仍只来自同一条 compose；放不下就明确失败保留编辑。
      async exportClipboard() {
        if (animation) throw new Error('动画不支持 PNG 复制');
        if (!image) throw new Error('尚未加载图片');
        if (cropDraft) throw new Error('裁切框还没应用：请先点「应用裁切」，或按 Esc 取消');
        if (loading || exporting || drag) throw new Error('请先完成当前操作');
        if (!flushAll()) throw new Error(flushMessage() || '这条批注还没完成');
        // 校验过了才收手势：未完成的连线手势不能跟着这次输出流出去（导出 API 可能不走按钮路径）。
        dropConnect();
        closeComment();
        exporting=true; sync();
        const request=epoch;
        let built=null;
        try {
          const crop=cropField();
          // 无批注、无总体说明时仍是原尺寸成图，不要求批注模型的“至少一条意见”。
          built=buildCopyCanvas();
          if (!built) return { token, png: await encodePng(), ...(crop ? { crop } : {}) };
          const blob=await new Promise((resolve,reject)=>built.canvas.toBlob(value=>value ? resolve(value) : reject(new Error('PNG 编码失败')),'image/png'));
          const bytes=new Uint8Array(await blob.arrayBuffer());
          if (request!==epoch) throw new Error('导出已取消');
          return { token, png: bytes, clipboardSize: { width: built.width, height: built.height, ...(built.insetWidth ? { insetWidth: built.insetWidth } : {}) }, ...(crop ? { crop } : {}) };
        } finally {
          if (built) built.canvas.width=built.canvas.height=0;
          exporting=false; sync();
        }
      },
      // 分段导出的第一步：把“复制成图”整张画布准备好并留在本页（一次分配，不每段重画整图）。
      // 无批注时就是当前画面本身；说明区自然落在末尾，段内内容与「复制图片」完全同源。
      async beginSegmentExport() {
        if (animation) throw new Error('动画不支持分段导出');
        if (!image) throw new Error('尚未加载图片');
        if (cropDraft) throw new Error('裁切框还没应用：请先点「应用裁切」，或按 Esc 取消');
        if (loading || exporting || drag) throw new Error('请先完成当前操作');
        if (segmentBusy) throw new Error('上一批分段导出还没结束');
        if (!flushAll()) throw new Error(flushMessage() || '说明还没写完');
        // 校验过了才收手势：分段导出同样可能不走按钮路径。
        dropConnect();
        closeComment();
        const built=buildCopyCanvas();
        segmentCanceled=false; segmentBusy=true; exporting=true;
        try {
          let canvas, canvasWidth, canvasHeight;
          if (built) { canvas=built.canvas; canvasWidth=built.width; canvasHeight=built.height; }
          else {
            const view=currentView();
            canvas=document.createElement('canvas'); canvas.width=view.width; canvas.height=view.height;
            const ctx=canvas.getContext('2d');
            if (!ctx) throw new Error('无法分配分段画布');
            compose(ctx);
            canvasWidth=view.width; canvasHeight=view.height;
          }
          segmentSession={ canvas, width: canvasWidth, height: canvasHeight, request: epoch };
          sync();
          return { width: canvasWidth, height: canvasHeight };
        } catch (error) {
          if (built) built.canvas.width=built.canvas.height=0;
          segmentBusy=false; exporting=false; sync(); throw error;
        }
      },
      // 逐段切图：只画一小块到临时画布，编码完立即释放，不在内存里留一批大 PNG。
      async exportSegment(index, top, height) {
        const session=segmentSession;
        if (!session) throw new Error('分段导出还没开始');
        if (session.request!==epoch) throw new Error('图片已经换了，这次分段导出作废');
        if (!Number.isInteger(index) || index < 0) throw new RangeError('分段序号无效');
        if (!Number.isInteger(top) || !Number.isInteger(height) || top < 0 || height < 1 || top + height > session.height) throw new RangeError('分段范围无效');
        const canvas=document.createElement('canvas');
        canvas.width=session.width; canvas.height=height;
        try {
          const ctx=canvas.getContext('2d');
          if (!ctx) throw new Error('无法分配分段画布');
          ctx.drawImage(session.canvas, 0, top, session.width, height, 0, 0, session.width, height);
          const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error('PNG 编码失败')),'image/png'));
          const bytes=new Uint8Array(await blob.arrayBuffer());
          if (session.request!==epoch || segmentSession!==session) throw new Error('图片已经换了，这次分段导出作废');
          return { index, png: bytes };
        } finally { canvas.width=canvas.height=0; }
      },
      endSegmentExport() {
        discardSegmentSession();
        segmentBusy=false; segmentCanceled=false; exporting=false; sync();
      },
      thumbnail(maxWidth=1000,maxHeight=800) {
        if (!image) throw new Error('尚未加载图片');
        if (cropDraft) throw new Error('裁切框还没应用：请先点「应用裁切」，或按 Esc 取消');
        if (!Number.isFinite(maxWidth)||!Number.isFinite(maxHeight)||maxWidth<1||maxHeight<1) throw new RangeError('缩略图边界无效');
        const view=currentView();
        const scale=Math.min(1,maxWidth/view.width,maxHeight/view.height,Math.sqrt(8000000/(view.width*view.height)));
        const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.floor(view.width*scale)); canvas.height=Math.max(1,Math.floor(view.height*scale));
        try { const ctx=canvas.getContext('2d'); ctx.scale(canvas.width/view.width,canvas.height/view.height); compose(ctx); return canvas.toDataURL('image/png'); }
        finally { canvas.width=canvas.height=0; }
      },
      close() {
        if (!opened || blocked()) return;
        // 返回预览也不丢字：先把便签里的文字/几何收口；正在选位置/连线先收掉暂态。
        linkPick = null; dropConnect(); ocrPending = false; ocrToken += 1;
        if (!flushAll()) return;
        // 未确认的裁切与临时导航状态一起清掉，不把旧范围带出去。
        cropDraft = null; spaceDown = false; stopPan();
        closeComment();
        savedScroll=[scroller.scrollLeft,scroller.scrollTop]; cancel(); opened=false; root.hidden=true;
        if (frame) cancelAnimationFrame(frame); frame=0;
        if (resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame=0;
        if (oldFocus?.isConnected && !root.contains(oldFocus)) oldFocus.focus();
        try { Promise.resolve(onClose()).catch(error=>status(error.message || error)); } catch(error) { status(error.message || error); }
      },
      reset() {
        ++epoch; loading=false; locked=false; cancel(); opened=false; root.hidden=true;
        linkPick=null; dropConnect(); ocrPending=false; ocrToken+=1;
        if(frame) cancelAnimationFrame(frame); frame=0;
        if(resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame=0; release(); status(''); sync();
      },
      // 忙碌只锁必要的控件：瞬时状态（选关联目标、OCR 在飞）一起清掉，迟到结果不能写回。
      setBusy(value) {
        locked=Boolean(value);
        if(locked) { spaceDown=false; linkPick=null; dropConnect(); ocrPending=false; ocrToken+=1; stopPan(); cancel(); }
        syncBubble(); sync();
      },
      setStatus: status,
      // 只读预览：默认关；宿主（长截图结果页）打开文档后自己决定进不进。
      setPreviewMode,
      get previewMode() { return previewMode; },
      get canRenderFrame() { return Boolean(image && !loading && !exporting && !drag && !cropDraft); },
      get hasEdits() { return cursor>0; }, get isOpen() { return opened; }, get busy() { return blocked(); },
      // 分段导出状态：宿主靠这两个只读值看“还能不能继续下一段”。
      get segmentActive() { return segmentBusy; }, get segmentStopped() { return segmentCanceled; },
      // 只读：当前裁切矩形（无裁切 undefined，返回副本）与当前输出尺寸（源尺寸在 width/height 里不变）。
      get cropRect() { const crop = cropField(); return crop ? { ...crop } : undefined; },
      get outputSize() { const view = currentView(); return { width: view.width, height: view.height }; }
    };
    root.hidden=true; sync(); return Object.freeze(api);
  };
})();
