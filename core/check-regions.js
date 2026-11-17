/* 未确认区域的对外收口：只接受左上原点、整数、正尺寸、落在成图内的矩形。
   输入是 core 报的成图像素坐标；这里不做任何坐标换算，也不补造缺失的位置。
   main 与渲染层共用同一份规则，任何一边都不能把非法矩形带进界面或文档。 */
(function (host) {
  'use strict';
  const MAX_REGIONS = 256;
  const positiveInt = value => Number.isInteger(value) && value > 0;

  // 返回 { total, truncated, rects }：
  // total 是来源报告的条数（即使位置不可信也保留计数），truncated 表示只保留了前 MAX_REGIONS 条。
  // 来源不是数组时返回 null：调用方应把它当成“没有可用元数据”，而不是零条。
  function sanitize(value, width, height) {
    if (!Array.isArray(value)) return null;
    const total = value.length;
    const rects = [];
    for (const item of value) {
      if (rects.length >= MAX_REGIONS) break;
      if (!item || typeof item !== 'object') continue;
      const { top, bottom, left, right } = item;
      if (!Number.isInteger(top) || !Number.isInteger(bottom) || !Number.isInteger(left) || !Number.isInteger(right)) continue;
      if (!(bottom > top) || !(right > left)) continue;
      if (top < 0 || left < 0) continue;
      if (bottom > height || right > width) continue;
      rects.push({ top, bottom, left, right });
    }
    return { total, truncated: total > MAX_REGIONS, rects };
  }

  // 界面文案所需的唯一判定：有没有计数、能不能定位、是否被截断。
  function summary(value) {
    if (!value || !Array.isArray(value.rects)) return null;
    const total = Number.isInteger(value.total) && value.total >= 0 ? value.total : value.rects.length;
    if (!total) return null;
    return { total, locatable: value.rects.length, truncated: Boolean(value.truncated) || value.rects.length < total };
  }

  // 对外出口：把 {total, truncated, rects} 按这张图的尺寸重验一遍，计数与位置分开对待。
  // 位置不可信时仍可保留计数（界面只能提示“位置不可用”）；计数为 0 时返回 undefined。
  function normalize(value, width, height) {
    if (!value || !Array.isArray(value.rects)) return undefined;
    if (!positiveInt(width) || !positiveInt(height)) return undefined;
    const clean = sanitize(value.rects, width, height);
    if (!clean) return undefined;
    const reported = Number.isInteger(value.total) && value.total >= 0 ? value.total : clean.total;
    const total = Math.max(reported, clean.total);
    if (!total) return undefined;
    return { total, truncated: Boolean(value.truncated) || clean.truncated || clean.rects.length < total, rects: clean.rects };
  }

  const api = { sanitize, normalize, summary, MAX_REGIONS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.CheckRegions = api;
})(typeof window === 'object' ? window : globalThis);
