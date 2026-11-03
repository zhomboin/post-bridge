import { test,expect,login,csrf,worker } from './fixtures';
import { randomUUID } from 'node:crypto';

test('无桌面远程输入与拖动验证成功后自动恢复等待草稿',async({page,stack},info)=>{
  await login(page,stack);const csp=(await page.request.get('/account')).headers()['content-security-policy'];expect(csp).toContain("img-src 'self' data: blob:");expect(csp).toContain("script-src 'self';");const token=await csrf(page.request);const headers={Origin:stack.url,'X-CSRF-Token':token};
  const response=await page.request.post('/api/jobs',{headers,data:{request_id:randomUUID(),kind:'save_draft',platform:'csdn',title:'等待远程验证的合成文章',markdown:'仅为独立跨服务测试。'}});expect(response.status()).toBe(202);const job=await response.json();
  const claim=await(await worker(page.request,stack,'/internal/worker/claim',{worker_id:'synthetic-worker'})).json();
  await worker(page.request,stack,'/internal/worker/jobs/'+job.id+'/complete',{lease_token:claim.lease_token,status:'waiting_user',error_code:'needs_login'});
  await page.goto('/account');await expect(page.getByRole('button',{name:'开始远程登录'})).toBeEnabled();await page.getByRole('button',{name:'开始远程登录'}).click();
  const image=page.getByRole('img',{name:'CSDN 远程登录画面'});await expect(image).toBeVisible();await expect.poll(()=>image.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth===1280)).toBe(true);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('远程登录-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:1440,height:1000});
  const point=async(x:number,y:number)=>{await image.scrollIntoViewIfNeeded();const box=(await image.boundingBox())!;return{x:box.x+x*box.width/1280,y:box.y+y*box.height/800}};
  let at=await point(80,100);await page.mouse.click(at.x,at.y);await page.getByLabel('输入到页面的文字').fill('synthetic-code');await page.getByRole('button',{name:'发送文字'}).click();await expect(page.getByRole('button',{name:'发送文字'})).toBeDisabled();
  at=await point(60,185);const end=await point(230,185);await page.mouse.move(at.x,at.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:10});await page.mouse.up();await expect(page.getByRole('button',{name:'下一输入框'})).toBeEnabled();
  at=await point(80,265);await page.mouse.click(at.x,at.y);
  await expect(page.getByText('指定账号登录成功，等待任务已恢复',{exact:true})).toBeVisible();
  const restored=await(await page.request.get('/api/jobs/'+job.id)).json();expect(restored.status).toBe('queued');expect(restored.retry_count).toBe(0);
  expect((await(await page.request.get('/api/account')).json()).status).toBe('connected');
});
