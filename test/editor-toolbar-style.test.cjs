'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../renderer/image-editor.css'),'utf8');

test('选中按钮悬停明确成对指定浅底和深字，不串用主操作按钮的深底',()=>{
  const selector='.image-editor button[aria-pressed=true]:hover:not(:disabled)';
  const rule=css.split('}').find(block=>block.trim().startsWith(selector+'{'));
  assert.ok(rule,'切开主按钮与选中按钮的悬停样式');
  assert.match(rule,/background:var\(--ie-mint\)/);
  assert.match(rule,/color:var\(--ie-ink\)/,'图标继承文字颜色，同步保持可读');
  assert.match(css,/button\.ie-primary:hover:not\(:disabled\)\{background:#326454\}/,'主操作按钮仍保留原本的深底浅字');
});
