import {ACTIVITY_1022, STATIC, Stop, Client, tenant, identity, activity,
  jsonRequest, ok, runSignin} from './callmeye.mjs';

const count = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0;

export async function read1022State(client, log, fetchImpl = fetch) {
  const wallet = await client.call('/aospay/virtual_currency_user_wallet');
  if (!count(wallet?.balance)) throw new Stop('1022 金币钱包余额格式异常。');
  log(`1022 共用金币钱包余额：${Number(wallet.balance)}。不将其他活动的余额变化算作本活动奖励。`);
  await client.call('/aoslottery/ac_lottery_times',{id:ACTIVITY_1022.lotteryId});
  await client.call('/aoslottery/act_user',{id:ACTIVITY_1022.lotteryId});
  await client.call('/aoslottery/act_record',{id:ACTIVITY_1022.lotteryId,offset:0,count:20});
  await client.call('/aoslottery/record_code_detail',{id:ACTIVITY_1022.lotteryId});
  await client.call('/aosbase/withdraw_getconfig');
  const withdrawal = ok(await jsonRequest(
    `${STATIC}/static_3/aosbasemodule/_withdrawal_ac_detail/${ACTIVITY_1022.withdrawalId}.json`,{},fetchImpl),'加载提现活动');
  if (Number(withdrawal?.id) !== ACTIVITY_1022.withdrawalId ||
      (withdrawal.t_id !== undefined && Number(withdrawal.t_id) !== 59)) {
    throw new Stop('1022 提现活动身份或租户异常。');
  }
  await client.call('/aospay/virtual_currency_user_bill');
  await client.call('/aosbase/withdraw_show');
  log('1022 抽奖次数、参与/中奖记录、核销码接口、金币流水和提现规则/记录已查询；不输出核销码，不执行抽奖或提现。');
  return {balance:Number(wallet.balance)};
}

export async function run1022(config, deps = {}) {
  if (config.activity !== '1022') throw new Stop('1022 执行器拒绝其他活动配置。');
  const log = deps.log || console.log, fetchImpl = deps.fetch || fetch;
  const settings = await tenant(fetchImpl);
  const client = deps.client || new Client(config,settings,fetchImpl);
  await client.initDevice();
  const rawUser = await client.call('/aosbase/user_info');
  const user = identity(rawUser,config.userId);
  log(`1022 测试账号验证通过：${user.user_id}；当前金币 ${user.gold}。`);
  const detail = await activity(fetchImpl,'1022');
  const signin = await runSignin(client,config,rawUser,detail,deps);
  // A confirmed (or already recorded) signin is final; diagnostics are inspect-only.
  if (config.mode === 'signin') return {signin,balance:signin.after ?? user.gold};
  const state = await read1022State(client,log,fetchImpl);
  return {signin,...state};
}
