/* Classic-script image editor. No capture, clipboard, IPC or external dependencies. */
(() => {
  'use strict';
  const LIMIT = Object.freeze({ pixels: 16000000, edge: 30000, operations: 1000, points: 200000, strokePoints: 20000 });
  window.createImageEditor = function createImageEditor({ root, onCommit = () => {}, onClose = () => {}, recognizeText = null, animation = false, onStateChange = () => {}, onMinimize = null,
    onPreviewRequest = null, onExitRequest = null }) {
    if (!(root instanceof HTMLElement)) throw new TypeError('需要编辑器 root');
    // 可选 OCR 桥：宿主真的传了函数才可用；没传就只让用户手填目标文字，不做任何兜底抓图。
    const ocrRecognize = typeof recognizeText === 'function' ? recognizeText : null;
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
      browse: '<path d="M8 12V6.5a1.8 1.8 0 0 1 3.6 0V11m0-4.5V5a1.8 1.8 0 0 1 3.6 0v6m0-5a1.8 1.8 0 0 1 3.6 0V16c0 3.4-2.4 5.5-6 5.5h-1.6c-1.7 0-2.9-.9-3.8-2.6l-3.2-5a1.8 1.8 0 0 1 2.9-2.1L8 13.5"/>',
      crop: '<path d="M7 3v14h14M3 7h14v14"/>',
      mosaic: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
      pen: '<path d="m5.5 15 9.5-9.5 3.5 3.5L9 18.5 4.5 19.5l1-4.5ZM13.5 7l3.5 3.5"/>',
      line: '<path d="M5 19 19 5"/>',
      rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
      arrow: '<path d="m5 19 14-14M9 5h10v10"/>',
      point: '<path d="M12 20.5s6.5-6.4 6.5-11.5a6.5 6.5 0 0 0-13 0c0 5.1 6.5 11.5 6.5 11.5Z"/><circle cx="12" cy="9" r="2.2"/>',
      region: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" stroke-dasharray="4 3"/><path d="M3.5 8V3.5H8m8 17h4.5V16"/>',
      minimize: '<rect x="4.5" y="6" width="15" height="12" rx="2"/><path d="M9 14h6"/>',
      undo: '<path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 6 6v3"/>',
      redo: '<path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3"/>'
    };
    const icon = name => `<svg class="ie-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
    // 横排分组：查看｜需求批注｜画标记｜处理图片｜编辑历史；属性只跟当前工具走。
    // 形状（直线/矩形）暂不折进下拉：原生 details 与画布指针/键盘交互叠加成本高，先按同组保留。
    const TOOL_GROUPS = [
      ['查看', [['browse', '抓手'], ['select', '选择']]],
      ['需求批注', [['point', '点批注'], ['region', '框批注']]],
      ['画标记', [['pen', '画笔'], ['arrow', '箭头'], ['line', '直线'], ['rect', '矩形']]],
      ['处理图片', [['mosaic', '马赛克'], ['crop', '裁切']]]
    ];
    const headerHtml = `<header class="ie-header"><div class="ie-document"><button type="button" class="ie-back" data-action="close">‹ 返回预览</button><strong class="ie-doc-title">图片编辑</strong><small class="ie-doc-size"></small><button type="button" class="ie-minimize" data-action="minimize" title="最小化到任务栏：编辑页不置顶，可以切到别的窗口" aria-label="最小化" hidden>${icon('minimize')}</button></div><div class="ie-exports" role="group" aria-label="输出"><button type="button" class="ie-outline" data-action="save-as" title="另存到指定位置">另存…</button><button type="button" class="ie-outline" data-action="save" title="保存到设置的文件夹；图片保留所有马赛克/纯色遮盖和笔迹，不含预览里的编号悬浮标记">保存</button><button type="button" class="ie-primary" data-action="copy" title="复制图片（保留所有遮盖和笔迹、不含编号悬浮标记）并在下方附上批注说明；复制后可粘贴到其他应用">复制图片</button></div></header>`;
    const optionsHtml = `<div class="ie-options" role="group" aria-label="当前工具设置"><strong class="ie-tool-name"></strong>
      <span data-tools="browse">左键拖动画面 · 空格或中键临时拖动</span>
      <span data-tools="point">点一下落编号，再在右侧写意见；点编号可改</span>
      <span data-tools="region">拖框圈住位置，再在右侧写意见；框内可拖动、手柄可缩放</span>
      <span data-tools="select">选择/调整：单击边线或线身选中旧标记；拖动移动，手柄缩放或改端点；Delete 删除</span>
      <button type="button" data-tools="select" data-action="shape-delete" title="删除选中的形状，可用撤销恢复">删除形状</button>
      <span data-tools="crop">框内拖动移动，四边四角手柄调整，框外重新拖框</span>
      <span data-tools="crop" class="ie-crop-size"></span>
      <button type="button" data-tools="crop" data-action="crop-apply" class="ie-primary" title="把框选范围应用为新的画面；可用撤销恢复">应用裁切</button>
      <button type="button" data-tools="crop" data-action="crop-cancel" title="放弃这次未应用的裁切框">取消裁切</button>
      <div class="ie-colors" data-tools="pen line rect arrow select" role="group" aria-label="标注颜色"><span>颜色</span><div class="ie-swatches" role="group" aria-label="常用颜色">${colors.map(([name,color])=>`<button type="button" class="ie-swatch" data-color="${color}" aria-label="${name}" title="${name}" aria-pressed="false"><span aria-hidden="true"></span></button>`).join('')}</div><label title="自选其他颜色"><input data-setting="color" type="color" value="#e05278" aria-label="自选标注颜色"></label></div>
      <label data-tools="pen line rect arrow select" title="粗细按原图像素计算">粗细 <input data-range="width" type="range" min="1" max="128" value="6" aria-label="笔画粗细滑块"><input data-setting="width" type="number" min="1" max="128" value="6" aria-label="原图像素线宽"><span>px</span></label>
      <label data-tools="mosaic" title="调整涂抹范围，不改变马赛克颗粒">笔刷大小 <input data-range="diameter" type="range" min="4" max="128" value="20" aria-label="马赛克笔刷大小滑块"><input data-setting="diameter" type="number" min="4" max="128" value="20" aria-label="马赛克原像素笔径"><span>px</span></label>
      <label data-tools="mosaic" title="颗粒越大，细节越少；敏感信息优先使用矩形纯色遮盖">颗粒大小 <input data-setting="grain" type="number" min="4" max="128" value="12" aria-label="马赛克原像素颗粒"><span>px</span></label>
      <label data-tools="rect"><input data-setting="fill" type="checkbox">纯色填充</label>
      </div>`;
    const TOOL_TITLES = { select: '选择/调整：单击边线或线身选中旧标记，拖动移动、手柄缩放；Delete 删除' };
    const toolbarHtml = `<div class="ie-toolbar" aria-label="工具">${TOOL_GROUPS.map(([label, tools]) => `<div class="ie-tool-group"><span class="ie-group-label">${label}</span><div class="ie-tools" role="group" aria-label="${label}">${tools.map(([id, text]) => `<button type="button" class="ie-tool" data-tool="${id}" aria-pressed="${id === 'browse'}" title="${TOOL_TITLES[id] || text}">${icon(id)}<span>${text}</span></button>`).join('')}${label === '需求批注' ? '<button type="button" class="ie-tool ie-tool-quiet" data-action="comment" aria-expanded="false" title="写一段不针对某个点的总体说明（右侧面板）">补充说明</button>' : ''}</div></div>`).join('')}<div class="ie-tool-group ie-history"><span class="ie-group-label">编辑历史</span><div class="ie-tools" role="group" aria-label="编辑历史"><button type="button" class="ie-tool" data-action="undo" title="撤销最近一次标注 · Ctrl+Z">${icon('undo')}<span>撤销</span></button><button type="button" class="ie-tool" data-action="redo" title="恢复刚撤销的标注 · Ctrl+Y 或 Ctrl+Shift+Z">${icon('redo')}<span>重做</span></button></div></div><button type="button" class="ie-help-toggle" data-action="help-toggle" aria-expanded="false" title="快捷键与工具说明">? 快捷键</button>${optionsHtml}</div>`;
    // 批注面板：编辑时展开、完成/取消后收起；不覆盖画布，窄窗也保留可操作宽度。
    const panelHtml = `<aside class="ie-panel" aria-label="批注面板" hidden>
        <section class="ie-note-bubble" role="group" aria-label="这条批注的意见" hidden>
          <div class="ie-panel-head"><strong class="ie-bubble-title"></strong><span class="ie-panel-head-actions"><button type="button" class="ie-quiet ie-bubble-delete" data-action="bubble-delete" title="删除这条批注，可用撤销恢复">删除</button><button type="button" class="ie-quiet" data-action="panel-collapse" title="收起面板；草稿不会丢，可以继续编辑">收起 ›</button></span></div>
          <div class="ie-field"><span class="ie-field-label">标记位置</span><div class="ie-bubble-targets" role="group" aria-label="这条批注标记的位置"></div><div class="ie-bubble-links"><button type="button" data-action="bubble-add-point" title="在图上再点一个位置，让这条意见同时指向几处">＋关联点</button><button type="button" data-action="bubble-add-region" title="在图上再框一块区域，让这条意见同时指向几处">＋关联框</button></div><label class="ie-bubble-relation">关系 <select data-setting="relation" aria-label="多个目标之间的关系"><option value="same">多处同意见</option><option value="move">从A移到B</option></select></label></div>
          <label class="ie-field"><span class="ie-field-label">想怎么改？</span><textarea class="ie-bubble-text" rows="5" placeholder="写这条意见…" aria-label="这条批注的意见"></textarea></label>
          <button type="button" class="ie-more-toggle" data-action="bubble-more-toggle" aria-expanded="false">更多选项 <span aria-hidden="true">⌄</span></button>
          <div class="ie-bubble-more" hidden><label>目标文字 <input class="ie-target-text" type="text" aria-label="目标上的文字，可手填或识别"></label><button type="button" data-action="bubble-ocr">识别目标文字（A）</button><label class="ie-bubble-inset"><input type="checkbox" data-setting="inset">附局部放大（放在复制图下方）</label><div class="ie-bubble-details" role="group" aria-label="可选的操作、当前、期望"><label>操作 <input class="ie-details-action" data-detail="action" type="text" aria-label="这一步做了什么操作"></label><label>当前 <input class="ie-details-current" data-detail="current" type="text" aria-label="当前是什么情况"></label><label>期望 <input class="ie-details-expected" data-detail="expected" type="text" aria-label="期望变成什么"></label></div></div>
          <div class="ie-panel-actions"><button type="button" data-action="bubble-cancel">取消</button><button type="button" class="ie-primary" data-action="bubble-save">完成批注</button></div>
        </section>
        <section class="ie-comment-bubble" role="group" aria-label="补充说明" hidden>
          <div class="ie-panel-head"><strong class="ie-bubble-title">补充说明</strong><span class="ie-panel-head-actions"><button type="button" class="ie-quiet" data-action="panel-collapse" title="收起面板；文字不会丢">收起 ›</button></span></div>
          <label class="ie-field"><span class="ie-field-label">这张图的总体说明</span><textarea class="ie-comment" rows="6" placeholder="想一起说的话，可以只写这一段" aria-label="补充说明"></textarea></label>
          <div class="ie-panel-actions"><button type="button" class="ie-primary" data-action="comment-close">完成</button></div>
        </section>
      </aside>`;
    const helpHtml = `<div class="ie-help" role="note" hidden><strong>快捷键与工具说明</strong><ul><li>滚轮上下查看 · Shift＋滚轮横移 · Ctrl＋滚轮缩放</li><li>空格或中键拖动画面；Esc 先取消当前的批注/补充说明，再收起裁切，最后关编辑器</li><li>批注：点或框选后在右侧面板写意见，Ctrl＋Enter「完成批注」，Esc 取消</li><li>框批注：先在面板里选中目标，再直接在框内拖动、拖 8 个手柄缩放</li><li>裁切：拖动边角调整范围，Enter 或「应用裁切」生效，Esc 取消</li><li>保存 / 另存 / 复制都会带上遮盖与笔迹；编号与框线只在预览里</li></ul></div>`;
    const footerHtml = `<footer class="ie-footer"><div class="ie-footer-info"><span class="ie-status" role="status" aria-live="polite"></span><button type="button" class="ie-resume" data-action="panel-resume" hidden>继续编辑批注</button></div><div class="ie-view-actions" role="group" aria-label="预览缩放与批注显示"><button type="button" data-action="notes-toggle" aria-pressed="true" aria-label="显示或隐藏批注" title="仅预览有效：显示或隐藏编号、引线与框批注；保存和复制的图片都不含这些标记">显示标记</button><button type="button" data-action="zoom-out" aria-label="缩小预览">−</button><output class="ie-zoom">100%</output><button type="button" data-action="zoom-in" aria-label="放大预览">＋</button><button type="button" data-action="fit">适合宽度</button><button type="button" data-action="fit-image" title="双维度适应整张图，四边留出可抓手柄的边距">适合整图</button><button type="button" data-action="actual">原尺寸</button></div></footer>`;
    root.innerHTML = `${headerHtml}
      ${toolbarHtml}
      <p class="ie-warning" role="note" hidden></p>
      <div class="ie-main"><div class="ie-workspace"><div class="ie-scroll" tabindex="0" aria-label="图片画布：滚轮上下、Shift 横移、Ctrl 滚轮缩放、空格或中键拖动画面"><div class="ie-spacer"></div></div><canvas class="ie-display" aria-hidden="true"></canvas><div class="ie-brush-cursor" aria-hidden="true" hidden></div><div class="ie-marker-layer" aria-label="批注编号"></div></div>${panelHtml}</div>
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
      for (const selector of ['[data-tool="point"]','[data-tool="region"]','[data-action="comment"]','[data-action="save"]','[data-action="save-as"]','[data-action="notes-toggle"]']) {
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
    // 只读预览：同一份文档/画布/历史，只收起工具栏与批注入口，只留浏览、缩放与输出。
    // 由宿主决定何时进入/退出（长截图结果页默认先进预览）；F1 唤回/同 token 重开不碰它。
    let previewMode = false;
    const previewHostRequest = typeof onPreviewRequest === 'function' ? onPreviewRequest : null;
    const exitHostRequest = typeof onExitRequest === 'function' ? onExitRequest : null;
    // 预览态下不允许改内容的按钮：工具栏与面板本身是隐藏的，这里再堵一层程序化点击。
    const PREVIEW_BLOCKED_ACTIONS = ['crop-apply', 'crop-cancel', 'undo', 'redo', 'comment', 'comment-close',
      'bubble-save', 'bubble-cancel', 'bubble-delete', 'bubble-add-point', 'bubble-add-region', 'bubble-more-toggle',
      'bubble-ocr', 'target-remove', 'target-frame', 'panel-resume', 'marker', 'shape-delete'];
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
    let annotationSeq = 0;
    // draft：还没入 ops 的新批注草稿；editing：正在改的旧批注（{id, text} 里的 text 永远是原文，做「取消保留原文」用）。
    let draft = null, editing = null, commentOpen = false, bubbleKey = '';
    // 关联目标选择中：气泡先藏起来（没存文字不丢），这一次点击/拖框只用来加目标。
    let linkPick = null, bubbleMoreOpen = false;
    // 当前选中的框目标下标：只有它显示 8 个手柄、可框内拖动/手柄缩放。
    // 新建/新关联的框直接成为当前框；点已有编号或在右栏目标行上选 A/B。
    let frameIndex = null;
    // 右栏收起状态：收起不丢草稿，底栏留一个「继续编辑」入口；完成/取消才真正关闭。
    let panelCollapsed = false;
    // 像素 revision：任何进历史的图像变化都 +1；OCR 生成的文字绑定生成时的 revision。
    let pixelRevision = 0, ocrToken = 0, ocrPending = false;
    // 用户手动改目标文字的次数：OCR 在飞时无论改成什么（包括改回原值、再清空）都不能被覆盖。
    let targetTextEditCount = 0;
    // 预览里是否显示批注（编号/引线/空心圈/框）：只影响屏幕预览和命中，任何导出的图片都不带批注标记。
    let notesVisible = true;
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
    function targetLetter(index) { return TARGET_LETTERS[index] || '?'; }
    function cloneTargetOf(target) {
      return target.kind === 'point'
        ? { kind: 'point', point: { x: target.point.x, y: target.point.y } }
        : { kind: 'region', rect: { x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height } };
    }
    // 源记录 → 目标清单：第一位永远是主目标（旧数据只有它），related 是可选附加目标。
    function recordTargets(record) {
      const list = [{ kind: record.kind, point: record.point, rect: record.rect }];
      if (Array.isArray(record.related)) {
        for (const extra of record.related) {
          if (list.length >= MAX_TARGETS) break;
          if (!extra || (extra.kind !== 'point' && extra.kind !== 'region')) continue;
          list.push({ kind: extra.kind, point: extra.point, rect: extra.rect });
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
            targets.push({ index, letter: targetLetter(index), kind: 'point', point: { x: target.point.x, y: target.point.y } });
            return;
          }
          const rect = clipRegion(target.rect, view);
          if (rect) targets.push({ index, letter: targetLetter(index), kind: 'region', rect });
        });
        if (!targets.length) continue;
        const primary = targets[0];
        alive.push({ id: record.id, number: alive.length + 1, kind: primary.kind,
          ...(primary.kind === 'point' ? { point: primary.point } : { rect: primary.rect }),
          text: typeof record.text === 'string' ? record.text : '', targets, targetCount: recordTargets(record).length, mainDead: primary.index !== 0, sourceCount,
          relation: record.relation === 'move' ? 'move' : 'same',
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
    // 最新有效版本（可写）：纯改字仍然就地写回这一版，撤销别的操作不会把文字带走。
    function opById(id) {
      let record;
      for (let i = 0; i < cursor; i++) {
        const op = ops[i];
        if (!op) continue;
        if (op.tool === 'annotation' && op.id === id) record = op;
        else if (op.tool === 'annotation-update' && op.id === id) record = op.snapshot;
        else if (op.tool === 'annotation-delete' && op.id === id) record = undefined;
      }
      return record;
    }
    function commitOp(op) {
      ops = ops.slice(0, cursor); ops.push(op); cursor += 1;
      // 只有真的改了像素（笔迹/遮盖/裁切）才推进 revision；批注本身不改像素，
      // 所以「先 OCR 再保存这条批注」不能把自己的目标文字作废。
      if (op.tool !== 'annotation' && op.tool !== 'annotation-update' && op.tool !== 'annotation-delete') pixelRevision += 1;
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
    // drawNote 只用于屏幕预览里的框批注边框（草稿用虚线）。
    // 编号/引线/空心圈只在 DOM 标记层存在，任何图片导出口都不画批注标记。
    function drawNote(ctx, note, preview = false) {
      if (!note || !note.rect) return;
      const radius = markerRadius(), ink = '#20382e', paper = '#f7faf6';
      ctx.save();
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash(preview ? [radius, radius / 2] : []);
      ctx.lineWidth = Math.max(2, Math.round(radius / 2)); ctx.strokeStyle = paper;
      ctx.strokeRect(note.rect.x, note.rect.y, note.rect.width, note.rect.height);
      ctx.lineWidth = Math.max(1, Math.round(radius / 5)); ctx.strokeStyle = ink;
      ctx.strokeRect(note.rect.x, note.rect.y, note.rect.width, note.rect.height);
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
      ctx.restore();
    }
    // —— 标记层：真实 button，只活在编辑器预览里 ——
    // 编号不进任何成图（保存/复制/thumbnail 都不画）；DOM 这一份是屏幕上唯一的编号：
    // 落点小空心圈 + 偏移的实心编号 + 引线。zoom 很小（例如 5760 宽原图 fit 到 960 CSS px，
    // 约 0.16）时编号仍保底 22 CSS px，偏移也按实际显示大小重新避让。
    const markerFigures = new Map();
    let markerSignatureValue = '';
    function imageScreenRect() {
      const o = origin(), view = currentView();
      return { x: o.x + view.x * zoom, y: o.y + view.y * zoom, width: view.width * zoom, height: view.height * zoom };
    }
    function draftTargets() {
      if (!draft) return [];
      return (draft.state?.targets || []).slice(0, MAX_TARGETS).map((target, index) =>
        ({ index, letter: targetLetter(index), ...cloneTargetOf(target) }));
    }
    // 正在编辑的那条按气泡里的暂存目标显示（新增/移除先看得到，保存才入 ops）。
    function stagedTargetsOf(item) {
      if (!editing || editing.id !== item.id || !editing.state) return null;
      const view = currentView(), out = [];
      editing.state.targets.forEach((target, index) => {
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
        const group = editing && editing.id === item.id ? editing.state.targets.length : item.sourceCount;
        const multi = group > 1;
        for (const target of targets) {
          entries.push({ key: `${item.id}#${target.index}`, id: item.id, draft: false, target,
            number: item.number, multi, text: item.text });
        }
      }
      const draftItems = draftTargets();
      for (const target of draftItems) {
        entries.push({ key: `draft#${target.index}`, id: 'draft', draft: true, target,
          number: items.length + 1, multi: draftItems.length > 1, text: '' });
      }
      return entries;
    }
    function markerLabel(entry) { return entry.multi ? `${entry.number}${entry.target.letter}` : String(entry.number); }
    function markerSignature() {
      return markerEntries().map(entry => `${entry.key}:${entry.target.kind}:${entry.multi ? 'm' : 's'}`).join(',');
    }
    function makeMarkerItem(entry) {
      const figure = document.createElement('div');
      figure.className = entry.draft ? 'ie-marker-figure ie-marker-figure-draft' : 'ie-marker-figure';
      const ring = document.createElement('span');
      ring.className = 'ie-marker-ring'; ring.setAttribute('aria-hidden', 'true');
      const leader = document.createElement('span');
      leader.className = 'ie-marker-leader'; leader.setAttribute('aria-hidden', 'true');
      const button = document.createElement('button');
      button.type = 'button'; button.className = entry.draft ? 'ie-marker ie-marker-draft' : 'ie-marker';
      button.dataset.action = 'marker'; button.dataset.annotationId = entry.id;
      button.dataset.targetIndex = String(entry.target.index);
      if (entry.draft) button.dataset.draft = 'true';
      figure.append(ring, leader, button);
      return { figure, ring, leader, button };
    }
    function placeMarker(entry, target, label) {
      if (!target) return;
      const at = target.kind === 'region' ? { x: target.rect.x, y: target.rect.y } : target.point;
      const o = origin();
      const anchor = { x: o.x + at.x * zoom, y: o.y + at.y * zoom };
      const ringRadius = Math.max(3, noteRingRadius() * zoom);
      const badgeRadius = Math.max(11, markerRadius() * zoom);
      const figure = noteFigure(anchor, ringRadius, badgeRadius, imageScreenRect());
      entry.ring.style.width = entry.ring.style.height = `${Math.round(ringRadius * 2)}px`;
      entry.ring.style.left = `${Math.round(anchor.x - ringRadius)}px`;
      entry.ring.style.top = `${Math.round(anchor.y - ringRadius)}px`;
      const length = Math.max(0, Math.hypot(figure.badge.x - anchor.x, figure.badge.y - anchor.y) - ringRadius - badgeRadius);
      entry.leader.hidden = length < 0.5;
      // 引线是旋转的一条细线，从圈外沿指向编号外沿。
      entry.leader.style.width = `${Math.round(length * 10) / 10}px`;
      entry.leader.style.left = `${Math.round(figure.x1 * 10) / 10}px`;
      entry.leader.style.top = `${Math.round(figure.y1 * 10) / 10}px`;
      entry.leader.style.transform = `rotate(${Math.round(Math.atan2(figure.y2 - figure.y1, figure.x2 - figure.x1) * 1800 / Math.PI) / 10}deg)`;
      const size = Math.round(badgeRadius * 2);
      entry.button.style.width = entry.button.style.height = `${size}px`;
      entry.button.style.left = `${Math.round(figure.badge.x - badgeRadius)}px`;
      entry.button.style.top = `${Math.round(figure.badge.y - badgeRadius)}px`;
      // 字号、纸色内圈都跟着尺寸走；保底 22px 时字号也保底 12px 可读。
      entry.button.style.fontSize = `${Math.max(12, Math.round(size * 0.55))}px`;
      entry.button.style.boxShadow = `inset 0 0 0 ${Math.max(1, Math.round(size / 12))}px #f7faf6`;
      const text = label == null ? '' : String(label);
      if (entry.button.textContent !== text) entry.button.textContent = text;
    }
    function renderMarkers() {
      const layer = $('.ie-marker-layer');
      if (!layer) return;
      const visible = Boolean(opened && image) && notesVisible;
      // 正在选关联目标时编号不接指针，点击直接落到画布上（否则选不中已有标记旁边的位置）。
      workspace.classList.toggle('ie-markers-live', visible && !blocked() && !linkPick && noteTools.has(tool));
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
        const label = markerLabel(entry);
        // 文字和编号每帧都同步：改完旧意见保存后，标记的 title 不能是旧的。
        const aria = entry.draft ? '正在写的这条批注'
          : `第 ${entry.number} 条批注${entry.multi ? `（目标 ${entry.target.letter}）` : ''}，点击修改`;
        if (node.button.getAttribute('aria-label') !== aria) node.button.setAttribute('aria-label', aria);
        const title = entry.draft ? '' : entry.text ? `第 ${entry.number} 条：${entry.text.slice(0, 30)}` : `第 ${entry.number} 条批注`;
        if (node.button.title !== title) node.button.title = title;
        placeMarker(node, entry.target, label);
      }
    }
    // —— 原位气泡：贴在编号旁边的小浮层，一条批注一个 textarea ——
    function noteBubble() { return $('.ie-note-bubble'); }
    function bubbleField() { return $('.ie-bubble-text'); }
    function bubbleValue() { const field = bubbleField(); return field ? field.value : ''; }
    function focusBubble() { try { bubbleField()?.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响批注。 */ } }
    // overflow:hidden 的容器仍然可以被程序化滚动：聚焦时浏览器会把画布区滚走，强制回到原点。
    function keepWorkspaceFixed() {
      if (workspace.scrollLeft) workspace.scrollLeft = 0;
      if (workspace.scrollTop) workspace.scrollTop = 0;
    }
    // 批注不再有任何画布内的浮层：右栏是唯一入口，因此这里只同步面板开关与「继续编辑」入口。
    // 收起时不碰草稿/文字/几何，也不替用户保存。
    function panelOpen() { return Boolean(draft || editing || commentOpen); }
    function syncPanel() {
      const panel = $('.ie-panel'), note = noteBubble(), comment = $('.ie-comment-bubble');
      const open = panelOpen() && !panelCollapsed;
      if (panel) panel.hidden = !open;
      if (note) note.hidden = !(open && (draft || editing));
      if (comment) comment.hidden = !(open && commentOpen);
      const resume = $('[data-action="panel-resume"]');
      if (resume) {
        resume.hidden = !(panelOpen() && panelCollapsed);
        resume.textContent = editing || draft ? '继续编辑批注' : '继续编辑补充说明';
      }
    }
    function expandPanel() { panelCollapsed = false; syncPanel(); }
    function collapsePanel() {
      if (!panelOpen()) return;
      // 只收起，不保存也不丢字：草稿文字、暂存几何都还在。
      panelCollapsed = true;
      syncPanel();
      status('面板已收起 · 草稿还在，点底栏「继续编辑」可回来');
      try { scroller.focus(); } catch { /* 忽略。 */ }
      schedule();
    }
    // —— 气泡里的一条可编辑副本：目标清单 + 可选目标文字/局部放大/操作-当前-期望 ——
    // 只有「保存批注」才把目标/可选字段写回 ops；纯改字仍按原规则就地写回、不进历史。
    const DETAIL_KEYS = [['action', '操作'], ['current', '当前'], ['expected', '期望']];
    function emptyBubbleState() {
      return { targets: [], relation: 'same', targetText: '', targetTextAuto: false, targetTextRevision: 0,
        inset: false, details: { action: '', current: '', expected: '' } };
    }
    function stateFromRecord(record) {
      const state = emptyBubbleState();
      if (record && (record.kind === 'point' || record.kind === 'region')) state.targets = recordTargets(record).map(cloneTargetOf);
      state.relation = record?.relation === 'move' ? 'move' : 'same';
      state.targetText = typeof record?.targetText === 'string' ? record.targetText : '';
      state.targetTextAuto = record?.targetTextAuto === true;
      state.targetTextRevision = Number.isSafeInteger(record?.targetTextRevision) ? record.targetTextRevision : 0;
      state.inset = record?.inset === true;
      for (const [key] of DETAIL_KEYS) state.details[key] = typeof record?.details?.[key] === 'string' ? record.details[key] : '';
      return state;
    }
    function bubbleState() { return draft ? draft.state : editing ? editing.state : null; }
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
      if ((state.relation === 'move') !== (base.relation === 'move')) return true;
      if (state.targetText !== base.targetText) return true;
      if (state.inset !== base.inset) return true;
      return DETAIL_KEYS.some(([key]) => state.details[key] !== base.details[key]);
    }
    function hasOptionalFields(state) {
      if (!state) return false;
      return state.targets.length > 1 || Boolean(state.targetText) || state.inset ||
        DETAIL_KEYS.some(([key]) => Boolean(state.details[key]));
    }
    // 操作/当前/期望里只要填了一项，就可以不写自由文字（不逼用户把同一句话再重复一遍）。
    function hasBubbleDetails(state) {
      return Boolean(state) && DETAIL_KEYS.some(([key]) => state.details[key].trim());
    }
    // 要写回 ops 的完整记录：主几何仍然只有一个合法 point/rect，附加目标进 related。
    function recordFromState(state, text) {
      const primary = state.targets[0];
      const record = { tool: 'annotation', kind: primary.kind };
      if (primary.kind === 'point') record.point = { x: primary.point.x, y: primary.point.y };
      else record.rect = { ...primary.rect };
      record.text = text;
      const related = state.targets.slice(1, MAX_TARGETS).map(cloneTargetOf);
      if (related.length) record.related = related;
      if (related.length === 1 && state.relation === 'move') record.relation = 'move';
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
    function coordinateText(value) { return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0'; }
    function targetText(target) {
      return target.kind === 'point'
        ? `点 (${coordinateText(target.point.x)}, ${coordinateText(target.point.y)})`
        : `框 (${coordinateText(target.rect.x)}, ${coordinateText(target.rect.y)}, ${coordinateText(target.rect.width)}, ${coordinateText(target.rect.height)})`;
    }
    function targetInView(target) {
      const view = currentView();
      return target.kind === 'point' ? pointInside(target.point, view) : Boolean(clipRegion(target.rect, view));
    }
    let bubbleTargetsSignature = '';
    // 目标清单/关系/可选字段的 UI 同步：只在内容变化时重建 chips，避免每帧抢走焦点。
    function syncBubbleExtras() {
      const state = bubbleState();
      if (!state) return;
      const list = bubbleTargetList();
      const signature = list.map(target =>
        `${target.letter}${target.kind}${targetText(target)}${targetInView(target) ? '' : '!'}`).join('|');
      const container = $('.ie-bubble-targets');
      if (container && signature !== bubbleTargetsSignature) {
        bubbleTargetsSignature = signature;
        container.textContent = '';
        for (const target of list) {
          const chip = document.createElement('span');
          chip.className = 'ie-target-chip';
          chip.dataset.targetIndex = String(target.index);
          const badge = document.createElement('b');
          badge.textContent = target.letter;
          const label = document.createElement('span');
          label.className = 'ie-target-label';
          label.textContent = `${targetText(target)}${targetInView(target) ? '' : '（已裁掉）'}`;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.dataset.action = 'target-remove';
          remove.dataset.targetIndex = String(target.index);
          remove.textContent = '移除';
          chip.append(badge, label);
          // 框目标多一个「选中」：选中后图上显示 8 个手柄，可以直接拖框内或拖手柄。
          if (target.kind === 'region') {
            const frame = document.createElement('button');
            frame.type = 'button';
            frame.className = 'ie-target-frame';
            frame.dataset.action = 'target-frame';
            frame.dataset.targetIndex = String(target.index);
            frame.textContent = '选中';
            chip.append(frame);
          }
          chip.append(remove);
          container.append(chip);
        }
      }
      for (const chip of (container ? [...container.children] : [])) {
        const remove = chip.querySelector?.('[data-action="target-remove"]');
        if (remove) {
          remove.title = list.length > 1 ? `移除目标 ${targetLetter(Number(chip.dataset.targetIndex))}` : '一条批注至少保留一个目标';
          remove.disabled = blocked() || list.length < 2;
        }
        const frame = chip.querySelector?.('[data-action="target-frame"]');
        if (frame) {
          const index = Number(chip.dataset.targetIndex);
          const selected = index === frameIndex;
          frame.setAttribute('aria-pressed', String(selected));
          frame.title = selected ? '这个框已在图上选中：拖框内移动，拖 8 个手柄缩放'
            : `选中目标 ${targetLetter(index)} 的框，在图上拖动或缩放`;
          frame.disabled = blocked() || Boolean(linkPick);
        }
      }
      const relationRow = $('.ie-bubble-relation'), relation = $('[data-setting="relation"]');
      if (relationRow) relationRow.hidden = list.length < 2;
      if (relation) { relation.value = state.relation === 'move' ? 'move' : 'same'; relation.disabled = blocked() || list.length !== 2; }
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
      const ocr = $('[data-action="bubble-ocr"]');
      if (ocr) {
        ocr.disabled = blocked() || ocrPending || !ocrRecognize;
        ocr.textContent = !ocrRecognize ? '识别目标文字（A）· 不可用'
          : ocrPending ? '正在识别目标文字（A）…' : '识别目标文字（A）';
        ocr.title = ocrRecognize ? '只识别目标 A 的局部文字；结果可手改，图像一改就作废'
          : '当前版本没有文字识别能力，可直接手填目标文字';
      }
      const full = list.length >= MAX_TARGETS;
      for (const node of [$('[data-action="bubble-add-point"]'), $('[data-action="bubble-add-region"]')]) {
        if (node) node.disabled = blocked() || full;
      }
    }
    // 右栏就是唯一的批注面板：不再计算画布内位置；只负责开合、标题/占位文字与字段同步。
    // textarea 只在换绑另一条批注时回写，避免重建而打断输入法组合串；聚焦也只在换绑时做一次。
    function syncBubble() {
      const node = noteBubble(), field = bubbleField();
      if (!node || !field) return;
      const key = draft ? 'draft' : editing ? `edit:${editing.id}` : '';
      if (!key) { bubbleKey = ''; bubbleTargetsSignature = ''; syncPanel(); schedule(); return; }
      const rebound = bubbleKey !== key;
      if (rebound) {
        bubbleKey = key;
        bubbleTargetsSignature = '';
        field.value = draft ? draft.text : editing.text;
        bubbleMoreOpen = editing ? hasOptionalFields(editing.state) : false;
      }
      const items = annotationList();
      const remove = $('.ie-bubble-delete'), title = $('.ie-bubble-title');
      if (draft) {
        title.textContent = `第 ${items.length + 1} 条批注`;
        remove.hidden = true; field.placeholder = '写这条意见…';
      } else {
        const item = items.find(entry => entry.id === editing.id);
        title.textContent = item ? `第 ${item.number} 条批注` : '这条批注';
        remove.hidden = false; field.placeholder = '改这条意见…';
      }
      field.disabled = blocked() || !image;
      syncBubbleExtras();
      // 先显示面板再聚焦：display:none 的祖先下 focus 不生效，新建/打开批注会不聚焦。
      syncPanel();
      if (rebound) {
        focusBubble();
        try { field.select?.(); } catch { /* 选不了不影响输入。 */ }
      }
      schedule();
    }
    function closeBubble() {
      draft = null; editing = null; bubbleKey = ''; bubbleTargetsSignature = ''; bubbleMoreOpen = false; linkPick = null; frameIndex = null; panelCollapsed = false;
      syncPanel();
      schedule();
    }
    function openDraft(kind, geometry) {
      if (previewMode) return;
      if (blocked() || !image) return;
      if (annotationList().length >= annotationLimits.annotations) { status(`批注最多 ${annotationLimits.annotations} 条`); return; }
      closeBubble(); closeComment();
      // 新点一条就自动把预览切回显示，否则刚点的内容会看不见。
      notesVisible = true;
      const state = emptyBubbleState();
      state.targets = [{ kind, ...(kind === 'point' ? { point: { ...geometry.point } } : { rect: { ...geometry.rect } }) }];
      draft = { text: '', state };
      // 新画的框就是当前框：能直接拖手柄调，不用先去面板里点选。
      frameIndex = kind === 'region' ? 0 : null;
      panelCollapsed = false;
      syncBubble(); sync();
    }
    function openEdit(id, targetIndex) {
      if (previewMode) return;
      if (blocked() || !image) return;
      const op = opById(id);
      if (!op) return;
      closeBubble(); closeComment();
      notesVisible = true;
      editing = { id, text: typeof op.text === 'string' ? op.text : '', state: stateFromRecord(op) };
      // 点的是哪个编号就选中哪一块框（A/B 都行）；点批注点不选框。
      frameIndex = selectFrameIndex(targetIndex, editing.state);
      panelCollapsed = false;
      syncBubble(); sync();
    }
    function selectFrameIndex(index, state) {
      if (!Number.isInteger(index) || !state) return null;
      const target = state.targets[index];
      return target && target.kind === 'region' ? index : null;
    }
    // 保存才是唯一入 ops 的时机：草稿在此之前只在 draft 里，取消不会留下空条目。
    // 旧批注只改字：仍就地写回（不进历史，撤销别的操作不会把文字带走）；
    // 改了目标或可选字段：提交一条 annotation-update 完整快照，撤销/重做都按历史有效版本读。
    function saveBubble(force = false) {
      if (!force && blocked()) return false;
      if (draft) {
        const text = bubbleValue();
        if (!text.trim() && !hasBubbleDetails(draft.state)) { status('先写一句再保存，或填一项操作/当前/期望；不想要这条就点取消'); focusBubble(); return false; }
        const record = recordFromState(draft.state, text);
        record.id = nextAnnotationId();
        commitOp(record);
        pointCount = ops.reduce((sum, op) => sum + (op.points?.length ?? 0), 0);
        status(''); closeBubble(); sync();
        return true;
      }
      if (editing) {
        const text = bubbleValue();
        if (!text.trim() && !hasBubbleDetails(editing.state)) { status('这条意见是空的；写一句或填一项操作/当前/期望，要删掉这条批注请点删除'); focusBubble(); return false; }
        const op = opById(editing.id);
        if (!op) { closeBubble(); sync(); return true; }
        const changed = stateDiffers(editing.state, op);
        if (changed) {
          const snapshot = recordFromState(editing.state, text);
          snapshot.id = editing.id;
          commitOp({ tool: 'annotation-update', id: editing.id, snapshot });
        } else if (op.text !== text) op.text = text;
        status(changed ? '已更新这条批注的目标/说明 · 可用撤销恢复' : '');
        closeBubble(); sync();
        return true;
      }
      return true;
    }
    function cancelBubble() {
      if (!draft && !editing) return;
      // 取消：新点整条丢掉（不留空标记），改旧点保留原文（原文一直在 op 上，从没被写回）。
      closeBubble(); sync();
      try { scroller.focus(); } catch { /* 忽略。 */ }
    }
    // 离开气泡（换工具、点画布、保存/复制、返回预览）前先收拢：有字就存下，空的新点直接丢。
    function resolveBubble(force = false) {
      if (!draft && !editing) return true;
      const value = bubbleValue();
      if (draft) {
        if (value.trim() || hasBubbleDetails(draft.state)) return saveBubble(force);
        closeBubble(); return true;
      }
      if (value !== editing.text || stateDiffers(editing.state, opById(editing.id))) return saveBubble(force);
      closeBubble(); return true;
    }
    function unsavedMessage() {
      const items = annotationList();
      if (draft) return `第 ${items.length + 1} 条批注还没保存：先点面板里的「完成批注」，不要就点「取消」`;
      if (editing) {
        // 只是打开看看、什么都没改，不算未保存。
        const value = bubbleValue();
        if (value === editing.text && !stateDiffers(editing.state, opById(editing.id))) return '';
        const item = items.find(entry => entry.id === editing.id);
        return `${item ? `第 ${item.number} 条` : '这条'}批注正在修改：先点「保存」或「取消」`;
      }
      return '';
    }
    // —— 关联目标选择：气泡先暂藏，选完一个目标再回同一条 ——
    function startLinkPick(kind) {
      if (blocked() || !image || (!draft && !editing) || drag || pan) return;
      const state = bubbleState();
      if (!state) return;
      if (state.targets.length >= MAX_TARGETS) { status(`一条批注最多 ${MAX_TARGETS} 个目标`); return; }
      linkPick = { kind, key: draft ? 'draft' : `edit:${editing.id}` };
      notesVisible = true;
      status(kind === 'point' ? '在图上点一下要关联的位置 · Esc 只取消这次选点' : '在图上拖一个框作为关联区域 · Esc 只取消这次框选');
      syncBubble(); sync();
    }
    function endLinkPick(message = '') {
      if (!linkPick) return;
      linkPick = null;
      if (message) status(message);
      syncBubble(); sync();
      focusBubble();
    }
    function finishLinkPick(geometry) {
      const state = bubbleState();
      if (!state) { linkPick = null; syncBubble(); sync(); return; }
      if (state.targets.length >= MAX_TARGETS) { endLinkPick(`一条批注最多 ${MAX_TARGETS} 个目标`); return; }
      state.targets.push(cloneTargetOf(geometry));
      const total = state.targets.length;
      // 「从A移到B」只允许恰好两个目标；加出第三个就回到「多处同意见」，不假造含义。
      const moved = state.relation === 'move' && total !== 2;
      if (moved) state.relation = 'same';
      linkPick = null;
      // 新关联上的框也直接成为当前框，可以接着拖；关联点不改选中。
      if (geometry.kind === 'region') frameIndex = total - 1;
      syncBubble(); sync();
      focusBubble();
      status(`已关联目标 ${targetLetter(total - 1)}${moved ? '；「从A移到B」只支持两个目标，关系已回到「多处同意见」' : ''}`);
    }
    function removeBubbleTarget(index) {
      const state = bubbleState();
      if (!state || !Number.isInteger(index) || index < 0 || index >= state.targets.length) return;
      if (state.targets.length < 2) { status('一条批注至少保留一个目标'); return; }
      state.targets.splice(index, 1);
      // 选中下标跟着移；被移除的那块不再可调。
      if (frameIndex != null) frameIndex = frameIndex === index ? null : frameIndex > index ? frameIndex - 1 : frameIndex;
      // 主目标换人了：之前从旧 A 识别的文字不能跟着新 A 走。
      const primaryChanged = index === 0;
      const droppedOcr = primaryChanged && state.targetTextAuto;
      if (droppedOcr) { state.targetText = ''; state.targetTextAuto = false; state.targetTextRevision = 0; }
      const moved = state.relation === 'move' && state.targets.length !== 2;
      if (moved) state.relation = 'same';
      syncBubbleExtras(); sync();
      status(`已移除目标 ${targetLetter(index)}${droppedOcr ? '；之前的识别文字来自旧目标 A，已一并作废' : ''}${moved ? '；「从A移到B」只支持两个目标，关系已回到「多处同意见」' : ''}`);
    }
    function setRelation(value) {
      const state = bubbleState();
      if (!state) return;
      if (value === 'move' && state.targets.length !== 2) {
        status(`「从A移到B」只支持恰好两个目标（当前 ${state.targets.length} 个），没有改成这个关系`);
        syncBubbleExtras();
        return;
      }
      state.relation = value === 'move' ? 'move' : 'same';
      syncBubbleExtras();
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
      commitOp({ tool: 'annotation-delete', id });
      if (editing?.id === id) closeBubble();
      status('已删除该条批注，可用撤销恢复');
      sync();
    }
    function toggleNotes() {
      // 只影响编辑器预览：任何导出的图片本来就不带编号/引线/框标记。
      if (!resolveBubble()) return;
      notesVisible = !notesVisible;
      if (!notesVisible) closeBubble();
      status(notesVisible ? '预览已显示批注（仅编辑器内）' : '预览已隐藏批注；保存/复制的图片不含悬浮标记，复制说明区仍保留编号说明');
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
        status('裁切范围没有变化，已取消这次裁切');
        sync(); schedule(); return;
      }
      commitOp({ tool: 'crop', rect: { ...rect } });
      cropDraft = null;
      // 裁切改变画面就保守收起形状选中（工具本来也已不是选择）。
      shapeSelected = null;
      clampScroll(); layout();
      status(`已裁切为 ${rect.width} × ${rect.height} 像素 · 可撤销恢复`);
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
      if (tool === 'rect') return rectCursor;
      if (tool === 'arrow') return arrowCursor;
      return penCursor;            // pen / line 共用一个细笔尖
    }
    function updateCursor() {
      const inside=opened && image && !blocked() && pointer && inImage(pointer);
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
      scroller.style.cursor = pan ? 'grabbing' : spaceDown ? 'grab' : frameHandle ? CROP_CURSORS[frameHandle] : overFrame ? 'move' : tool==='browse' ? (drag?'grabbing':'grab') : tool==='mosaic' ? (brushCursor.hidden?'default':'none') : tool==='crop' ? (handle ? CROP_CURSORS[handle] : overDraft ? 'move' : (pointer&&!inside ? 'default' : 'crosshair')) : tool==='select' ? (shapeHandle ? (shapeHandle.kind === 'resize' ? CROP_CURSORS[shapeHandle.handle] : 'crosshair') : overShape ? 'move' : 'default') : pointer&&!inside ? 'default' : toolCursor();
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
      if (e.target?.closest?.('.ie-toolbar,.ie-bubble,.ie-view-actions')) return;
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
      root.querySelectorAll('[data-tools]').forEach(el => { el.hidden=!el.dataset.tools.split(' ').includes(tool); });
      $('.ie-tool-name').textContent = `${$(`[data-tool="${tool}"]`).textContent}设置`;
      root.querySelectorAll('[data-range]').forEach(el => { el.value=setting(el.dataset.range).value; });
      syncColors();updateCursor();renderMarkers();syncBubbleExtras();
      $('.ie-zoom').textContent = `${Math.round(zoom * 100)}%`;
      // 给宿主一个「状态可能变了」的通知（GIF 编辑器用它刷新自己的时间栏）；
      // 宿主回调抛错绝不能打断原编辑器，也不回写编辑器状态。
      try { onStateChange(); } catch { /* 宿主回调失败不影响编辑器本身。 */ }
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
      spacer.style.width = `${Math.max(scroller.clientWidth, view.width * zoom + 32)}px`;
      spacer.style.height = `${Math.max(scroller.clientHeight, view.height * zoom + 32)}px`;
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
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (points.length === 1) ctx.lineTo(points[0].x + 0.001, points[0].y);
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
          ctx.moveTo(p.x + dx, p.y - dy); ctx.lineTo(q.x + dx, q.y - dy); ctx.lineTo(q.x - dx, q.y + dy); ctx.lineTo(p.x - dx, p.y + dy); ctx.closePath();
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
    // 点批注的编号/引线/空心圈只由 DOM 标记层画。任何导出（保存/复制/thumbnail）都不带批注标记。
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
          // 批注、关联更新、裁切与形状的更新/删除记录都不是笔迹：进历史、可撤销，但不直接进像素。
          if (!op || op.tool === 'annotation' || op.tool === 'annotation-update' || op.tool === 'annotation-delete' ||
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
          for (const target of targets) if (target.kind === 'region') drawNote(ctx, target);
        }
        // 正在拖的新框、正在拖的关联框和还没保存的框草稿都用虚线，提示“还没定下来”。
        const pendingRegion = drag?.op?.tool === 'annotation' && drag.op.kind === 'region' ? drag.op : null;
        const pendingLink = drag?.mode === 'link-region' ? drag.rect : null;
        if (pendingLink && pendingLink.width > 0 && pendingLink.height > 0) drawNote(ctx, { rect: pendingLink }, true);
        if (pendingRegion) drawNote(ctx, pendingRegion, true);
        // 草稿 A 与正在拉的关联 B 共存，不能让临时 B 把未保存的 A 分支跳掉。
        if (draft) for (const target of draftTargets()) if (target.kind === 'region') drawNote(ctx, target, true);
      }
      if (live && cropDraft && tool === 'crop') drawCropDraft(ctx, cropDraft, view);
      ctx.restore();
    }
    function render() {
      frame = 0; if (!opened || !image) return;
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
      // 标记层跟着同一帧的 zoom/scroll 重算；批注表单在右栏，不参与画布定位。
      keepWorkspaceFixed();
      renderMarkers();
    }
    function schedule() { if (!frame && opened) frame = requestAnimationFrame(render); }
    function cancel() {
      const previous = drag; drag = null;
      // 框调整被中断（Esc/pointercancel/lostcapture/blur/关窗）时，几何退回按下那一刻；正常松手已标记 kept。
      if (previous && !previous.kept && (previous.mode === 'frame-move' || previous.mode === 'frame-resize')) restoreFrameDrag(previous);
      if (previous && scroller.hasPointerCapture(previous.id)) scroller.releasePointerCapture(previous.id);
      sync(); schedule();
    }
    function point(e) {
      const rect = scroller.getBoundingClientRect(), o = origin(), view = currentView();
      const x = (e.clientX-rect.left-o.x)/zoom, y = (e.clientY-rect.top-o.y)/zoom;
      return { x: Math.max(view.x, Math.min(view.x + view.width, x)), y: Math.max(view.y, Math.min(view.y + view.height, y)) };
    }
    function inImage(e) {
      const rect = scroller.getBoundingClientRect(), o = origin(), view = currentView();
      const x=e.clientX-rect.left-o.x-view.x*zoom, y=e.clientY-rect.top-o.y-view.y*zoom;
      return x>=0 && y>=0 && x<=view.width*zoom && y<=view.height*zoom;
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
      return noteTools.has(tool) && !linkPick && notesVisible && !blocked() && Boolean(bubbleState()) && frameIndex != null;
    }
    function activeFrameRect() {
      if (!frameAdjustable()) return null;
      const state = bubbleState();
      const target = state.targets[frameIndex];
      return target && target.kind === 'region' ? target.rect : null;
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
    // 松手只留草稿：几何写进暂存状态，点「完成批注」才走既有的 annotation-update（一次可撤销）。
    function finishFrameDrag() {
      const state = bubbleState(), target = state?.targets?.[drag.frameIndex];
      if (!target || target.kind !== 'region') return;
      const label = `目标 ${targetLetter(drag.frameIndex)} 的框`;
      if (sameFrameRect(drag.origin, target.rect)) { status(`没有改动 ${label}`); return; }
      // 主目标 A 的自动识别文字来自旧几何：留着就会和现在的框对不上。
      if (drag.frameIndex === 0 && state.targetTextAuto) {
        state.targetText = ''; state.targetTextAuto = false; state.targetTextRevision = 0;
        bubbleTargetsSignature = '';
        syncBubbleExtras();
        status(`${label}已改 · 之前识别的文字来自旧框，已清空；需要就重新识别或手填 · 点「完成批注」生效`);
        return;
      }
      status(`${label}已改 ${targetText(target)} · 点「完成批注」生效，Esc 取消这次调整`);
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
      // 2) 裁切手柄 / 当前批注框手柄命中优先于“图外拒绝”：
      //    框贴边时手柄有一半在图外，不能因为 inImage 为假就抓不到；
      //    原生滚动条已经在 1) 拦过，这里吞不到它。
      const cropHandle = tool === 'crop' ? cropHandleAt(e) : null;
      const frameHandle = !linkPick && frameAdjustable() ? frameHandleAt(e) : null;
      // 3) 其余非浏览工具仍要求起点在当前画面内（选择工具要能点到贴边手柄）。
      if (tool !== 'browse' && tool !== 'crop' && tool !== 'select' && !inImage(e) && !frameHandle) return;
      // 关联目标选择：这一次左键只加一个目标（中键/空格平移和非主键在上面已经拦过），不动其它批注也不丢字。
      if (linkPick) {
        if (spaceDown || pan || !inImage(e)) return;
        e.preventDefault(); scroller.focus(); closeComment();
        const start = point(e);
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY,
          mode: linkPick.kind === 'point' ? 'link-point' : 'link-region', start };
        if (drag.mode === 'link-region') drag.rect = { x: start.x, y: start.y, width: 0, height: 0 };
        scroller.setPointerCapture(e.pointerId); sync(); schedule(); return;
      }
      // 当前批注框：手柄缩放优先，其次是框内移动；都在 resolveBubble 之前拦下，避免把气泡先收掉。
      if (frameAdjustable() && !spaceDown) {
        if (frameHandle || frameContainsPoint(e)) {
          if (startFrameDrag(e, frameHandle)) return;
        }
      }
      // 画布上的新动作先收拢已开着的气泡：有字就存下，空的新点直接丢，绝不悄悄丢字。
      if (!resolveBubble()) return;
      // 选择工具：手柄→缩放/端点；边线/线身→选中并拖动；空白→取消选中。
      // 左右空白处也算取消选中，但不建 drag、不进历史；预览只读不接。
      if (tool === 'select' && !previewMode && !spaceDown && !pan) {
        const handle = shapeHandleAt(e);
        if (handle) { startShapeDrag(e, handle.shape, handle); return; }
        const hit = topShapeAt(e);
        if (hit) {
          if (hit.id !== shapeSelected) selectShape(hit.id);
          startShapeDrag(e, hit, null);
          return;
        }
        e.preventDefault();
        if (shapeSelected) { selectShape(null); status('已取消选中'); }
        return;
      }
      e.preventDefault(); scroller.focus(); closeComment();
      drag = { id:e.pointerId, x:e.clientX, y:e.clientY };
      if (tool !== 'browse') {
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
            // 点一下就立刻出编号草稿和原位气泡：不等 pointerup，也不用先拖一下。
            drag.mode = 'point';
            openDraft('point', { point: start });
          } else {
            drag.start = start;
            drag.op = { tool:'annotation', kind:'region', id:'', text:'',
              rect: { x:start.x, y:start.y, width:0, height:0 } };
          }
        } else {
          drag.op = { tool, color:setting('color').value, width:number('width',6,1,128), diameter:number('diameter',20,4,128), grain:Math.round(number('grain',12,4,128)), fill:setting('fill').checked, points:[point(e)] };
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
      if (!drag || drag.id !== e.pointerId) return;
      // pointerup normally reports buttons=0; its final sample must still be kept.
      if (e.type === 'pointermove' && !(e.buttons & 1)) { cancel(); return; }
      // 点的位置由按下那一刻定，不跟着指针漂（就不会因为“没拖动”而过不了闸）。
      if (drag.mode === 'point' || drag.mode === 'link-point') return;
      if (drag.mode === 'link-region') {
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
      for (const event of (e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e])) {
        const p=point(event), last=op.points[op.points.length-1];
        if (Math.hypot(p.x-last.x,p.y-last.y)<0.25) continue;
        if (['line','rect','arrow'].includes(op.tool)) op.points[1]=p;
        else if (op.points.length < LIMIT.strokePoints && pointCount + op.points.length < LIMIT.points) op.points.push(p);
        else { cancel(); status('本笔达到点数上限，已取消；请缩短笔画'); return; }
      }
      schedule();
    }
    scroller.addEventListener('pointermove', move);
    scroller.addEventListener('pointerup', e => {
      if (pan && pan.id === e.pointerId) { stopPan(); return; }
      if (!drag || drag.id !== e.pointerId) return;
      move(e); if (!drag) return;
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
          else openDraft('region', { rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
        } else {
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
    scroller.addEventListener('pointercancel', e => { if (pan?.id === e.pointerId) stopPan(); if (drag?.id === e.pointerId) cancel(); });
    scroller.addEventListener('lostpointercapture', e => { if (pan?.id === e.pointerId) stopPan(); if (drag?.id === e.pointerId) cancel(); });
    window.addEventListener('blur', ()=>{ pointer=null; spaceDown=false; stopPan(); cancel(); });
    scroller.addEventListener('scroll', ()=>{updateCursor();schedule();});
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
      // 绘制/拖框进行中禁轮：避免遥相连接误画。
      if (drag) { e.preventDefault(); return; }
      if (!image) return;
      // 工具设置区/气泡里的输入框滚动不拦。
      if (e.target?.closest?.('textarea,input,select,.ie-bubble,.ie-toolbar,.ie-view-actions')) return;
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
        if (op && op.tool !== 'annotation' && op.tool !== 'annotation-update' && op.tool !== 'annotation-delete') count += 1;
      }
      const view = currentView();
      return `${count}:${view.x},${view.y},${view.width},${view.height}`;
    }
    function history(delta) {
      if (previewMode) return;
      if (blocked() || drag) return;
      // 平移还活着时不改历史（也不改视窗），避免 pan 锚点错位。
      if (pan) return;
      const before = currentView(), beforeStamp = pixelStamp();
      const nextCursor=Math.max(0,Math.min(ops.length,cursor+delta));
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
      // 撤销/重做把正在改的那条（或它所在的画面）拿掉时，气泡不能挂在已经不存在的批注上。
      if (editing && !annotationList().some(item => item.id === editing.id)) closeBubble(); else syncBubble();
      sync(); schedule();
    }
    root.addEventListener('input', e => {
      if (blocked()) return;
      // 气泡里的文字只活在输入框（和 draft/editing.text）里，保存时才写回 ops。
      if (e.target?.classList?.contains('ie-bubble-text') || e.target?.classList?.contains('ie-comment')) return;
      // 目标文字：用户手改后就算手填（不再受 OCR 生成时的 revision 限制）。
      if (e.target?.classList?.contains('ie-target-text')) {
        const state = bubbleState();
        if (state) { state.targetText = e.target.value; state.targetTextAuto = false; state.targetTextRevision = 0; }
        targetTextEditCount += 1;
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
      const button=e.target.closest('button'); if (!button || blocked()) return;
      // 预览态只读：工具切换与一切会改内容的按钮都不接（工具栏/面板已隐藏，这里再堵程序化点击）。
      if (previewMode && (button.dataset.tool || PREVIEW_BLOCKED_ACTIONS.includes(button.dataset.action))) return;
      if (animation && ['point','region'].includes(button.dataset.tool)) return;
      if (button.dataset.tool) {
        const nextTool = button.dataset.tool;
        // 鼠标/指针点工具后把焦点交给画布，Space 才能立即当抓手；键盘触发（detail 0）保留按钮焦点。
        const pointerClick = e.detail === undefined ? true : e.detail !== 0;
        if (pointerClick) { try { scroller.focus({ preventScroll: true }); } catch { /* 聚焦失败不影响切工具。 */ } }
        // 平移还活着时不切工具（视图不变）。
        if (pan) return;
        // 重复点同一个工具按钮不能重置正在调整的框/缩放。
        if (nextTool === tool) return;
        // 换工具前先把气泡收拢（有字就存），不留悬空草稿；未确认的裁切也一起取消。
        if (linkPick) endLinkPick('已取消本次关联');
        if (!resolveBubble()) return;
        if (cropDraft) { cropDraft = null; status('已取消未应用的裁切'); }
        closeComment(); cancel(); tool=nextTool;
        // 换走选择工具就不留悬浮选中（回到画布也不抢焦点）。
        if (tool !== 'select') shapeSelected = null;
        // 进裁切先双维度适应整图，并把当前画面作为初始全选框（可直接拖手柄缩小）。
        if (tool === 'crop') { fitImage(); cropDraft = { ...currentView() }; }
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
        case 'panel-collapse': collapsePanel(); break;
        case 'minimize': awaitMinimize(); break;
        case 'panel-resume':
          expandPanel();
          if (draft || editing) focusBubble(); else { try { commentField()?.focus({ preventScroll: true }); } catch { /* 忽略。 */ } }
          break;
        case 'comment':
          if (!resolveBubble()) break;
          commentOpen = !commentOpen;
          panelCollapsed = false;
          if (commentOpen) syncComment();
          else { closeComment(); scroller.focus(); }
          break;
        case 'comment-close': closeComment(); scroller.focus(); break;
        case 'marker':
          // 正在选关联目标时编号不接点击（只是避免选到一半又跳去改别的批注）。
          if (linkPick) break;
          // 点哪个编号就选中哪一块框（草稿也一样），可以直接拖手柄。
          if (button.dataset.draft) {
            frameIndex = selectFrameIndex(Number(button.dataset.targetIndex), draft?.state);
            bubbleTargetsSignature = ''; syncBubbleExtras(); schedule(); focusBubble();
            break;
          }
          openEdit(button.dataset.annotationId, Number(button.dataset.targetIndex));
          break;
        case 'target-frame': {
          const index = Number(button.dataset.targetIndex);
          // 目标按钮只负责选中 A/B 框：选中后直接在图上拖框内/手柄，不再有中间确认步骤。
          frameIndex = index;
          bubbleTargetsSignature = ''; syncBubbleExtras(); schedule();
          status(`已选中目标 ${targetLetter(index)} 的框：框内拖动移动，8 个手柄缩放；「完成批注」保存`);
          break;
        }
        case 'bubble-save': saveBubble(); break;
        case 'bubble-cancel': cancelBubble(); break;
        case 'bubble-delete': if (editing) deleteAnnotation(editing.id); break;
        case 'bubble-add-point': startLinkPick('point'); break;
        case 'bubble-add-region': startLinkPick('region'); break;
        case 'bubble-more-toggle': bubbleMoreOpen = !bubbleMoreOpen; syncBubbleExtras(); break;
        case 'bubble-ocr': recognizeTargetText(); break;
        case 'target-remove': removeBubbleTarget(Number(button.dataset.targetIndex)); break;
        case 'notes-toggle': toggleNotes(); break;
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
          // 保存 = 存到设好的文件夹；另存 = 弹出保存位置；复制 = 单张 PNG 进剪贴板。
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
      // 正在选关联目标：Esc 只取消这一次选点/框选，回到同一条批注（不改任何已写文字）。
      if (linkPick && e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!blocked()) endLinkPick('已取消本次关联，回到这条批注');
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
          if (inBubble) cancelBubble(); else closeComment();
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (blocked()) return;
          if (inBubble) saveBubble(); else closeComment();
          return;
        }
        return;
      }
      // Space 临时抓手：画布目标先拦下原生翻页，再看当前状态否可用；已开始画不转平移。
      // 选关联目标时也允许 Space/中键临时平移（不会误加目标）。
      if ((e.key === ' ' || e.code === 'Space') && !interactiveTarget(e)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (blocked() || !image || drag || commentOpen || ((draft || editing) && !linkPick)) return;
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
      if (!interactiveTarget(e) && (drag || blocked() || draft || editing || commentOpen) && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (blocked()) return;
        // 预览态没有草稿可取消：Esc 直接向宿主申请退出（图仍留在屏上等确认）。
        if (previewMode) { requestExitFromHost(); return; }
        // 形状调整中：先回原几何；已经选中的：再取消选中；都不会退出页面。
        if (drag?.mode === 'shape-move' || drag?.mode === 'shape-resize' || drag?.mode === 'shape-endpoint') {
          cancel(); status('已取消这次调整'); return;
        }
        if (shapeSelected && tool === 'select') { selectShape(null); status('已取消选中'); return; }
        // 正在拖框：Esc 只中断这次调整，几何退回拖动前，面板与文字都留着。
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
        // Esc 优先取消面板里的批注/补充说明；没有的话先撤掉未确认的裁切（并结束手势），再关编辑器。
        if (draft || editing) { cancelBubble(); return; }
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
      // 新 token / reset：批注、草稿、正在改的那条、总体意见和气泡一起清空（同 token 重开不清）。
      annotationSeq=0; linkPick=null; ocrPending=false; ocrToken+=1; pixelRevision+=1;
      closeBubble(); closeComment(); notesVisible=true; cropDraft=null;
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
      // 源记录有多个目标（哪怕 A 被裁掉只剩一个可见）就把字母与坐标写清楚。
      if (note.targetCount > 1 || note.targets.length > 1 || note.mainDead) {
        extras.push(`[目标] ${note.targets.map(target => `${target.letter} ${targetText(target)}`).join('；')}`);
        const missing = Array.from({ length: note.targetCount || note.targets.length }, (_, i) => i)
          .filter(index => !note.targets.some(target => target.index === index)).map(targetLetter);
        if (missing.length) extras.push(`[提示] 目标 ${missing.join('、')} 已裁掉，不提供其坐标；涉及这些目标的关系需重新确认`);
        if (note.targets.length > 1) {
          extras.push(note.relation === 'move' && note.targets.length === 2 ? '[关系] 从A移到B' : '[关系] 多处同意见');
        }
      }
      if (note.mainDead) extras.push('[提示] 主目标 A 不在当前画面：目标文字与局部放大已略过');
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
    function prepareNotes(notes, revision) {
      return notes.map(note => ({ id: note.id, kind: note.kind,
        ...(note.kind === 'point' ? { point: note.point } : { rect: note.rect }),
        text: flattenNoteText(note, revision) }));
    }
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
          label: `局部放大 · 第 ${note.number} 条 A · 来源框 (${coordinateText(source.x)}, ${coordinateText(source.y)}, ${coordinateText(source.width)}, ${coordinateText(source.height)}) · 放大 ${exact ? '' : '约 '}${INSET_PANEL.scale}×`,
          drawWidth, drawHeight });
      }
      return specs;
    }
    // —— OCR：只在用户点「识别目标文字（A）」时，把目标 A 的局部图（compose 之后、已含遮盖）交给宿主 ——
    // 不自己抓屏、不联网、不落盘；临时 PNG 用完即弃，不回传原始位图或 dataUrl。
    const OCR_LIMIT = Object.freeze({ edge: 2048, pixels: 4000000, bytes: 8 * 1024 * 1024 });
    function targetStamp(target) {
      if (!target) return '';
      return target.kind === 'point' ? `point:${target.point.x},${target.point.y}`
        : `region:${target.rect.x},${target.rect.y},${target.rect.width},${target.rect.height}`;
    }
    function ocrRegion() {
      const state = bubbleState();
      if (!state || !state.targets.length) return null;
      const view = currentView(), main = state.targets[0];
      if (main.kind === 'point') {
        if (!pointInside(main.point, view)) return null;
        const width = Math.min(INSET_PANEL.pointWidth, view.width), height = Math.min(INSET_PANEL.pointHeight, view.height);
        return { x: Math.max(0, Math.min(view.width - width, main.point.x - view.x - width / 2)),
          y: Math.max(0, Math.min(view.height - height, main.point.y - view.y - height / 2)), width, height };
      }
      const rect = clipRegion(main.rect, view);
      return rect ? { x: rect.x - view.x, y: rect.y - view.y, width: rect.width, height: rect.height } : null;
    }
    async function recognizeTargetText() {
      if (!ocrRecognize || ocrPending || blocked() || !image) return;
      const state = bubbleState();
      if (!state) return;
      const region = ocrRegion();
      if (!region) { status('目标 A 不在当前画面里，没有可识别的局部；先取消裁切或重新关联后再试'); return; }
      const request = ++ocrToken;
      const captured = { epoch, revision: pixelRevision, key: draft ? 'draft' : editing ? `edit:${editing.id}` : '',
        text: bubbleValue(), targetText: state.targetText, stamp: targetStamp(state.targets[0]),
        edits: targetTextEditCount };
      // 编码 await 之后、发桥之前，以及回包之后，都要确认还是同一张图/同一条批注/同一个目标/没被手改过。
      const stale = () => request !== ocrToken || captured.epoch !== epoch || captured.revision !== pixelRevision ||
        (draft ? 'draft' : editing ? `edit:${editing.id}` : '') !== captured.key || bubbleState() !== state ||
        bubbleValue() !== captured.text || targetStamp(state.targets[0]) !== captured.stamp ||
        targetTextEditCount !== captured.edits || state.targetText !== captured.targetText;
      ocrPending = true; syncBubbleExtras();
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
        crop.width = Math.max(1, Math.floor(region.width * scale));
        crop.height = Math.max(1, Math.floor(region.height * scale));
        const cropContext = crop.getContext('2d');
        if (!cropContext) throw new Error('无法分配识别画布');
        cropContext.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
        const size = { width: crop.width, height: crop.height };
        const blob = await new Promise((resolve, reject) => crop.toBlob(value => value ? resolve(value) : reject(new Error('识别图编码失败')), 'image/png'));
        const png = new Uint8Array(await blob.arrayBuffer());
        if (png.byteLength > OCR_LIMIT.bytes) throw new Error('识别用的局部图超过 8 MiB，请缩小范围');
        if (stale()) return;
        const result = await ocrRecognize({ token, png, width: size.width, height: size.height });
        // 迟到的回复不能写回：换图/撤销/裁切/遮盖/关闭/换目标/手改过文字都算过期。
        if (stale()) return;
        const text = typeof result?.text === 'string' ? result.text : '';
        if (!text.trim()) { status('没有识别到文字，可以手填目标文字'); return; }
        state.targetText = text;
        state.targetTextAuto = true;
        state.targetTextRevision = pixelRevision;
        bubbleMoreOpen = true;
        syncBubbleExtras(); sync();
        status('已识别目标 A 的文字，可以手改；之后图像一有改动，这段文字就不再导出');
      } catch (error) {
        // 过期任务（换图/关窗/换目标/手改）失败不能污染当前编辑器的状态栏。
        if (!stale()) status(`文字识别失败：${error?.message || error}；可以手填目标文字`);
      } finally {
        if (source) source.width = source.height = 0;
        if (crop) crop.width = crop.height = 0;
        if (request === ocrToken) { ocrPending = false; syncBubbleExtras(); }
      }
    }
    // —— 复制说明区 ——
    // 批注不能只复制编号：有批注或总体说明时，把「编号 → 原始坐标 + 全文」画在图片下方，
    // 粘到任何对话里都能直接读懂。上方图片仍是不带悬浮标记的编辑图（保留遮盖与笔迹）；
    // 没批注就仍是原尺寸成图，不额外分配画布。
    const NOTE_PANEL = Object.freeze({ minWidth: 720, gap: 24, margin: 20, bodyMax: 1200, lineHeight: 30, itemGap: 8,
      font: "20px 'Microsoft YaHei UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif" });
    function noteRows(notes, commentText, view) {
      const rows = [{ text: '【截图批注说明】', gap: 0 },
        { text: `图像尺寸：${view.width} × ${view.height} 像素`, gap: 0 },
        { text: '坐标原点 (0, 0) 在图片左上角，单位：像素', gap: 0 },
        { text: '上方截图不含编号悬浮标记；下列坐标基于上方截图，框为 (x, y, 宽, 高)', gap: 0 }];
      for (const note of notes) {
        const at = note.kind === 'point'
          ? `点 (${note.point.x}, ${note.point.y})`
          : `框 (${note.rect.x}, ${note.rect.y}, ${note.rect.width}, ${note.rect.height})`;
        rows.push({ text: `第 ${note.number} 条 · ${at}：${note.text}`, gap: NOTE_PANEL.itemGap });
      }
      if (commentText.trim()) rows.push({ text: `总体说明：${commentText}`, gap: NOTE_PANEL.itemGap });
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
    function notesLayout(ctx, rows, bodyWidth, top) {
      const lines = [];
      let y = top + NOTE_PANEL.gap;
      for (const row of rows) {
        y += row.gap;
        for (const text of wrapLines(ctx, row.text, bodyWidth)) { lines.push({ text, y }); y += NOTE_PANEL.lineHeight; }
      }
      return { lines, height: Math.ceil(y + NOTE_PANEL.margin) };
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
        linkPick = null; ocrPending = false; ocrToken += 1;
        if (!resolveBubble(true)) { syncBubble(); return previewMode; }
        if (commentOpen) closeComment();
        if (cropDraft) { cropDraft = null; status('已取消未应用的裁切'); }
        spaceDown = false; stopPan(); tool = 'browse';
        // 预览只读：不留形状选中，也不留调整手柄。
        shapeSelected = null;
      }
      previewMode = on;
      root.classList.toggle('ie-preview', on);
      root.setAttribute('aria-label', on ? '截图预览' : '图片编辑');
      layout(); sync();
      return previewMode;
    }
    const api = {
      async open(source) {
        if (blocked()) throw new Error('编辑器忙，请稍后重试');
        if (!source || source.token == null) throw new TypeError('图片来源或 token 无效');
        if (image && source.token === token) {
          if (source.warning) warning(source.warning);
          cancel();
          if (opened) savedScroll=[scroller.scrollLeft,scroller.scrollTop];
          else oldFocus=document.activeElement;
          opened=true; root.hidden=false; layout(); scroller.scrollLeft=savedScroll[0]; scroller.scrollTop=savedScroll[1]; scroller.focus(); syncBubble(); return;
        }
        if (typeof source.dataUrl !== 'string' || !source.dataUrl.startsWith('data:image/')) throw new TypeError('新图片需要有效 dataUrl');
        const w=source.width,h=source.height, docToken=source.token, docWarning=String(source.warning ?? '');
        if (!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>LIMIT.edge||h>LIMIT.edge||w*h>LIMIT.pixels) throw new RangeError('图片超过限制：边长 30000 像素、总计 1600 万像素');
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
        // 保存/复制前先把开着的气泡收拢：有字就存进这一条（只进下方说明区，不进上方截图），空白新点直接丢。
        if (!resolveBubble(true)) throw new Error(unsavedMessage() || '这条批注还没保存');
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
        if (!resolveBubble(true)) throw new Error(unsavedMessage() || '这条批注还没保存');
        closeComment();
        exporting=true; sync();
        const request=epoch;
        let canvas=null, insetSource=null;
        try {
          const view=currentView(), crop=cropField();
          const currentNotes=projectedNotes(annotationList(), view), currentComment=commentField()?.value ?? '';
          // 无批注走普通图片出口，不要求批注模型的“至少一条意见”。
          if (!currentNotes.length && !currentComment.trim()) return { token, png: await encodePng(), ...(crop ? { crop } : {}) };
          const model=window.Annotations;
          if (!model) throw new Error('批注模型未加载');
          // 目标/目标文字/模板先按明确标签拼进 text 再过 prepare：交给说明区的仍是这一层结构。
          const prepared=model.prepare({ width:view.width, height:view.height, annotations:prepareNotes(currentNotes, pixelRevision), comment:currentComment });
          const notes=prepared.annotations, commentText=prepared.comment;
          // 先算局部放大：它们决定画布要不要更宽（固定 2×，不降倍率）。
          const insets=insetSpecs(currentNotes, view);
          const insetWidth=insets.reduce((widest, spec) => Math.max(widest, spec.drawWidth), 0);
          const baseWidth=Math.max(view.width, NOTE_PANEL.minWidth);
          const canvasWidth=Math.max(baseWidth, insetWidth ? insetWidth + NOTE_PANEL.margin*2 : 0);
          // 只有真被放大图撑宽时才声明 insetWidth（左右 margin 20 已含在画布宽里）；其余情况旧输出形状不变。
          const declaredInsetWidth=insetWidth && canvasWidth > baseWidth ? insetWidth : 0;
          // 先用 1 像素高量字（行宽、行数、总高），确认放得下再分配真正的大画布。
          canvas=document.createElement('canvas'); canvas.width=canvasWidth; canvas.height=1;
          const measure=canvas.getContext('2d');
          if (!measure) throw new Error('无法分配说明画布');
          measure.font=NOTE_PANEL.font;
          // 行宽跟着新画布宽走：放大图撑宽后，说明文字也用上多出来的宽度。
          const bodyWidth=Math.min(canvasWidth - NOTE_PANEL.margin*2, NOTE_PANEL.bodyMax);
          const layout=notesLayout(measure, noteRows(notes, commentText, view), bodyWidth, view.height);
          // 放大图接在说明文字后面：先算总高（不缩主图、不截说明），放不下就明确失败。
          let total=Math.max(view.height, layout.height - NOTE_PANEL.margin);
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
              : `批注说明要 ${canvasWidth} × ${height} 像素，超过复制上限（边长 ${LIMIT.edge}、总计 ${LIMIT.pixels} 像素）；可关闭「附局部放大」或缩短说明后重试，或直接保存原尺寸截图`);
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
          ctx.restore();
          ctx.fillStyle='#111111'; ctx.font=NOTE_PANEL.font; ctx.textAlign='left'; ctx.textBaseline='top';
          for (const line of layout.lines) ctx.fillText(line.text, NOTE_PANEL.margin, line.y);
          for (const spec of insets) {
            let y=spec.top;
            for (const line of spec.lines) { ctx.fillText(line, NOTE_PANEL.margin, y); y+=NOTE_PANEL.lineHeight; }
            ctx.drawImage(insetSource, spec.source.x, spec.source.y, spec.source.width, spec.source.height,
              NOTE_PANEL.margin, y, spec.drawWidth, spec.drawHeight);
          }
          const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value ? resolve(value) : reject(new Error('PNG 编码失败')),'image/png'));
          const bytes=new Uint8Array(await blob.arrayBuffer());
          if (request!==epoch) throw new Error('导出已取消');
          return { token, png: bytes, clipboardSize: { width: canvasWidth, height, ...(declaredInsetWidth ? { insetWidth: declaredInsetWidth } : {}) }, ...(crop ? { crop } : {}) };
        } finally {
          if (canvas) canvas.width=canvas.height=0;
          if (insetSource) insetSource.width=insetSource.height=0;
          exporting=false; sync();
        }
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
        // 返回预览也不丢字：开着的气泡按保存处理（空白新点直接丢）；正在选关联目标先回到气泡。
        linkPick = null; ocrPending = false; ocrToken += 1;
        if (!resolveBubble(true)) return;
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
        linkPick=null; ocrPending=false; ocrToken+=1;
        if(frame) cancelAnimationFrame(frame); frame=0;
        if(resizeFrame) cancelAnimationFrame(resizeFrame); resizeFrame=0; release(); status(''); sync();
      },
      // 忙碌只锁必要的控件：瞬时状态（选关联目标、OCR 在飞）一起清掉，迟到结果不能写回。
      setBusy(value) {
        locked=Boolean(value);
        if(locked) { spaceDown=false; linkPick=null; ocrPending=false; ocrToken+=1; stopPan(); cancel(); }
        syncBubble(); sync();
      },
      setStatus: status,
      // 只读预览：默认关；宿主（长截图结果页）打开文档后自己决定进不进。
      setPreviewMode,
      get previewMode() { return previewMode; },
      get canRenderFrame() { return Boolean(image && !loading && !exporting && !drag && !cropDraft); },
      get hasEdits() { return cursor>0; }, get isOpen() { return opened; }, get busy() { return blocked(); },
      // 只读：当前裁切矩形（无裁切 undefined，返回副本）与当前输出尺寸（源尺寸在 width/height 里不变）。
      get cropRect() { const crop = cropField(); return crop ? { ...crop } : undefined; },
      get outputSize() { const view = currentView(); return { width: view.width, height: view.height }; }
    };
    root.hidden=true; sync(); return Object.freeze(api);
  };
})();
