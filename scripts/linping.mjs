import {createHash, randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

export const API = 'https://ya.iyunxh.com/api';
export const STATIC = 'https://static2-ya.iyunxh.com/api';
export const PAGE = 'https://linping.y-h5.iyunxh.com/module-page/home/home?id=621';
export const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 YUNXH-YDAPP/1.0';
const EXPECTED_USER = 19426008;
const EXPECTED_TENANT = 59;
const MD5 = value => createHash('md5').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Stop extends Error {
  constructor(message) { super(message); this.name = 'Stop'; }
}

// Never include remote response bodies/messages, credentials or session IDs in logs.
export function safeCode(code) {
  const value = String(code);
  return /^-?\d{1,8}$/.test(value) ? value : 'unknown';
}

export function decodeObject(value, base64 = false) {
  try {
    if (typeof value === 'string') value = JSON.parse(base64 ? Buffer.from(value, 'base64').toString('utf8') : value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Stop('配置格式无法识别；停止，不猜测请求参数。'); }
}

export function configFrom(env) {
  const token = env.LINPING_TOKEN?.trim();
  if (!token || /[\r\n]/.test(token)) throw new Stop('请先在 GitHub Secrets 配置 LINPING_TOKEN（仅 Token 本身）。');
  const mode = env.MODE || 'inspect';
  if (!['inspect', 'signin'].includes(mode)) throw new Stop('MODE 只能是 inspect 或 signin。');
  const maxWait = Number(env.MAX_WAIT_MINUTES || 190);
  if (!Number.isInteger(maxWait) || maxWait < 0 || maxWait > 200) throw new Stop('等待上限必须为 0～200 分钟。');
  const device = env.LINPING_DEVICE_ID?.trim();
  if (device && !/^[\w-]{1,128}$/.test(device)) throw new Stop('LINPING_DEVICE_ID 格式不正确。');
  return {token, mode, maxWait, device};
}

export function signature(appid, appkey, now = Date.now(), nonce = randomUUID().replaceAll('-', '')) {
  if (appid !== 'linping' || typeof appkey !== 'string' || !appkey) throw new Stop('租户签名配置不符合预期。');
  const even = [], odd = [];
  for (let i = 0; i < appkey.length; i++) (i % 2 ? odd : even).push(appkey[i]);
  const key = MD5(even.join('') + odd.join(''));
  return [appid, nonce, now, MD5(appid + nonce + now + key)].join(';');
}

export function identity(data) {
  if (Number(data?.id) !== EXPECTED_USER || Number(data?.user_id ?? data?.id) !== EXPECTED_USER || Number(data?.t_id) !== EXPECTED_TENANT) {
    throw new Stop('账号或租户与预期测试账号不一致；停止，避免操作其他账号。');
  }
  if (!Number.isSafeInteger(Number(data.gold)) || Number(data.gold) < 0) throw new Stop('金币余额格式异常。');
  return {user_id:EXPECTED_USER, gold:Number(data.gold)};
}

export async function jsonRequest(url, options = {}, fetchImpl = fetch) {
  const target = new URL(url);
  if (![new URL(API).origin, new URL(STATIC).origin].includes(target.origin) || !target.pathname.startsWith('/api/') || target.username || target.password) {
    throw new Stop('拒绝向非预期地址发送请求。');
  }
  let response;
  try {
    response = await fetchImpl(url, {...options, redirect:'error', signal:AbortSignal.timeout(20000)});
  } catch { throw new Stop('网络请求失败或超时；不自动重试。若发生在签到提交阶段，请先人工核对签到记录。'); }
  if ([401,403].includes(response.status)) throw new Stop('请求被拒绝：可能是 Token、签名或环境校验；停止，不重试登录。');
  if (!response.ok) throw new Stop(`HTTP ${response.status}；停止，不自动重试。`);
  let result;
  try { result = await response.json(); } catch { throw new Stop('接口未返回可识别的 JSON。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Stop('接口响应格式异常。');
  return result;
}

export function ok(result, label) {
  if (['1001','1002'].includes(String(result.code))) throw new Stop('登录失效或需要重新认证：请从 App 重新取得 H5 Token，更新 LINPING_TOKEN 后重跑。');
  if (String(result.code) !== '0') throw new Stop(`${label}未成功，业务码 ${safeCode(result.code)}。原始响应未记录。`);
  return result.data;
}

export async function tenant(fetchImpl = fetch) {
  const r = await jsonRequest(`${STATIC}/aosbase/_auth_h5init/linping.json`, {}, fetchImpl);
  const data = ok(r, '加载租户');
  const settings = decodeObject(data, typeof data === 'string');
  if (settings.appid !== 'linping' || Number(settings.t_id) !== EXPECTED_TENANT || Number(settings.t_id_in) !== EXPECTED_TENANT || !settings.appkey) {
    throw new Stop('租户配置发生变化；停止。');
  }
  return settings;
}

export class Client {
  constructor(config, settings, fetchImpl = fetch) {
    this.config = config; this.settings = settings; this.fetchImpl = fetchImpl;
    this.deviceToken = null;
  }
  async initDevice() {
    const headers = {'Access-T-Id':'59','Access-T-Id-In':'59','Access-Api-Unique-Token':'1',
      'Access-Api-Dt':this.config.device || randomUUID(), 'User-Agent':UA};
    const value = ok(await jsonRequest(`${API}/aosbase/_auth_dt`, {headers}, this.fetchImpl), '设备会话初始化');
    if (typeof value !== 'string' || value.length < 68) throw new Stop('设备会话格式发生变化；停止。');
    // Same extraction as the H5 filterDeviceToken(). Not an App credential refresh.
    this.deviceToken = value.slice(32, 68);
  }
  async call(path, data = {}, method = 'GET') {
    const allowed = new Set(['/aosbase/user_info','/aossignin/user_times','/aossignin/stay_session',
      '/aossignin/stay_session/checkpoint','/aossignin/stay_session/status','/aossignin/ac_sub']);
    if (!allowed.has(path) || !['GET','POST'].includes(method)) throw new Stop('拒绝未列入测试范围的接口。');
    if (!this.deviceToken) throw new Stop('设备会话尚未初始化。');
    const headers = {'Access-Token':this.config.token, 'Access-User-Id':String(EXPECTED_USER),
      'Access-T-Id':'59', 'Access-T-Id-In':'59', 'Access-Api-Unique-Token':'1',
      'Access-Wxclient-Type':'wx_app', 'Access-Api-Signature':signature(this.settings.appid,this.settings.appkey),
      'Access-Api-Dt':this.deviceToken, 'User-Agent':UA, 'Origin':new URL(PAGE).origin, 'Referer':PAGE};
    const url = new URL(API + path);
    const options = {method, headers};
    if (method === 'GET') for (const [key,value] of Object.entries(data)) url.searchParams.set(key,String(value));
    else { headers['Content-Type']='application/json'; options.body=JSON.stringify(data); }
    return ok(await jsonRequest(url.href,options,this.fetchImpl), path === '/aossignin/ac_sub' ? '签到提交' : '接口请求');
  }
}

export function activityFromPage(data) {
  let content;
  try { content=typeof data?.content==='string'?JSON.parse(data.content):data?.content; }
  catch { throw new Stop('页面组件配置无法解析。'); }
  if (!Array.isArray(content)) throw new Stop('页面组件配置格式异常。');
  const signins=content.filter(item=>item.type==='signin');
  const id=Number(signins[0]?.attr?.id);
  if (signins.length !== 1 || !Number.isSafeInteger(id) || id<=0) throw new Stop('未找到唯一签到活动，停止以免选错。');
  return id;
}

export async function activity(fetchImpl = fetch) {
  const page=ok(await jsonRequest(`${STATIC}/cms/page_getattr/621.json`,{},fetchImpl),'加载页面');
  const id=activityFromPage(page);
  const detail=ok(await jsonRequest(`${STATIC}/static_3/aossignin/_ac_detail/${id}.json`,{},fetchImpl),'加载活动');
  if (Number(detail?.id)!==id || Number(detail?.t_id)!==EXPECTED_TENANT) throw new Stop('活动身份或租户异常。');
  return {...detail, id, rule:decodeObject(detail.rule), other_set:decodeObject(detail.other_set)};
}

export function checkRule(detail, user, now = Date.now()) {
  const start=Number(detail.start_time)*1000, end=Number(detail.end_time)*1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || now<start || now>end) throw new Stop('活动不在有效期内。');
  const limit=detail.rule.submit_limit, cheat=detail.rule.prevent_cheat, area=cheat?.area_limit;
  if (!limit || !cheat || !area) throw new Stop('活动限制配置不完整；停止。');
  if (Number(limit.open_userinfo_collect) || Number(cheat.verif_code) || Number(cheat.is_open_ydsafe) ||
      Number(cheat.is_open_password) || Number(cheat.is_open_blacklist) || Number(cheat.is_open_whitelist) ||
      Number(limit.open_black) || ['ip_limit','location_limit','phone_limit','geometry_limit'].some(key=>Number(area[key])) ||
      Number(detail.other_set.is_bind_app) || (Number(cheat.is_open_phone_verify) && !Number(user.phone_verify))) {
    throw new Stop('活动包含额外验证条件；本测试器不代填定位、不解验证码、不绕过限制，请在原 App 完成。');
  }
  if (Number(limit.open_stay_time)!==1 || !Number.isFinite(Number(limit.stay_time)) || Number(limit.stay_time)<=0) {
    throw new Stop('停留规则与本测试器预期不符；停止。');
  }
}

export function signed(data) {
  const value = data?.day_remain;
  if (value === undefined || value === null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value)<0) throw new Stop('今日签到状态无法确认；停止。');
  return Number(value)>0;
}

export function session(value, previous) {
  if (!value || typeof value.session_id!=='string' || !value.session_id || value.session_id.length>64 ||
      !['waiting','eligible','closed','expired'].includes(value.status)) throw new Stop('停留会话格式不符合 H5 协议。');
  for (const key of ['required_ms','credited_ms','remaining_ms','server_now_ms','started_at_ms','settled_until_ms','expires_at_ms']) {
    if (!Number.isSafeInteger(value[key]) || value[key]<0) throw new Stop('停留时长字段异常。');
  }
  if (value.credited_ms>value.required_ms || value.remaining_ms!==value.required_ms-value.credited_ms ||
      value.started_at_ms>value.settled_until_ms || value.settled_until_ms>value.server_now_ms ||
      value.expires_at_ms<value.started_at_ms || (value.status==='waiting' && value.remaining_ms<=0) ||
      (value.status==='eligible' && value.remaining_ms!==0) ||
      (previous && (previous.session_id!==value.session_id || value.server_now_ms<previous.server_now_ms))) {
    throw new Stop('停留会话校验失败；停止，不根据本地倒计时提交。');
  }
  if (['closed','expired'].includes(value.status)) throw new Stop('停留会话已关闭或过期；本次停止，不自动重建。');
  return value;
}

export async function eligible(client, id, maxWait, log, deps = {}) {
  const sleep=deps.sleep||wait, clock=deps.clock||(()=>performance.now());
  const started=clock(), deadline=started+maxWait*60000;
  let current=session(await client.call('/aossignin/stay_session',{activity_id:id,page_instance_id:randomUUID()},'POST'));
  const checkpoint=async()=>{
    current=session(await client.call('/aossignin/stay_session/checkpoint',{
      activity_id:id,session_id:current.session_id,operation:'checkpoint'},'POST'),current);
    log(`服务端进度：${Math.floor(current.credited_ms/1000)}/${Math.ceil(current.required_ms/1000)} 秒，剩余 ${Math.ceil(current.remaining_ms/1000)} 秒。`);
  };
  await checkpoint();
  while(current.status!=='eligible') {
    const budget=deadline-clock();
    if (budget<=0) throw new Stop('达到本次等待上限，但服务端尚未确认达标；未提交签到。不跨运行伪造或补报停留时长。');
    // An actual running process waits. Never send a claimed elapsed duration.
    await sleep(Math.min(60000, Math.max(1000,current.remaining_ms),budget));
    await checkpoint();
  }
  return current;
}

export async function submitOnce(client, id, current, log) {
  if (signed(await client.call('/aossignin/user_times',{activity_id:id}))) {
    log('今日已有签到记录，本次不重复提交。'); return {already:true};
  }
  const user=await client.call('/aosbase/user_info'); identity(user);
  const fresh=session(await client.call('/aossignin/stay_session/checkpoint',{
    activity_id:id,session_id:current.session_id,operation:'checkpoint'},'POST'),current);
  if (fresh.status!=='eligible' || fresh.server_now_ms>=fresh.expires_at_ms) throw new Stop('提交前服务端资格尚未达标或已到期；未提交。');
  const before=identity(user).gold;
  // Exactly one mutation attempt. A timeout or rejection is NEVER retried.
  await client.call('/aossignin/ac_sub',{id,stay_session_id:fresh.session_id,
    afs_tokenid:'',collect_info:'',longitude:0,latitude:0},'POST');
  log('签到接口返回成功；正在核对今日记录和余额（不再提交）。');
  const confirmed=signed(await client.call('/aossignin/user_times',{activity_id:id}));
  const after=identity(await client.call('/aosbase/user_info')).gold;
  if (!confirmed) throw new Stop('签到接口返回成功，但今日记录尚未确认；请人工核对，勿立即重跑。');
  log(`今日签到记录已确认。金币：${before} → ${after}，变化 ${after-before}。余额变化不单独作为签到成功证据。`);
  return {confirmed,before,after};
}

export async function run(config, deps = {}) {
  const log=deps.log||console.log, fetchImpl=deps.fetch||fetch;
  const settings=await tenant(fetchImpl);
  const client=deps.client||new Client(config,settings,fetchImpl);
  await client.initDevice();
  const rawUser=await client.call('/aosbase/user_info');
  const user=identity(rawUser);
  log(`测试账号验证通过：${user.user_id}；当前金币 ${user.gold}。`);
  const detail=await activity(fetchImpl);
  log(`页面 621 对应签到活动 ${detail.id}；停留规则 ${Number(detail.rule.submit_limit?.stay_time)||0} 秒。`);
  if (signed(await client.call('/aossignin/user_times',{activity_id:detail.id}))) { log('今日已签到，未创建新会话，也未重复提交。'); return; }
  if (config.mode==='inspect') { log('检查完成。inspect 不创建停留会话，不提交签到。选择 signin 才会真实等待并尝试签到。'); return; }
  checkRule(detail,rawUser);
  const current=await eligible(client,detail.id,config.maxWait,log,deps);
  // Configuration may have changed while waiting several hours.
  const latest=await activity(fetchImpl);
  if (latest.id!==detail.id) throw new Stop('等待期间页面活动发生变化；停止。');
  checkRule(latest,await client.call('/aosbase/user_info'));
  await submitOnce(client,detail.id,current,log);
}

async function main() {
  const lines=[];
  const log=message=>{console.log(message);lines.push(message);};
  try { await run(configFrom(process.env),{log}); }
  catch (error) {
    log(error instanceof Stop ? error.message : '发生未预期错误；为防止凭证泄露不输出原始异常。请先人工核对签到记录。');
    process.exitCode=1;
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY) {
      // Every message above is generated locally, with only validated numeric fields.
      await appendFile(process.env.GITHUB_STEP_SUMMARY,'## 悦临平测试结果\n\n'+lines.map(x=>'- '+x).join('\n')+'\n');
    }
  }
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
