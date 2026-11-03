const COLUMNS = 48;
export const MAX_PIXELS = 16_000_000;
export const MAX_HEIGHT = 30000;

export function fingerprint({ data, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 48 || data.length !== width * height * 4) {
    throw new RangeError('选区至少需要 16 × 48 像素');
  }
  const rows = new Uint8Array(height * COLUMNS);
  const ranges = new Uint8Array(height), detail = new Uint8Array(height * COLUMNS);
  const background = new Uint8Array(height * 4), backgroundDetail = new Uint8Array(height * 4);
  const gray = (x, y) => {
    const i = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  };
  for (let y = 0; y < height; y++) {
    let min = 255, max = 0;
    for (let c = 0; c < COLUMNS; c++) {
      // 避开两侧边框与滚动条，不在纵向缩放，保留单像素位移精度。
      const x = Math.min(width - 1, Math.floor(width * (.06 + .88 * (c + .5) / COLUMNS)));
      const i = (y * width + x) * 4;
      const value = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      rows[y * COLUMNS + c] = value;
      detail[y * COLUMNS + c] = Math.max(Math.abs(value - gray(x - 2, y)), Math.abs(value - gray(x + 2, y)),
        Math.abs(value - gray(x, y - 2)), Math.abs(value - gray(x, y + 2)));
      min = Math.min(min, value); max = Math.max(max, value);
    }
    ranges[y] = max - min;
    for (let c = 0; c < 4; c++) {
      const x = Math.floor(width * [.01, .03, .97, .99][c]), value = gray(x, y);
      background[y * 4 + c] = value;
      backgroundDetail[y * 4 + c] = Math.max(Math.abs(value - gray(x - 2, y)), Math.abs(value - gray(x + 2, y)),
        Math.abs(value - gray(x, y - 2)), Math.abs(value - gray(x, y + 2)));
    }
  }
  return { rows, ranges, detail, background, backgroundDetail, width, height };
}
function rowError(a, ay, b, by) {
  let error = 0;
  for (let c = 0; c < COLUMNS; c++) error += Math.abs(a.rows[ay * COLUMNS + c] - b.rows[by * COLUMNS + c]);
  return error / COLUMNS;
}
function score(a, b, shift, coarse) {
  const guard = Math.max(2, Math.floor(a.height * .08));
  const start = Math.max(guard, guard - shift);
  const end = Math.min(a.height - guard, a.height - guard - shift);
  if (end - start < a.height * .25) return null;
  const step = coarse ? Math.max(1, Math.floor((end - start) / 28)) : 1;
  let sum = 0, count = 0, matches = 0;
  for (let y = start; y < end; y += step) {
    if (a.ranges[y + shift] < 12 && b.ranges[y] < 12) continue;
    const error = rowError(a, y + shift, b, y);
    sum += Math.min(error, 40);
    count++;
    if (error <= 10) matches++;
  }
  if (count < (coarse ? 4 : Math.min(12, (end - start) / 8))) return null;
  return { error: sum / count, coverage: matches / count };
}
function flatTail(frame) {
  const color = frame.rows[(frame.height - 1) * COLUMNS];
  let length = 0;
  for (let y = frame.height - 1; y >= 0; y--) {
    if (frame.ranges[y] > 3 || Math.abs(frame.rows[y * COLUMNS] - color) > 2) break;
    length++;
  }
  return { length, color };
}
function fixedEdge(a, b, shift) {
  // 大块同色底部无法可靠区分正文留白和纯色固定栏，宁可停住，不追加可疑底条。
  const tailA = flatTail(a), tailB = flatTail(b);
  const minFlatBand = Math.max(16, Math.ceil(a.height * .05));
  if (tailA.length >= minFlatBand && tailB.length >= minFlatBand && Math.abs(tailA.color - tailB.color) <= 2) {
    return { edge: '底部', uncertain: true };
  }
  const band = Math.floor(a.height * .18);
  // 底部优先：顶部固定不影响取底部新行，但底栏会污染新增条。
  for (const [name, start, end] of [['底部', a.height - band, a.height], ['顶部', 0, band]]) {
    let stationary = 0;
    for (let y = start; y < end; y++) {
      const moved = y + shift < a.height ? y + shift : y - shift;
      if (moved < 0 || moved >= a.height || a.ranges[y] < 16) continue;
      if (rowError(a, y, b, y) < 1.5 && rowError(a, moved, b, y) > 10) stationary++;
    }
    if (stationary >= (name === '底部' ? 1 : 4)) return { edge: name };
  }
  return null;
}

// 基准必须始终是最后接受的最远帧，不能被反向／失败帧替换。
function detectRawShift(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { kind: 'invalid' };
  let unchanged = 0;
  for (let y = 0; y < a.height; y++) unchanged += rowError(a, y, b, y);
  if (unchanged / a.height < .8) return { kind: 'still' };
  const limit = Math.floor(a.height * .65);
  const candidates = [];
  for (let shift = -limit; shift <= limit; shift++) {
    const s = score(a, b, shift, true);
    if (s && s.error < 12 && s.coverage >= .75) candidates.push({ shift, ...s });
  }
  candidates.sort((x, y) => x.error - y.error);
  const valid = candidates.slice(0, 8).map(item => ({ shift: item.shift, ...score(a, b, item.shift, false) }))
    .filter(item => Number.isFinite(item.error) && item.error <= 6 && item.coverage >= .85)
    .sort((x, y) => x.error - y.error);
  if (!valid.length) return { kind: 'unmatched' };
  const best = valid[0];
  if (valid.some(other => Math.abs(other.shift - best.shift) >= 1 && other.error - best.error < .5)) return { kind: 'ambiguous' };
  if (best.shift === 0) return { kind: 'still' };
  if (best.shift < 0) return { kind: 'reverse', shift: best.shift };
  const edge = fixedEdge(a, b, best.shift);
  if (edge?.edge === '顶部') {
    // 顶栏只留在首帧；放行前额外逐行核对拼接缝的尾部重叠，防薄底栏漏检。
    const band = Math.floor(a.height * .18);
    // 用已确认在滚动的正文行给顶栏范围划保守上界，不能把检测用18%当成实际顶栏高度。
    let headerEnd, movingRows = 0;
    for (let y = 0; y < a.height - best.shift; y++) {
      if (rowError(a, y, b, y) > 10 && rowError(a, y + best.shift, b, y) <= 6 && ++movingRows >= 4) {
        headerEnd = y + 1; break;
      }
    }
    let tailAligned = Number.isInteger(headerEnd) && a.height - best.shift > headerEnd;
    for (let y = Math.max(best.shift + (headerEnd ?? a.height), a.height - band); y < a.height; y++) {
      if (rowError(a, y, b, y - best.shift) > 8) { tailAligned = false; break; }
    }
    if (tailAligned) return { kind: 'forward', shift: best.shift, error: best.error, fixedTop: true, headerRows: headerEnd };
  }
  if (edge) return { kind: 'fixed', shift: best.shift, ...edge };
  return { kind: 'forward', shift: best.shift, error: best.error };
}

// 只对存在分散、平滑且同坐标稳定底纹的画面启用前景投票；不学习停住的正文。
function hasStationaryBackground(a, b) {
  if (!a.background || !b.background) return false;
  let points = 0, rows = 0;
  const vertical = new Set(), sides = new Set(), step = Math.max(1, Math.floor(a.height / 80));
  for (let y = 3; y < a.height - 3; y += step) {
    let rowPoints = 0;
    for (let c = 0; c < 4; c++) {
      const i = y * 4 + c;
      if (Math.abs(a.background[i] - b.background[i]) > 2 || a.backgroundDetail[i] > 8 || b.backgroundDetail[i] > 8) continue;
      const range = Math.abs(a.background[i - 12] - a.background[i + 12]);
      if (range < 2 || range > 32) continue;
      rowPoints++; points++; vertical.add(Math.floor(y * 4 / a.height)); sides.add(c < 2 ? 0 : 1);
    }
    if (rowPoints) rows++;
  }
  return points >= 24 && rows >= 6 && vertical.size >= 2 && sides.size === 2;
}
function patchError(a, ay, b, by, column) {
  let sum = 0, minA = 255, maxA = 0, minB = 255, maxB = 0;
  const baseA = a.rows[ay * COLUMNS + column], baseB = b.rows[by * COLUMNS + column];
  for (let dy = -1; dy <= 1; dy++) for (let dc = -1; dc <= 1; dc++) {
    const valueA = a.rows[(ay + dy) * COLUMNS + column + dc], valueB = b.rows[(by + dy) * COLUMNS + column + dc];
    sum += Math.abs((valueA - baseA) - (valueB - baseB));
    minA = Math.min(minA, valueA); maxA = Math.max(maxA, valueA);
    minB = Math.min(minB, valueB); maxB = Math.max(maxB, valueB);
  }
  // 以双方较弱的局部对比度衡量字形噪声；只影响匹配，不改变输出像素。
  // 96以下沿用原误差，高对比度块最多放宽255/96倍，仍须满足分布、唯一性及固定结构门。
  return (sum / 9) * 96 / Math.max(96, Math.min(maxA - minA, maxB - minB));
}
// 每对帧只算一次与位移无关的候选列资格：b 侧局部对比、b.detail、a/b 同坐标差异。
// 每位移只走这些列（顺序仍按列号升序，累加顺序与原逐列过滤完全一致），
// 另外把与位移相关但只依赖行号的后两条门槛（a.detail[old]、|a.rows[old]-b.rows[old]|）预计算成 typedarray。
function foregroundProbe(a, b) {
  const cells = a.height * COLUMNS, shifted = new Uint8Array(cells), lists = new Array(a.height);
  for (let y = 0; y < a.height; y++) {
    const list = [];
    for (let c = 1; c < COLUMNS - 1; c += 2) {
      const i = y * COLUMNS + c, value = b.rows[i], left = b.rows[i - 1], right = b.rows[i + 1];
      if ((value - left) * (value - right) <= 0 || Math.min(Math.abs(value - left), Math.abs(value - right)) < 12 ||
          b.detail[i] < 12 || Math.abs(a.rows[i] - value) < 12) continue;
      list.push(c);
    }
    lists[y] = list;
  }
  // 这里的下标就是查询时用的 old（(y+shift)*COLUMNS+c），存的是原判定的 a.detail[old]>=12 与 |a.rows[old]-b.rows[old]|>=12；
  // 它不参与同屏位置（i）的筛选——那是原实现里没有的门槛。
  for (let i = 0; i < cells; i++) if (a.detail[i] >= 12 && Math.abs(a.rows[i] - b.rows[i]) >= 12) shifted[i] = 1;
  return { shifted, lists };
}
function foregroundScore(a, b, shift, coarse, probe) {
  const guard = Math.max(3, Math.floor(a.height * .08));
  const start = Math.max(guard, guard - shift), end = Math.min(a.height - guard, a.height - guard - shift);
  if (end - start < a.height * .25) return null;
  const step = coarse ? Math.max(1, Math.floor((end - start) / 40)) : 1;
  const { shifted, lists } = probe;
  let eligible = 0, matches = 0, sum = 0;
  const rows = new Set(), columns = new Set(), rowGroups = new Set(), columnGroups = new Set();
  for (let y = start; y < end; y += step) {
    const list = lists[y];
    for (let k = 0; k < list.length; k++) {
      const c = list[k], old = (y + shift) * COLUMNS + c;
      // 与原条件同序：仍逐项核 a.detail[old]>=12 与 |a.rows[old]-b.rows[old]|>=12。
      if (!shifted[old]) continue;
      const error = patchError(a, y + shift, b, y, c);
      eligible++; sum += Math.min(error, 40);
      if (error <= 6) {
        matches++; rows.add(y); columns.add(c);
        rowGroups.add(Math.min(3, Math.floor((y - start) * 4 / (end - start)))); columnGroups.add(Math.floor(c / 12));
      }
    }
  }
  if (!eligible) return null;
  return { shift, error: sum / eligible, coverage: matches / eligible, matches, movingRows: rows.size,
    movingColumns: columns.size, rowGroups: rowGroups.size, columnGroups: columnGroups.size,
    columnStart: Math.min(...columns), columnEnd: Math.max(...columns) };
}
function rowPatchError(a, b, y, c) {
  let sum = 0;
  for (let dc = -1; dc <= 1; dc++) {
    const i = y * COLUMNS + Math.max(0, Math.min(COLUMNS - 1, c + dc));
    sum += Math.abs(a.rows[i] - b.rows[i]);
  }
  return sum / 3;
}
function foregroundFixedEdge(a, b, shift, raw, columnStart, columnEnd) {
  // 已证实正文水平范围外的装饰留边，不用于否决正文运动；宽结构边界仍按全宽核对。
  const inContent = c => c >= columnStart - 1 && c <= columnEnd + 1;
  const band = Math.floor(a.height * .18), suspects = [];
  for (let y = 2; y < a.height; y++) {
    // 上下邻行的字形可令空白行detail很高；它不构成这一行自己的固定纹理。
    if (a.ranges[y] < 16 || b.ranges[y] < 16) continue;
    const counts = new Uint8Array(256);
    for (let c = 0; c < COLUMNS; c++) counts[b.rows[y * COLUMNS + c]]++;
    const moved = y + shift < a.height ? y + shift : y - shift;
    if (moved < 0 || moved >= a.height) continue;
    const columns = [], wideColumns = [];
    for (let c = 0; c < COLUMNS; c++) {
      const i = y * COLUMNS + c, source = moved * COLUMNS + c;
      if (counts[b.rows[i]] > COLUMNS / 2 || a.detail[i] < 16 || b.detail[i] < 16 || rowPatchError(a, b, y, c) > 2 ||
          !(Math.abs(a.rows[source] - b.rows[i]) > 10 || a.detail[source] + 8 < b.detail[i])) continue;
      wideColumns.push(c);
      const left = b.rows[y * COLUMNS + Math.max(0, c - 1)], right = b.rows[y * COLUMNS + Math.min(COLUMNS - 1, c + 1)];
      if (Math.max(left, b.rows[i], right) - Math.min(left, b.rows[i], right) >= 16) columns.push(c);
    }
    // 本行字形与跨宽度的栏边界分开；邻行文字带来的高detail不证明本行白底固定。
    const nearEdge = y < band || y >= a.height - band;
    const contentColumns = columns.filter(inContent);
    const evidence = wideColumns.length >= COLUMNS * .75 ? wideColumns : nearEdge && contentColumns.length >= 3 &&
      (rowError(a, y, b, y) < 1.5 || contentColumns.length >= 12) ? contentColumns : [];
    if (evidence.length) suspects.push({ edge: y < band ? '顶部' : '底部', y, columns: evidence, detailed: true,
      minimum: Math.max(3, Math.ceil(evidence.length * .75)) });
  }
  // 跨宽度、连续多行保持同一静止剖面的实体带，不能随留边一起豁免。
  // 用空间连续性补柔和低对比度栏；不靠一行纸面或某个留边纹理否决整个正文。
  let profileStart = 0, profileRun = 0;
  for (let y = 0; y < a.height; y++) {
    if (!profileRun) profileStart = y;
    const columns = [];
    if (a.ranges[y] >= 8 && b.ranges[y] >= 8) for (let c = 0; c < COLUMNS; c++) {
      const i = y * COLUMNS + c, first = profileStart * COLUMNS + c;
      if (Math.abs(a.rows[i] - b.rows[i]) <= 2 && Math.abs(a.rows[i] - a.rows[first]) <= 2 &&
          Math.abs(b.rows[i] - b.rows[first]) <= 2) columns.push(c);
    }
    profileRun = columns.length >= COLUMNS - 2 ? profileRun + 1 : 0;
    if (profileRun >= 16 && y >= a.height - band) {
      const counts = new Uint8Array(256);
      for (let c = 0; c < COLUMNS; c++) counts[b.rows[y * COLUMNS + c]]++;
      // 空白不能凑宽度：窄纹饰加大片同色留白，不构成跨宽度的实体剖面。
      const evidence = columns.filter(c => counts[b.rows[y * COLUMNS + c]] <= COLUMNS / 2);
      if (evidence.length >= COLUMNS / 2 && new Set(evidence.map(c => Math.floor(c / 12))).size >= 3) {
        suspects.push({ edge: '底部', y, columns: evidence, detailed: false, profileStart: y - 15,
          minimum: Math.max(COLUMNS / 2, evidence.length - 2) });
      }
    }
  }
  // 原灰度门的静止证据不能因为局部细节低就消失，柔和渐变栏也保留否决。
  for (const distance of new Set([shift, raw.kind === 'fixed' ? raw.shift : shift])) {
    for (const [edge, start, end] of [['底部', a.height - band, a.height], ['顶部', 0, band]]) {
      for (let y = start; y < end; y++) {
        const moved = y + distance < a.height ? y + distance : y - distance;
        if (moved < 0 || moved >= a.height || a.ranges[y] < 16 || rowError(a, moved, b, y) <= 10) continue;
        const counts = new Uint8Array(256), columns = []; let stable = 0;
        let minA = 255, maxA = 0, minB = 255, maxB = 0;
        for (let c = 0; c < COLUMNS; c++) counts[b.rows[y * COLUMNS + c]]++;
        for (let c = 0; c < COLUMNS; c++) {
          const i = y * COLUMNS + c;
          // 静止的半透明纸面可能只残留微弱底纹，辨识度要取正文范围内双方自身，不能借留边或旧字。
          if (c >= columnStart && c <= columnEnd) {
            minA = Math.min(minA, a.rows[i]); maxA = Math.max(maxA, a.rows[i]);
            minB = Math.min(minB, b.rows[i]); maxB = Math.max(maxB, b.rows[i]);
          }
          // 先逐列收集稳定性，不能让无关单点闪烁用整行均值抹掉低频证据。
          if (Math.abs(a.rows[i] - b.rows[i]) <= 2) {
            stable++;
            if (inContent(c) && counts[b.rows[i]] <= COLUMNS / 2) columns.push(c);
          }
        }
        if (stable >= COLUMNS - 2 && columns.length && maxA - minA >= 16 && maxB - minB >= 16) suspects.push({ edge, y, columns, detailed: false,
          minimum: Math.max(1, Math.ceil(columns.length * .75)) });
      }
    }
  }
  return suspects;
}
function foregroundMatches(a, b) {
  // 候选列资格与位移无关：一对帧只建一次，所有候选位移共用。
  const probe = foregroundProbe(a, b);
  const limit = Math.floor(a.height * .65), candidates = [];
  for (let shift = -limit; shift <= limit; shift++) {
    if (!shift) continue;
    const result = foregroundScore(a, b, shift, true, probe);
    if (result && result.matches >= 3 && result.coverage >= .55 && result.error < 14) candidates.push(result);
  }
  candidates.sort((x, y) => x.error - y.error || y.coverage - x.coverage);
  const valid = candidates.slice(0, 8).map(item => foregroundScore(a, b, item.shift, false, probe))
    .filter(item => item && item.matches >= Math.max(24, a.height * .1) && item.movingRows >= Math.max(12, a.height * .03) &&
      item.movingColumns >= 6 && item.rowGroups >= 3 && item.columnGroups >= 3 && item.coverage >= .8 && item.error <= 6)
    .sort((x, y) => x.error - y.error || y.coverage - x.coverage);
  return valid;
}
export function detectShift(a, b, history) {
  const raw = detectRawShift(a, b);
  if (['invalid', 'still', 'reverse'].includes(raw.kind) || raw.uncertain || !hasStationaryBackground(a, b)) return raw;
  const valid = foregroundMatches(a, b);
  if (!valid.length) return raw.kind === 'forward' ? { kind: 'unmatched', foreground: true } : raw;
  const best = valid[0];
  if (valid.some(other => other.shift !== best.shift && other.error - best.error < .5)) return { kind: 'ambiguous', foreground: true };
  const result = { kind: best.shift > 0 ? 'forward' : 'reverse', shift: best.shift, error: best.error, coverage: best.coverage,
    movingRows: best.movingRows, movingColumns: best.movingColumns, foreground: true };
  if (best.shift > 0) {
    // 候选最多移动65%帧高，新增条起点至少在35%帧高处；顶部18%的固定内容不会被追加。
    // 只排除顶部嫌疑，底部/中部结构的安全门及历史确认保持不变。
    const suspects = foregroundFixedEdge(a, b, best.shift, raw, best.columnStart, best.columnEnd)
      .filter(item => item.edge !== '顶部');
    if (suspects.length) {
      // 新增条没有旧帧对应像素；反向取一行不能证明固定UI。先等第三个不同位置，
      // 只有原场景中的可疑行在该独立移动帧也改变，才可解除本次静止结构的否决。
      const previous = history?.previous;
      const independent = previous && previous !== a && previous.width === a.width && previous.height === a.height &&
        Number.isInteger(history.shift) && history.shift !== 0 && history.shift !== best.shift;
      const witnesses = independent ? foregroundMatches(a, previous) : [];
      const witness = witnesses[0];
      const confirmed = Boolean(witness && witness.shift === history.shift && !witnesses.some(other => other.shift !== witness.shift && other.error - witness.error < .5));
      const persistent = confirmed ? suspects.find(item => {
        // 实体带的历史见证也核对整段同批列，不能仅凭末行仍静止便确认16行剖面。
        for (let y = item.profileStart ?? item.y; y <= item.y; y++) {
          const stable = item.columns.filter(c => {
            const i = y * COLUMNS + c;
            const error = item.detailed ? rowPatchError(previous, b, y, c) : Math.abs(previous.rows[i] - b.rows[i]);
            return error <= 2 && (!item.detailed || previous.detail[i] >= 16);
          }).length;
          if (stable < item.minimum) return false;
        }
        return true;
      }) : suspects[0];
      if (persistent) return { ...result, kind: 'fixed', edge: persistent.edge, pending: !confirmed };
    }
  }
  return result;
}

// 自动布局探测只取运动候选，固定边缘不在此处否决；成图安全由二维覆盖层单独验证。
// 旧detectShift路径不变，不能把本候选直接当作允许拼入的结论。
export function estimateMotion(a, b) {
  if(a.width!==b.width||a.height!==b.height)return {kind:'invalid'};
  let changed=0;for(let i=0;i<a.rows.length;i++)if(Math.abs(a.rows[i]-b.rows[i])>3)changed++;
  if(!changed)return {kind:'still'};
  const raw=detectRawShift(a,b), valid=foregroundMatches(a,b), best=valid[0];
  const rawScore=raw.shift?score(a,b,raw.shift,false):null;
  const rawValid=rawScore&&rawScore.error<=6&&rawScore.coverage>=.85;
  if(best&&valid.some(other=>other.shift!==best.shift&&other.error-best.error<.5))return {kind:'ambiguous'};
  if(best){
    // 行估计与前景各自都强成立、但给出的位移不同：这是真冲突，只作元数据上报，不改 kind。
    if(rawValid&&raw.shift!==best.shift)return {kind:'ambiguous',conflicting:true};
    return {kind:'motion',shift:best.shift,error:best.error,foreground:true};
  }
  if(rawValid)return {kind:'motion',shift:raw.shift,error:rawScore.error};
  return raw.kind==='still'?{kind:'still'}:{kind:raw.kind==='ambiguous'?'ambiguous':'unmatched'};
}

export function newRows(frame, shift) {
  if (!Number.isInteger(shift) || shift <= 0 || shift >= frame.height) throw new RangeError('无效拼接位移');
  return { height: shift, data: frame.data.slice((frame.height - shift) * frame.width * 4) };
}

// 向上接长只取帧顶部的新露出行，与 newRows 严格对称。
export function topRows(frame, shift) {
  if (!Number.isInteger(shift) || shift <= 0 || shift >= frame.height) throw new RangeError('无效拼接位移');
  return { height: shift, data: frame.data.slice(0, shift * frame.width * 4) };
}
export function compose(chunks, width) {
  const height = chunks.reduce((sum, chunk) => sum + chunk.height, 0);
  if (!Number.isInteger(width) || width <= 0 || height > MAX_HEIGHT || width * height > MAX_PIXELS) throw new RangeError('长图已达到尺寸上限');
  const data = new Uint8ClampedArray(width * height * 4);
  let offset = 0;
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.height) || chunk.height <= 0 || chunk.data.length !== width * chunk.height * 4) throw new RangeError('无效图像片段');
    data.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return { data, width, height };
}
