'use strict';
// 独立图片编辑窗口的页面胶水：把浏览器里的编辑器接到受限 IPC 上。
// 只做五件事：收到打开指令 → editor.open；编辑器点保存/复制 → 导出后交主进程；
// 「返回预览」→ 交缩略图给主进程（失败就把编辑页放回来）；主进程要导出 → 在页面里导出并回包；
// 长截图结果（presentation='long-result'）默认进同窗只读预览，点「编辑图片」才展开工具。
// 不读文件、不碰剪贴板、不导航、不执行主进程注入的脚本。
(() => {
  const root = document.getElementById('editor-root');
  const host = window.editorHost;
  const editButton = document.getElementById('host-edit');
  let token = '';
  // 宿主自己的显示状态：'long-result' 的文档默认预览，其它文档就是原来的编辑页。
  // 同 token 重开/唤回不再覆盖这里，草稿和当前模式都留在本页。
  let presentation = '';
  let exiting = false;
  let busy = false;

  const editor = window.createImageEditor({
    root,
    onCommit: action => handleCommit(action),
    onClose: () => handleClose(),
    // 编辑态末端「返回预览」：长截图结果回同窗预览，其它文档保持原来的收起语义。
    onPreviewRequest: () => enterPreview(),
    // 预览态 Esc：只申请退出，图片留在屏上等确认面板。
    onExitRequest: () => requestExit('escape-key'),
    // 只有编辑器里显式点了识别才走这里；图片字节由编辑器自己算，本页不缓存。
    recognizeText: payload => host.recognizeText(payload),
    copyText: payload => host.copyText(payload),
    // 顶栏「分段导出」：目录与文件名、写入校验全在主进程，本页只负责按计划逐段编码。
    onSegmentRequest: () => handleSegmentExport()
  });

  const isLongResult = () => presentation === 'long-result';
  // 只读诊断：给隐藏窗口验收核对批注与关系当前状态；不暴露任何可写接口。
  window.__imageEditorDebug = () => editor.debug();

  // 「编辑图片」就放在顶栏输出组的最前面（真实 DOM 顺序：编辑 → 另存 → 保存 → 复制，不靠 CSS order）。
  // 进了编辑器根后，忙碌时 sync() 的通用禁用会自然盖到它上。
  const exportsGroup = root.querySelector('.ie-exports');
  if (editButton && exportsGroup) exportsGroup.prepend(editButton);

  function setStatus(message) {
    try { editor.setStatus(message); } catch { /* 状态栏不可用不影响保留数据。 */ }
  }

  // 右上角的「编辑图片」只在同窗预览时出现；进入编辑就收起，返回预览再出现。
  function syncChrome() {
    const preview = isLongResult() && editor.previewMode === true;
    if (editButton) editButton.hidden = !preview;
  }

  function enterPreview() {
    if (!isLongResult()) {
      // 普通编辑窗：仍是原来的「返回预览」——收起本窗、回到原选区页。
      editor.close();
      return false;
    }
    if (editor.setPreviewMode(true) !== true) {
      setStatus('这条批注还没保存：先点「完成批注」或「取消」，再返回预览');
      return false;
    }
    syncChrome();
    return true;
  }

  function enterEdit() {
    if (!isLongResult()) return false;
    editor.setPreviewMode(false);
    syncChrome();
    return true;
  }

  // 保存/复制：三个动作都要同一张完整成图（含批注说明），再交给主进程做尺寸/裁切校验与写出。
  async function handleCommit(action) {
    if (busy || !token) return;
    busy = true;
    try {
      editor.setBusy(true);
      setStatus(action === 'copy' ? '正在复制…' : action === 'save' ? '正在另存并复制…' : '正在保存并复制…');
      // 三个动作共用同一条合成出口：写盘与发布用同一份字节。
      const edited = await editor.exportClipboard();
      // 实际裁切过才带 crop；主进程会按文档尺寸再严格校验一次。
      const crop = editor.cropRect;
      if (crop) edited.crop = crop;
      const result = await host.commit(action, edited);
      if (result && result.canceled === true) setStatus(`${result.message || '已取消保存'} · 编辑保留，可重新保存或复制`);
      else if (result && result.ok === false) setStatus(`${result.message || (result.errors || []).join('；') || '操作未完成，请重试'} · 编辑保留，可重试`);
      else if (result && result.message) setStatus(result.message);
    } catch (error) {
      setStatus(`未完成：${error?.message || error} · 编辑保留，可重试`);
    } finally {
      busy = false;
      try { editor.setBusy(false); } catch { /* 会话可能已结束，窗口随之关闭。 */ }
    }
  }

  // 分段导出：目录由主进程选，本页只把“复制成图”逐段切下来、编码、交给主进程写盘。
  // 不在内存里留整批 PNG，也不另写一套说明区排版；取消/失败都如实说已写多少张。
  async function handleSegmentExport() {
    if (busy || !token) return;
    if (editor.segmentActive) return;
    const rules = window.SegmentExport;
    if (!rules) { setStatus('分段规则未加载，无法分段导出'); return; }
    if (typeof host.segmentStart !== 'function') { setStatus('当前窗口不支持分段导出'); return; }
    busy = true;
    // 本次导出的文档归属：编码是异步的，中途换图/重开新文档都不能把这一段写到旧批次以外的归属上。
    const docToken = token;
    let batchId = '';
    try {
      const started = await host.segmentStart(token);
      if (!started || started.canceled === true) { setStatus('已取消分段导出，图片和编辑都还在'); return; }
      batchId = started.batchId;
      setStatus('正在准备分段导出…');
      const size = await editor.beginSegmentExport();
      const plan = rules.plan(size.width, size.height);
      // 主进程按同一份规则重算并确认段数：两边不一致就不写任何文件。
      const begun = await host.segmentBegin({ token, batchId, width: plan.width, height: plan.height });
      if (!begun || begun.ok !== true || begun.total !== plan.segments.length) throw new Error('分段计划没有被主进程接受，已停止');
      for (const segment of plan.segments) {
        if (editor.segmentStopped || token !== docToken || !editor.segmentActive) break;
        setStatus(`正在导出第 ${segment.index + 1}/${plan.segments.length} 段…`);
        const part = await editor.exportSegment(segment.index, segment.top, segment.height);
        if (!part || !part.png) throw new Error('这一段没有编码出图片');
        // 编码要花时间（toBlob/arrayBuffer），用户完全可能在这段时间里点了停止：
        // 停止后不再提交任何新写入；已经开始的那一次写盘由主进程写完并如实记账。
        if (editor.segmentStopped || token !== docToken) break;
        const ack = await host.segmentPart({ token: docToken, batchId, index: segment.index, png: part.png.buffer });
        if (!ack || ack.ok !== true) throw new Error('这一段没有被写入');
      }
      if (editor.segmentStopped) {
        const stopped = await host.segmentAbort({ token: docToken, batchId, reason: 'canceled' });
        setStatus(`已停止分段导出：已写 ${stopped?.written ?? 0}/${plan.segments.length} 张，已写的图片留在目标文件夹`);
        return;
      }
      if (token !== docToken) throw new Error('文档已经换了，这次分段导出作废');
      const done = await host.segmentDone({ token: docToken, batchId });
      setStatus(`已导出 ${done.files} 段 PNG 到 ${done.dir} · 分段按原分辨率导出，发送平台仍可能压缩`);
    } catch (error) {
      const message = error?.message || String(error);
      // 失败/取消都问一次主进程已写多少张：不把半次输出说成完成，也不删已写文件。
      let written = 0;
      if (batchId) { try { const stopped = await host.segmentAbort({ token: docToken, batchId, reason: 'failed' }); written = stopped?.written ?? 0; } catch { /* 会话可能已结束。 */ } }
      setStatus(`分段导出未完成：${message} · 已写 ${written} 张，已写好的图片不会被删除`);
    } finally {
      try { editor.endSegmentExport(); } catch { /* 会话可能已结束，窗口随之关闭。 */ }
      busy = false;
    }
  }

  // 返回预览：主进程负责收起本窗、显示原选区页并通知它更新缩略图；被拒就把编辑页放回来。
  // 长截图结果页不走这里（onPreviewRequest 已经把同窗切到预览）。
  async function handleClose() {
    if (!token) return;
    let payload;
    try {
      payload = { token, thumbnail: editor.thumbnail(), outputSize: editor.outputSize };
    } catch (error) {
      setStatus(`返回预览失败：${error?.message || error} · 编辑保留`);
      await reopen();
      return;
    }
    const crop = editor.cropRect;
    if (crop) payload.crop = crop;
    try {
      await host.close(payload);
    } catch (error) {
      setStatus(`返回预览失败：${error?.message || error} · 编辑保留`);
      await reopen();
    }
  }

  async function reopen() {
    try { await editor.open({ token }); } catch (error) {
      root.hidden = false;
      setStatus(`编辑页无法恢复：${error?.message || error}；请保留当前窗口并重试或退出。`);
      throw error;
    }
  }

  // 退出申请：只把 token 与来源交给主进程，确认面板与收尾都归会话层；图不会被先藏起来。
  async function requestExit(source) {
    if (!token || exiting) return false;
    exiting = true;
    try {
      const accepted = await host.requestExit(token, source);
      return accepted === true;
    } catch (error) {
      setStatus(`退出没能确认：${error?.message || error} · 图片仍保留`);
      return false;
    } finally { exiting = false; }
  }

  // 打开指令：同 token 时编辑器只重新显示（不重解码、不丢草稿与操作历史），新 token 才加载新图。
  // 先切好展示形态再回 ready：主进程收到 ready 时窗口还没上屏，第一帧就是预览（不会先闪一下工具栏）。
  async function handleOpen(payload) {
    if (!payload || typeof payload.token !== 'string') return;
    const reopening = token === payload.token;
    token = payload.token;
    presentation = typeof payload.presentation === 'string' ? payload.presentation : '';
    try {
      await editor.open(payload);
      // 同一份文档重开/唤回不覆盖宿主本地模式；只有新文档才按 presentation 决定进不进预览。
      if (!reopening && payload.presentation === 'long-result' && editor.setPreviewMode(true) !== true) {
        throw new Error('结果页没能进入预览');
      }
      syncChrome();
      await host.ready(token);
      // 报送出口只有「复制」：批注会连同坐标和全文画在图片下方，粘到哪里由用户自己决定。
      setStatus(editor.previewMode === true
        ? '长截图预览 · 滚轮查看、Ctrl＋滚轮缩放；要标注就点右上角的「编辑图片」。'
        : '保存各条批注后点「复制」：批注附在图片下方，复制后可粘贴到其他应用。');
    } catch (error) {
      setStatus(`编辑页打开失败：${error?.message || error}`);
      await host.openFailed(token, error?.message || String(error)).catch(() => {});
    }
  }

  // 预览里的保存/复制：主进程发来导出请求，本页按当前画面导出并回包（一次一请求，id 由主进程生成）。
  async function handleExport(request) {
    if (!token || request.token !== token) return;
    try {
      // 三个动作都是同一张完整成图：主进程要的也是带说明区的复制成图。
      const result = await editor.exportClipboard();
      const crop = editor.cropRect;
      if (crop) result.crop = crop;
      await host.exportReply(request.id, true, result);
    } catch (error) {
      await host.exportReply(request.id, false, { message: error?.message || String(error) }).catch(() => {});
    }
  }

  // 右上角「编辑图片」：同一份文档、同一块画布、同一段历史，只把工具区展开。
  if (editButton) editButton.addEventListener('click', () => { enterEdit(); });

  // 预览态右键也申请退出（编辑器自己的右键只用来拦原生菜单，没有内容操作）。
  window.addEventListener('contextmenu', event => {
    if (!isLongResult() || editor.previewMode !== true) return;
    event.preventDefault();
    event.stopPropagation();
    requestExit('context-menu');
  }, true);

  host.onOpen(payload => { handleOpen(payload); });
  host.onExportRequest(request => { if (request && typeof request.id === 'string') handleExport(request); });
})();
