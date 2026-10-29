import {randomInt} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {Stop, configFrom, expectedUserId, tokenIdentity, testDeviceId, run} from './linping.mjs';

export const MAX_ACCOUNTS = 10;
export const MAX_RANDOM_WINDOW_MINUTES = 90;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only the numeric index and planned start time may leave the planner job.
// Never put tokens, device IDs or the account JSON into outputs or a matrix.
export function accountsFrom(env) {
  if (!env.LINPING_ACCOUNTS?.trim()) return [configFrom(env)];
  let entries;
  try { entries = JSON.parse(env.LINPING_ACCOUNTS); }
  catch { throw new Stop('LINPING_ACCOUNTS 不是有效 JSON；不回退到单账号，未发送请求。'); }
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ACCOUNTS) {
    throw new Stop(`LINPING_ACCOUNTS 必须是包含 1～${MAX_ACCOUNTS} 个账号的数组。`);
  }
  const users = new Set(), tokens = new Set(), devices = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['user_id','token','device_id'].includes(key)) ||
        typeof entry.token !== 'string' || !entry.token.trim() ||
        (Object.hasOwn(entry,'user_id') && !['string','number'].includes(typeof entry.user_id)) ||
        (Object.hasOwn(entry,'device_id') && (typeof entry.device_id !== 'string' || !entry.device_id.trim()))) {
      throw new Stop('多账号条目须包含非空 token；user_id、device_id 可省略，其他字段不支持。');
    }
    // Opaque tokens remain supported with an explicit user_id (legacy config).
    // The observed format is also cross-checked against any explicit ID.
    const explicitUser = Object.hasOwn(entry,'user_id');
    const claims = !explicitUser || /^[a-f\d]{32}/i.test(entry.token.trim()) ? tokenIdentity(entry.token) : undefined;
    const userId = explicitUser ? expectedUserId(entry.user_id) : claims.userId;
    if (claims && claims.userId !== userId) throw new Stop('配置的 user_id 与 Token 内账号不一致；未发送请求。');
    const config = configFrom({...env, LINPING_TOKEN:entry.token, LINPING_USER_ID:userId,
      LINPING_DEVICE_ID:entry.device_id ?? testDeviceId(userId)});
    if (users.has(config.userId) || tokens.has(config.token) || devices.has(config.device)) {
      throw new Stop('多账号配置中存在重复账号、Token 或设备标识；停止，避免重复提交或混用身份。');
    }
    users.add(config.userId); tokens.add(config.token); devices.add(config.device);
    return config;
  });
}

export function executionEnv(env) {
  if (env.GITHUB_EVENT_NAME !== 'schedule') return env;
  // Scheduled execution is a REAL signin, independent of manual-input defaults.
  return {...env, MODE:'signin', MAX_WAIT_MINUTES:env.SCHEDULE_MAX_WAIT_MINUTES || '200'};
}

export function randomWindow(env) {
  const value = env.RANDOM_WINDOW_MINUTES?.trim() || '60';
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) > MAX_RANDOM_WINDOW_MINUTES) {
    throw new Stop(`RANDOM_WINDOW_MINUTES 必须为 0～${MAX_RANDOM_WINDOW_MINUTES} 的整数。`);
  }
  return Number(value);
}

export function planFrom(env, deps = {}) {
  const accounts = accountsFrom(executionEnv(env));
  const now = (deps.now || Date.now)();
  const scheduled = env.GITHUB_EVENT_NAME === 'schedule';
  const windowMs = scheduled ? randomWindow(env) * 60000 : 0;
  const choose = deps.randomInt || randomInt;
  if (!Number.isSafeInteger(now) || now < 0) throw new Stop('计划时间无效。');
  return {include:accounts.map((_, index) => {
    const delay = scheduled ? choose(0, windowMs + 1) : 0;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > windowMs) throw new Stop('随机启动时间超出窗口。');
    if (!Number.isSafeInteger(now + delay)) throw new Stop('计划时间无效。');
    return {account_index:index, start_at_ms:scheduled ? now + delay : 0};
  })};
}

export async function waitForStart(startAt, env, log, deps = {}) {
  if (env.GITHUB_EVENT_NAME !== 'schedule') return;
  if (!/^[1-9]\d*$/.test(String(startAt)) || !Number.isSafeInteger(Number(startAt))) {
    throw new Stop('定时任务缺少有效的计划启动时间；未发送请求。');
  }
  const target = Number(startAt), now = deps.now || Date.now;
  const current = now(), remaining = target - current;
  const chinaDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0,10);
  if (chinaDay(target) !== chinaDay(current)) throw new Stop('任务已跨北京时间日期；停止旧计划，避免补签或跨日误操作。');
  if (remaining > randomWindow(env) * 60000) throw new Stop('计划启动时间超出配置窗口；未发送请求。');
  if (remaining <= 0) { log('计划启动时间已到，立即执行；GitHub 排队可能导致延迟。'); return; }
  log(`本账号计划启动时间：${new Date(target).toISOString()}（UTC）；约等待 ${Math.ceil(remaining / 1000)} 秒。`);
  // Scheduling jitter is separate from dwell time: no API/session is created here.
  const clock = deps.clock || (() => performance.now());
  const started = clock();
  while (clock() - started < remaining) {
    await (deps.sleep || sleep)(Math.min(60000, remaining - (clock() - started)));
  }
}

export async function executeAccount(env, index, deps = {}) {
  const accounts = accountsFrom(executionEnv(env));
  if (!/^\d+$/.test(String(index)) || !Number.isSafeInteger(Number(index)) || Number(index) >= accounts.length) {
    throw new Stop('账号索引无效；未发送请求。');
  }
  const config = accounts[Number(index)], log = deps.log || console.log;
  await waitForStart(env.START_AT_MS, env, log, deps);
  log(`开始执行账号 ${Number(index) + 1}/${accounts.length}；模式 ${config.mode}。`);
  return await (deps.run || run)(config, deps);
}

function maskSecrets(env) {
  if (env.GITHUB_ACTIONS !== 'true') return;
  const values = [env.LINPING_TOKEN, env.LINPING_DEVICE_ID];
  try {
    const accounts = JSON.parse(env.LINPING_ACCOUNTS || '[]');
    if (Array.isArray(accounts)) for (const account of accounts) values.push(account?.token, account?.device_id);
  } catch { /* Validation reports a local, constant message later. */ }
  for (const value of values) if (typeof value === 'string' && value.trim()) {
    const escaped = value.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
    console.log(`::add-mask::${escaped}`);
  }
}

async function main() {
  const env = process.env, lines = [];
  const log = message => { console.log(message); lines.push(message); };
  maskSecrets(env);
  try {
    if (process.argv[2] === '--plan' && process.argv.length === 3) {
      const plan = planFrom(env);
      if (!env.GITHUB_OUTPUT) throw new Stop('缺少 GITHUB_OUTPUT；未导出计划。');
      await appendFile(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(plan)}\n`);
      log(`已校验 ${plan.include.length} 个账号；只导出索引和计划时间，不导出凭证。`);
    } else if (process.argv[2] === '--account' && process.argv.length === 4) {
      await executeAccount(env, process.argv[3], {log});
    } else throw new Stop('用法：daily.mjs --plan 或 daily.mjs --account <从 0 开始的索引>。');
  } catch (error) {
    log(error instanceof Stop ? error.message : '发生未预期错误；不输出原始异常以保护凭证，请人工核对本账号记录。');
    process.exitCode = 1;
  } finally {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
      '## 悦临平任务结果\n\n' + lines.map(line => '- ' + line).join('\n') + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
