import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { errorText, useWorkspace } from './runtime';

type LoginState = { id: string; status: string; width: number; height: number; expires_at: string; error?: string };
type Point = { x: number; y: number };
const labels: Record<string,string> = { idle:'准备远程登录',pending:'正在等待执行器空闲',active:'请完成 CSDN 登录验证',succeeded:'指定账号登录成功，等待任务已恢复',failed:'远程登录未完成',expired:'远程登录已超时，请重新开始',cancelled:'远程登录已结束',busy:'另一个管理员会话正在验证' };
export default function RemoteLogin({ onVerified }: { onVerified: () => void }) {
  const { api }=useWorkspace();
  const [remote,setRemote]=useState<LoginState>();
  const [enabled,setEnabled]=useState(false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [frame,setFrame]=useState('');
  const [text,setText]=useState('');
  const [phone,setPhone]=useState('');
  const [code,setCode]=useState('');
  const [filled,setFilled]=useState('');
  const current=useRef<LoginState | undefined>(undefined);const objectURL=useRef('');const busy=useRef(false);
  const verified=useRef(onVerified);verified.current=onVerified;
  const generation=useRef(0);const mounted=useRef(true);const creating=useRef<AbortController | undefined>(undefined);const inputTail=useRef(Promise.resolve());const queued=useRef(0);
  const points=useRef<Point[]>([]);const requests=useRef(new Set<AbortController>());
  const active=remote?.status==='active';const running=active||remote?.status==='pending';
  const update=(value:LoginState)=>{current.current=value;setRemote(value);if(value.status!=='active'){setPhone('');setCode('');setFilled('');}};
  const clearFrame=()=>{if(objectURL.current){URL.revokeObjectURL(objectURL.current);objectURL.current='';}setFrame('');};
  useEffect(()=>{
    mounted.current=true;let alive=true;let timer:ReturnType<typeof setTimeout>;let done='';
    const tick=async()=>{
      const controller=new AbortController();requests.current.add(controller);const epoch=generation.current;
      try {
        if(document.hidden)return;
        const state=await api<LoginState>('/api/account/login',{signal:controller.signal});
        if(!alive||epoch!==generation.current)return;setEnabled(true);setError('');update(state);
        if(state.status==='succeeded'&&done!==state.id){done=state.id;verified.current();}
        if(state.status==='active'){
          const response=await fetch('/api/account/login/'+encodeURIComponent(state.id)+'/frame',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
          if(!response.ok)throw Error(response.status===401?'管理员会话已失效，请重新登录':'登录画面暂时不可用');
          if(!response.headers.get('Content-Type')?.startsWith('image/jpeg'))throw Error('登录画面格式异常');
          const blob=await response.blob();if(blob.size>2_000_000)throw Error('登录画面超过大小限制');
          if(!alive||epoch!==generation.current)return;const next=URL.createObjectURL(blob);if(objectURL.current)URL.revokeObjectURL(objectURL.current);objectURL.current=next;setFrame(next);
        }else{clearFrame();}
      }catch(e){if(alive&&!controller.signal.aborted){setError(errorText(e));if(!current.current)setEnabled(false);}}
      finally{requests.current.delete(controller);if(alive)timer=setTimeout(tick,current.current&&['pending','active'].includes(current.current.status)?1000:5000);}
    };
    void tick();
    return()=>{alive=false;mounted.current=false;generation.current++;clearTimeout(timer);for(const c of requests.current)if(c!==creating.current)c.abort();requests.current.clear();if(objectURL.current)URL.revokeObjectURL(objectURL.current);objectURL.current='';const state=current.current;if(state&&['pending','active'].includes(state.status))void api('/api/account/login/'+encodeURIComponent(state.id),{method:'DELETE',keepalive:true}).catch(()=>{});};
  },[api]);
  async function perform(path:string,method:string,body?:object){
    if(busy.current)return;busy.current=true;if(!path.endsWith('/input'))generation.current++;setPending(true);setError('');
    const controller=new AbortController();requests.current.add(controller);const isCreation=path==='/api/account/login'&&method==='POST';if(isCreation)creating.current=controller;
    try{const value=await api<LoginState>(path,{method,body:body?JSON.stringify(body):undefined,signal:controller.signal});if(!mounted.current){if(isCreation&&value?.id)await api('/api/account/login/'+encodeURIComponent(value.id),{method:'DELETE',keepalive:true}).catch(()=>{});return false;}if(!controller.signal.aborted){if(value?.status)update(value);return true;}}
    catch(e){if(mounted.current&&!controller.signal.aborted)setError(errorText(e));}
    finally{requests.current.delete(controller);if(creating.current===controller)creating.current=undefined;busy.current=false;if(mounted.current&&!controller.signal.aborted)setPending(false);}
    return false;
  }
  async function input(value:object){
    const state=current.current;if(state?.status!=='active'||!mounted.current)return;
    if(queued.current>=64){setError('输入过于频繁，请等待已发送的操作完成');return;}
    const epoch=generation.current;queued.current++;
    const operation=inputTail.current.then(async()=>{if(mounted.current&&generation.current===epoch&&current.current?.status==='active')return perform('/api/account/login/'+encodeURIComponent(state.id)+'/input','POST',value);return false;}).finally(()=>{queued.current--;});
    inputTail.current=operation.then(()=>{},()=>{});return operation;
  }
  function stop(){for(const c of requests.current)if(c!==creating.current)c.abort();busy.current=false;clearFrame();void perform('/api/account/login/'+encodeURIComponent(current.current!.id),'DELETE');}

  function position(event:PointerEvent<HTMLImageElement>):Point{
    const rect=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1279,(event.clientX-rect.left)*1280/Math.max(1,rect.width))),y:Math.max(0,Math.min(799,(event.clientY-rect.top)*800/Math.max(1,rect.height)))};
  }
  function down(event:PointerEvent<HTMLImageElement>){if(pending||!active)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture?.(event.pointerId);points.current=[position(event)];}
  function move(event:PointerEvent<HTMLImageElement>){if(points.current.length&&points.current.length<127)points.current.push(position(event));}
  function up(event:PointerEvent<HTMLImageElement>){if(!points.current.length)return;const start=points.current[0],end=position(event),path=[...points.current,end];points.current=[];if(Math.hypot(end.x-start.x,end.y-start.y)<4)void input({type:'click',...end});else void input({type:'drag',points:path});}
  function keyboard(event:KeyboardEvent<HTMLImageElement>){
    if(event.key==='Tab')return;
    if(event.key==='Escape'){event.preventDefault();event.currentTarget.closest('section')?.querySelector<HTMLButtonElement>('.remote-toolbar button:not(:disabled)')?.focus();return;}
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const key=event.key===' '? 'Space':event.shiftKey&&event.key==='Tab'?'Shift+Tab':event.key;
    if(['Enter','Tab','Shift+Tab','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Escape','Space'].includes(key)){event.preventDefault();void input({type:'key',key});}
    else if(event.key.length===1){event.preventDefault();void input({type:'text',text:event.key});}
  }
  async function sendText(){if(!text)return;const value=text;setText('');await input({type:'text',text:value});}
  async function fill(field:'phone'|'code'){
    const value=field==='phone'?phone:code;
    if(!(field==='phone'?/^[0-9]{5,20}$/:/^[0-9]{4,8}$/).test(value))return;
    if(field==='phone')setPhone('');else setCode('');setFilled('');
    if(await input({type:'fill',field,text:value}))setFilled(field==='phone'?'手机号已填入，请在画面获取验证码':'验证码已填入，请在画面确认登录');
  }
  return <section className="surface section-gap"><div className="surface-header"><h2>远程登录验证</h2><span className="muted">仅当前管理员会话</span></div><div className="surface-body">
    <p>无需服务器桌面。在此完成扫码或短信验证，确认指定账号后自动恢复等待任务。</p>
    {remote&&<p role="status" className="section-gap">{labels[remote.status]||'正在读取验证状态'}</p>}
    {error&&<div className="notice error section-gap" role="alert">{error}</div>}
    {remote?.error&&<div className="notice warning section-gap">{remote.error}</div>}
    <div className="remote-toolbar section-gap"><button className="primary" disabled={!enabled||pending||running||remote?.status==='busy'} onClick={()=>void perform('/api/account/login','POST',{})}>开始远程登录</button>{running&&<button onClick={stop}>结束远程登录</button>}</div>
    {active&&<><p className="form-hint section-gap">点击或拖动画面操作；可直接输入文字，Tab 离开画面，Escape 返回操作区。远端切换输入框请用下方按钮。验证会话最长十分钟，离开后自动关闭。</p><div className="remote-screen section-gap">{frame?<img src={frame} alt="CSDN 远程登录画面" draggable={false} tabIndex={0} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{points.current=[];}} onKeyDown={keyboard}/>:<p>正在获取登录画面…</p>}</div>
      <p className="form-hint section-gap">短信登录请先在画面选择国家或地区，再填写不含国家区号的手机号。下方操作只填入内容；获取短信和确认登录请在画面中操作。</p>
      <div className="remote-toolbar section-gap"><label>手机号<input type="tel" inputMode="numeric" autoComplete="off" value={phone} maxLength={20} disabled={pending} onChange={e=>setPhone(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void fill('phone');}}}/></label><button disabled={pending||!/^[0-9]{5,20}$/.test(phone)} onClick={()=>void fill('phone')}>填写手机号</button></div>
      <div className="remote-toolbar section-gap"><label>短信验证码<input type="password" inputMode="numeric" autoComplete="off" value={code} maxLength={8} disabled={pending} onChange={e=>setCode(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void fill('code');}}}/></label><button disabled={pending||!/^[0-9]{4,8}$/.test(code)} onClick={()=>void fill('code')}>填写验证码</button></div>
      {filled&&<p role="status" className="form-hint section-gap">{filled}</p>}
      <div className="remote-toolbar section-gap"><label>输入到页面的文字<input type="password" autoComplete="off" value={text} maxLength={2000} disabled={pending} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void sendText();}}}/></label><button disabled={pending||!text} onClick={()=>void sendText()}>发送文字</button></div><div className="remote-toolbar section-gap">{['Tab','Enter','Backspace','Escape'].map(key=><button key={key} disabled={pending} onClick={()=>void input({type:'key',key})}>{({Tab:'下一输入框',Enter:'确认',Backspace:'退格',Escape:'关闭提示'})[key]}</button>)}<button disabled={pending} onClick={()=>void input({type:'scroll',deltaY:-500})}>向上滚动</button><button disabled={pending} onClick={()=>void input({type:'scroll',deltaY:500})}>向下滚动</button></div>
    </>}
  </div></section>;
}
