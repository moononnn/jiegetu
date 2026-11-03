'use strict';
// 极简 DOM 夹具：只实现 renderer/image-editor.js 真正用到的那部分接口。
// 不做布局与样式计算：所有尺寸、scroll 和坐标都由测试显式给定，避免“夹具自己算对”的假通过。
// 故意不实现 document.querySelector 等全局查找，强制测试走编辑器内部的 root 作用域。

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function kebab(name) {
  return String(name).replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
}

function createDataset(element) {
  return new Proxy({}, {
    get: (_, key) => {
      const value = element.attributes.get(`data-${kebab(String(key))}`);
      return value === undefined ? undefined : value;
    },
    set: (_, key, value) => { element.attributes.set(`data-${kebab(String(key))}`, String(value)); return true; },
    has: (_, key) => element.attributes.has(`data-${kebab(String(key))}`),
    deleteProperty: (_, key) => { element.attributes.delete(`data-${kebab(String(key))}`); return true; },
    ownKeys: () => [...element.attributes.keys()].filter(name => name.startsWith('data-'))
  });
}

function tokenizeSelector(compound) {
  const tokens = [];
  const pattern = /(\[[^\]]*\]|:not\([^)]*\)|:[\w-]+|[.#]?[\w-]+)/g;
  let match;
  while ((match = pattern.exec(compound))) tokens.push(match[1]);
  return tokens;
}

function parseCompound(compound) {
  const parsed = { tag: null, classes: [], id: null, attrs: [], nots: [], pseudos: [] };
  for (const token of tokenizeSelector(compound)) {
    if (token.startsWith('.')) parsed.classes.push(token.slice(1));
    else if (token.startsWith('#')) parsed.id = token.slice(1);
    else if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      const equal = inner.indexOf('=');
      if (equal === -1) parsed.attrs.push({ name: inner.trim(), value: undefined });
      else parsed.attrs.push({ name: inner.slice(0, equal).trim(), value: inner.slice(equal + 1).trim().replace(/^["']|["']$/g, '') });
    } else if (token.startsWith(':not(')) parsed.nots.push(parseCompound(token.slice(5, -1)));
    else if (token.startsWith(':')) parsed.pseudos.push(token.slice(1));
    else parsed.tag = token.toUpperCase();
  }
  return parsed;
}

function parseSelector(selector) {
  return String(selector).split(',').map(part => part.trim().split(/\s+/).filter(Boolean).map(parseCompound)).filter(group => group.length);
}

function matchesCompound(element, compound) {
  if (!element || element.nodeType !== 1) return false;
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (compound.id && element.getAttribute('id') !== compound.id) return false;
  for (const name of compound.classes) if (!element.classList.contains(name)) return false;
  for (const attr of compound.attrs) {
    if (!element.attributes.has(attr.name)) return false;
    if (attr.value !== undefined && element.getAttribute(attr.name) !== attr.value) return false;
  }
  for (const pseudo of compound.pseudos) {
    if (pseudo === 'disabled' && !element.disabled) return false;
    if (pseudo === 'focus' && element.ownerDocument.activeElement !== element) return false;
    if (pseudo === 'focus-visible' && element.ownerDocument.activeElement !== element) return false;
  }
  for (const inner of compound.nots) if (matchesCompound(element, inner)) return false;
  return true;
}

function matchesGroup(element, group) {
  if (!matchesCompound(element, group[group.length - 1])) return false;
  let index = group.length - 2, node = element.parentNode;
  while (index >= 0) {
    while (node && node.nodeType === 1 && !matchesCompound(node, group[index])) node = node.parentNode;
    if (!node || node.nodeType !== 1) return false;
    index -= 1; node = node.parentNode;
  }
  return true;
}

class HTMLElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.tabIndex = -1;
    this._hidden = false;
    this._classes = new Set();
    this.dataset = createDataset(this);
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (on) this._classes.add(name); else this._classes.delete(name);
        return on;
      }
    };
  }

  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = Boolean(value); if (this._hidden) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get type() { return this.getAttribute('type') || ''; }
  set type(value) { this.setAttribute('type', value); }
  get maxLength() { const value = this.getAttribute('maxlength'); return value === null ? -1 : Number(value); }
  set maxLength(value) { this.setAttribute('maxlength', String(value)); }
  get rows() { return Number(this.getAttribute('rows') || 0); }
  set rows(value) { this.setAttribute('rows', String(value)); }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(value) { this.setAttribute('placeholder', value); }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
    if (name === 'checked') this.checked = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'class') this.className = value;
    if (name === 'hidden') this._hidden = true;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'value') this.value = ''; }

  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() {
    return this.childNodes.map(node => node.nodeType === 3 ? node.data : node.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? '');
    if (text) this.childNodes.push({ nodeType: 3, data: text, parentNode: this, textContent: text });
  }
  set innerHTML(html) {
    this.childNodes = [];
    parseHTML(String(html ?? ''), this, this.ownerDocument);
  }
  get innerHTML() { return this.textContent; }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (typeof node === 'string') {
        const last = this.childNodes[this.childNodes.length - 1];
        if (last && last.nodeType === 3) last.data += node;
        else this.childNodes.push({ nodeType: 3, data: node, parentNode: this });
        continue;
      }
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }

  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    const out = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (groups.some(group => matchesGroup(child, group))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return parseSelector(selector).some(group => matchesGroup(this, group)); }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  contains(node) {
    let current = node;
    while (current) { if (current === this) return true; current = current.parentNode; }
    return false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(item => item !== handler));
  }
  dispatchEvent(event) { this.emit(event.type, event); return true; }
  emit(type, event = {}) {
    const payload = { type, target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(payload);
    return payload;
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getClientRects() { return this.isVisible() ? [this.getBoundingClientRect()] : []; }
  isVisible() {
    let node = this;
    while (node && node.nodeType === 1) { if (node.hidden) return false; node = node.parentNode; }
    return true;
  }
  getBoundingClientRect() {
    const box = this.box || { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top };
  }
  setPointerCapture(pointerId) { this.captured = pointerId; }
  hasPointerCapture(pointerId) { return this.captured === pointerId; }
  releasePointerCapture() { this.captured = undefined; }
  get clientWidth() { return this.box ? this.box.width : 0; }
  get clientHeight() { return this.box ? this.box.height : 0; }
  get offsetWidth() { return this.box ? this.box.width : 0; }
  get offsetHeight() { return this.box ? this.box.height : 0; }
  get offsetLeft() { return this.box ? (this.box.left || 0) : 0; }
  get offsetTop() { return this.box ? (this.box.top || 0) : 0; }
}

class FakeCanvas extends HTMLElement {
  constructor(ownerDocument, serial) {
    super(ownerDocument, 'canvas');
    this.serial = serial;
    this.width = 300; this.height = 150;
    this.context = createContext(this);
  }
  getContext() { return this.context; }
  toBlob(callback) { callback(new FakeBlob(this)); }
  toDataURL() { return `data:image/png;base64,canvas-${this.serial}`; }
}

class FakeBlob {
  constructor(canvas) { this.canvas = canvas; }
  async arrayBuffer() {
    const bytes = new Uint8Array(12);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes[8] = this.canvas.width & 0xff; bytes[9] = this.canvas.height & 0xff; bytes[10] = this.canvas.serial & 0xff;
    return bytes.buffer;
  }
}

function label(value) {
  if (!value) return 'none';
  if (value.kind === 'bitmap') return 'bitmap';
  if (value.nodeType === 1 && value.tagName === 'CANVAS') return `canvas#${value.serial}`;
  if (typeof value === 'string') return 'url';
  return 'other';
}

function createContext(canvas) {
  const calls = [];
  const context = { canvas, calls, imageSmoothingEnabled: true };
  const record = name => (...args) => {
    calls.push({ name, args: args.map(arg => (arg && typeof arg === 'object' ? label(arg) : arg)) });
  };
  for (const name of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'clip', 'stroke',
    'fill', 'fillRect', 'strokeRect', 'setTransform', 'clearRect', 'rect', 'scale', 'fillText', 'setLineDash',
    'translate', 'rotate']) context[name] = record(name);
  context.getImageData = (x,y,width,height) => ({data:new Uint8ClampedArray(width*height*4)});
  context.drawImage = (source, ...rest) => { calls.push({ name: 'drawImage', source: label(source), args: rest }); };
  // 字宽是固定模型（不是真实字体度量）：CJK/全角 20px、其余 10px，让换行与行数可被测试精确预期。
  // 真实字体下的换行与像素另由 Electron 离屏实验验。
  context.measureText = text => ({ width: [...String(text)].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e80 ? 20 : 10), 0) });
  return context;
}

function parseHTML(html, root, ownerDocument) {
  const stack = [root];
  let index = 0;
  const pushText = text => { if (text) stack[stack.length - 1].append(text); };
  const findEnd = from => {
    let quote = null;
    for (let i = from; i < html.length; i += 1) {
      const ch = html[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') return i;
    }
    return html.length;
  };
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) { pushText(html.slice(index)); break; }
    if (lt > index) pushText(html.slice(index, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const gt = findEnd(lt);
      const name = html.slice(lt + 2, gt).trim().toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === name) { stack.length = i; break; }
      }
      index = gt + 1;
      continue;
    }
    const gt = findEnd(lt);
    const raw = html.slice(lt + 1, gt);
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const match = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(body);
    if (!match) { pushText(html.slice(lt, gt + 1)); index = gt + 1; continue; }
    const element = ownerDocument.createElement(match[1]);
    const attrPattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    let attr;
    while ((attr = attrPattern.exec(match[2]))) {
      const value = attr[2] === undefined ? '' : attr[2].replace(/^["']|["']$/g, '');
      element.setAttribute(attr[1], value);
    }
    stack[stack.length - 1].append(element);
    if (!selfClose && !VOID_TAGS.has(match[1].toLowerCase())) stack.push(element);
    index = gt + 1;
  }
}

class FakeImage {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
  set src(value) { this._src = value; }
  get src() { return this._src; }
  removeAttribute() { this._src = ''; }
  async decode() {
    const meta = this.ownerDocument?.images?.get(this._src);
    if (!meta) throw new Error('decode 失败');
    this.naturalWidth = meta.width; this.naturalHeight = meta.height;
  }
}

class ResizeObserver {
  constructor(callback) { this.callback = typeof callback === 'function' ? callback : () => {}; this.targets = []; }
  observe(target) { this.targets.push(target); }
  unobserve(target) { this.targets = this.targets.filter(item => item !== target); }
  disconnect() { this.targets = []; }
  // 夹具没有布局引擎：只有测试显式推一下，回调才会跑（模拟 scroller 尺寸变了）。
  trigger() { this.callback([], this); }
}

// 生成一整套夹具：root 已解析好编辑器骨架吗？没有——root 由 createImageEditor 自己填 innerHTML。
function createEditorDom({
  root = { width: 1000, height: 800 },
  workspace = { width: 1000, height: 600 },
  scroller = { width: 400, height: 300 },
  bubble = { width: 260, height: 180 },
  dpr = 1
} = {}) {
  const frames = [];
  const canvases = [];
  const document = {
    activeElement: null,
    images: new Map(),
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        const canvas = new FakeCanvas(document, canvases.length + 1);
        canvases.push(canvas);
        return canvas;
      }
      return new HTMLElement(document, tag);
    }
  };
  const body = new HTMLElement(document, 'body');
  document.body = body;
  document.activeElement = body;

  const window = {
    devicePixelRatio: dpr,
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!window.listeners.has(type)) window.listeners.set(type, []);
      window.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = window.listeners.get(type);
      if (list) window.listeners.set(type, list.filter(item => item !== handler));
    },
    emit(type, event = {}) {
      const payload = { type, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...event };
      for (const handler of [...(window.listeners.get(type) || [])]) handler(payload);
      return payload;
    }
  };

  const rootNode = document.createElement('div');
  rootNode.box = { left: 0, top: 0, width: root.width, height: root.height };
  const observers = [];
  class EditorResizeObserver extends ResizeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  }

  // 编辑器创建后会把这些节点塞进 root；尺寸靠 data 角色定位，而不是靠解析后的选择器顺序。
  const attachBoxes = () => {
    const pick = selector => rootNode.querySelector(selector);
    const workspaceNode = pick('.ie-workspace');
    if (workspaceNode) workspaceNode.box = { left: 0, top: 0, width: workspace.width, height: workspace.height };
    const scrollNode = pick('.ie-scroll');
    if (scrollNode) scrollNode.box = { left: 0, top: 0, width: scroller.width, height: scroller.height };
    const toolbarNode = pick('.ie-toolbar');
    if (toolbarNode) toolbarNode.box = { left: 0, top: 0, width: 320, height: 96 };
    const statusNode = pick('.ie-status');
    if (statusNode) statusNode.box = { left: 0, top: 0, width: 400, height: 20 };
    // 气泡尺寸：编辑器自己算 left/top，夹具只给一个固定的 clientWidth/clientHeight。
    for (const selector of ['.ie-note-bubble', '.ie-comment-bubble']) {
      const node = pick(selector);
      if (node) node.box = { left: 0, top: 0, width: bubble.width, height: bubble.height };
    }
  };

  return {
    window, document, root: rootNode, canvases, attachBoxes, observers,
    // 只重跑观察者回调；真实回流仍由调用方给出的 box 尺寸决定。
    resize() { for (const observer of observers) observer.trigger(); },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    flushFrames() { const pending = frames.splice(0); for (const fn of pending) fn(); },
    createImageBitmap: async image => ({ kind: 'bitmap', width: image.naturalWidth ?? image.width, height: image.naturalHeight ?? image.height, secret: 'RAW-BITMAP-SECRET', close() {} }),
    Image: class extends FakeImage { constructor() { super(); this.ownerDocument = document; } },
    ResizeObserver: EditorResizeObserver
  };
}

module.exports = { createEditorDom, HTMLElement };
