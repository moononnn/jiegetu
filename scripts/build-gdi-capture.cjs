'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
function build(){
 if(process.platform!=='win32')throw new Error('GDI采集组件仅支持Windows');
 const csc=path.join(process.env.WINDIR||process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 if(!fs.existsSync(csc))throw new Error('缺少本机编译器，未尝试安装');
 const root=path.resolve(__dirname,'..'),output=path.join(root,'native/gdi-capture.exe');
 const run=spawnSync(csc,['/nologo','/utf8output','/optimize+','/platform:x64','/target:exe',`/out:${output}`,path.join(root,'native/gdi-capture.cs')],{windowsHide:true,encoding:'utf8',timeout:30000});
 if(run.error||run.status!==0||!fs.existsSync(output))throw new Error(run.error?.message||run.stdout||run.stderr||'未生成采集组件');
 return output;
}
if(require.main===module){try{console.log(build());}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
