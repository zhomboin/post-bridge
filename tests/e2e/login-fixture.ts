import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteLoginManager } from '../../apps/worker/src/remote-login.js';
import { openLoginBrowser } from '../../apps/worker/src/login-browser.js';
import { startLoginControl } from '../../apps/worker/src/login-control.js';

export async function remoteLoginFixture(directory:string,token:string){
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='test';
  const site=createServer(async(req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url==='/authenticate'&&req.method==='POST'){
      let body='';for await(const chunk of req)body+=chunk;
      if(body!=='synthetic-code:true:'&&body!=='123456:true:12345678901'){res.statusCode=400;res.end('未通过');return;}
      res.setHeader('Set-Cookie','synthetic-login=yes; HttpOnly; SameSite=Lax; Path=/');res.end('ok');return;
    }
    if(req.url==='/account'&&req.headers.cookie?.includes('synthetic-login=yes')){res.end('<a href="https://blog.csdn.net/synthetic-csdn-account">演示创作者</a>');return;}
    if(req.url==='/account'){res.end('<a href="/login">登录</a>');return;}
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font:24px sans-serif;background:#f6f8fa}input,button{font:24px sans-serif;position:absolute;left:40px}input{top:80px;width:300px;height:45px}button{top:240px;width:200px;height:50px}#slider{position:absolute;left:40px;top:165px;width:280px;height:45px;background:#d8dee8;touch-action:none}#thumb{width:40px;height:45px;background:#2557c8}</style><h1>合成 CSDN 登录验证</h1><input aria-label="合成验证码" placeholder="6位数字验证码"><input type="tel" placeholder="手机号" style="left:400px"><div id="slider"><div id="thumb"></div></div><button>确认登录</button><script>let dragged=false;const slider=document.querySelector('#slider');slider.onpointerdown=e=>slider.setPointerCapture(e.pointerId);slider.onpointerup=e=>{dragged=e.clientX>160;if(dragged)slider.style.background='#b1dfbe'};document.querySelector('button').onclick=async()=>{const r=await fetch('/authenticate',{method:'POST',body:document.querySelector('input').value+':'+dragged+':'+document.querySelector('[placeholder=手机号]').value});if(r.ok)location.href='/account'};</script>`);
  });
  await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
  const address=site.address() as {port:number};const origin='http://127.0.0.1:'+address.port;
  const profile=resolve(directory,'remote-profile');mkdirSync(profile,{mode:0o700});
  const manager=new RemoteLoginManager(signal=>openLoginBrowser({profileDir:profile,username:'synthetic-csdn-account',executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH},signal,{origin,loginPath:'/login',accountPath:'/account'}),{pollMs:50});
  const control=await startLoginControl('127.0.0.1:0',token,manager);const stop=new AbortController();
  const timer=setInterval(()=>{if(manager.pending())void manager.run(stop.signal).catch(()=>{});},30);
  return {url:control.url,close:async()=>{clearInterval(timer);stop.abort();await manager.close();await control.close();await new Promise<void>(r=>site.close(()=>r()));if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}};
}
