import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ACTIVITY_1022, STATIC, Stop, Client, configFrom, activity, run} from '../scripts/callmeye.mjs';
import {accountsFrom, executionEnv, planFrom, executeAccount} from '../scripts/daily.mjs';
import {read1022State} from '../scripts/activity-1022.mjs';

const userId = 19426009;
const user = {id:userId,user_id:userId,t_id:59,gold:100};
const settings = {appid:'linping',appkey:'offline-only',t_id:59,t_id_in:59};
const env = {LINPING_ACTIVITY:'1022',LINPING_TOKEN:'offline-only',LINPING_USER_ID:String(userId),MAX_WAIT_MINUTES:'200'};
const rule = () => ({
  submit_limit:{open_userinfo_collect:0,open_stay_time:1,stay_time:10800},
  prevent_cheat:{area_limit:{}}
});
const detail = () => ({id:ACTIVITY_1022.signinId,t_id:59,start_time:1,end_time:9999999999,
  rule:JSON.stringify(rule()),other_set:'{}'});
const reply = (data,code='0') => ({ok:true,status:200,json:async()=>({code,data})});
const frame = elapsed => ({session_id:'offline-1022-session',
  status:elapsed>=10800000?'eligible':'waiting',required_ms:10800000,credited_ms:Math.min(elapsed,10800000),
  remaining_ms:Math.max(0,10800000-elapsed),started_at_ms:1000,settled_until_ms:1000+elapsed,
  expires_at_ms:20000000,server_now_ms:1000+elapsed});

function fixture(options = {}) {
  let elapsed = 0, submissions = 0;
  const requests = [], sleeps = [], logs = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : undefined;
    const path = target.pathname.replace('/api','');
    requests.push({url:target,init,path,body});
    if (options.respond) {
      const result = options.respond({target,init,path,body,elapsed,submissions});
      if (result !== undefined) return result;
    }
    if (path.includes('_auth_h5init')) return reply(settings);
    if (path.endsWith('_auth_dt')) return reply('a'.repeat(32)+'b'.repeat(36));
    if (path.includes('/static_3/aossignin/')) return reply(options.detail || detail());
    if (path.includes('/_withdrawal_ac_detail/')) return reply({id:ACTIVITY_1022.withdrawalId,t_id:59});
    if (path.endsWith('user_info')) return reply({...user,gold:100+10*submissions});
    if (path.endsWith('user_times')) return reply({day_remain:options.already ? 1 : submissions});
    if (path === '/aossignin/stay_session' || path.endsWith('/checkpoint')) return reply(frame(elapsed));
    if (path === '/aossignin/ac_sub') { submissions++; return reply({gold:10,lottery:1}); }
    if (path.endsWith('/virtual_currency_user_wallet')) return reply({balance:100+10*submissions,unit:'gold'});
    if (path.endsWith('/ac_lottery_times')) return reply(0);
    if (path.startsWith('/aoslottery/') || path.includes('withdraw') || path.endsWith('virtual_currency_user_bill')) return reply({});
    throw new Error(`Unexpected offline request ${path}`);
  };
  return {
    deps:{fetch:fetchImpl,clock:()=>elapsed,sleep:async ms=>{sleeps.push(ms);elapsed+=ms;},log:message=>logs.push(message)},
    requests,sleeps,logs,elapsed:()=>elapsed,submissions:()=>submissions
  };
}

test('1022 reuses account validation but keeps stable, separate device and page scopes',async()=>{
  const base = {LINPING_ACCOUNTS:JSON.stringify([{user_id:userId,token:'offline',device_id:'same-input-device'}])};
  const [old] = accountsFrom(base), [next] = accountsFrom({...base,LINPING_ACTIVITY:'1022'});
  assert.equal(next.token,old.token); assert.equal(next.userId,old.userId);
  assert.equal(old.activity,undefined); assert.equal(next.activity,'1022');
  assert.notEqual(next.device,old.device);
  assert.equal(accountsFrom({...base,LINPING_ACTIVITY:'1022'})[0].device,next.device);
  const f = fixture(), client = new Client(next,settings,f.deps.fetch);
  await client.initDevice(); await client.call('/aosbase/user_info');
  for (const {init} of f.requests) {
    assert.match(init.headers.Referer,/\?id=1022$/);
    assert.equal(init.headers.Origin,'https://linping.y-h5.iyunxh.com');
  }
  const headers = f.requests[1].init.headers;
  assert.equal(headers.token,'offline'); assert.equal(headers['Access-Token'],'offline');
  assert.equal(headers['Access-User-Id'],String(userId));
  assert.match(headers['Access-Api-Signature'],/^linping;/);
});

test('unsupported activity is rejected before planning',()=>{
  assert.throws(()=>configFrom({...env,LINPING_ACTIVITY:'999'}),Stop);
  assert.throws(()=>planFrom({...env,LINPING_ACTIVITY:'999'}),Stop);
});

test('1022 resolves only the documented signin, never the 621 page or signin',async()=>{
  const f = fixture();
  const result = await activity(f.deps.fetch,'1022');
  assert.equal(result.id,10609054); assert.equal(result.rule.submit_limit.stay_time,10800);
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url.href,`${STATIC}/static_3/aossignin/_ac_detail/10609054.json`);
  const missingTenant = {...detail()}; delete missingTenant.t_id;
  assert.equal((await activity(async()=>reply(missingTenant),'1022')).id,10609054);
  for (const patch of [{id:10609040},{t_id:60},{rule:'bad-json'}]) {
    await assert.rejects(activity(async()=>reply({...detail(),...patch}),'1022'),Stop);
  }
});

test('1022 inspect queries the supplied read APIs without creating sessions, drawing or withdrawing',async()=>{
  const f = fixture();
  const result = await run(configFrom(env),f.deps);
  assert.equal(result.signin.inspect,true); assert.equal(result.balance,100);
  assert.equal(f.elapsed(),0);
  assert.ok(f.requests.every(request=>!request.body));
  const paths = f.requests.map(request=>request.path);
  for (const path of ['/aosbase/user_info','/aossignin/user_times','/aoslottery/ac_lottery_times',
    '/aoslottery/act_user','/aoslottery/act_record','/aoslottery/record_code_detail',
    '/aospay/virtual_currency_user_wallet','/aospay/virtual_currency_user_bill',
    '/aosbase/withdraw_getconfig','/aosbase/withdraw_show']) assert.ok(paths.includes(path),path);
  assert.ok(paths.some(path=>path.endsWith('/13109567.json')));
  assert.ok(paths.every(path=>!path.includes('621') && !path.includes('10609040')));
  assert.ok(f.logs.every(line=>!line.includes(env.LINPING_TOKEN) && !line.includes('offline-1022-session')));
});

test('1022 full flow waits three actual simulated hours then submits exactly once and confirms gold',async()=>{
  const f = fixture();
  const result = await run(configFrom({...env,MODE:'signin'}),f.deps);
  assert.equal(f.elapsed(),10800000);
  assert.equal(f.sleeps.length,180); assert.ok(f.sleeps.every(ms=>ms===60000));
  assert.equal(f.submissions(),1);
  assert.equal(result.signin.confirmed,true); assert.equal(result.signin.before,100); assert.equal(result.signin.after,110);
  assert.equal(result.balance,110);
  const sessions = f.requests.filter(request=>request.path==='/aossignin/stay_session');
  assert.equal(sessions.length,1); assert.equal(sessions[0].body.activity_id,10609054);
  assert.match(sessions[0].body.page_instance_id,/^[\da-f-]{36}$/);
  const [submit] = f.requests.filter(request=>request.path==='/aossignin/ac_sub');
  assert.deepEqual(submit.body,{id:10609054,stay_session_id:'offline-1022-session',
    afs_tokenid:'',collect_info:'',longitude:0,latitude:0});
  assert.ok(f.requests.every(request=>!request.body || !('observed_elapsed_ms' in request.body)));
  assert.ok(!f.requests.some(request=>request.path==='/aoslottery/ac_sub'));
  assert.ok(f.logs.some(line=>line.includes('不执行抽奖或提现')));
});

test('already-signed 1022 still reads records without another session or reward',async()=>{
  const f = fixture({already:true});
  const result = await run(configFrom({...env,MODE:'signin'}),f.deps);
  assert.equal(result.signin.already,true); assert.equal(result.balance,100);
  assert.equal(f.elapsed(),0); assert.equal(f.submissions(),0);
  assert.ok(!f.requests.some(request=>request.path==='/aossignin/stay_session'));
});

test('1022 insufficient wait budget or extra signin verification never creates a stay session',async()=>{
  const restricted = detail(), r = rule(); r.prevent_cheat.verif_code = 1;
  restricted.rule = JSON.stringify(r);
  for (const [options,maxWait] of [[{},'179'],[{detail:restricted},'200']]) {
    const f = fixture(options);
    await assert.rejects(run(configFrom({...env,MODE:'signin',MAX_WAIT_MINUTES:maxWait}),f.deps),Stop);
    assert.ok(!f.requests.some(request=>request.path.includes('stay_session') || request.path.endsWith('/ac_sub')));
  }
});

test('1022 login expiry, account mismatch and rejected signin never retry a reward',async()=>{
  for (const stage of ['login','identity','signin']) {
    let submits = 0;
    const f = fixture({respond:({path})=>{
      if (stage==='login' && path.endsWith('user_info')) return reply({},'1001');
      if (stage==='identity' && path.endsWith('user_info')) return reply({...user,id:1});
      if (stage==='signin' && path==='/aossignin/ac_sub') { submits++; return reply({},'1002'); }
    }});
    await assert.rejects(run(configFrom({...env,MODE:'signin'}),f.deps),Stop);
    assert.equal(submits,stage==='signin'?1:0);
    assert.ok(!f.requests.some(request=>request.path==='/aoslottery/ac_sub'));
  }
});

test('1022 uses the same scheduled planner and preserves immediate manual inspect/signin selection',async()=>{
  const now = Date.parse('2026-11-19T02:20:00Z');
  const scheduled = {...env,GITHUB_EVENT_NAME:'schedule',MODE:'inspect',MAX_WAIT_MINUTES:'0'};
  assert.equal(accountsFrom(executionEnv(scheduled))[0].mode,'signin');
  const plan = planFrom(scheduled,{now:()=>now,randomInt:()=>0});
  assert.deepEqual(plan,{slots:[`0:${now}`]});
  for (const mode of ['inspect','signin']) {
    await executeAccount({...env,GITHUB_EVENT_NAME:'workflow_dispatch',MODE:mode},'0:0',
      {log:()=>{},run:async config=>{assert.equal(config.activity,'1022');assert.equal(config.mode,mode);}});
  }
});

test('1022-only read APIs stay unavailable to 621; both clients forbid lottery and withdrawal mutations',async()=>{
  const readPaths = ['/aoslottery/ac_lottery_times','/aoslottery/act_user','/aoslottery/act_record',
    '/aoslottery/record_code_detail','/aospay/virtual_currency_user_wallet','/aosbase/withdraw_getconfig',
    '/aospay/virtual_currency_user_bill','/aosbase/withdraw_show'];
  let requests = 0;
  const fetchImpl = async()=>{requests++;return reply({});};
  const old = new Client(configFrom({...env,LINPING_ACTIVITY:'621'}),settings,fetchImpl);
  const next = new Client(configFrom(env),settings,fetchImpl);
  old.deviceToken=next.deviceToken='offline-device';
  for (const path of readPaths) {
    await next.call(path);
    await assert.rejects(old.call(path),Stop);
    await assert.rejects(next.call(path,{},'POST'),Stop);
  }
  await next.call('/aossignin/stay_session/recover',{},'POST');
  await assert.rejects(old.call('/aossignin/stay_session/recover',{},'POST'),Stop);
  const before = requests;
  for (const client of [old,next]) {
    for (const method of ['GET','POST']) {
      for (const path of ['/aosbase/withdraw','/aoslottery/ac_sub']) {
        await assert.rejects(client.call(path,{},method),/拒绝未列入测试范围/);
      }
    }
  }
  assert.equal(requests,before);
});

test('wallet and withdrawal metadata fail closed without logging private records',async()=>{
  for (const data of [{balance:-1},{balance:null},{balance:''},{balance:true},{}]) {
    await assert.rejects(read1022State({call:async()=>data},()=>{}),/余额格式/);
  }
  const f = fixture({respond:({path})=>path.includes('_withdrawal_ac_detail')?reply({id:1}):undefined});
  await assert.rejects(run(configFrom(env),f.deps),/提现活动身份/);
});

test('manual and scheduled 1022 runs never draw or withdraw even with positive lottery chances',async()=>{
  const now = Date.parse('2026-11-19T02:20:00Z');
  for (const event of ['workflow_dispatch','schedule']) {
    for (const mode of ['inspect','signin']) {
      const f = fixture({respond:({path})=>path.endsWith('/ac_lottery_times')?reply(10):undefined});
      await executeAccount({...env,GITHUB_EVENT_NAME:event,MODE:mode},
        `0:${event==='schedule'?now:0}`,{...f.deps,now:()=>now});
      const posts = f.requests.filter(request=>request.init.method==='POST');
      assert.ok(posts.every(request=>['/aossignin/stay_session','/aossignin/stay_session/checkpoint',
        '/aossignin/ac_sub'].includes(request.path)));
      assert.equal(f.submissions(),event==='schedule'||mode==='signin'?1:0);
      assert.ok(f.requests.every(request=>request.path!=='/aoslottery/ac_sub'));
      assert.ok(f.requests.filter(request=>request.path.includes('withdraw')).every(request=>!request.body));
      assert.ok(f.requests.every(request=>!request.path.includes('/static_3/aoslottery/')));
    }
  }
});

test('1022 workflow is independent, one hour later, manual-capable and protected by its own lock',async()=>{
  const root = new URL('../',import.meta.url);
  const old = await readFile(new URL('.github/workflows/callmeye.yml',root),'utf8');
  const next = await readFile(new URL('.github/workflows/activity-1022-regression.yml',root),'utf8');
  const cron = text => /cron: '(\d+) (\d+) \* \* \*'/.exec(text);
  const a = cron(old), b = cron(next);
  assert.equal(Number(b[1])+Number(b[2])*60-(Number(a[1])+Number(a[2])*60),60);
  assert.match(next,/workflow_dispatch:/); assert.match(next,/default: inspect/);
  assert.match(next,/LINPING_ACTIVITY: '1022'/);
  assert.match(next,/group: linping-1022-signin-accounts/);
  assert.match(old,/group: linping-signin-accounts/);
  assert.doesNotMatch(next,/workflow_run:|check_621|gh api|actions: read|contents: write|pull_request_target/);
  assert.match(next,/github\.event_name != 'schedule' \|\| vars\.LINPING_1022_DAILY != 'false'/);
  assert.match(next,/secrets\.LINPING_1022_ACCOUNTS/); assert.match(next,/secrets\.LINPING_ACCOUNTS/);
  assert.match(next,/!secrets\.LINPING_1022_TOKEN && secrets\.LINPING_ACCOUNTS/);
  assert.match(next,/LINPING_TOKEN: \$\{\{ secrets\.LINPING_1022_TOKEN \|\| secrets\.LINPING_TOKEN \}\}/);
  assert.match(next,/LINPING_DEVICE_ID: \$\{\{ secrets\.LINPING_1022_DEVICE_ID \|\| secrets\.LINPING_DEVICE_ID \}\}/);
  assert.match(next,/LINPING_USER_ID: \$\{\{ vars\.LINPING_1022_USER_ID \|\| vars\.LINPING_USER_ID \|\| '19426008' \}\}/);
  assert.match(next,/fail-fast: false/); assert.match(next,/max-parallel: 3/);
  assert.match(next,/timeout-minutes: 330/); assert.match(next,/cancel-in-progress: false/);
  assert.match(next,/fromJSON\(format\('\[\{0\}\]', needs\.prepare\.outputs\.slots\)\)/);
  assert.ok(next.indexOf('node --test')<next.indexOf('id: plan'));
});

test('1022 CLI validation errors never echo account JSON or tokens',()=>{
  const script = fileURLToPath(new URL('../scripts/daily.mjs',import.meta.url));
  const result = spawnSync(process.execPath,[script,'--account','0:0'],{
    encoding:'utf8',env:{...process.env,...env,LINPING_ACCOUNTS:'not-json-private',GITHUB_ACTIONS:'',
      GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_STEP_SUMMARY:'',GITHUB_OUTPUT:''}
  });
  assert.equal(result.status,1);
  assert.doesNotMatch(result.stdout+result.stderr,/not-json-private|offline-only/);
  assert.match(result.stdout,/不是有效 JSON/);
});
