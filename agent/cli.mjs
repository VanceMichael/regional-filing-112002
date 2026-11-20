#!/usr/bin/env node
// 联合登记录入代办 CLI。
// 用法见 README：sync / list / draft / submit / recheck / run / receipt / edit。
import { resolve } from 'node:path';
import { Store } from './store.mjs';
import {
  withDriver,
  sync,
  reconcile,
  draft as draftPacket,
  submit as submitPacket,
  overview,
  lookupReceipt,
} from './orchestrator.mjs';

const parseArgs = (argv) => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[++i];
    else args._.push(token);
  }
  return args;
};

const baseUrlOf = (args) => args.base || process.env.PORTAL_URL || 'http://127.0.0.1:4100';
const statePathOf = (args) => resolve(args.state || process.env.AGENT_STATE || './.agent/state.json');

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const printOverview = (items) => {
  if (!items.length) return print('本地无资料，先执行 sync。');
  for (const item of items) {
    const region = item.packet?.region ?? '?';
    const receipt = item.receipt ? ` 回执=${item.receipt.receipt}(${item.receipt.state})` : '';
    console.log(`■ ${item.key} [${item.state}] 地区=${region}${receipt}`);
    console.log(`  可执行: ${item.actions.join(', ')}`);
    for (const blocker of item.blockers) console.log(`  阻塞: ${blocker}`);
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const baseUrl = baseUrlOf(args);
  const store = new Store(statePathOf(args));
  await store.load();
  store.state.baseUrl = baseUrl;

  switch (command) {
    case 'sync': {
      const result = await sync(store, baseUrl);
      await store.save();
      print(`阶段 ${result.stage}，同步来件 ${result.count} 份。`);
      break;
    }
    case 'list': {
      await withDriver(baseUrl, async (driver) => printOverview(await overview(store, driver)));
      break;
    }
    case 'draft': {
      const key = args._[1];
      if (!key) throw new Error('用法: draft <case/fingerprint>');
      await withDriver(baseUrl, async (driver) => {
        const result = await draftPacket(store, driver, key);
        print(`草稿已保存: ${JSON.stringify(result.fields)}`);
        for (const blocker of result.plan.blockers) console.log(`阻塞: ${blocker}`);
      });
      break;
    }
    case 'edit': {
      // 经办人人工修改本地草稿字段（模拟人工改单），值会被保留且不再被代办覆盖。
      const [, key, field, ...rest] = args._;
      const value = rest.join(' ');
      if (!key || !field || value === undefined) throw new Error('用法: edit <key> <field> <value>');
      if (!store.markHumanEdit(key, field, value)) throw new Error('草稿不存在，无法人工修改');
      await store.save();
      print(`已记录人工修改 ${key} ${field}=${value}`);
      break;
    }
    case 'submit': {
      const key = args._[1];
      if (!key) throw new Error('用法: submit <case/fingerprint>');
      await withDriver(baseUrl, async (driver) => print(await submitPacket(store, driver, key)));
      break;
    }
    case 'recheck': {
      await withDriver(baseUrl, async (driver) => {
        const rows = await reconcile(store, driver);
        print(`对账完成，门户回执 ${rows.length} 条。`);
        printOverview(await overview(store, null));
      });
      break;
    }
    case 'run': {
      // 同步 -> 对账 -> 逐份：可安全递交的递交，其余存草稿并列出阻塞。
      const synced = await sync(store, baseUrl);
      await store.save();
      await withDriver(baseUrl, async (driver) => {
        print(`阶段 ${synced.stage}，来件 ${synced.count} 份，开始逐份处理。`);
        const rows = await reconcile(store, driver);
        for (const rec of store.list()) {
          const status = (await overview(store, null)).find((item) => item.key === rec.key);
          if (status.state === 'accepted' || status.state === 'processing' ||
              status.state === 'returned' || status.state === 'conflict' || status.state === 'uncertain') {
            console.log(`跳过 ${rec.key}：${status.state}`);
            continue;
          }
          const result = await submitPacket(store, driver, rec.key);
          if (result.submitted) console.log(`递交 ${rec.key}：${result.status} ${result.message}`);
          else {
            console.log(`暂缓 ${rec.key}：${result.reason}`);
            for (const blocker of result.blockers ?? []) console.log(`  阻塞: ${blocker}`);
          }
        }
        console.log('\n=== 当前清单 ===');
        printOverview(await overview(store, driver));
      });
      break;
    }
    case 'receipt': {
      const receiptId = args._[1];
      if (!receiptId) throw new Error('用法: receipt <受理号，如 SL-101>');
      const found = lookupReceipt(store, receiptId);
      if (!found) throw new Error(`未反查到受理号 ${receiptId}`);
      print(found);
      break;
    }
    default:
      print([
        '用法: agent <command> [--base URL] [--state PATH]',
        '命令:',
        '  sync                分页同步来件到本地',
        '  list                对账回执并列出每份资料的状态/可执行动作/阻塞原因',
        '  draft <key>         按授权字段起草并保存草稿（不签署、不递交）',
        '  edit <key> <f> <v>  记录经办人对草稿字段的人工修改',
        '  submit <key>        无阻塞时网页递交（仅点击一次，409 自动绑定回执）',
        '  recheck             重开时先对账同一次递交的归属与状态',
        '  run                 同步后逐份处理：能交的交，不能交的留草稿列阻塞',
        '  receipt <受理号>    按受理号反查当时各角色确认的材料',
        'key 形如 D-21/A-27',
      ].join('\n'));
  }
}

main().catch((error) => {
  console.error(`代办失败: ${error.message}`);
  process.exitCode = 1;
});
