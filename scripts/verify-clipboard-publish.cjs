/* 常驻剪贴板服务的发布链路验收：真实 native/clipboard-helper.exe --watch + 真实 main/clipboard-service.cjs。
   验证「记录已开启时截图复制走 broker」这条路径本身能不能成功发布 PNG/文本。
   注意：会真实改写系统剪贴板（这是要验证的行为）。运行后自己再复制一次想保留的内容即可。
   运行：node scripts/verify-clipboard-publish.cjs */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createClipboardService } = require('../main/clipboard-service.cjs');

const ROOT = path.join(__dirname, '..');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(width, height, paint) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      rows[y * (stride + 1) + 1 + x * 3] = r;
      rows[y * (stride + 1) + 2 + x * 3] = g;
      rows[y * (stride + 1) + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-publish-'));
  const spoolDir = path.join(root, 'spool');
  const statuses = [];
  const events = [];
  const service = createClipboardService({
    // 允许用刚编译的候选产物验收，不必覆盖正在被现用进程占用 native/clipboard-helper.exe。
    helperPath: process.env.CLIPBOARD_HELPER || path.join(ROOT, 'native', 'clipboard-helper.exe'),
    spoolDir,
    onEvent: parts => events.push(parts),
    onStatus: status => statuses.push(status)
  });

  await service.start();
  check('常驻 helper 启动到 ready', service.status().phase === 'ready', service.status().phase);

  // 截图复制的真实体量：800×600 噪点，压缩后约 1.4MB。
  const noise = makePng(800, 600, (x, y) => [(x * 37 + y * 11) & 255, (x * 13 + y * 29) & 255, (x * 7 + y * 53) & 255]);
  check('测试 PNG 是像样的体量', noise.length > 300 * 1024, `${noise.length} 字节`);

  try {
    const reply = await service.publish([{ format: 'png', bytes: noise }]);
    check('常驻发布 PNG 成功', reply?.published === true, JSON.stringify(reply));
  } catch (error) {
    check('常驻发布 PNG 成功', false, `抛错：${error?.message || error}`);
  }

  try {
    const text = Buffer.from('验收文本 · plain', 'utf16le');
    const reply = await service.publish([{ format: 'text', bytes: text }]);
    check('常驻发布文本成功', reply?.published === true, JSON.stringify(reply));
  } catch (error) {
    check('常驻发布文本成功', false, `抛错：${error?.message || error}`);
  }

  await sleep(300);
  const spoolLeft = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir) : [];
  check('发布成功后 spool 不残留', spoolLeft.length === 0, JSON.stringify(spoolLeft));
  check('自己的写入没有被当成外部复制入库', events.length === 0, `收到 ${events.length} 次事件`);

  await service.dispose?.();
  const report = { results, failures, statuses, noiseBytes: noise.length, spoolLeft, root };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return failures.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
