import { fingerprint, estimateMotion, topRows, compose, MAX_HEIGHT, MAX_PIXELS } from './scroll.mjs';
import { createBackgroundModel, observeBackground, extendBackground, backgroundSummary } from './background-model.mjs';
import { estimateFeatureMotion } from './feature-motion.mjs';
import { renderPreview } from './scroll-preview.mjs';
import { inspectDocumentRing, findDocumentRepairSource } from './document-ring-evidence.mjs';

// 生产 Worker 的遮挡分析轮询预算（毫秒）：比 renderer 的 10 秒硬看门狗更早停手，超时由外置 checkpoint 恢复。
// 这是“轮询点发现超时即停”的预算，不严格覆盖整段 accept/finish：组件 BFS、逐点核验等循环每若干轮/行/点才看一次时钟，
// 单次未被轮询的循环仍可能略微超出，不能当成对整个 accept 的严格超时；10 秒看门狗仍保留兜底。
// core 默认不启用预算（Infinity），纯算法与性能测试不受真实时钟波动影响；唯一生产入口 Worker 显式使用此值。
export const ANALYSIS_BUDGET_MS = 4000;

// A second candidate source, never a substitute for the original-pixel and occlusion gates.
function motionBetween(a,b,fa,fb){
 const old=estimateMotion(fa,fb);
 if(!['unmatched','still','ambiguous'].includes(old.kind))return {...old,method:'rows'};
 // 行估计与前景都强成立但位移不同（conflicting）：保留 rows 拒绝，不用特征候选放大这类风险。
 if(old.conflicting)return {...old,method:'rows'};
 const next=estimateFeatureMotion(a,b);
 return next.kind==='motion'?{kind:'motion',shift:next.shift,foreground:true,error:1-next.support,method:'features',support:next.support}:{...old,method:'rows'};
}

const gray=(image,x,y)=>{const i=(y*image.width+x)*4;return (image.data[i]*77+image.data[i+1]*150+image.data[i+2]*29)>>8;};
const delta=(a,ai,b,bi)=>Math.max(Math.abs(a[ai]-b[bi]),Math.abs(a[ai+1]-b[bi+1]),Math.abs(a[ai+2]-b[bi+2]));
function samePixels(a,b){
 if(a.length!==b.length)return false;
 if(a.buffer&&b.buffer&&a.byteOffset%4===0&&b.byteOffset%4===0){const x=new Uint32Array(a.buffer,a.byteOffset,a.length/4),y=new Uint32Array(b.buffer,b.byteOffset,b.length/4);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;return true;}
 for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;
}
// 必须拷贝：修补片段不得改写原始记录，身份缓存也依赖原帧不变。
const crop=(image,top,bottom)=>({width:image.width,height:bottom-top,data:image.data.slice(top*image.width*4,bottom*image.width*4)});
// 匹配专用 body 视图：只读的 subarray，不复制像素；它只给指纹/运动估计读，永不传修补写入。
const bodyView=(image,top,bottom)=>({width:image.width,height:bottom-top,data:image.data.subarray(top*image.width*4,bottom*image.width*4)});
function reference(image,layout){
 const end=layout?.bottom??image.height,start=Math.max(layout?.top??0,end-Math.max(320,Math.ceil(image.width/3))),scale=Math.min(1,960/image.width,320/(end-start)),width=Math.max(1,Math.floor(image.width*scale)),height=Math.max(1,Math.floor((end-start)*scale)),data=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=((start+Math.floor(y*(end-start)/height))*image.width+Math.floor(x*image.width/width))*4;data.set(image.data.subarray(p,p+4),(y*width+x)*4);}
 return {width,height,data};
}
// 行差都是两个 0..255 灰度的差，必为 ±255 内的整数：用 511 桶直方图找上中位数（累计 > n>>1），
// 与 slice().sort() 取 sorted[n>>1] 完全一致。极窄图（取样点不足 12 个，宽约 <28px）桶表清零的开销占优，
// 仍走原排序路径；其余宽度统一用直方图。具体耗时对比只在 experiments/fast-scroll-bench.mjs 的输出里看。
const MEDIAN_HISTOGRAM_MIN = 12;
function rowShiftMedian(samples,n,hist){
 if(n<MEDIAN_HISTOGRAM_MIN){const sorted=samples.slice(0,n).sort();return sorted[n>>1];}
 hist.fill(0);
 for(let i=0;i<n;i++)hist[samples[i]+255]++;
 const middle=n>>1;
 for(let v=0,seen=0;v<511;v++){seen+=hist[v];if(seen>middle)return v-255;}
 return 0;
}
// 窄内容域：内容只占全宽四分桶的一格时，support 的 columns>=2 会单独否决真实运动。
// 变化域只用「同坐标亮度变化 + 局部细节」推，不依赖候选位移、不用匹配上的 good 点提名，
// 也不依赖建窗后的 masks/background（那里是准入之后的事）。
// 域只量“空间跨度”，不要求随机纹理那种密度：按 1px 列 + 16 个纵向段记同坐标变化见证，
// 4px 小箱只用来把 7px 字形侧面的空列跨过去（真实字符间距不是空白证据）。
const DOMAIN_BIN=4,DOMAIN_SEGMENTS=16,DOMAIN_MIN_WIDTH=96,DOMAIN_MIN_SEGMENTS=6,DOMAIN_MIN_SPAN_SEGMENTS=5,DOMAIN_GROUPS=4;
function changeDomain(a,b,range){
 const w=a.width,h=a.height,top=Math.max(0,range?.top??0),bottom=Math.min(h,range?.bottom??h);
 const height=bottom-top;
 if(height<128||w<64)return null;
 // 1px 分辨率的 x 采样：与 7px 字形周期不会固定同相，不会整列打空。
 const seen=new Uint8Array(w*DOMAIN_SEGMENTS);
 const stepY=Math.max(1,Math.floor(height/(DOMAIN_SEGMENTS*8)));
 let any=false;
 for(let y=top+1;y<bottom-1;y+=stepY){
  const seg=Math.min(DOMAIN_SEGMENTS-1,Math.floor((y-top)*DOMAIN_SEGMENTS/height));
  for(let x=1;x<w-1;x++){
   const k=x*DOMAIN_SEGMENTS+seg;
   if(seen[k])continue;
   const value=gray(a,x,y);
   if(Math.abs(value-gray(b,x,y))<14)continue;
   const detail=Math.max(Math.abs(gray(a,x-1,y)-value),Math.abs(gray(a,x+1,y)-value),Math.abs(gray(a,x,y-1)-value),Math.abs(gray(a,x,y+1)-value));
   if(detail<12)continue;
   seen[k]=1;any=true;
  }
 }
 if(!any)return null;
 // 每列的见证段数→见证列；再按 4px 分箱避免字形间的空列把整段切碎。
 const witness=new Uint8Array(Math.floor(w/DOMAIN_BIN)+1);
 for(let x=1;x<w-1;x++){let n=0;for(let s=0;s<DOMAIN_SEGMENTS;s++)n+=seen[x*DOMAIN_SEGMENTS+s];
  if(n>=DOMAIN_MIN_SEGMENTS)witness[Math.floor(x/DOMAIN_BIN)]++;}
 let best=null,start=-1;
 for(let i=0;i<=witness.length;i++){const active=i<witness.length&&witness[i]>=2;
  if(active&&start<0)start=i;
  if(!active&&start>=0){const len=i-start;if(!best||len>best.len)best={start,len};start=-1;}
 }
 if(!best)return null;
 const left=best.start*DOMAIN_BIN,right=Math.min(w,(best.start+best.len)*DOMAIN_BIN);
 if(right-left<DOMAIN_MIN_WIDTH)return null;
 // 域内纵向跨度：看段并集，只有半截动的不能当成整页正文域。
 const span=new Uint8Array(DOMAIN_SEGMENTS);
 for(let x=left;x<right;x++)for(let s=0;s<DOMAIN_SEGMENTS;s++)if(seen[x*DOMAIN_SEGMENTS+s])span[s]=1;
 let segCount=0,minSeg=-1,maxSeg=-1;
 for(let s=0;s<DOMAIN_SEGMENTS;s++)if(span[s]){segCount++;if(minSeg<0)minSeg=s;maxSeg=s;}
 if(segCount<DOMAIN_MIN_SEGMENTS||maxSeg-minSeg+1<DOMAIN_MIN_SPAN_SEGMENTS)return null;
 return {left,right};
}
function intersectDomain(p,q){
 if(!p||!q)return null;
 const left=Math.max(p.left,q.left),right=Math.min(p.right,q.right);
 return right-left>=DOMAIN_MIN_WIDTH?{left,right}:null;
}
// context 是显式对象：{bootstrap:true} 用本对帧自己的域做候选许可；{domain} 与已冻结的历史域相交。
// 域的纵向几何必须固定：建窗期用整帧高度，layout 之后用冻结的 layout；绝不跟着会收缩的 learningRange 走。
function resolveDomain(a,b,range,context){
 if(!context)return null;
 const geometry=context.bootstrap===true?null:range;
 const own=changeDomain(a,b,geometry);
 if(!own)return null;
 if(context.domain)return intersectDomain(own,context.domain);
 return context.bootstrap===true?own:null;
}
// 原分辨率局部形状核验；灰度48列仅提供候选，不能直接允许追加。
function support(a,b,shift,range,context){
 const w=a.width,h=a.height,stepX=Math.max(1,Math.floor(w/72)),stepY=Math.max(1,Math.floor(h/400));
 const ys=[],columns=new Set(),tiles=new Map();let good=0,eligible=0;
 // 两个对应位置都须落在已确认正文内，动态头尾不能从移位的一侧混入核验。
 const top=range?.top??0,bottom=range?.bottom??h;
 const start=Math.max(2,2-shift,top,top-shift),end=Math.min(h-2,h-2-shift,bottom,bottom-shift);
 // 同一屏幕行上固定背景大致相同，整行差值的**中位数**能估出“背景参与混合”造成的那部分亮度差。
 // 用中位数而非均值：窄条固定物只占行的一小段，会被直接忽略，不会把它的强烈变化倒灌给整行。
 const rowShift=new Float32Array(h),samples=new Float32Array(Math.ceil(w/2)+1),hist=new Uint32Array(511);
 for(let y=start;y<end;y++){let n=0;for(let x=2;x<w-2;x+=2)samples[n++]=gray(a,x,y+shift)-gray(b,x,y);
  if(!n){rowShift[y]=0;continue;}rowShift[y]=rowShiftMedian(samples,n,hist);}
 const shaped=(x,y)=>gray(a,x,y+shift)-gray(b,x,y)-(rowShift[y]??0);
 const goodX=context?new Set():null;
 for(let y=start;y<end;y+=stepY){let row=0;
  for(let x=Math.max(2,Math.floor(w*.03));x<w*.97-2;x+=stepX){
   const ac=gray(a,x,y+shift),bc=gray(b,x,y);
   if(Math.abs(gray(a,x,y)-bc)<10||Math.abs(gray(a,x,y+shift)-gray(b,x,y+shift))<10)continue;
   const detail=im=>{const yy=im===a?y+shift:y,c=im===a?ac:bc;return Math.max(Math.abs(gray(im,x-1,yy)-c),Math.abs(gray(im,x+1,yy)-c),Math.abs(gray(im,x,yy-1)-c),Math.abs(gray(im,x,yy+1)-c));};
   if(Math.min(detail(a),detail(b))<12)continue;
   const center=shaped(x,y);let error=0;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)error+=Math.abs(shaped(Math.max(0,Math.min(w-1,x+dx)),Math.max(start,Math.min(end-1,y+dy)))-center);
   eligible++;const key=`${Math.floor(x/48)},${Math.floor(y/48)}`,t=tiles.get(key)??{good:0,bad:0};tiles.set(key,t);
   if(error/9<=5){good++;row++;columns.add(Math.floor(x*4/w));t.good++;if(goodX)goodX.add(x);}else t.bad++;
  }
  if(row>=2)ys.push(y,y+shift);
 }
 const conflicts=[...tiles.values()].filter(t=>t.bad>=12&&t.good<t.bad/2).length;
 const strict=eligible>=24&&good/eligible>=.85&&ys.length>=16&&columns.size>=2&&!conflicts;
 // 域提取改成懒的：只有「其余门全过、唯独全宽 4 桶不足 2 桶」才去算域，宽内容和其他失败都不付这个开销。
 let domain=null,groups=null;
 if(!strict&&goodX&&!conflicts&&eligible>=24&&good/eligible>=.85&&ys.length>=16&&columns.size<2){
  domain=resolveDomain(a,b,range,context);
  if(domain){groups=new Set();for(const x of goodX)if(x>=domain.left&&x<domain.right)groups.add(Math.floor((x-domain.left)*DOMAIN_GROUPS/(domain.right-domain.left)));}
 }
 // 窄域例外只顶替「全宽 4 桶里要 2 桶」这一条；其余全图门（含 tiles 冲突）一条不放。
 const narrow=Boolean(domain)&&Boolean(groups)&&groups.size>=2;
 return {ok:strict||narrow,top:ys.length?Math.min(...ys):0,bottom:ys.length?Math.max(...ys)+1:h,coverage:eligible?good/eligible:0,eligible,good,rows:ys.length/2,columns:columns.size,conflicts,
  domainUsed:narrow,domainWidth:domain?domain.right-domain.left:0,domainColumns:groups?groups.size:0,
  ...(narrow?{domain:{left:domain.left,right:domain.right}}:{})};
}
const proofSummary=c=>({motionCoverage:c.coverage,motionEligible:c.eligible,motionGood:c.good,motionRows:c.rows,motionColumns:c.columns,motionConflicts:c.conflicts,
 motionDomainWidth:c.domainWidth??0,motionDomainColumns:c.domainColumns??0,motionDomainUsed:Boolean(c.domainUsed),motionProofVersion:2});
function components(frames,layout,masks=[],guard,workspace){
 const [a,b,c]=frames,w=a.image.width,h=a.image.height,size=6,cols=Math.ceil(w/size),rows=Math.ceil(h/size),bits=new Uint8Array(cols*rows);
 const active=frames.map(f=>masks.filter(m=>present(m,f,guard)));
 // 覆盖查询：有活动掩码时用一张 w*h 覆盖位图（bit0/1/2 对应 frames[0/1/2]），每像素一次数组读取
 // 代替对 3 组掩码反复做 some/矩形比较。矩形边界与原 covered 完全一致（左闭右开、裁到画面内）。
 // 位图由调用方按一次 learn（最多 33 轮）传进来复用：每轮清零、不重新分配；无掩码时不分配也不碰。
 // 仅本次 learn 内存活（<= w*h 字节，最大 16MiB）；另有每个 6×6 tile 一字节的剪枝图。
 let cover=null;
 if(active.some(list=>list.length)){
  if(workspace?.cover?.length===w*h)cover=workspace.cover.fill(0);
  else{cover=new Uint8Array(w*h);if(workspace)workspace.cover=cover;}
  for(let k=0;k<3;k++){
   const flag=1<<k;
   for(const rect of active[k]||[]){
    const left=Math.max(0,rect.left),right=Math.min(w,rect.right),top=Math.max(0,rect.top),bottom=Math.min(h,rect.bottom);
    for(let y=top;y<bottom;y++){guard?.('learn-components');const row=y*w;for(let x=left;x<right;x++)cover[row+x]|=flag;}
   }
  }
 }
 const differs=(from,to,x,y,yy)=>{
  const p=(y*w+x)*4,q=(yy*w+x)*4,d=delta(from.image.data,p,to.image.data,q);if(d<=12)return false;
  let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   const xx=Math.max(0,Math.min(w-1,x+dx)),u=(Math.max(0,Math.min(h-1,y+dy))*w+xx)*4,v=(Math.max(0,Math.min(h-1,yy+dy))*w+xx)*4;
   for(let ch=0;ch<3;ch++)sum+=Math.abs((from.image.data[u+ch]-from.image.data[p+ch])-(to.image.data[v+ch]-to.image.data[q+ch]));
  }
  // 平滑底纹导致的整体色差不是遮挡；同时存在局部形状矛盾才作为见证。
  return sum/27>5;
 };
 // 仅豁免连续外侧、整列随全部运动保持静止且没有硬文字边缘的柔和底纹。
 // 中间球、短条及固定侧栏不能因为“没动”就拿到背景豁免。
 const softColumn=x=>{guard?.('learn-components');let min=255,max=0;for(let y=layout.top;y<layout.bottom;y++){const i=(y*w+x)*4;if(delta(a.image.data,i,b.image.data,i)>2||delta(a.image.data,i,c.image.data,i)>2)return false;const value=gray(a.image,x,y);if(y>layout.top&&Math.abs(value-gray(a.image,x,y-1))>24)return false;min=Math.min(min,value);max=Math.max(max,value);}return max-min>=8;};
 // 外侧纯色窄边只作“扫描连接段”：它本身不是壁纸，也不给纯白页面新豁免，
 // 只让既有 softColumn 从它后面继续找柔和壁纸。上限 min(16, w*5%)、必须从画幅外侧起算。
 // 三帧每帧的整列 RGBA 都要近纯色（含 alpha），三帧并集也不许超过 ±2，否则不当作纯色。
 const pureColumn=x=>{guard?.('learn-components');let base=null,minR=255,maxR=0,minG=255,maxG=0,minB=255,maxB=0,minA=255,maxA=0;
  for(let y=layout.top;y<layout.bottom;y++){const i=(y*w+x)*4;if(delta(a.image.data,i,b.image.data,i)>2||delta(a.image.data,i,c.image.data,i)>2)return null;
   for(const data of [a.image.data,b.image.data,c.image.data]){const r=data[i],g=data[i+1],bl=data[i+2],al=data[i+3];base??=[r,g,bl];
    minR=Math.min(minR,r);maxR=Math.max(maxR,r);minG=Math.min(minG,g);maxG=Math.max(maxG,g);minB=Math.min(minB,bl);maxB=Math.max(maxB,bl);minA=Math.min(minA,al);maxA=Math.max(maxA,al);}}
  return maxR-minR<=2&&maxG-minG<=2&&maxB-minB<=2&&maxA-minA<=2?base:null;};
 const pureLimit=Math.min(16,Math.floor(w*.05));
 // 整个前缀必须同一颜色：以第一列为固定锚，不随列更新，逐列累计漂移不能混过去。
 const pureEdge=fromRight=>{let anchor=null,skip=0;
  while(skip<pureLimit){const column=pureColumn(fromRight?w-1-skip:skip);
   if(!column||anchor&&(Math.abs(column[0]-anchor[0])>2||Math.abs(column[1]-anchor[1])>2||Math.abs(column[2]-anchor[2])>2))break;
   anchor??=column;skip++;}
  return skip;};
 let edgeLeft,edgeRight;
 if(workspace?.edges){({left:edgeLeft,right:edgeRight}=workspace.edges);}
 else{
  const pureLeft=pureEdge(false),pureRight=pureEdge(true);
  edgeLeft=pureLeft;edgeRight=w-pureRight;
  while(edgeLeft<Math.floor(w*.2)&&softColumn(edgeLeft))edgeLeft++;while(edgeRight>Math.ceil(w*.8)&&softColumn(edgeRight-1))edgeRight--;
  // 纯色段本身不得因此拿豁免：后面没接上既有合格柔和纹理就退回 0/w，行为与无纯色时一致。
  if(edgeLeft===pureLeft)edgeLeft=0;if(edgeRight===w-pureRight)edgeRight=w;
  if(workspace)workspace.edges={left:edgeLeft,right:edgeRight};
 }
 const liveTiles=workspace?(workspace.liveTiles??=new Uint8Array(cols*rows).fill(1)):null;
 let marked=0;
 for(let ty=0;ty<rows;ty++)for(let tx=0;tx<cols;tx++){
  guard?.('learn-components');
  const tile=ty*cols+tx;
  if(liveTiles&&!liveTiles[tile])continue;
  if(ty*size<layout.top||(ty+1)*size>layout.bottom)continue;
  let witnesses=0;
  for(let y=ty*size;y<Math.min(h,(ty+1)*size);y++)for(let x=tx*size;x<Math.min(w,(tx+1)*size);x++){
   if(x<edgeLeft||x>=edgeRight||cover&&cover[y*w+x])continue;
   const i=(y*w+x)*4;
   // The expensive shape test cannot create a witness unless this original pixel stayed fixed.
   if(delta(a.image.data,i,b.image.data,i)>2||delta(a.image.data,i,c.image.data,i)>2)continue;
   const yy=y+a.offset-c.offset,reverseY=y+c.offset-a.offset;
   const disagrees=yy>=layout.top&&yy<layout.bottom&&!(cover&&(cover[yy*w+x]&4))&&differs(a,c,x,y,yy)||reverseY>=layout.top&&reverseY<layout.bottom&&!(cover&&(cover[reverseY*w+x]&1))&&differs(c,a,x,y,reverseY);
   if(disagrees)witnesses++;
  }
  if(witnesses>=1){bits[tile]=1;marked++;}
  else if(liveTiles)liveTiles[tile]=0;
 }
 const boxes=[],unknown=[];
 for(let i=0;i<bits.length;i++)if(bits[i]){
  const queue=[i];bits[i]=0;let left=cols,right=0,top=rows,bottom=0;
  for(let k=0;k<queue.length;k++){
   if((k&1023)===0)guard?.('learn-components');
   const j=queue[k],x=j%cols,y=Math.floor(j/cols);left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||xx>=cols||yy<0||yy>=rows)continue;const n=yy*cols+xx;if(bits[n]){bits[n]=0;queue.push(n);}}
  }
  if(!queue.length)continue;
  const rect={left:Math.max(0,left*size-8),right:Math.min(w,right*size+8),top:Math.max(0,top*size-8),bottom:Math.min(h,bottom*size+8)};
  if(rect.bottom-rect.top>(layout.bottom-layout.top)*.55||((rect.right-rect.left)*(rect.bottom-rect.top)>w*(layout.bottom-layout.top)*.35)){unknown.push(rect);continue;}
  boxes.push(rect);
 }
 // 合并相邻碎片，使空心图形内部与阴影一起取真实来源，不只擦轮廓。
 for(let changed=true;changed;){changed=false;outer:for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
  guard?.('learn-components');
  const a=boxes[i],b=boxes[j];if(a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top){boxes[i]={left:Math.min(a.left,b.left),right:Math.max(a.right,b.right),top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom)};boxes.splice(j,1);changed=true;break outer;}
 }}
 return {boxes,unknown,edges:{left:edgeLeft,right:edgeRight},wallpaper:marked>cols*Math.ceil((layout.bottom-layout.top)/size)*.18};
}
function template(rect,frames,maxPoints,guard){
 const [a,b,c]=frames,w=a.image.width,points=[];
 for(let y=rect.top;y<rect.bottom;y++){guard?.('learn-template');
  for(let x=rect.left;x<rect.right;x++){const i=(y*w+x)*4;if(delta(a.image.data,i,b.image.data,i)<=2&&delta(a.image.data,i,c.image.data,i)<=2){points.push({i,r:a.image.data[i],g:a.image.data[i+1],b:a.image.data[i+2]});if(points.length>maxPoints)return null;}}
 }
 return {...rect,points,firstId:Math.min(...frames.map(f=>f.id))};
}
// 模板与原始记录像素均不改写；同一对的逐点核验只做一次，弱引用不延长缓存帧寿命。
const presenceCache=new WeakMap();
function present(mask,record,guard){
 if(!record||!mask.points.length)return false;
 let cache=presenceCache.get(mask);const cached=cache?.get(record);if(cached!==undefined)return cached;
 guard?.('present');
 // 掩码点数可达数十万：入口之外每 1024 点再轮询一次，长模板核验不会整段霸住预算。
 let same=0;for(let k=0;k<mask.points.length;k++){if((k&1023)===0)guard?.('present');const p=mask.points[k];if(Math.max(Math.abs(record.image.data[p.i]-p.r),Math.abs(record.image.data[p.i+1]-p.g),Math.abs(record.image.data[p.i+2]-p.b))<=3)same++;}
 const result=same/mask.points.length>=.94;
 if(!cache){cache=new WeakMap();presenceCache.set(mask,cache);}cache.set(record,result);
 return result;
}
// 两幅原始图的框外邻域必须对应；修补像素永远不参与运动见证。
function ringMatches(target,source,rect,sourceTop,layout,masks,others,part,guard){
 guard?.('ring-matches');
 const w=source.image.width,dy=sourceTop-rect.top,targetImage=target?.image??part,origin=target?0:part.sourceTop,targetOffset=target?.offset??part.offset;let count=0,matching=0,detailed=0;
 const masked=(r,x,y)=>masks.some(m=>x>=m.left&&x<m.right&&y>=m.top&&y<m.bottom&&present(m,r,guard));
 const check=(x,y)=>{guard?.('ring-matches');const yy=y+dy,unknownTarget=!target&&masks.some(m=>x>=m.left&&x<m.right&&y>=m.top&&y<m.bottom);if(x<0||x>=w||y<layout.top||y>=layout.bottom||y<origin||y>=origin+targetImage.height||yy<layout.top||yy>=layout.bottom||unknownTarget||target&&masked(target,x,y)||masked(source,x,yy))return;count++;if(delta(targetImage.data,((y-origin)*w+x)*4,source.image.data,(yy*w+x)*4)<=3)matching++;const value=gray(source.image,x,yy);if(Math.max(Math.abs(value-gray(source.image,Math.max(0,x-1),yy)),Math.abs(value-gray(source.image,x,Math.max(0,yy-1))))>=12)detailed++;};
 for(let x=rect.left;x<rect.right;x+=Math.max(1,Math.floor((rect.right-rect.left)/12))){check(x,rect.top-2);check(x,rect.bottom+1);}
 for(let y=rect.top;y<rect.bottom;y+=Math.max(1,Math.floor((rect.bottom-rect.top)/12))){check(rect.left-2,y);check(rect.right+1,y);}
 if(count<8||matching/count<.95)return false;
 if(detailed>=4)return true;
 // 纯色邻域不能凭一圈同色证明来源，另要不同位置的第二张干净原图逐块一致。
 return others.some(other=>{
  if(other.offset===source.offset)return false;const y0=rect.top+targetOffset-other.offset;
  if(y0<layout.top||y0+rect.bottom-rect.top>layout.bottom||masks.some(m=>present(m,other,guard)&&rect.left<m.right&&rect.right>m.left&&y0<m.bottom&&y0+rect.bottom-rect.top>m.top))return false;
  // 低纹理整矩形兜底要逐像素走完整块：按行轮询，避免一块纯色区域绕过预算。
  for(let y=0;y<rect.bottom-rect.top;y++){guard?.('ring-matches');for(let x=rect.left;x<rect.right;x++){const p=((sourceTop+y)*w+x)*4,q=((y0+y)*w+x)*4;if(delta(source.image.data,p,other.image.data,q)>2||source.image.data[p+3]!==other.image.data[q+3])return false;}}
  return true;
 });
}
export function createAutoScrollSession(seed,options={}){
 // 默认容纳建窗必需的三帧并留一帧周转；16M像素护栏仍限制预算，显式缓存上限不擅自抬高。
 const maxFrames=options.maxFrames??6,maxBytes=options.maxBytes??Math.max(64*1024*1024,seed.data.byteLength*4),maxHeight=Math.min(options.maxHeight??MAX_HEIGHT,MAX_HEIGHT,Math.floor(MAX_PIXELS/seed.width));
 fingerprint(seed);
 if(!Number.isInteger(maxFrames)||maxFrames<3||!Number.isInteger(maxBytes)||maxBytes<seed.data.byteLength*3||!Number.isInteger(maxHeight)||maxHeight<seed.height||seed.width*seed.height>MAX_PIXELS)throw new RangeError('自动识别选区过大或缓存不足，请缩小选区');
 const w=seed.width,h=seed.height,stride=w*4;let seq=0,cleared=false,layout=null,learningRange=null,frames=[],masks=[],chunks=[],prefix=null,frontier=null,geometry=0,trusted=0,ceiling=0,trustedCeiling=0,lastViewport=null,viewportMatched=false,limit=false,paused=false,lastKind='learning',lastWarning='',bytes=0,pending='',unknown=[],lastMissing=[],lastShift=0,lastForeground=false,lastScore=0,background=null,lastMotion={},fixedSummary={},proofDomain=null;
 const record=(image,offset,atMs,fp)=>{const f={id:seq++,offset,atMs,image:{width:w,height:h,data:new Uint8ClampedArray(image.data)}};f.fp=fp??fingerprint(f.image);frames.push(f);bytes+=f.image.data.byteLength;return f;};
 const seedMeta={width:w,height:h};let initial=record(seed,0,0),anchor=initial;seed=null;
 // 预算只在 accept/finish 开头起算，guard 每 64 次检查才读一次时钟，避免逐像素取时；不共享全局可变状态。
 const nowMs=options.now??(()=>performance.now());
 const analysisBudgetMs=options.analysisBudgetMs??Infinity;
 if(!(analysisBudgetMs===Infinity||Number.isFinite(analysisBudgetMs)&&analysisBudgetMs>0))throw new RangeError('遮挡分析预算无效');
 let budgetEnd=Infinity,budgetTicks=0,learnPasses=0,learnDuration=0,repairDuration=0,recoveredFrames=0;
 // 文档环证据只是独立来源证据的观察：必须显式开启（匿名测试专用），生产入口不传，默认关闭。
 // 只做有上限的计数，从不参与 clean/resolved/missing/trusted/checkpoint 判定。
 const ringEvidence=options.inspectDocumentRing===true;
 let documentRingChecks=0,documentRingSupported=0,documentRingRefused=0,ringObservations=0;
 // 文档环实际修补（实验）：默认关闭，renderer 不传；只有旧环规则无源时才查双整框来源。
 const repairRing=options.repairDocumentRing===true;
 const REPAIR_WARNING='实验性修补，来源未完全核实，请对照原图检查';
 let documentRepairCopies=0,repairBlocked=false;
 // 证据版本：只要新增遮挡掩码或未知区，先前“可信”像素就可能被重判，旧检查点随之失效。
 // 用回调即时上报，不靠回包：预算在 learn 中途抛出时调用方也能先收到失效通知。
 let evidenceRevision=0,checkpointBlocked=false,blockedWarning='';
 const noteEvidence=reason=>{
  evidenceRevision++;
  try{options.onEvidence?.(evidenceRevision,reason);}catch{/* 上报失败不影响分析本身 */}
 };
 const startBudget=()=>{budgetTicks=0;budgetEnd=analysisBudgetMs===Infinity?Infinity:nowMs()+analysisBudgetMs;};
 const guard=stage=>{
  if(budgetEnd===Infinity)return;
  if((++budgetTicks&63)!==0||nowMs()<=budgetEnd)return;
  // 预算耗尽留下的是一帧半分析的证据：先标成未完成，避免后续 finish 把当前帧当可信成图。
  pending='遮挡分析超出预算，后续未核实';
  const error=new RangeError('遮挡分析超出预算');
  error.code='analysis-budget';error.stage=stage;
  throw error;
 };
 const active=()=>{if(cleared)throw new Error('滚动会话已清除');};
 // 失配类 pending 只表示“上一帧没对上”；一旦本帧对齐被确认（正常核验/历史重定位/精确回位）就清掉。
 // 尺寸、重叠、预算、未知区等其余 pending 不动，后续 append 也会重新置上自己的 pending。
 const clearMismatch=()=>{
  if(pending==='滚动跨得太远，缺少重叠'){pending='';lastWarning='';return true;}
  if(pending==='末段没有可靠对齐'||pending==='画面存在未确认的运动或重排'){pending='';return true;}
  return false;
 };
 const originals=()=>[...new Set([...frames,initial,frontier,anchor].filter(Boolean))];
 const trim=()=>{for(;;){const retained=originals();bytes=retained.reduce((n,f)=>n+f.image.data.byteLength,0);if(retained.length<=maxFrames&&bytes<=maxBytes)break;const index=frames.findIndex(f=>f!==initial&&f!==frontier&&f!==anchor);if(index<0){paused=true;lastWarning='原始来源缓存不足，停止追加';break;}frames.splice(index,1);}};
 const part=(f,top,bottom)=>({...crop(f.image,top,bottom),sourceTop:top,recordId:f.id,offset:f.offset,covered:new Set(masks.flatMap((m,k)=>present(m,f)?[k]:[])),resolved:new Set()});
 // 环证据与整框修补共用的遮挡谓词：已记录 unknown 与当前 masks 都算被挡。
 const blockedBox=(record,box)=>unknown.some(m=>box.left<m.right&&box.right>m.left&&box.top<m.bottom&&box.bottom>m.top)||masks.some(m=>present(m,record,guard)&&box.left<m.right&&box.right>m.left&&box.top<m.bottom&&box.bottom>m.top);
 function observeRing(target,rect,part){
  // 旁路观察：只在旧环规则本轮拒绝、且目标帧仍保留时，记录一份有上限的文档环证据。
  // 只累加计数，不改 clean / resolved / missing / trusted / checkpoint，也不碰任何像素。
  const candidate=originals().find(f=>f!==target&&Math.abs(target.offset-f.offset)>=rect.bottom-rect.top+2&&rect.top+part.offset-f.offset>=layout.top&&rect.top+part.offset-f.offset+rect.bottom-rect.top<=layout.bottom);
  if(!candidate)return;
  ringObservations++;documentRingChecks++;
  const evidence=inspectDocumentRing({target,source:candidate,retained:originals(),rect,layout:{left:0,right:w,...layout},guard,blocked:blockedBox});
  if(evidence.supported)documentRingSupported++;else documentRingRefused++;
 }
 function markAndRepair(parts){
  const missing=[];ringObservations=0;guard('mark-repair');
  for(const rect of unknown)for(const p of parts){guard('mark-repair');const top=Math.max(rect.top,p.sourceTop),bottom=Math.min(rect.bottom,p.sourceTop+p.height);if(bottom>top)missing.push({top:top+p.offset,bottom:bottom+p.offset,left:rect.left,right:rect.right});}
  for(const p of parts)for(let k=0;k<masks.length;k++){
   guard('mark-repair');
   const m=masks[k],target=originals().find(f=>f.id===p.recordId);
   if(target&&present(m,target,guard))p.covered.add(k);
   // 原帧已淘汰时，模板不匹配不能证明没有部分遮挡；交集一律先记未知。
   // 仍可用未改写的原始片段边缘与新原图核对；没有邻域/来源就保留缺口。
   if(!target&&!p.resolved.has(k)&&m.top<p.sourceTop+p.height&&m.bottom>p.sourceTop)p.covered.add(k);
   if(!p.covered.has(k)||p.resolved.has(k))continue;
   const top=Math.max(m.top,p.sourceTop),bottom=Math.min(m.bottom,p.sourceTop+p.height);
   if(bottom<=top){p.resolved.add(k);continue;}
   const rect=target?m:{...m,top,bottom};
   const clean=originals().find(f=>{
    const y=rect.top+p.offset-f.offset;
    return f.id!==p.recordId&&y>=layout.top&&y+rect.bottom-rect.top<=layout.bottom&&
      !masks.some(n=>present(n,f,guard)&&rect.left<n.right&&rect.right>n.left&&y<n.bottom&&y+rect.bottom-rect.top>n.top)&&ringMatches(target,f,rect,y,layout,masks,originals(),p,guard);
   });
   if(clean){for(let y=top;y<bottom;y++){if(((y-top)&31)===0)guard('repair-copy');const from=((y+p.offset-clean.offset)*w+m.left)*4,to=((y-p.sourceTop)*w+m.left)*4;p.data.set(clean.image.data.subarray(from,from+(m.right-m.left)*4),to);}p.resolved.add(k);}
   else{
    // 旧规则无源时才试双整框证据；只有两张现有原帧在同一文档坐标逐字节一致才写，写前只查一次预算。
    const source=target&&repairRing?findDocumentRepairSource({target,retained:originals(),rect,
     layout:{left:0,right:w,top:layout.top,bottom:layout.bottom},blocked:blockedBox,guard}):null;
    if(source){
     // 一次性原子提交：先查一次预算，之后整框同步复制，不在行间抛预算（≤1MiB 有界）。
     guard('repair-copy');
     const cols=rect.right-rect.left;
     for(let y=top;y<bottom;y++){
      const from=((y+p.offset-source.offset)*w+rect.left)*4,to=((y-p.sourceTop)*w+rect.left)*4;
      p.data.set(source.image.data.subarray(from,from+cols*4),to);
     }
     p.resolved.add(k);documentRepairCopies++;
     // 来源只能算支持性证据：一旦实际写过像素，本场永久封死检查点，不再重新认证。
     if(!repairBlocked){repairBlocked=true;checkpointBlocked=true;blockedWarning=REPAIR_WARNING;noteEvidence('document-repair');}
    }else{
     if(target&&ringEvidence&&ringObservations<4)observeRing(target,rect,p);
     missing.push({top:top+p.offset,bottom:bottom+p.offset,left:m.left,right:m.right});
    }
   }
  }
  return missing;
 }
 function learn(){
  // 大区证据不足时保留原像素续采；不再重复扩张掩码，缺口仍由收尾逐片标记。
  if(unknown.length){fixedSummary={fixedStopReason:fixedSummary.fixedStopReason,fixedAnalysisSkipped:true};return;}
  const unique=[];for(let i=frames.length-1;i>=0&&unique.length<3;i--)if(!unique.some(f=>f.offset===frames[i].offset))unique.unshift(frames[i]);
  if(unique.length<3)return;
  // 先确认较大静止物，再排除这些被挡原图中的假运动见证，逐个重算。
  // 不能把“旧帧恰好被球挡住”误认成另一处新浮物。
  // 本次 learn 只追加固定掩码，present 对固定帧不变，覆盖只增不减；零见证 tile 不会复活。
  // workspace 不跨 learn；剪枝图与 BFS 消费的 bits 独立，覆盖位图仍每轮重建。
  const workspace={cover:null,liveTiles:null,edges:null};
  for(let pass=0;pass<=32;pass++){
   learnPasses++;guard('learn-mask');
   const found=components(unique,layout,masks,guard,workspace);
   fixedSummary={fixedCandidates:found.boxes.length,fixedUnknown:found.unknown.length,fixedEdgeLeft:found.edges.left,fixedEdgeRight:found.edges.right};
   if(found.unknown.length||found.wallpaper&&found.boxes.length)fixedSummary.fixedStopReason=found.unknown.length?'large-region':'dense-regions';
   if(found.unknown.length||found.wallpaper&&found.boxes.length){unknown.push(...found.unknown,...found.boxes);noteEvidence('unknown');lastWarning='已保留原像素继续接长；有区域未确认，可能重复或缺失';return;}
   const box=found.boxes.sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top))[0];
   if(!box)return;
   const room=262144-masks.reduce((n,m)=>n+m.points.length,0),m=room>0&&masks.length<32?template(box,unique,room,guard):null;
   // 遮挡预算用尽不再停下整个长截图：超出的固定区按原样拼接，由收尾提示带出。
   if(!m||!m.points.length){fixedSummary.fixedStopReason='mask-budget';lastWarning='固定遮挡过多，超出的部分按原样拼接';
    // 无法建立模板就无法证明旧片段已修复；本场后续也不再导出“无缺口”检查点。
    if(!checkpointBlocked){checkpointBlocked=true;blockedWarning=lastWarning;noteEvidence('mask-budget');}return;}
   masks.push(m);noteEvidence('mask');
  }
 }
 // 只附加几何坐标供实验定位误判来源；不含像素、文本或特征，诊断白名单仍自行过滤。
 const rectList=list=>list.slice(0,8).map(({left,right,top,bottom})=>({left,right,top,bottom}));
 const unknownSummary=()=>{const r=unknown.reduce((a,b)=>!a||(b.right-b.left)*(b.bottom-b.top)>(a.right-a.left)*(a.bottom-a.top)?b:a,null);return r?{unknownTop:r.top,unknownBottom:r.bottom,unknownLeft:r.left,unknownRight:r.right}:{};};
 // 文档顺序：向上片段已插在首屏正文之前，prefix 与 footer 固定在两端。
 const orderedParts=()=>[...(prefix?[prefix]:[]),...chunks,...(frontier?.footer?[frontier.footer]:[])];
 const previewField=()=>{const preview=renderPreview(w,layout?orderedParts():[initial.image]);return preview?{preview}:{};};
 const viewportAt=f=>layout?{top:layout.top+(f.offset-ceiling),height:layout.bottom-layout.top,matched:true}:undefined;
 const view=(kind,added=0,includeReference=false,capturedAdded=0)=>({autoEvidence:{...lastMotion,...fixedSummary,...unknownSummary(),maskCount:masks.length,evidenceRevision,...(ringEvidence?{documentRingChecks,documentRingSupported,documentRingRefused}:{}),...(repairRing?{documentRepairCopies}:{}),masks:masks.map(({left,right,top,bottom})=>({left,right,top,bottom})),unknownRects:rectList(unknown),missingRects:rectList(lastMissing),rawFrames:originals().length,rawBytes:bytes},result:{kind,auto:true,shift:lastShift,error:lastScore,foreground:lastForeground,...(lastWarning?{message:lastWarning}:{}),...(layout?{content:{...layout}}:{})},height:h+trusted-trustedCeiling,chunks:trusted-trustedCeiling>0?chunks.length:1,added,capturedHeight:h+geometry-ceiling,capturedChunks:chunks.length||1,capturedAdded,pendingFrames:frames.length,pendingBytes:bytes,droppedFrames:0,recoveredFrames,limit,complete:Boolean(layout)&&!paused&&!pending&&!checkpointBlocked&&lastKind!=='occluded',...(includeReference||added>0||capturedAdded>0?{reference:reference(frontier?.image??initial.image,layout),...previewField()}:{}),...(lastViewport?{viewport:{...lastViewport,matched:viewportMatched}}:{})});
 function append(f){
  const advanceDown=f.offset-geometry,advanceUp=ceiling-f.offset;
  if(advanceDown<=0&&advanceUp<=0){if(f.offset===geometry)frontier=f;return;}
  const bodyHeight=layout.bottom-layout.top,advance=advanceDown>0?advanceDown:advanceUp;
  if(advance>=bodyHeight){pending=lastWarning='滚动跨得太远，缺少重叠';lastKind='unmatched';return;}
  const span=Math.max(geometry,f.offset)-Math.min(ceiling,f.offset);
  if(h+span>maxHeight||chunks.length>=1000){limit=true;pending='已达到长图尺寸或片段上限';return;}
  const rising=advanceDown>0;
  // 顶部区始终跟随最上方已接帧：真固定 header 的像素不会变，换新帧安全；
  // support 保守排除的两行本就不保证固定，不能一直用首帧。
  const piece=rising?part(f,layout.bottom-advance,layout.bottom):part(f,layout.top,layout.top+advance);
  piece.mask=observeBackground(background,crop(frontier.image,layout.top,layout.bottom),crop(f.image,layout.top,layout.bottom),{start:rising?bodyHeight-advance:0,rows:advance});piece.sourceStart=rising?bodyHeight-advance:0;
  if(rising){chunks.push(piece);geometry=f.offset;frontier=f;}
  else{prefix=part(f,0,layout.top);chunks.unshift(piece);ceiling=f.offset;}
  pending='';
 }
 // 历史重定位：正常核验失败或失定位后回到已截范围才跑。参考只取仍保留、且落在已截
 // [ceiling,geometry] 内的原帧；所有通过证明的候选必须给出同一个绝对 offset，否则整体拒绝（不是 first-hit）。
 // known 仅接收已过原门或正文 exact 的图内 anchor 候选；它也必须与其他原帧一致，避免周期内容假回位。
 // 不新增片段、不收图外位置、不复制原图、不加缓存预算、不放宽证明；anchor/frames/几何的提交由 accept 做。
 function relocate(image,b,known=null){
  if(paused||!layout)return null;
  const spent=()=>Number.isFinite(budgetEnd)&&nowMs()>budgetEnd;
  const context=proofDomain?{domain:proofDomain}:undefined,rawNew=bodyView(image,layout.top,layout.bottom),found=known?[known]:[];
  for(const ref of originals()){
   if(ref===anchor||ref.offset<ceiling||ref.offset>geometry)continue;
   // 候选之间直接查共享预算：耗尽就安全放弃本次重定位，不把没检查完的候选集当结论。
   if(spent())return null;
   const rawRef=bodyView(ref.image,layout.top,layout.bottom),m=motionBetween(rawRef,rawNew,ref.bodyFp??=fingerprint(rawRef),b);
   // 原帧自身给出的强冲突候选与普通路径同标准拒绝，不以历史名义绕过。
   if(m.conflicting||!['motion','still'].includes(m.kind))continue;
   const s=m.kind==='motion'?m.shift:0;
   // 位移为 0 只认正文与原帧逐字节相同（首栏/时钟像素不算证据），固定背景的 still 不能冒充回位。
   if(!s){if(!samePixels(rawRef.data,rawNew.data))continue;}
   else if(!support(ref.image,image,s,layout,context).ok)continue;
   const offset=ref.offset+s;
   // 跨空洞、越过已截两端都不接入：只重定位到已截范围之内。
   if(offset<ceiling||offset>geometry)continue;
   found.push({offset,shift:offset-anchor.offset,method:m.method,error:m.error??0,foreground:Boolean(m.foreground)});
  }
  // 一致性检查与提交之前再查一次预算：尾候选可能刚好用尽，不能带着未检查完的集合提交。
  if(spent())return null;
  // 绝对位置必须一致：不同参考给出不同落点就整体拒绝，不是 first-hit。
  if(!found.length)return null;
  const offset=found[0].offset;
  if(found.some(r=>r.offset!==offset))return null;
  // 不写回任何诊断阶段：失败保留原 candidate/pixel-proof 与 proofSummary，成功走原有 fixed-analysis/ready。
  return found[0];
 }
 return {
  accept(image,atMs){
   active();if(image.width!==w||image.height!==h||image.data.length!==w*h*4||!Number.isFinite(atMs))throw new RangeError('自动截图尺寸或采集时间无效');
   startBudget();
   const wasMatched=viewportMatched;
   lastShift=0;lastForeground=false;lastScore=0;viewportMatched=false;recoveredFrames=0;
   if(paused){lastMotion={analysisStage:'paused'};return view('layout-changed');}
   if(samePixels(image.data,anchor.image.data)){
    lastMotion={analysisStage:'identical'};
    // 全帧相同只证明“没动”：只有已建 layout 且 anchor 真在已截范围内才是可信回位；
    // 图外 anchor（如尺寸上限拒收）与首屏未建窗都不得标绿。失配留下的 pending 在此清掉，
    // 但 lastKind 仍按既有缺口记 occluded，未知区/警告/检查点封锁一概不洗白。
    if(layout&&!paused&&anchor.offset>=ceiling&&anchor.offset<=geometry){
     if(!wasMatched){
      const b=anchor.bodyFp??=fingerprint(bodyView(image,layout.top,layout.bottom));
      if(!relocate(image,b,{offset:anchor.offset,shift:0,error:0,foreground:false})){
       pending||='末段没有可靠对齐';lastKind='ambiguous';return view('ambiguous');
      }
     }
     viewportMatched=true;lastViewport=viewportAt(anchor);
     if(clearMismatch())recoveredFrames=1;
     lastKind=lastMissing.length?'occluded':'still';
     return view(lastKind);
    }
    viewportMatched=wasMatched;return view(!layout?'learning':lastKind==='occluded'?'occluded':'still');
   }
   const fp=fingerprint(image);
   // body 部分只需读像素：用共享帧上的只读视图，不再每帧复制两块正文 RGBA。
   const rawB=layout?bodyView(image,layout.top,layout.bottom):image;
   const rawA=layout?bodyView(anchor.image,layout.top,layout.bottom):anchor.image;
   // 记录一旦建立不再改写、layout 也只在建窗时落定：anchor 的 body 指纹缓存一次即可。
   const a=layout?(anchor.bodyFp??=fingerprint(rawA)):anchor.fp;
   const b=layout?fingerprint(rawB):fp;
   const motion=motionBetween(rawA,rawB,a,b);
   lastMotion={analysisStage:'candidate',motionMethod:motion.method,...(motion.support!==undefined?{motionSupport:motion.support}:{})};
   // 正常候选 + 原像素核验优先；失败或失定位后回到已截范围时，才核对历史位置的一致性。
   let shift=0,failed=null;
   if(!['motion','still'].includes(motion.kind))failed=()=>{pending='末段没有可靠对齐';lastKind=motion.kind;return view(motion.kind);};
   else{
    shift=motion.kind==='motion'?motion.shift:0;
    lastShift=shift;lastForeground=Boolean(motion.foreground);lastScore=motion.error??0;
    /* viewportMatched 只在本帧对齐得到确认后置真 */
    if(shift){
     // 建窗期：窄域只能当候选许可（{bootstrap:true}）；建窗后：只允许在冻结的历史域里用（{domain}）。
     const context=layout?(proofDomain?{domain:proofDomain}:undefined):{bootstrap:true};
     const check=support(anchor.image,image,shift,layout??learningRange,context);lastMotion.analysisStage='pixel-proof';Object.assign(lastMotion,proofSummary(check));
     if(!check.ok)failed=()=>{pending='画面存在未确认的运动或重排';lastKind='ambiguous';return view('ambiguous');};
     // 建窗前也沿用已经通过原帧核验的正文交集；它只收缩证据域，不提前宣布布局。
     // 窄域放行本身不得收缩：否则就是拿自己收窄的 y 范围去放大动画证据。
     else if(!layout&&!check.domainUsed)learningRange={top:Math.max(learningRange?.top??0,check.top),bottom:Math.min(learningRange?.bottom??h,check.bottom)};
    }
   }
   // 零位移的 still 只能靠“正文逐字节相同”证明没动；固定背景或首栏颤动的静止不算证据。
   const stillBody=Boolean(layout)&&!failed&&shift===0&&samePixels(rawA.data,rawB.data);
   // 一般 still（正文不 exact）且当前不在已确认位置时，正常候选按失败处理：交给历史原帧真正证明，
   // 不直接背书、也不清掉失配 pending。已定位时的普通 still 沿用原语义，不另造门。
   if(!failed&&!paused&&layout&&shift===0&&!stillBody&&!wasMatched)failed=()=>{pending='末段没有可靠对齐';lastKind='unmatched';return view('unmatched');};
   // 失定位后，已过局部门的图内候选也须与历史原帧一致；周期别名不能靠零移位或局部位移洗白。
   const knownOffset=anchor.offset+shift;
   const verifyReturn=!failed&&layout&&!wasMatched&&(shift!==0||stillBody)&&knownOffset>=ceiling&&knownOffset<=geometry;
   const known=verifyReturn?{offset:knownOffset,shift,error:lastScore,foreground:lastForeground}:null;
   // 正常 strong 冲突不允许被历史重定位绕过。
   const relocated=(failed||verifyReturn)&&layout&&!motion.conflicting?relocate(image,b,known):null;
   if((failed||verifyReturn)&&!relocated){
    if(failed)return failed();
    pending||='末段没有可靠对齐';lastKind='ambiguous';return view('ambiguous');
   }
   if(relocated){shift=relocated.shift;lastShift=shift;lastForeground=relocated.foreground;lastScore=relocated.error;}
   // 只有真实位移核验通过、正文严格零位移或历史原帧证明成功，才算对齐确认（可清失配 pending + 恢复事件）。
   if((relocated||(!failed&&(shift!==0||stillBody)))&&clearMismatch())recoveredFrames=1;
   const oldGeometry=geometry,oldCeiling=ceiling,oldTrusted=trusted,oldTrustedCeiling=trustedCeiling;
   const f=record(image,anchor.offset+shift,atMs,fp);
   // 本帧 body 指纹刚算过：布局已有时缓存给下一帧当 anchor，避免重复整帧重算。
   if(layout)f.bodyFp=b;
   anchor=f;
   // 重定位只换 anchor、不补片段；落点仍在已截范围内时 append 只会更新 frontier/无操作。
   if(relocated){append(f);recoveredFrames=1;}
   else if(!layout){
    const different=frames.filter((f,i,list)=>list.findIndex(g=>g.offset===f.offset)===i);
    if(different.length<3){lastMotion.analysisStage='collecting';trim();lastKind='learning';return view('learning');}
    const tail=different.at(-1),closure=motionBetween(initial.image,tail.image,initial.fp,tail.fp);
    if(closure.kind!=='motion'||closure.shift!==tail.offset){lastMotion={analysisStage:'closure',motionMethod:closure.method,closureShift:closure.shift,closureExpected:tail.offset};lastKind='ambiguous';trim();return view('ambiguous');}
    const checks=[];let narrowUsed=false;
    // 建窗窄域：相邻对与 initial↔tail 各自的独立变化域求交集；交集不够宽就不许用窄域例外。
    const pairs=[];for(let i=1;i<different.length;i++)pairs.push([different[i-1],different[i]]);pairs.push([initial,tail]);
    let shared=null;
    for(const [from,to] of pairs){const own=changeDomain(from.image,to.image,null);shared=shared?intersectDomain(shared,own):own;if(!shared)break;}
    // 共同域不仅要交集，还必须在 initial↔tail 上被原帧真实验证过（真实 support 闭合），
    // 否则不缓存：光靠 changeDomain 交集自证不够。
    const closureProof=shared?support(initial.image,tail.image,tail.offset,learningRange,{bootstrap:true,domain:shared}):null;
    for(let i=1;i<different.length;i++){
     const d=different[i].offset-different[i-1].offset;
     let proof=support(different[i-1].image,different[i].image,d,learningRange);
     if(!proof.ok&&shared){const alt=support(different[i-1].image,different[i].image,d,learningRange,{bootstrap:true,domain:shared});if(alt.ok){proof=alt;narrowUsed=true;}}
     if(!proof.ok){lastMotion={analysisStage:'initial-proof',...proofSummary(proof)};lastKind='ambiguous';trim();return view('ambiguous');}
     checks.push(proof);
    }
    // 窄例外参与建窗时，它的共同域必须先经闭合验证，否则不许建窗。
    if(narrowUsed&&!closureProof?.ok){lastMotion={analysisStage:'initial-proof',...proofSummary(closureProof??{})};lastKind='ambiguous';trim();return view('ambiguous');}
    const top=Math.max(learningRange?.top??0,...checks.map(c=>c.top)),bottom=Math.min(learningRange?.bottom??h,...checks.map(c=>c.bottom));
    if(bottom-top<48){lastKind='learning';trim();return view('learning');}
    layout={top,bottom};
    // 只有 layout 真的建立时才落域：开场全 strict 也缓存（已验证的共同域），失败尝试不留陈旧域。
    // Build 只表示“窄例外参与了建窗”，单纯保存严格路径验过的域不算。
    proofDomain=shared&&closureProof?.ok?{left:shared.left,right:shared.right}:null;
    if(narrowUsed)lastMotion.motionDomainBuild=true;learningRange=null;background=createBackgroundModel(w,bottom-top);prefix=part(initial,0,top);chunks=[part(initial,top,bottom)];frontier=initial;lastViewport={top,height:bottom-top,matched:false};
    for(const old of frames)append(old);
   }else append(f);
   // 运动核验成功不代表画面已收进成图：尺寸/重叠拒绝后不得把图外锚点报成已定位。
   // 已通过历史重定位的落点按构造就在已截范围内，可按真实几何更新视口。
   viewportMatched=relocated?true:(shift!==0||stillBody)&&f.offset>=ceiling&&f.offset<=geometry;
   lastMotion.analysisStage='fixed-analysis';const learnStarted=nowMs();learn();learnDuration+=nowMs()-learnStarted;
   const footer=part(frontier,layout.bottom,h),repairStarted=nowMs(),missing=markAndRepair([prefix,...chunks,footer].filter(Boolean));repairDuration+=nowMs()-repairStarted;lastMissing=missing;
   if(!paused)lastMotion.analysisStage=missing.length?'composition':'ready';
   // 尾部片段取自已采集最远位置（不等于无缺口可信位置）；原始图另存以便证明运动。
   frontier.footer=footer;
   const old=trusted;if(!missing.length&&!paused){trusted=geometry;trustedCeiling=ceiling;}
   lastKind=paused?'layout-changed':missing.length?'occluded':shift<0?'reverse':shift===0?'still':'forward';
   if(!paused&&layout&&viewportMatched&&anchor)lastViewport=viewportAt(anchor);
   trim();return view(lastKind,Math.max(0,(trusted-trustedCeiling)-(oldTrusted-oldTrustedCeiling)),false,Math.max(0,(geometry-ceiling)-(oldGeometry-oldCeiling)));
  },
  stats(){active();return view(lastKind,0,true);},
  // 只给诊断用的少量计数；已清除时仍可安全读取，不触发“会话已清除”异常。
  // learnPasses/learnDuration/repairDuration 为整场会话累计值（跨帧累加、不清零），只用于量级诊断，不是单帧耗时。
  counters(){return {learnPasses,learnDuration,repairDuration,trustedSpan:trusted-trustedCeiling,evidenceRevision};},
  // 可信检查点：布局与可信跨度都已落定、没有待办/缺口时，直接 compose 已确认片段。
  // 不重铺背景、不做事后掩码修补，也不靠裁高冒充；后续 learn 若又发现固定遮挡，这份快照只代表“最后一次确认”。
  checkpoint(){
   active();
   if(!layout||paused||pending||unknown.length||lastMissing.length||checkpointBlocked)return null;
   if(geometry!==trusted||ceiling!==trustedCeiling||trusted-trustedCeiling<=0)return null;
   const footer=frontier?.footer??part(frontier,layout.bottom,h),parts=[prefix,...chunks,footer].filter(Boolean);
   if(!parts.length)return null;
   // 检查点只是保底数据，尺寸护栏或片段异常时宁可不给，不把异常报成匹配失败。
   try{return {...compose(parts,w),evidenceRevision};}catch{return null;}
  },
  finish(){
   active();startBudget();
   if(!layout)return {...seedMeta,data:new Uint8ClampedArray(initial.image.data),complete:false,missingRanges:[],...(ringEvidence?{documentRingChecks,documentRingSupported,documentRingRefused}:{}),...(repairRing?{documentRepairCopies}:{}),warning:'还需再小幅滚动一下确认范围；本次仅保留首屏'};
   const footer=frontier.footer??part(frontier,layout.bottom,h),parts=[prefix,...chunks,footer].filter(Boolean),repairStarted=nowMs(),missing=markAndRepair(parts);repairDuration+=nowMs()-repairStarted;
   // 沿用已有壁纸延展，不将修补结果送回原始运动证据。已知/未知浮物所在整列禁重铺。
   for(const rect of [...masks,...unknown])for(let x=rect.left;x<rect.right;x++)background.movingColumns[x]=1;
   const rendered=chunks.map(p=>({...p,data:new Uint8ClampedArray(p.data),mask:p.mask?new Uint8Array(p.mask):null}));
   const seedIndex=chunks.findIndex(p=>p.offset+(p.sourceTop-layout.top)===0);
   const wallpaper=extendBackground(seedIndex>0?rendered.slice(seedIndex):rendered,background,{seedHeight:layout.bottom-layout.top});
   const output={...compose([prefix,...rendered,footer].filter(Boolean),w),background:wallpaper,backgroundEvidence:backgroundSummary(background)};
   // 拼不到干净来源的部分不再截断整张长图：按已接范围完整输出，只标记出来，
   // 让人能拿到完整的正文，同时知道哪里可能重复或缺失。
   // 遮挡预算耗尽时，超出预算的固定物没有被掩码证明过，成图里可能留着旧像素的重复/缺失；
   // 原像素照旧完整输出（不伪造缺口矩形、不截断），但这一场不再宣称“完整”。
   const complete=!missing.length&&!paused&&!pending&&!checkpointBlocked;
   return {...output,complete,missingRanges:missing,...(ringEvidence?{documentRingChecks,documentRingSupported,documentRingRefused}:{}),...(repairRing?{documentRepairCopies}:{}),warning:complete?'':repairBlocked?REPAIR_WARNING:pending||lastWarning||blockedWarning||'长图已拼出，但有内容无法从其他帧确认，该处可能重复或缺失'};
  },
  clear(){if(cleared)return;frames=[];masks=[];chunks=[];unknown=[];prefix=frontier=anchor=initial=background=learningRange=null;ceiling=trustedCeiling=0;lastViewport=null;viewportMatched=false;bytes=0;cleared=true;}
 };
}
