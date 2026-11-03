import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 测试专用内部导出；每轮新 workspace 作为无历史剪枝的对照。
const url = new URL('../core/auto-scroll-session.mjs', import.meta.url);
const source = fs.readFileSync(url, 'utf8').replace(/from '\.\/(.*?)'/g,
  (_, name) => `from '${new URL(name, url).href}'`);
const { components, template } = await import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { components, template };').toString('base64'));

function framesFor(offsets, width=180, height=180) {
  return offsets.map((offset,id) => {
    const data = new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const i=(y*width+x)*4, row=y-offset;
      data[i]=(x*7+row*13)&255; data[i+1]=(x*3+row*19)&255;
      data[i+2]=(x*11+row*5)&255; data[i+3]=(x+y)&255;
      for(const [left,top] of [[20,28],[90,65],[35,125]]) if(x>=left&&x<left+18&&y>=top&&y<top+14){
        data[i]=240;data[i+1]=30;data[i+2]=100;
      }
    }
    return {id,offset,image:{width,height,data}};
  });
}

test('逐轮新增遮罩时零见证 tile 不复活，方向和布局变化均与逐轮重算一致', () => {
  for(const offsets of [[0,-4,-8],[0,4,8]]) for(const layout of [{top:0,bottom:180},{top:12,bottom:168}]) {
    const frames=framesFor(offsets), workspace={}, masks=[];
    const original=frames.map(f=>f.image.data.slice());
    let previous=null, transitions=0;
    for(let pass=0;pass<8;pass++) {
      const cached=components(frames,layout,masks,undefined,workspace), freshWorkspace={};
      const fresh=components(frames,layout,masks,undefined,freshWorkspace);
      assert.deepEqual(cached,fresh);
      if(previous) for(let i=0;i<previous.length;i++) {
        if(!previous[i]) assert.equal(freshWorkspace.liveTiles[i],0,'零见证 tile 不得复活');
        if(previous[i]&&!freshWorkspace.liveTiles[i]) transitions++;
      }
      assert.deepEqual(workspace.liveTiles,freshWorkspace.liveTiles);
      previous=workspace.liveTiles.slice();
      const box=cached.boxes.sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top))[0];
      if(!box)break;
      const mask=template(box,frames,262144);assert.ok(mask?.points.length);masks.push(mask);
    }
    assert.ok(masks.length>=2, `必须实际多轮：${offsets}, ${JSON.stringify(layout)}`);
    assert.ok(transitions>0,'新增掩码须真正使见证 tile 消失');
    frames.forEach((f,i)=>assert.deepEqual(f.image.data,original[i], '不得改写 RGBA，包括透明通道'));
  }
});
