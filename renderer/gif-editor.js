/* Sequential native GIF decoding; pixels live for one frame only. */
(() => {
  'use strict';
  window.createGifEditor = function ({ root, bridge, onClose = () => {}, onStatus = () => {} }) {
    // 上面是播放定位，下面是片段条：定位只动播放头，片段只用来选和删，两件事不再混在一根条上。
    root.innerHTML = `<div class="ge-image"></div><section class="ge-time" aria-label="GIF 播放定位与片段"><p>标记固定位置，对保留的全部帧生效；移动隐私可能遮漏，优先纯色遮盖</p><div class="ge-row"><button data-ge="play">播放</button><button data-ge="prev">上一帧</button><button data-ge="next">下一帧</button><output data-ge="position"></output><output data-ge="duration"></output></div><div class="ge-timeline"><div class="ge-track" data-ge="rail"><input data-ge="seek" type="range" min="0" step="10" value="0" aria-label="播放位置"><span class="ge-pick" data-ge="pick" hidden></span><div class="ge-cut-layer" data-ge="cutLayer" aria-hidden="true"></div><span class="ge-playhead" data-ge="playhead"></span></div><p class="ge-caption">播放定位：紫红短线是切分点，黑线是播放位置；拖动只定位，播放整段内容</p></div><div class="ge-row"><button data-ge="split" title="在播放头处切一刀">切分</button><button data-ge="remove" title="删除下方选中的片段">删除片段</button><button data-ge="undo" title="只撤销时间编辑（切分/删段），画笔、马赛克与空间裁切不受影响">撤销</button><button data-ge="redo" title="只重做时间编辑（切分/删段），画笔、马赛克与空间裁切不受影响">重做</button><button data-ge="cancel" hidden>取消生成</button></div><div class="ge-segments-block"><p class="ge-caption">片段：点一块选中后可删除；宽度示意，实际时长见标签</p><div class="ge-segments" data-ge="segments" role="group" aria-label="片段列表"></div></div><p data-ge="status" role="status"></p></section>`;
    const $ = name => root.querySelector(`[data-ge="${name}"]`);
    const imageRoot=root.querySelector('.ge-image');
    let decoder=null, timeline=null, sourceId=null, epoch=0, index=0, head=0;
    // 切点 cuts=[0,…,总长]：相邻两刀之间就是一个片段。selected 是选中片段序号（null=没选）。
    let cuts=[], selected=null;
    // 时间编辑（切分/删段）共用一份历史：只存时间线快照与切点，不复制像素。
    const MAX_HISTORY=100;
    let past=[], future=[];
    let opening=false, active=false, running=false, ticker=0, wanted=0, seekRevision=0, playRevision=0, playOrigin=0, chain=Promise.resolve(), job=null, pendingFrame=-1, pendingClock=false;
    const status = text => { $('status').textContent=text; onStatus(text); };
    const editor=window.createImageEditor({ root:imageRoot, animation:true, onCommit:()=>exportGif(), onClose:()=>close(),
      // 画笔/裁切/忙碌/取消都会走图片编辑器的 sync，这里只跟着刷新时间栏，不回写编辑器、也不递归。
      onStateChange:()=>refreshFromEditor() });
    const grid = ms => Math.max(0, Math.round(Number(ms)/10)*10);
    const durationMs = () => timeline ? timeline.durationMs : 0;
    // The clock owns the playhead: 10ms steps through the whole timeline, independent of decoding.
    const clockHead = () => Math.min(durationMs()-10, Math.floor(((performance.now()-playOrigin)%durationMs())/10)*10);
    function refreshFromEditor() { if (!timeline || !active) return; sync(); }
    function pause() {
      const wasRunning=running;
      running=false; ++playRevision; clearInterval(ticker); ticker=0; $('play').textContent='播放';
      if (wasRunning && timeline) {
        // Record the current clock position (10ms grid) and show it immediately, not the last decoded frame.
        head=clockHead();
        // A clock decode for a frame the pause point is not in can only repaint the wrong picture.
        if (pendingClock && pendingFrame!==frameAt(head)) { pendingClock=false; pendingFrame=-1; ++seekRevision; }
        sync();
      }
    }
    function segmentRange(slot) {
      if (!timeline || !Number.isSafeInteger(slot) || slot<0 || slot>=cuts.length-1) return null;
      return { from:cuts[slot], to:cuts[slot+1] };
    }
    // 切分位置：必须是 10ms 栅格上的块内点。返回 null 表示这里能切，否则返回原因文案。
    function splitBlockedReason(ms) {
      const total=durationMs();
      if (!Number.isSafeInteger(ms)) return '播放头位置无效';
      if (ms<=0) return '播放头在片头，先在定位条上挪到片段中间';
      if (ms>=total) return '播放头在片尾，先往前挪一点';
      if (ms%10!==0) return '播放头要落在 10ms 栅格上';
      if (cuts.includes(ms)) return '这里已经是切点，换一个位置再切';
      return null;
    }
    function syncSegments() {
      const host=$('segments'), total=durationMs();
      const key=cuts.join(',');
      if (host.dataset.key!==key) {
        host.dataset.key=key;
        host.innerHTML=cuts.slice(0,-1).map((from,slot)=>{
          const to=cuts[slot+1];
          const label=(from/1000).toFixed(2);
          const endLabel=(to/1000).toFixed(2);
          return `<button type="button" class="ge-segment" data-ge="segment" data-index="${slot}" data-from="${from}" data-to="${to}" aria-pressed="false" aria-label="片段 ${slot+1}：${label}–${endLabel} 秒，宽 ${((to-from)/1000).toFixed(2)} 秒"><b>${slot+1}</b><span>${label}–${endLabel}秒</span></button>`;
        }).join('');
        for (const button of host.querySelectorAll('[data-ge="segment"]')) {
          // 宽按时长占比给 flex-basis（扇区宽度只是示意），并扣除块间 gap；短段靠 CSS min-width:56px 保证可点。
          // 用 CSSOM 赋值：内联 style 属性会被页面 CSP 挡掉。
          const from=Number(button.dataset.from), to=Number(button.dataset.to);
          const share=(to-from)/total*100, count=cuts.length-1, gap=2;
          const compensation=count>1 ? (count-1)*gap/count : 0;
          button.style.flexGrow='0';
          button.style.flexShrink='0';
          button.style.flexBasis=`calc(${share.toFixed(4)}% - ${compensation.toFixed(2)}px)`;
          button.addEventListener('click', () => selectSegment(Number(button.dataset.index)));
        }
      }
      // 每 tick 只改属性、不重建节点：否则播放时焦点和 hover 会被一次次抳掉。
      for (const button of host.querySelectorAll('[data-ge="segment"]')) {
        const on=Number(button.dataset.index)===selected;
        button.setAttribute('aria-pressed',String(on));
      }
    }
    // 上方轨道切点层：只画不点（CSS 里 pointer-events:none），所以 seek 的点击、拖动、键盘完全不受影响。
    // 位置一律用 ms/总长 算百分比，与播放头同一套坐标；相邻秒数标签挤在一起时只藏标签，切线一条不少。
    const CUT_LABEL_GAP=6, CUT_LABEL_EDGE=8;
    const trackPercent = ms => { const total=durationMs(); return total>0 ? Math.min(100,Math.max(0,Number(ms)/total*100)) : 0; };
    function syncCuts(total) {
      const layer=$('cutLayer');
      // cuts 的最后一项就是总长，仍把 total 写进键：换了时间线一定重算。
      const key=`${cuts.join(',')}|${total}`;
      if (layer.dataset.key===key) return;
      layer.dataset.key=key;
      // 首尾不是“切出来的点”，不画竖线也不给标签；没有内部切点时这一层就是空的。
      layer.innerHTML=cuts.slice(1,-1).map(ms=>`<span class="ge-cut" data-ge="cut" data-at="${ms}"><span class="ge-cut-line"></span><span class="ge-cut-label"></span></span>`).join('');
      let shown=-Infinity;
      for (const mark of layer.querySelectorAll('[data-ge="cut"]')) {
        const at=Number(mark.dataset.at), percent=trackPercent(at);
        const label=mark.querySelector('.ge-cut-label');
        label.textContent=(at/1000).toFixed(2);
        // 用 CSSOM 赋值：内联 style 属性会被页面 CSP 挡掉。
        mark.style.left=`${percent.toFixed(4)}%`;
        // 太窄时先藏标签：切点是结构信息，露不露秒数都不能少一条线。
        if (percent-shown<CUT_LABEL_GAP) { label.hidden=true; continue; }
        shown=percent;
        // 靠两端的标签换对齐方式，避免半截越出轨道。
        mark.dataset.align=percent<CUT_LABEL_EDGE ? 'start' : percent>100-CUT_LABEL_EDGE ? 'end' : 'mid';
      }
    }
    // 轨道底部的选中高亮：读的就是下方片段条的 selected，无选中就收起来。
    function syncPick(range, total) {
      const pick=$('pick');
      const key=`${range ? `${range.from}-${range.to}` : 'none'}|${total}`;
      if (pick.dataset.key===key) return;
      pick.dataset.key=key;
      if (!range) { pick.hidden=true; return; }
      const from=trackPercent(range.from), to=trackPercent(range.to);
      pick.hidden=false;
      pick.style.left=`${from.toFixed(4)}%`;
      pick.style.width=`${(to-from).toFixed(4)}%`;
    }
    function sync() {
      if (!timeline) return;
      const total=durationMs();
      $('seek').max=total-10; $('seek').value=head;
      $('seek').setAttribute('aria-valuetext',`${(head/1000).toFixed(2)}秒`);
      $('playhead').style.left=`${head/total*100}%`;
      $('position').textContent=`${index+1}/${timeline.frames.length} · ${(head/1000).toFixed(2)}秒`;
      $('duration').textContent=`共 ${(total/1000).toFixed(2)}秒 · ${Math.max(0,cuts.length-1)} 段`;
      syncSegments();
      syncCuts(total);
      syncPick(segmentRange(selected), total);
      // 时间编辑与历史吃同一道门：生成中、空间裁切未应用、绘制未完成都不能改（按钮只是提示，函数里还会再判）。
      const blocked=!active || Boolean(job) || !timeline || !editor.canRenderFrame;
      // 播放定位与选片段也一样禁：不能只拦动作、却让画面和选中先动了。取消生成不受影响。
      for (const name of ['seek','play','prev','next']) $(name).disabled=blocked;
      for (const button of $('segments').querySelectorAll('[data-ge="segment"]')) button.disabled=blocked;
      const splitReason=splitBlockedReason(head);
      const split=$('split');
      split.disabled=blocked || Boolean(splitReason);
      split.title=splitReason || `在 ${(head/1000).toFixed(2)} 秒处切一刀`;
      const range=segmentRange(selected===null?-1:selected);
      const remove=$('remove');
      const whole=Boolean(range) && total-(range.to-range.from)<10;
      remove.disabled=blocked || !range || whole;
      remove.title=!range ? '先在下方点一个片段选中它'
        : whole ? '至少要保留 10ms：不能把整段都删掉' : `删除第 ${selected+1} 段（${(range.from/1000).toFixed(2)}–${(range.to/1000).toFixed(2)} 秒）`;
      $('undo').disabled=blocked || !past.length;
      $('redo').disabled=blocked || !future.length;
      $('cancel').hidden=!job;
    }
    // UI/播放/逐帧全部用虚拟序号；只有真正解码时才换成原图像帧号（删段后两者不再相等）。
    const frameSource = target => timeline?.frames?.[target]?.sourceIndex ?? target;
    function follow(target) {
      // Clock-driven picture update: a late decode may change the picture, never the playhead.
      if (!active || !editor.canRenderFrame) return chain;
      const request=epoch, revision=++seekRevision, current=decoder;
      pendingFrame=target; pendingClock=true;
      chain=chain.catch(()=>{}).then(async () => {
        if (request!==epoch || revision!==seekRevision || !active) return;
        const result=await current.decode({frameIndex:frameSource(target),completeFramesOnly:true});
        try {
          if (request!==epoch || revision!==seekRevision || !active || !editor.canRenderFrame) return;
          if (await editor.replaceFrame(result.image)) { if(request===epoch && revision===seekRevision) { index=target; sync(); } }
        } finally { result.image.close(); if(request===epoch && revision===seekRevision) { pendingClock=false; pendingFrame=-1; } }
      }).catch(error=> { if(request===epoch) { pendingClock=false; pendingFrame=-1; pause(); status(`无法显示帧：${error.message}`); } });
      return chain;
    }
    function tick() {
      if (!running || !active) return;
      if (job || !editor.canRenderFrame) { pause(); return; }
      const next=clockHead(), moved=next!==head;
      head=next;
      if (moved) sync();
      const target=frameAt(head);
      // The clock left the frame a pending decode was asked for (e.g. after a loop), so that decode can never be shown.
      if (pendingClock && pendingFrame!==target) { pendingClock=false; pendingFrame=-1; ++seekRevision; }
      // One pending decode per target frame: slow decoding must not queue the same frame over and over.
      if (target!==index && target!==pendingFrame) void follow(target);
    }
    function startClock() { clearInterval(ticker); ticker=setInterval(tick,30); tick(); }
    function seek(next, stop=true, time) {
      if (stop) pause();
      if (!active || job || !editor.canRenderFrame) return chain;
      wanted=Math.max(0,Math.min(timeline.frames.length-1,Number(next))); const revision=++seekRevision, request=epoch, current=decoder, target=wanted;
      pendingFrame=target; pendingClock=false;
      const point=Math.max(0,Math.min(durationMs()-10,Number.isFinite(time)?time:timeline.frames[target].startMs));
      // 暂停时的 seek 由播放头自己说了算：先把头挪到位并刷新，画面稍后跟上。
      // 切分/选片段读的就是这个头，不能等解码回来才算数。
      if (stop && !running) { head=point; sync(); }
      chain=chain.catch(()=>{}).then(async () => {
        if (request!==epoch || revision!==seekRevision || !active) return;
        const result=await current.decode({frameIndex:frameSource(target),completeFramesOnly:true});
        try {
          if (request!==epoch || revision!==seekRevision || !active || !editor.canRenderFrame) return;
          // A paused seek owns the playhead; while the clock runs it owns the playhead instead, so no rewind or restart.
          if (await editor.replaceFrame(result.image)) { if(request===epoch && revision===seekRevision) { index=target; if(!running) head=point; sync(); } }
        } finally { result.image.close(); if(request===epoch && revision===seekRevision) { pendingClock=false; pendingFrame=-1; } }
      }).catch(error=> { if(request===epoch) { pendingClock=false; pendingFrame=-1; pause(); status(`无法显示帧：${error.message}`); } });
      return chain;
    }
    async function abort(current) {
      if (!current || current.finished) return;
      try { await bridge.edit('abort', current.token ? {token:current.token} : {sourceId:current.sourceId}); }
      catch (error) { if (active) status(`取消生成未完成：${error.message}`); }
    }
    function cancelExport() { if (job) { job.cancelled=true; void abort(job); } }
    function stopClock() { running=false; ++playRevision; clearInterval(ticker); ticker=0; $('play').textContent='播放'; }
    const snapshot = () => ({ timeline, cuts:cuts.slice(), selected, head });
    // 换一份时间线后的统一收尾：作废旧 seek/follow（慢解码不能把已删帧画回来）、复位待显帧，
    // 再按新的切点/播放头重画并 seek。串行 chain 不动，仍在使用中的 decoder 不被换掉。
    function adoptTimeline(next, { cuts: nextCuts, selected: nextSelected=null, head: headMs } = {}) {
      timeline=next;
      cuts=(Array.isArray(nextCuts) && nextCuts.length>=2 ? nextCuts.slice() : [0,next.durationMs]);
      cuts[0]=0; cuts[cuts.length-1]=next.durationMs;
      selected=(Number.isSafeInteger(nextSelected) && nextSelected>=0 && nextSelected<cuts.length-1) ? nextSelected : null;
      head=Math.max(0,Math.min(next.durationMs-10,grid(headMs)));
      stopClock(); ++seekRevision; pendingFrame=-1; pendingClock=false;
      index=frameAt(head); sync();
      void seek(index,true,head);
    }
    function restore(snapshotValue) {
      if (!snapshotValue || !snapshotValue.timeline) return;
      adoptTimeline(snapshotValue.timeline,{ cuts:snapshotValue.cuts, selected:snapshotValue.selected, head:snapshotValue.head });
    }
    function pushHistory() {
      past.push(snapshot());
      if (past.length>MAX_HISTORY) past.shift();
      future.length=0;
    }
    // 选中片段：只移动播放头到这块的第一帧，不改变播放范围，也不动时间线。
    function selectSegment(slot) {
      if (!timeline || !Number.isSafeInteger(slot) || !segmentRange(slot)) return;
      // 与切分/删段同一道门：生成中、裁切草稿未应用、绘制未完成都不换帧。
      if (!canTrim()) return;
      selected=slot;
      const from=cuts[slot];
      pause();
      head=Math.max(0,Math.min(durationMs()-10,from));
      index=frameAt(head); sync();
      void seek(index,true,head);
      status(`已选中片段 ${slot+1}（${(from/1000).toFixed(2)} 秒起）`);
    }
    // 在播放头切一刀：只多一个切点，不丢任何内容；切完自动选中右侧新片段。
    function splitAtPlayhead() {
      if (!canTrim()) return;
      // 先停表再判：播放中 pause 会把头推到实时位置，用旧头判定、再用新头插入会插出重复切点。
      pause();
      const reason=splitBlockedReason(head);
      if (reason) { status(reason); return; }
      pushHistory();
      const at=head;
      cuts=[...cuts,at].sort((left,right)=>left-right);
      selected=cuts.indexOf(at);
      sync();
      status(`已在 ${(at/1000).toFixed(2)} 秒处切分，右侧片段已选中`);
    }
    // 删除选中片段：内容交给 GifTimeline.remove，切点跟着新时钟缩短，其余片段顺序与速度不变。
    function removeSegment() {
      if (!canTrim()) return;
      const slot=selected, range=segmentRange(slot);
      if (!range) { status('先在下方点一个片段选中它，再删除'); return; }
      const total=durationMs(), removed=range.to-range.from;
      if (total-removed<10) { status('至少要保留 10ms：不能把整段都删掉'); return; }
      pause();
      let next;
      try { next=window.GifTimeline.remove(timeline,range.from,range.to); }
      catch (error) { status(`无法删除片段：${error.message}`); return; }
      pushHistory();
      const nextCuts=[];
      for (const cut of cuts) {
        if (cut>range.from && cut<range.to) continue;
        const moved=cut>=range.to ? cut-removed : cut;
        if (nextCuts[nextCuts.length-1]!==moved) nextCuts.push(moved);
      }
      nextCuts[nextCuts.length-1]=next.durationMs;
      const landing=nextCuts.indexOf(range.from);
      const nextSelected=landing>=0 && landing<nextCuts.length-1 ? landing : nextCuts.length-2;
      adoptTimeline(next,{ cuts:nextCuts, selected:nextSelected, head:Math.min(range.from,head) });
      status(`已删除片段 ${slot+1}；其余片段顺序不变，可继续选片段删除或撤销`);
    }
    function undoTime() {
      if (!canTrim() || !past.length) return;
      pause();
      const previous=past.pop();
      future.push(snapshot());
      if (future.length>MAX_HISTORY) future.shift();
      restore(previous);
      status('已撤销时间编辑');
    }
    function redoTime() {
      if (!canTrim() || !future.length) return;
      pause();
      const previous=future.pop();
      past.push(snapshot());
      if (past.length>MAX_HISTORY) past.shift();
      restore(previous);
      status('已重做时间编辑');
    }
    function reset({ committed=false }={}) {
      ++epoch; ++seekRevision; pause(); chain=Promise.resolve(); pendingFrame=-1; pendingClock=false;
      if (job) { if(committed) job.finished=true; else { job.cancelled=true; void abort(job); } }
      job=null; opening=false; active=false; root.hidden=true; editor.reset(); decoder?.close(); decoder=null; timeline=null; sourceId=null;
      cuts=[]; selected=null; past.length=0; future.length=0;
      $('segments').dataset.key=''; $('segments').innerHTML='';
      $('cutLayer').dataset.key=''; $('cutLayer').innerHTML=''; $('pick').dataset.key=''; $('pick').hidden=true;
    }
    async function close() { reset(); try { await bridge.action('edit-close'); } finally { onClose(); } }
    async function open(source) {
      reset(); const request=epoch; opening=true; onStatus('正在打开 GIF 编辑…');
      try {
        if (!source?.sourceId || typeof bridge.edit!=='function' || !window.ImageDecoder) throw new Error('当前环境不支持 GIF 编辑，原 GIF 仍可保存');
        timeline=window.GifTimeline.parse(source.bytes);
        if (timeline.width!==source.width || timeline.height!==source.height) throw new Error('GIF 尺寸不一致');
        sourceId=source.sourceId; cuts=[0,timeline.durationMs]; selected=null; index=0; head=0;
        const current=new ImageDecoder({type:'image/gif',data:source.bytes}); decoder=current;
        await current.completed;
        await current.tracks.ready;
        if(request!==epoch) return;
        if(current.tracks.selectedTrack.frameCount!==timeline.frames.length) throw new Error('GIF 帧数不一致');
        const result=await current.decode({frameIndex:0,completeFramesOnly:true});
        let dataUrl;
        try { if(request!==epoch) return; const canvas=document.createElement('canvas'); canvas.width=timeline.width; canvas.height=timeline.height; try {canvas.getContext('2d').drawImage(result.image,0,0); dataUrl=canvas.toDataURL('image/png');} finally {canvas.width=canvas.height=0;} }
        finally {result.image.close();}
        if(request!==epoch) return;
        await bridge.action('edit');
        if(request!==epoch) return;
        active=true; root.hidden=false;
        await editor.open({token:sourceId,width:timeline.width,height:timeline.height,dataUrl});
        if(request!==epoch) return;
        opening=false; status(''); sync();
      } catch(error) { if(request===epoch) { reset(); onClose(); onStatus(`无法编辑：${error.message}`); try {await bridge.action('edit-close');} catch {} } }
    }
    async function exportGif() {
      if (!active || job) return;
      pause();
      const currentJob={sourceId,token:null,cancelled:false,finished:false}; job=currentJob; sync();
      await chain;
      if (!active || job!==currentJob) return;
      if (!editor.canRenderFrame || currentJob.cancelled) { job=null; sync(); status(currentJob.cancelled ? '已取消生成，编辑草稿保留' : '请先应用或取消裁切，并完成绘制'); return; }
      const request=epoch, current=decoder;
      // 切分只是切点，不改变输出；导出永远是当前时间线的 0..总长。
      const frames=window.GifTimeline.trim(timeline,0,durationMs());
      // 帧清单在开编时冻结；总时长用各帧时长相加，主进程的 elapsedMs 校验只看这份真实序列。
      const totalMs=frames.reduce((sum,frame)=>sum+frame.durationMs,0);
      const check=()=> {if(request!==epoch || currentJob.cancelled) throw new Error('已取消生成，原 GIF 与编辑草稿保留');};
      editor.setBusy(true); sync(); status('正在应用编辑…');
      try {
        const size=editor.outputSize;
        const result=await bridge.edit('begin',{sourceId:currentJob.sourceId,...size,frames:frames.length,durationMs:totalMs});
        currentJob.token=result.token; check();
        for (const frame of frames) {
          check(); const decoded=await current.decode({frameIndex:frame.index,completeFramesOnly:true});
          try { check(); const rendered=editor.renderFrame(decoded.image); await bridge.edit('frame',{token:currentJob.token,rgba:rendered.rgba,elapsedMs:frame.elapsedMs}); }
          finally { decoded.image.close(); }
          await new Promise(resolve=>setTimeout(resolve,0)); check();
        }
        await bridge.edit('finish',{token:currentJob.token});
        currentJob.finished=true;
        // The new preview event owns resetting this controller, never replay old bytes.
      } catch(error) {
        await abort(currentJob);
        if(request===epoch) status(`生成未完成：${error.message}`);
      } finally {
        if(request===epoch) {job=null; editor.setBusy(false); sync();}
      }
    }
    imageRoot.addEventListener('pointerdown',pause,true);
    $('play').addEventListener('click',async()=> {
      if(running) return pause();
      if(!active || !editor.canRenderFrame || job) return;
      const request=epoch, revision=++playRevision;
      await chain;
      if(request!==epoch || revision!==playRevision || !active || job || !editor.canRenderFrame) return;
      // 点位与虚拟序号一起判：删段后原位置可能已被剪掉，序号也可能越界。
      const valid=head>=0 && head<durationMs() && Number.isSafeInteger(index) && index>=0 && index<timeline.frames.length;
      if(!valid) await seek(frameAt(0),false,0);
      if(request!==epoch || revision!==playRevision || !active || job || !editor.canRenderFrame) return;
      running=true; playOrigin=performance.now()-head;
      $('play').textContent='暂停'; startClock();
    });
    $('prev').addEventListener('click',()=>seek(index-1)); $('next').addEventListener('click',()=>seek(index+1));
    function frameAt(ms) { return timeline.frames.findLast(frame=>frame.startMs<=ms)?.index ?? 0; }
    function canTrim() {
      if(!active || job || !timeline) return false;
      if(!editor.canRenderFrame) { pause(); status('请先应用或取消空间裁切，并完成绘制，再调整时间'); return false; }
      return true;
    }
    // Dragging the rail stops the clock first; otherwise the next tick writes its own playhead back over the drag.
    $('seek').addEventListener('pointerdown',pause);
    $('seek').addEventListener('input',()=> {
      if(!canTrim()) { sync(); return; }
      const time=grid(Math.max(0,Math.min(durationMs()-10,Number($('seek').value))));
      status(''); void seek(frameAt(time),true,time);
    });
    $('split').addEventListener('click',splitAtPlayhead);
    $('remove').addEventListener('click',removeSegment);
    $('undo').addEventListener('click',undoTime);
    $('redo').addEventListener('click',redoTime);
    $('cancel').addEventListener('click',cancelExport);
    root.querySelector('.ge-time').addEventListener('keydown',event=> {if(event.key==='Escape') {event.preventDefault();event.stopPropagation(); if(job) cancelExport(); else void close();}});
    window.addEventListener('blur',()=> { if(running) pause(); });
    window.addEventListener('beforeunload',()=>reset());
    root.hidden=true;
    return Object.freeze({open,reset,close,get isOpen(){return active || opening;},get isLoading(){return opening;},get busy(){return Boolean(job);}});
  };
})();
