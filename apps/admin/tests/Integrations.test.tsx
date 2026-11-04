import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';
const response = (value: unknown) => new Response(JSON.stringify(value));
const client = { id: 'client-one', name: '内容中心', source_id: 'editorial', environment: 'test', service_id: 'post-bridge', status: 'active', scopes: ['targets:read'], accounts: ['csdn-main'], operations: ['save_draft'], grant_version: 1, expires_at: '2099-01-01T00:00:00Z', rate_limit_per_minute: 60 };
const preparation = { id: 'prep-one', request_id: 'request-one', source_id: 'editorial', client_id: 'client-one', article_id: 'article-one', source_version: 1, state_seq: 1, content_fingerprint: 'fingerprint', revision: 1, confirmed: false, status: 'prepared', expires_at: '2099-01-01T00:00:00Z', created_at: '', snapshot: { title: '来源文章', summary: '', body: '# 原稿', body_format: 'markdown', tags: [] }, drafts: [{ id: 'draft-one', platform: 'csdn', account_id: 'csdn-main', operation: 'save_draft', title: '平台标题', markdown: '# 平台正文', revision: 1 }] };
let calls: {url: string; init?: RequestInit}[];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  calls = []; window.history.replaceState({}, '', '/integrations');
  handler = url => url === '/api/session' ? response({ user: { username: '管理员' }, csrf_token: 'csrf' }) : url === '/api/integration-clients' ? response({items:[client]}) : url === '/api/integration-clients/client-one' ? response(client) : url.startsWith('/api/integration-preparations?') ? response({ items: [preparation], total: 1, page: 1, page_size: 20 }) : url === '/api/integration-preparations/prep-one' ? response(preparation) : response({items:[]});
  vi.stubGlobal('fetch', vi.fn((url, init) => { calls.push({url:String(url),init}); return Promise.resolve(handler(String(url),init)); }));
});
afterEach(() => vi.unstubAllGlobals());
it('页签与筛选保留在地址中，方向键切换页签', async () => {
  render(<App />); await screen.findByRole('link', { name: '来源文章' });
  fireEvent.click(screen.getByRole('tab', {name:'应用'}));
  await screen.findByRole('button', {name:'内容中心'});
  expect(window.location.search).toBe('?tab=clients');
  fireEvent.change(screen.getByLabelText('状态筛选'), {target:{value:'active'}});
  expect(window.location.search).toBe('?tab=clients&status=active');
  fireEvent.keyDown(screen.getByRole('tab',{name:'应用'}), {key:'ArrowRight'});
  await screen.findByRole('heading',{name:'注册申请'});
  expect(window.location.search).toBe('?tab=registrations');
});
it('轮换须确认且一次密钥关闭后清理，刷新不重显', async () => {
  window.history.replaceState({}, '', '/integrations?tab=clients');
  const base = handler; let finish: (value:Response)=>void = () => {};
  handler = (url, init) => url.endsWith('/rotate') ? new Promise(resolve => {finish=resolve;}) : base(url,init);
  render(<App />); fireEvent.click(await screen.findByRole('button',{name:'内容中心'}));
  fireEvent.click(await screen.findByRole('button',{name:'轮换密钥'}));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'确认轮换'}));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'正在处理…'}));
  expect(calls.filter(call=>call.url.endsWith('/rotate'))).toHaveLength(1);
  await act(async()=> finish(response({client_id:'client-one',key_id:'key-two',client_secret:'temporary-example-secret',status:'pending_activation'})));
  await screen.findByText('temporary-example-secret');
  fireEvent.click(screen.getByRole('button',{name:'关闭密钥'}));
  expect(screen.queryByText('temporary-example-secret')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'刷新列表'}));
  await waitFor(()=>expect(calls.filter(call=>call.url==='/api/integration-clients').length).toBeGreaterThan(1));
  expect(screen.queryByText('temporary-example-secret')).toBeNull();
  expect(localStorage.length).toBe(0);
});
it('保存生成新修订，确认绑定已保存修订且未保存时禁用', async () => {
  window.history.replaceState({}, '', '/integration-preparations/prep-one');
  const base = handler;
  handler = (url,init) => init?.method === 'PUT' ? response({...preparation, revision:2, drafts:[{...preparation.drafts[0],title:'新平台标题',revision:2}]}) : url.endsWith('/confirm') ? response({...preparation,revision:2,status:'confirmed',confirmed:true}) : base(url,init);
  render(<App />); fireEvent.change(await screen.findByLabelText('平台标题'),{target:{value:'新平台标题'}});
  expect((screen.getByRole('button',{name:'确认平台稿'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'保存新修订'}));
  await screen.findByText('修订 2');
  expect(JSON.parse(calls.find(call=>call.init?.method==='PUT')!.init!.body as string).revision).toBe(1);
  fireEvent.click(screen.getByRole('button',{name:'确认平台稿'}));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'确认当前修订'}));
  await screen.findByText('已确认');
  expect(JSON.parse(calls.find(call=>call.url.endsWith('/confirm'))!.init!.body as string)).toEqual({revision:2});
});
it('已提交平台稿只读且预览不加载图片或执行HTML', async () => {
  window.history.replaceState({}, '', '/integration-preparations/prep-one');
  const base=handler; handler=(url,init)=>url==='/api/integration-preparations/prep-one' ? response({...preparation,status:'submitted',drafts:[{...preparation.drafts[0],markdown:'<script>alert(1)</script>\n![图片](https://invalid.example/pixel)'}]}) : base(url,init);
  const {container}=render(<App />); const title=await screen.findByLabelText('平台标题');
  expect((title as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'保存新修订'})).toBeNull();
  expect(screen.queryByRole('button',{name:'确认平台稿'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'预览'}));
  expect(container.querySelector('script,img')).toBeNull();
});

it('离开邀请页后迟到的签发响应不显示密钥', async () => {
  window.history.replaceState({}, '', '/integrations?tab=invitations');
  const base=handler; let finish:(value:Response)=>void=()=>{};
  handler=(url,init)=>url==='/api/integration-invitations'&&init?.method==='POST'?new Promise(resolve=>{finish=resolve;}):base(url,init);
  render(<App />); fireEvent.click(await screen.findByRole('button',{name:'创建邀请'}));
  fireEvent.change(screen.getByLabelText('来源标识'),{target:{value:'editorial'}});
  fireEvent.change(screen.getByLabelText('运行环境'),{target:{value:'test'}});
  fireEvent.change(screen.getByLabelText('允许账号（逗号分隔）'),{target:{value:'csdn-main'}});
  fireEvent.change(screen.getByLabelText('邀请有效期'),{target:{value:'2099-01-01T00:00'}});
  fireEvent.change(screen.getByLabelText('应用有效期'),{target:{value:'2099-02-01T00:00'}});
  fireEvent.click(screen.getByRole('button',{name:'生成邀请'}));
  window.history.pushState({},'', '/integrations?tab=clients'); fireEvent.popState(window);
  await screen.findByRole('button',{name:'内容中心'});
  await act(async()=>finish(response({invitation_id:'invitation-one',invitation_token:'late-example-token',expires_at:'2099-01-01T00:00:00Z'})));
  expect(screen.queryByText('late-example-token')).toBeNull();
});
it('创建邀请携带CSRF且关闭和离开均清除一次令牌', async () => {
  window.history.replaceState({}, '', '/integrations?tab=invitations');
  const base=handler;
  handler=(url,init)=>url==='/api/integration-invitations'&&init?.method==='POST'?response({invitation_id:'invitation-one',invitation_token:'one-time-invitation',expires_at:'2099-01-01T00:00:00Z'}):base(url,init);
  render(<App />); fireEvent.click(await screen.findByRole('button',{name:'创建邀请'}));
  for(const [label,value] of [['来源标识','editorial'],['运行环境','test'],['允许账号（逗号分隔）','csdn-main'],['邀请有效期','2099-01-01T00:00'],['应用有效期','2099-02-01T00:00']]) fireEvent.change(screen.getByLabelText(label),{target:{value}});
  fireEvent.click(screen.getByRole('button',{name:'生成邀请'})); await screen.findByText('one-time-invitation');
  const call=calls.find(item=>item.init?.method==='POST')!;
  expect(new Headers(call.init?.headers).get('X-CSRF-Token')).toBe('csrf');
  expect(JSON.parse(call.init!.body as string).operations).toEqual(['save_draft']);
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Tab',shiftKey:true});
  expect(document.activeElement?.textContent).toBe('one-time-invitation');
  fireEvent.click(screen.getByRole('button',{name:'关闭密钥'}));
  expect(screen.queryByText('one-time-invitation')).toBeNull();
});
it('反向来源密钥保存后立即清空且不出现在请求地址中', async () => {
  window.history.replaceState({}, '', '/integrations?tab=clients');
  const base=handler;handler=(url,init)=>url==='/api/integration-clients/client-one'&&init?.method==='PUT'?response({...client,grant_version:2}):base(url,init);
  render(<App />); fireEvent.click(await screen.findByRole('button',{name:'内容中心'}));
  const input=await screen.findByLabelText('来源密钥');
  fireEvent.change(input,{target:{value:'private-example-key'}});
  fireEvent.click(screen.getByRole('button',{name:'保存应用配置'}));
  await waitFor(()=>expect((input as HTMLInputElement).value).toBe(''));
  expect(calls.some(call=>call.url.includes('private-example-key'))).toBe(false);
  const body=JSON.parse(calls.find(call=>call.init?.method==='PUT')!.init!.body as string);
  expect(body.source_secret).toBe('private-example-key');
  expect(localStorage.length).toBe(0);
});
it('平台稿保存冲突保留本地编辑并提示重新核对', async () => {
  window.history.replaceState({}, '', '/integration-preparations/prep-one');
  const base=handler;handler=(url,init)=>init?.method==='PUT'?new Response(JSON.stringify({message:'修订冲突'}),{status:409}):base(url,init);
  render(<App />); fireEvent.change(await screen.findByLabelText('平台标题'),{target:{value:'保留本地修改'}});
  fireEvent.click(screen.getByRole('button',{name:'保存新修订'}));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('平台标题') as HTMLInputElement).value).toBe('保留本地修改');
  expect(screen.getByRole('alert').textContent).toContain('重新读取');
  expect((screen.getByRole('button',{name:'确认平台稿'}) as HTMLButtonElement).disabled).toBe(true);
});

it('未保存平台稿可确认放弃本地修改再读取', async () => {
  window.history.replaceState({}, '', '/integration-preparations/prep-one');
  render(<App />);fireEvent.change(await screen.findByLabelText('平台标题'),{target:{value:'待放弃标题'}});
  fireEvent.click(screen.getByRole('button',{name:'重新读取'}));
  const dialog=screen.getByRole('dialog');
  expect(within(dialog).getByText('确认放弃未保存的修改并重新读取？')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button',{name:'放弃修改并读取'}));
  await waitFor(()=>expect((screen.getByLabelText('平台标题') as HTMLInputElement).value).toBe('平台标题'));
});
it('过期平台稿不允许编辑、保存或确认', async () => {
  window.history.replaceState({}, '', '/integration-preparations/prep-one');const base=handler;
  handler=(url,init)=>url==='/api/integration-preparations/prep-one'?response({...preparation,expires_at:'2020-01-01T00:00:00Z'}):base(url,init);
  render(<App />);expect((await screen.findByLabelText('平台标题') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('已过期')).toBeTruthy();expect(screen.queryByRole('button',{name:'确认平台稿'})).toBeNull();
});
it('审批只签发一次密钥并发送当前权限和账号', async () => {
  window.history.replaceState({}, '', '/integrations?tab=registrations');const base=handler;
  handler=(url,init)=>url==='/api/integration-registrations'?response({items:[{...client,grant_version:undefined,status:'pending',created_at:'2026-01-01T00:00:00Z'}]}):url.endsWith('/approve')?response({client_id:'client-approved',key_id:'key-approved',client_secret:'approval-example-secret',status:'pending_activation'}):base(url,init);
  render(<App />);fireEvent.click(await screen.findByRole('button',{name:'审批'}));
  fireEvent.click(screen.getByRole('button',{name:'批准并签发密钥'}));
  await screen.findByText('approval-example-secret');
  const call=calls.find(item=>item.url.endsWith('/approve'))!;
  expect(JSON.parse(call.init!.body as string).accounts).toEqual(['csdn-main']);
  expect(JSON.parse(call.init!.body as string).scopes).toEqual(['targets:read']);
  fireEvent.click(screen.getByRole('button',{name:'关闭密钥'}));
  expect(screen.queryByText('approval-example-secret')).toBeNull();
});
it('暂停和撤销应用均等待明确确认，失败保留错误', async () => {
  window.history.replaceState({}, '', '/integrations?tab=clients');const base=handler;
  handler=(url,init)=>url.endsWith('/suspend')?new Response(JSON.stringify({message:'状态已改变'}),{status:409}):base(url,init);
  render(<App />);fireEvent.click(await screen.findByRole('button',{name:'内容中心'}));fireEvent.click(await screen.findByRole('button',{name:'暂停应用'}));
  expect(calls.some(call=>call.url.endsWith('/suspend'))).toBe(false);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'确认暂停'}));
  await within(screen.getByRole('dialog')).findByRole('alert');
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('状态已改变');
});

it('分发记录详情按子任务展示状态，恢复绑定确认指纹且需要明确确认', async () => {
  window.history.replaceState({}, '', '/integrations?tab=distributions&distribution_id=distribution-one');
  const distribution={id:'distribution-one',source_id:'editorial',article_id:'article-one',preparation_id:'prep-one',source_version:1,created_at:'2026-11-04T00:00:00Z',confirmation_fingerprint:'confirmation-one',status:'needs_attention',resume_allowed:true,children:[{id:'job-one',platform:'csdn',account_id:'csdn-main',operation:'save_draft',status:'waiting_user',external_status:'unknown',outcome:'not_submitted',error_code:'source_changed',error_message:'来源内容已改变',detail_url:'/jobs/job-one'}]};
  const base=handler;
  handler=(url,init)=>url==='/api/integration-distributions/distribution-one'?response(distribution):url.endsWith('/resume')?response({...distribution,resume_allowed:false,status:'in_progress'}):base(url,init);
  render(<App />);await screen.findByRole('heading',{name:'分发 article-one'});
  expect(screen.getByRole('link',{name:'查看草稿任务'}).getAttribute('href')).toBe('/jobs/job-one');
  fireEvent.click(screen.getByRole('button',{name:'恢复原任务'}));
  expect(calls.some(call=>call.url.endsWith('/resume'))).toBe(false);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'确认恢复原任务'}));
  await waitFor(()=>expect(calls.some(call=>call.url.endsWith('/resume'))).toBe(true));
  const call=calls.find(item=>item.url.endsWith('/resume'))!;
  expect(JSON.parse(call.init!.body as string)).toEqual({confirmation_fingerprint:'confirmation-one'});
});
it('未知外站结果的分发仅提供详情，不提供恢复', async () => {
  window.history.replaceState({}, '', '/integrations?tab=distributions&distribution_id=distribution-one');const base=handler;
  handler=(url,init)=>url==='/api/integration-distributions/distribution-one'?response({id:'distribution-one',source_id:'editorial',article_id:'article-one',created_at:'',confirmation_fingerprint:'confirmation-one',status:'needs_attention',resume_allowed:false,children:[{id:'job-one',platform:'csdn',account_id:'csdn-main',operation:'save_draft',status:'reconciling',external_status:'unknown',detail_url:'/jobs/job-one'}]}):base(url,init);
  render(<App />);await screen.findByRole('heading',{name:'分发 article-one'});
  expect(screen.queryByRole('button',{name:'恢复原任务'})).toBeNull();
  expect(screen.getByText('待核对')).toBeTruthy();
});

it('分发记录详情返回时保留原筛选与分页', async () => {
  window.history.replaceState({}, '', '/integrations?tab=distributions&status=needs_attention&page=2');
  const distribution={id:'distribution-one',source_id:'editorial',article_id:'article-one',created_at:'',status:'needs_attention',resume_allowed:false,confirmation_fingerprint:'confirmation-one',children:[]};
  const base=handler;handler=(url,init)=>url.startsWith('/api/integration-distributions?')?response({items:[distribution],page:2,page_size:20,total:21}):url==='/api/integration-distributions/distribution-one'?response(distribution):base(url,init);
  render(<App />);fireEvent.click(await screen.findByRole('link',{name:'article-one'}));
  await screen.findByRole('heading',{name:'分发 article-one'});
  fireEvent.click(screen.getByRole('button',{name:'返回分发记录'}));
  expect(window.location.search).toBe('?tab=distributions&status=needs_attention&page=2');
});

it('草稿任务入口接受同源绝对地址并拒绝外站地址', async () => {
  window.history.replaceState({}, '', '/integrations?tab=distributions&distribution_id=distribution-one');
  const base=handler;handler=(url,init)=>url==='/api/integration-distributions/distribution-one'?response({id:'distribution-one',source_id:'editorial',article_id:'article-one',created_at:'',confirmation_fingerprint:'confirmation-one',status:'needs_attention',resume_allowed:false,children:[{id:'job-one',platform:'csdn',account_id:'csdn-main',operation:'save_draft',status:'reconciling',external_status:'unknown',detail_url:window.location.origin+'/jobs/job-one'},{id:'job-two',platform:'csdn',account_id:'csdn-main',operation:'save_draft',status:'reconciling',external_status:'unknown',detail_url:'https://invalid.example/jobs/job-two'}]}):base(url,init);
  render(<App />);await screen.findByRole('heading',{name:'分发 article-one'});
  const links=screen.getAllByRole('link',{name:'查看草稿任务'});
  expect(links).toHaveLength(1);expect(links[0].getAttribute('href')).toBe('/jobs/job-one');
});

it('分发子任务来源暂停显示来源待处理', async () => {
  window.history.replaceState({}, '', '/integrations?tab=distributions&distribution_id=distribution-one');const base=handler;
  handler=(url,init)=>url==='/api/integration-distributions/distribution-one'?response({id:'distribution-one',source_id:'editorial',article_id:'article-one',created_at:'',confirmation_fingerprint:'confirmation-one',status:'needs_attention',resume_allowed:false,children:[{id:'job-one',platform:'csdn',account_id:'csdn-main',operation:'save_draft',status:'waiting_user',error_code:'source_changed',external_status:'not_submitted'}]}):base(url,init);
  render(<App />);await screen.findByRole('heading',{name:'分发 article-one'});
  expect(screen.getByText('来源待处理')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'恢复原任务'})).toBeNull();
});
