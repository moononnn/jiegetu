/* 批注的纯模型：只做校验、编号和固定形状投射，不碰 DOM、画布、IPC 或外部存储。
   编辑器把当前可见批注按顺序交进来，这里负责：
   - 拒绝没写意见的草稿、超长文本、超条数、越界坐标、重复 id；
   - 按可见顺序重排 number（1..n 连续），id 原样保留、与序号无关；
   - 只投射 {id, number, kind, point|rect, text} 与 {annotations, comment}，
     ops、原始 dataUrl、位图、撤销历史一律不进入返回值。
   坐标单位是原图像素，允许小数；**越界整份拒绝，绝不静默夹取**（夹取会把用户没说过的位置交出去）。
   文本一律原样保留（含前后空格与换行），只拿 trim 判空，长度按码位算（emoji 算 1 个）。 */
(() => {
  'use strict';
  const LIMITS = Object.freeze({ annotations: 100, text: 2000, comment: 4000, id: 64,
    edge: 30000, pixels: 16000000 });

  const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
  const codePoints = value => Array.from(value).length;
  function sizeOf(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > LIMITS.edge || height > LIMITS.edge || width * height > LIMITS.pixels) {
      throw new Error(`批注尺寸无效（边长 ≤ ${LIMITS.edge}，总计 ≤ ${LIMITS.pixels} 像素）`);
    }
    return { width, height };
  }
  function pointOf(value, size) {
    if (!value || typeof value !== 'object' || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) throw new Error('批注坐标无效');
    if (value.x < 0 || value.y < 0 || value.x > size.width || value.y > size.height) throw new Error('批注坐标超出图片范围');
    return { x: value.x, y: value.y };
  }
  function rectOf(value, size) {
    if (!value || typeof value !== 'object' || !['x', 'y', 'width', 'height'].every(key => isFiniteNumber(value[key]))) {
      throw new Error('批注范围无效');
    }
    const { x, y, width, height } = value;
    if (width <= 0 || height <= 0) throw new Error('批注范围无效');
    if (x < 0 || y < 0 || x + width > size.width || y + height > size.height) {
      throw new Error('批注范围超出图片范围');
    }
    return { x, y, width, height };
  }
  // 文本原样返回：不改类型、不 trim、不换行归一。只在这里判空和数字数。
  function textOf(value, max, label, required) {
    if (typeof value !== 'string') throw new Error(`${label}无效`);
    if (required && !value.trim()) throw new Error(`${label}还没有填写意见`);
    const count = codePoints(value);
    if (count > max) throw new Error(`${label}超过 ${max} 字（当前 ${count} 字）`);
    return value;
  }

  // 只保留固定字段：任何额外属性都不会被带到导出结果里。
  function prepare({ width, height, annotations, comment } = {}) {
    const size = sizeOf(width, height);
    if (!Array.isArray(annotations)) throw new Error('批注列表无效');
    if (annotations.length > LIMITS.annotations) throw new Error(`批注最多 ${LIMITS.annotations} 条`);
    const seen = new Set();
    const list = annotations.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 条批注无效`);
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) throw new Error(`第 ${index + 1} 条批注标识无效`);
      if (seen.has(item.id)) throw new Error(`第 ${index + 1} 条批注标识重复`);
      seen.add(item.id);
      const number = index + 1;
      const body = textOf(item.text, LIMITS.text, `第 ${number} 条批注`, true);
      if (item.kind === 'point') return { id: item.id, number, kind: 'point', point: pointOf(item.point, size), text: body };
      if (item.kind === 'region') return { id: item.id, number, kind: 'region', rect: rectOf(item.rect, size), text: body };
      throw new Error(`第 ${index + 1} 条批注类型无效`);
    });
    // 总体说明独立计数：不因有批注就放宽，也不会被批注的字数挤占；可以为空（但至少得有批注或它）。
    const absent = comment === undefined || comment === null;
    const overall = absent ? '' : textOf(comment, LIMITS.comment, '总体说明', false);
    if (!list.length && !overall.trim()) throw new Error('至少写一条批注或一段总体说明');
    return { annotations: list, comment: overall };
  }

  window.Annotations = Object.freeze({ LIMITS, prepare });
})();
