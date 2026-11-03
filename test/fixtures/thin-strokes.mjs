// Owned sub-sample-width strokes. The old 48-column fingerprint misses every stroke;
// the raw-pixel proof still sees them. This is a sampling counterexample, not a real page.
export const THIN_WIDTH=343;
export const THIN_HEIGHT=539;
export const THIN_OFFSETS=[0,4,108,140,172];
const excluded=new Set();
for(let c=0;c<48;c++){const x=Math.floor(THIN_WIDTH*(.06+.88*(c+.5)/48));for(let dx=-2;dx<=2;dx++)excluded.add(x+dx);}
const columns=new Set();for(let x=26;x<THIN_WIDTH*.97-2;x+=4)if(!excluded.has(x))columns.add(x);
export function thinFrame(offset,height=THIN_HEIGHT){
 const data=new Uint8ClampedArray(THIN_WIDTH*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<THIN_WIDTH;x++){
  let z=Math.imul(y+offset+119,0x9e3779b1)^Math.imul(x+13,0x85ebca6b);z^=z>>>16;z=Math.imul(z,0x7feb352d);z^=z>>>15;
  const v=columns.has(x)&&(z&1)?35:245,p=(y*THIN_WIDTH+x)*4;data[p]=data[p+1]=data[p+2]=v;data[p+3]=255;
 }
 return {width:THIN_WIDTH,height,data};
}
export function thinScene(){
 const frames=THIN_OFFSETS.map(offset=>({offset,image:thinFrame(offset)}));
 return {seedFrame:frames[0].image,frames,expected:thinFrame(0,THIN_HEIGHT+THIN_OFFSETS.at(-1))};
}
