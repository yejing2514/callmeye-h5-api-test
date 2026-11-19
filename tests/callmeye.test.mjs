import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {API,STATIC,UA,Stop,configFrom,signature,identity,jsonRequest,ok,tenant,Client,
  activityFromPage,checkRule,checkWaitBudget,signed,session,eligible,submitOnce,run,safeCode,
  MAX_WAIT_MINUTES,CHECKPOINT_INTERVAL_MS} from '../scripts/callmeye.mjs';

const user={id:19426008,user_id:19426008,t_id:59,gold:180};
const config={token:'offline-test-token',mode:'inspect',maxWait:1};
const settings={appid:'linping',appkey:'offline-test-key',t_id:59,t_id_in:59};
const reply=(data,code='0')=>({ok:true,status:200,json:async()=>({code,data})});
const frame=(changes={})=>({session_id:'offline-session',status:'waiting',required_ms:120000,
  credited_ms:0,remaining_ms:120000,server_now_ms:1000,started_at_ms:1000,
  settled_until_ms:1000,expires_at_ms:900000,...changes});
const rule=()=>({id:10609040,t_id:59,start_time:1,end_time:9999999999,
  rule:{submit_limit:{open_userinfo_collect:0,open_stay_time:1,stay_time:10800},prevent_cheat:{area_limit:{}}},other_set:{}});
const ready=()=>frame({status:'eligible',credited_ms:120000,remaining_ms:0,server_now_ms:121000,settled_until_ms:121000});

test('Token missing or multiline stops before requests',()=>{
  assert.throws(()=>configFrom({}),Stop);
  assert.throws(()=>configFrom({LINPING_TOKEN:'abc\ndef'}),Stop);
  assert.equal(configFrom({LINPING_TOKEN:' test '}).token,'test');
});
test('invalid mode and wait limits rejected',()=>{
  for(const x of ['-1',String(MAX_WAIT_MINUTES+1),'NaN','1.5']) assert.throws(()=>configFrom({LINPING_TOKEN:'test',MAX_WAIT_MINUTES:x}),Stop);
  assert.equal(configFrom({LINPING_TOKEN:'test',MAX_WAIT_MINUTES:'0'}).maxWait,0);
  assert.throws(()=>configFrom({LINPING_TOKEN:'test',MODE:'anything'}),Stop);
});
test('wait budget is checked before a new stay session is created',()=>{
  assert.equal(checkWaitBudget(rule(),200),10800000);
  assert.throws(()=>checkWaitBudget(rule(),179),/等待上限不足/);
  assert.equal(CHECKPOINT_INTERVAL_MS,60000);
});
test('signature exactly matches the H5 transformation',()=>{
  const md5=x=>createHash('md5').update(x).digest('hex');
  const key=md5('acegbdfh');
  assert.equal(signature('linping','abcdefgh',123,'nonce'),`linping;nonce;123;${md5('linpingnonce123'+key)}`);
  assert.notEqual(signature('linping','abcdefgh',123,'nonce'),signature('linping','abcdefgh',124,'nonce'));
});
test('identity uses both user and tenant, not just the balance',()=>{
  assert.deepEqual(identity(user),{user_id:19426008,gold:180});
  for(const patch of [{id:24321158},{user_id:1},{t_id:1},{gold:'NaN'}]) assert.throws(()=>identity({...user,...patch}),Stop);
});
test('untrusted error codes cannot become log content',()=>{
  assert.equal(safeCode('1007'),'1007');assert.equal(safeCode('::error::secret'),'unknown');
  assert.throws(()=>ok({code:'1001',msg:'private data'},'test'),/登录失效/);
  assert.throws(()=>ok({code:'1002'},'test'),/登录失效/);
  assert.throws(()=>ok({code:'1007',msg:'private data'},'test'),error=>!error.message.includes('private'));
});
test('request redirects forbidden and domain allowlist enforced',async()=>{
  let options;
  await jsonRequest(`${API}/aosbase/user_info`,{},async(url,opt)=>{options=opt;return reply({});});
  assert.equal(options.redirect,'error');
  for(const url of ['https://evil.invalid/api/foo','https://ya.iyunxh.com.evil.invalid/api/foo',`${API}/../foo`]) {
    await assert.rejects(jsonRequest(url,{},()=>{throw new Error('must not call');}),Stop);
  }
});
test('network errors do not disclose URL or credentials, no retry',async()=>{
  let calls=0;
  await assert.rejects(jsonRequest(API+'/aosbase/user_info',{},()=>{calls++;throw new Error('PRIVATE_TOKEN');}),error=>!error.message.includes('PRIVATE_TOKEN'));
  assert.equal(calls,1);
});
test('HTTP auth failure safely stops',async()=>{
  await assert.rejects(jsonRequest(API+'/aosbase/user_info',{},async()=>({status:403})),/请求被拒绝/);
});
test('tenant metadata decoded only in memory',async()=>{
  const s=await tenant(async()=>reply(Buffer.from(JSON.stringify(settings)).toString('base64')));
  assert.equal(s.appid,'linping');
  await assert.rejects(tenant(async()=>reply({...settings,t_id:1})),Stop);
});
test('device token and fresh headers follow the H5',async()=>{
  const requests=[];
  const client=new Client(config,settings,async(url,opt)=>{
    requests.push({url,opt});return url.endsWith('_auth_dt')?reply('a'.repeat(32)+'b'.repeat(36)):reply(user);
  });
  await client.initDevice(); await client.call('/aosbase/user_info');
  assert.equal(requests[1].opt.headers['Access-Api-Dt'],'b'.repeat(36));
  assert.equal(requests[1].opt.headers['User-Agent'],UA);
  assert.equal(requests[1].opt.headers['Access-Token'],config.token);
  assert.match(requests[1].opt.headers['Access-Api-Signature'],/^linping;[^;]+;\d+;[a-f0-9]{32}$/);
});
test('all eight captured business headers supported; signatures refreshed per request',async()=>{
  const requests=[];
  const client=new Client({...config,userId:19426009,device:'fixed-offline-client'},settings,async(url,opt)=>{
    requests.push({url,opt});return url.endsWith('_auth_dt')?reply('a'.repeat(32)+'b'.repeat(32)):reply({});
  });
  await client.initDevice(); await client.call('/aosbase/user_info'); await client.call('/aosbase/user_info');
  const headers=requests[1].opt.headers;
  const expected={'Access-Token':config.token,'Access-User-Id':'19426009','Access-T-Id':'59',
    'Access-T-Id-In':'59','Access-Api-Unique-Token':'1','Access-Wxclient-Type':'wx_app',
    'Access-Api-Dt':'b'.repeat(32)};
  for(const [name,value] of Object.entries(expected)) assert.equal(headers[name],value,name);
  assert.match(headers['Access-Api-Signature'],/^linping;[^;]+;\d+;[a-f0-9]{32}$/);
  assert.notEqual(headers['Access-Api-Signature'],requests[2].opt.headers['Access-Api-Signature']);
  for(const request of requests) {
    assert.equal(request.opt.headers['User-Agent'],UA);
    assert.equal(request.opt.headers.Origin,'https://linping.y-h5.iyunxh.com');
    assert.equal(request.opt.headers.Referer,'https://linping.y-h5.iyunxh.com/module-page/home/home?id=621');
  }
  const init=requests[0].opt.headers;
  assert.equal(init['Access-Api-Dt'],'fixed-offline-client');
  assert.equal(init['Access-Token'],undefined);assert.equal(init['Access-Api-Signature'],undefined);
});
test('H5 device extraction supports observed 32 and 36 character tokens, not only 36',async()=>{
  for(const size of [32,36]) {
    const client=new Client(config,settings,async()=>reply('a'.repeat(32)+'b'.repeat(size)));
    await client.initDevice();assert.equal(client.deviceToken,'b'.repeat(size));
  }
  for(const value of ['a'.repeat(63),'a'.repeat(65),'a'.repeat(67),'a'.repeat(32)+'\r'.repeat(32)]) {
    await assert.rejects(new Client(config,settings,async()=>reply(value)).initDevice(),Stop);
  }
});
test('client rejects extra endpoints',async()=>{
  const client=new Client(config,settings);client.deviceToken='test';
  await assert.rejects(client.call('/withdraw'),Stop);
});
test('real activity ID parsed instead of page ID 621',()=>{
  assert.equal(activityFromPage({content:JSON.stringify([{type:'signin',attr:{id:'10609040'}}])}),10609040);
  assert.throws(()=>activityFromPage({content:'[]'}),Stop);
  assert.throws(()=>activityFromPage({content:[{type:'signin',attr:{id:1}},{type:'signin',attr:{id:2}}]}),Stop);
});
test('daily counter checked, unknown value fails closed',()=>{
  assert.equal(signed({day_remain:0}),false);assert.equal(signed({day_remain:'1'}),true);
  for(const value of [undefined,null,'',-1,'secret']) assert.throws(()=>signed({day_remain:value}),Stop);
});
test('current rule accepts elapsed-time test only within activity dates',()=>{
  checkRule(rule(),user,100000);
  assert.throws(()=>checkRule({...rule(),end_time:2},user,100000),Stop);
});
test('verification, location, binding and collection restrictions stop',()=>{
  const changes=[d=>d.rule.prevent_cheat.verif_code=1,d=>d.rule.prevent_cheat.area_limit.ip_limit=1,
    d=>d.rule.prevent_cheat.area_limit.location_limit=1,d=>d.rule.submit_limit.open_userinfo_collect=1,
    d=>d.other_set.is_bind_app=1,d=>d.rule.prevent_cheat.is_open_phone_verify=1,
    d=>d.rule.prevent_cheat.is_open_ydsafe=1,d=>d.rule.prevent_cheat.is_open_whitelist=1];
  for(const change of changes){const d=rule();change(d);assert.throws(()=>checkRule(d,user,100000),Stop);}
});
test('strict session invariants and eligibility',()=>{
  assert.equal(session(ready()).status,'eligible');
  for(const patch of [{remaining_ms:1},{required_ms:-1},{credited_ms:NaN},{status:'eligible'},
    {settled_until_ms:2000},{expires_at_ms:0},{status:'expired'},{session_id:''}]) {
    assert.throws(()=>session(frame(patch)),Stop);
  }
  assert.throws(()=>session(frame({session_id:'other'}),frame()),Stop);
  assert.throws(()=>session(frame({server_now_ms:999}),frame()),Stop);
});
test('real waiting and checkpoint; never fabricated elapsed field',async()=>{
  let time=0,step=0;const requests=[],messages=[];
  const client={call:async(path,data)=>{
    requests.push({path,data});
    return step++<2?frame():step===3?frame({credited_ms:60000,remaining_ms:60000,server_now_ms:61000,settled_until_ms:61000}):ready();
  }};
  const result=await eligible(client,10609040,3,x=>messages.push(x),{clock:()=>time,sleep:async ms=>{time+=ms;}});
  assert.equal(time,120000);assert.equal(result.status,'eligible');
  assert.ok(requests.every(r=>!('observed_elapsed_ms' in r.data)));
  assert.equal(requests.filter(r=>r.path.endsWith('ac_sub')).length,0);
  assert.ok(messages.every(m=>!m.includes('offline-session')));
});
test('server does not credit time: stop at budget, never submit',async()=>{
  let time=0;
  const client={call:async()=>frame()};
  await assert.rejects(eligible(client,1,1,()=>{},{clock:()=>time,sleep:async ms=>{time+=ms;}}),/上限/);
  assert.equal(time,60000);
});
test('zero budget permits already-eligible, refuses waiting',async()=>{
  await assert.rejects(eligible({call:async()=>frame()},1,0,()=>{}),/上限/);
  assert.equal((await eligible({call:async()=>ready()},1,0,()=>{})).status,'eligible');
});
test('daily duplicate is skipped before mutation',async()=>{
  let calls=0;
  assert.deepEqual(await submitOnce({call:async()=>{calls++;return {day_remain:1};}},1,ready(),()=>{}),{already:true});
  assert.equal(calls,1);
});
test('success requires single submission plus daily confirmation',async()=>{
  const requests=[];let counter=0,users=0;
  const client={call:async(path,data)=>{
    requests.push({path,data});
    if(path.endsWith('user_times'))return {day_remain:counter++};
    if(path.endsWith('user_info'))return {...user,gold:180+10*users++};
    if(path.endsWith('checkpoint'))return ready();
    if(path.endsWith('ac_sub'))return {};
    throw new Error('unexpected');
  }};
  const result=await submitOnce(client,10609040,ready(),()=>{});
  assert.equal(result.confirmed,true);assert.equal(result.after,190);
  const submits=requests.filter(x=>x.path.endsWith('ac_sub'));
  assert.equal(submits.length,1);assert.equal(submits[0].data.id,10609040);
  assert.equal(submits[0].data.stay_session_id,'offline-session');
});
test('wrong account before submit causes no mutation',async()=>{
  const requests=[];
  const client={call:async path=>{requests.push(path);return path.endsWith('user_times')?{day_remain:0}:{...user,id:1};}};
  await assert.rejects(submitOnce(client,1,ready(),()=>{}),/账号/);
  assert.ok(!requests.some(x=>x.endsWith('ac_sub')));
});
test('lost eligibility before submit causes no mutation',async()=>{
  const client={call:async path=>path.endsWith('user_times')?{day_remain:0}:path.endsWith('user_info')?user:frame({server_now_ms:121000})};
  await assert.rejects(submitOnce(client,1,ready(),()=>{}),/尚未达标/);
});
test('unknown submission result is never retried',async()=>{
  let submits=0;
  const client={call:async path=>{
    if(path.endsWith('user_times'))return {day_remain:0};if(path.endsWith('user_info'))return user;
    if(path.endsWith('checkpoint'))return ready();
    submits++;throw new Stop('timeout');
  }};
  await assert.rejects(submitOnce(client,1,ready(),()=>{}),/timeout/);
  assert.equal(submits,1);
});
test('eligible status at expiry is never submitted',async()=>{
  let submits=0;
  const client={call:async path=>{
    if(path.endsWith('user_times'))return {day_remain:0};if(path.endsWith('user_info'))return user;
    if(path.endsWith('checkpoint'))return {...ready(),server_now_ms:900000};
    submits++;return {};
  }};
  await assert.rejects(submitOnce(client,1,ready(),()=>{}),/已到期/);
  assert.equal(submits,0);
});
test('successful POST without daily confirmation is not claimed as confirmed',async()=>{
  let submits=0;
  const client={call:async path=>{
    if(path.endsWith('user_times'))return {day_remain:0};if(path.endsWith('user_info'))return user;
    if(path.endsWith('checkpoint'))return ready();submits++;return {};
  }};
  await assert.rejects(submitOnce(client,1,ready(),()=>{}),/尚未确认/);assert.equal(submits,1);
});
test('inspect is read-only for user activity: no stay session, no reward',async()=>{
  const paths=[],logs=[];
  const fetchImpl=async url=>url.includes('_auth_h5init')?reply(Buffer.from(JSON.stringify(settings)).toString('base64')):
    url.includes('page_getattr')?reply({content:[{type:'signin',attr:{id:10609040}}]}):reply({...rule(),rule:JSON.stringify(rule().rule),other_set:'{}'});
  const client={initDevice:async()=>{},call:async path=>{paths.push(path);return path.endsWith('user_info')?user:{day_remain:0};}};
  await run(config,{fetch:fetchImpl,client,log:x=>logs.push(x)});
  assert.deepEqual(paths,['/aosbase/user_info','/aossignin/user_times']);
  assert.ok(logs.some(x=>x.includes('inspect')));assert.ok(logs.every(x=>!x.includes(config.token)));
});
test('workflow runs real daily jobs with secret-free matrix and preserves manual modes',async()=>{
  const yaml=await readFile(new URL('../.github/workflows/callmeye.yml',import.meta.url),'utf8');
  assert.match(yaml,/schedule:/);
  assert.match(yaml,/contents: read/);assert.match(yaml,/cancel-in-progress: false/);
  assert.match(yaml,/secrets\.LINPING_TOKEN/);assert.doesNotMatch(yaml,/pull_request_target|contents: write/);
  assert.match(yaml,/cron: '20 1 \* \* \*'/);
  assert.match(yaml,/secrets\.LINPING_ACCOUNTS/);
  assert.match(yaml,/MAX_WAIT_MINUTES: \$\{\{ inputs\.max_wait_minutes \}\}/);
  assert.ok(yaml.indexOf('node --test')<yaml.indexOf('id: plan'));
  assert.match(yaml,/needs: prepare/);
  assert.match(yaml,/slot: \$\{\{ fromJSON\(format\('\[\{0\}\]', needs\.prepare\.outputs\.slots\)\) \}\}/);
  assert.match(yaml,/ACCOUNT_SLOT: \$\{\{ matrix\.slot \}\}/);
  assert.match(yaml,/fail-fast: false/);
  assert.match(yaml,/max-parallel: 3/);
  assert.match(yaml,/timeout-minutes: 330/);
  assert.match(yaml,/node scripts\/daily\.mjs --account/);
  assert.doesNotMatch(yaml,/if: github\.event_name == 'workflow_dispatch'|ENABLE_SCHEDULE/);
});
