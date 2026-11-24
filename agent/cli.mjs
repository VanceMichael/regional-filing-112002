#!/usr/bin/env node
// 代办命令行：经办人查看每份资料可安全执行的动作与阻塞原因。
import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { fetchIntake, indexPackets } from './intake.mjs';
import { ACTIONS } from './policy.mjs';

const STATE_PATH = process.env.AGENT_STATE ?? resolve(process.cwd(), '.agent-state.json');

const ACTION_TEXT = {
  [ACTIONS.FILL_DRAFT]: '可填草稿（有阻塞，不能递交）',
  [ACTIONS.SUBMIT]: '可递交',
  [ACTIONS.SUPPLEMENT]: '可补送（绑定原退回回执）',
  [ACTIONS.WAIT_REVIEW]: '等待门户评审',
  [ACTIONS.NONE]: '无安全动作',
};

function printReport(report) {
  for (const item of report) {
    const { packet, decision, receipt } = item;
    const header = `[${packet.record}] 申请 ${packet.case} · 指纹 ${packet.fingerprint} · ${packet.region}/${decision.branch.name}`;
    console.log(header);
    console.log(`  动作：${ACTION_TEXT[decision.action] ?? decision.action}` +
      (receipt ? `（门户回执 ${receipt.receipt}：${receipt.stateText}）` : ''));
    if (decision.selectionPlan.ambiguousNames?.length) {
      for (const amb of decision.selectionPlan.ambiguousNames) {
        console.log(`  机构歧义：${amb.role} 的来件简称「${amb.shortName}」在门户有 ${amb.candidates.join('、')}，按来件统一编号取 ${amb.resolved}`);
      }
    }
    const fills = decision.fillPlan.fills
      .map((fill) => `${fill.field}=${fill.value}${fill.source === 'human' ? '（人工）' : ''}${fill.conflict ? '（冲突）' : ''}`);
    if (fills.length) console.log(`  代填字段：${fills.join('，')}`);
    const signs = decision.signaturePlan.valid.map((item) => `${item.role}✓`);
    console.log(`  有效签署：${signs.join('、') || '无'}`);
    if (decision.blockers.length) {
      for (const blocker of decision.blockers) console.log(`  阻塞 [${blocker.code}]：${blocker.message}`);
    }
    console.log('');
  }
}

async function loadPackets(baseUrl, recordId) {
  const { records } = await fetchIntake(baseUrl);
  const packets = indexPackets(records);
  if (recordId) {
    const packet = packets.get(recordId);
    if (!packet) throw new Error(`当前阶段查不到来件记录 ${recordId}`);
    return [recordId, packet];
  }
  return null;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const baseUrl = process.env.PORTAL_URL ?? 'http://127.0.0.1:4100';
  const store = new Store(STATE_PATH);
  await store.load();
  const engine = new Engine({ baseUrl, store, headless: process.env.HEADED !== '1' });

  switch (command) {
    case 'sync': {
      const { stage, report } = await engine.sync();
      console.log(`回放阶段 ${stage}，共 ${report.length} 份资料\n`);
      printReport(report);
      break;
    }
    case 'list': {
      const { report } = await engine.sync();
      printReport(report);
      break;
    }
    case 'draft': {
      const [record] = args;
      if (!record) throw new Error('用法：agent draft <record>');
      const target = await loadPackets(baseUrl, record);
      const result = await engine.fillDraft(target[1]);
      console.log(result.ok ? '草稿已在门户页面填好（未勾选任何签署、未递交）' : '草稿填写存在页面级阻塞');
      printReport([{ record, packet: target[1], decision: result.decision, receipt: null }]);
      if (result.pageBlockers?.length) {
        for (const blocker of result.pageBlockers) console.log(`页面阻塞 [${blocker.code}]：${blocker.message}`);
      }
      break;
    }
    case 'submit': {
      const [record] = args;
      if (!record) throw new Error('用法：agent submit <record>');
      const target = await loadPackets(baseUrl, record);
      const result = await engine.submit(target[1]);
      if (result.ok) console.log(`已递交，门户回复：${result.output}（回执受理后可查）`);
      else if (result.reason === 'blocked') {
        console.log('策略未放行，未递交。阻塞如下：');
        for (const blocker of result.decision.blockers) console.log(`  [${blocker.code}] ${blocker.message}`);
      } else if (result.reason === 'page-dirty') {
        console.log('页面状态不干净，已阻止递交：');
        for (const blocker of result.pageBlockers) console.log(`  [${blocker.code}] ${blocker.message}`);
      } else {
        console.log(`门户未接收：${JSON.stringify(result.reply)}`);
      }
      break;
    }
    case 'reconcile': {
      const { records } = await fetchIntake(baseUrl);
      const packets = indexPackets(records);
      const results = await engine.reconcile(packets);
      for (const item of results) {
        console.log(`[${item.record}] ${item.packet.case}/${item.packet.fingerprint}：${item.status.state}` +
          (item.status.receipt ? `（回执 ${item.status.receipt}）` : '') +
          (item.status.message ? ` — ${item.status.message}` : ''));
      }
      break;
    }
    case 'lookup': {
      const [receiptId] = args;
      if (!receiptId) throw new Error('用法：agent lookup <回执号>');
      const detail = await engine.lookup(receiptId);
      console.log(`回执 ${detail.receipt}：${detail.stateText}（申请 ${detail.case}，指纹 ${detail.fingerprint}，分支 ${detail.branch}）`);
      if (detail.supplementsTo) console.log(`补送自原回执：${detail.supplementsTo}`);
      if (detail.state === 'returned') console.log(`退回原因：${detail.reason}；仍有效字段：${(detail.retainFields ?? []).join('、') || '无'}`);
      console.log('按角色确认的材料：');
      for (const role of detail.roles) {
        console.log(`  - ${role.role} ${role.org}` +
          (role.signed ? `，签署 ${role.branch}，字段[${role.fields.join(',')}]，版本 ${role.fingerprint}` : '，未签署'));
      }
      break;
    }
    case 'edit': {
      const [record, field, ...rest] = args;
      if (!record || !field || rest.length === 0) throw new Error('用法：agent edit <record> <field> <value>');
      await engine.noteHumanEdit(record, field, rest.join(' '));
      console.log(`已登记人工修改：${record}.${field}=${rest.join(' ')}（下次 sync 起参与冲突判定）`);
      break;
    }
    default:
      console.log(`用法：node agent/cli.mjs <sync|list|draft <record>|submit <record>|reconcile|lookup <回执号>|edit <record> <field> <value>>
环境变量：PORTAL_URL（默认 http://127.0.0.1:4100）、AGENT_STATE（默认 ./.agent-state.json）、HEADED=1 显示浏览器`);
  }
}

main().catch((error) => {
  console.error(`代办失败：${error.message}`);
  process.exitCode = 1;
});
