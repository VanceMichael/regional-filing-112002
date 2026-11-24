import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { makePortal } from '../portal.mjs';
import { sendJson, start } from '../source-server.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { fetchIntake, indexPackets } from './intake.mjs';
import { BLOCKERS } from './policy.mjs';

async function harness() {
  const { server, url } = await start({ portal: makePortal(sendJson) });
  const dir = await mkdtemp(join(tmpdir(), 'filing-agent-'));
  const statePath = join(dir, 'state.json');
  const store = new Store(statePath);
  await store.load();
  const engine = new Engine({ baseUrl: url, store, headless: true });
  const packets = async () => indexPackets((await fetchIntake(url)).records);
  const setStage = (stage) => fetch(`${url}/control?stage=${stage}`, { method: 'POST' });
  return {
    server, url, store, engine, dir, packets, setStage,
    cleanup: async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('端到端：草稿不代签、旧分支声明不可复用、处理中重开不重复递交', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  let all = await h.packets();

  // 阶段1：intake-1 资料齐全可递交；intake-2 跨区只带国内-R1 旧声明且缺联络人签署。
  let { report } = await h.engine.sync();
  const byRecord = Object.fromEntries(report.map((item) => [item.record, item]));
  assert.equal(byRecord['intake-1'].decision.canSubmit, true);
  const d22 = byRecord['intake-2'].decision;
  assert.equal(d22.canSubmit, false);
  assert.ok(d22.blockers.some((b) => b.code === BLOCKERS.MISSING_SIGNATURE));
  assert.match(d22.blockers.map((b) => b.message).join(' '), /不可复用/);
  // 同名“远帆”按统一编号区分的事实被记录
  assert.ok(d22.selectionPlan.ambiguousNames.some((a) => a.candidates.includes('ORG-02')));

  // intake-2 只能填草稿，且草稿不得勾选任何签署框
  const draft = await h.engine.fillDraft(all.get('intake-2'));
  assert.equal(draft.snapshot.signedBoxes.holderSigned, false);
  assert.equal(draft.snapshot.signedBoxes.liaisonSigned, false);
  assert.equal(draft.snapshot.fields.title, '馆藏镜头');
  // 策略未放行时 submit 直接拒绝，不碰页面递交
  const blocked = await h.engine.submit(all.get('intake-2'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked');

  // intake-1 正常递交，当场只有“处理中”，没有回执号
  const sent = await h.engine.submit(all.get('intake-1'));
  assert.equal(sent.ok, true);
  assert.equal(sent.output, '处理中');

  // 重开：本地有递交动作但门户索引暂未出现（这里立即查其实已可查，两种路径都不得重交）
  let reconcile = await h.engine.reconcile(all);
  const r21 = reconcile.find((item) => item.record === 'intake-1');
  assert.ok(['processing', 'unknown-processing'].includes(r21.status.state));
  assert.notEqual(r21.status.state, 'never-submitted');

  // 重复递交被策略层拦截（门户已确认接收）
  await h.setStage(2);
  all = await h.packets();
  await h.engine.sync();
  const again = await h.engine.submit(all.get('intake-1'));
  assert.equal(again.ok, false);
  assert.ok(again.decision.blockers.some((b) => b.code === BLOCKERS.ALREADY_SUBMITTED));

  // 回执索引中确认受理，凭回执号反查角色确认材料
  reconcile = await h.engine.reconcile(all);
  const receiptId = reconcile.find((item) => item.record === 'intake-1').status.receipt;
  assert.match(receiptId, /^SL-\d+$/);
  const detail = await h.engine.lookup(receiptId);
  assert.equal(detail.state, 'accepted');
  assert.equal(detail.roles.find((r) => r.role === '素材权利人').org, 'ORG-03');
  assert.equal(detail.roles.find((r) => r.role === '素材权利人').fingerprint, 'A-27');
});

test('端到端：退回补正保留原凭据，补送绑定原回执与新分支', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.setStage(3);
  let all = await h.packets();
  const p3 = all.get('intake-3');

  // 阶段3：A-29 两份跨区-R2 签署齐全，可递交
  const { report } = await h.engine.sync();
  const d3 = report.find((item) => item.record === 'intake-3').decision;
  assert.equal(d3.canSubmit, true);
  const sent = await h.engine.submit(p3);
  assert.equal(sent.ok, true);

  // 控制员评审退回：只补正 contact，title/count 凭据仍有效
  await h.engine.sync();
  const index = await (await fetch(`${h.url}/filing/receipts?format=json`)).json();
  const receipt = index.items.find((item) => item.fingerprint === 'A-29');
  const review = await fetch(
    `${h.url}/filing/review?receipt=${receipt.receipt}&decision=return&reason=${encodeURIComponent('联络资料需补正')}&retain=title&retain=count`,
    { method: 'POST' });
  assert.equal(review.status, 200);

  // 阶段4：A-30 补送来件出现，决策应为 supplement，并绑定原退回回执
  await h.setStage(4);
  all = await h.packets();
  const p4 = all.get('intake-4');
  const synced = await h.engine.sync();
  const d4 = synced.report.find((item) => item.record === 'intake-4');
  assert.equal(d4.decision.action, 'supplement');
  assert.equal(d4.returnedOrigin.receipt, receipt.receipt);

  // 不允许把新材料当普通新件递交（门户也会拒绝无绑定的同案新材料）
  const supplement = await h.engine.submit(p4);
  assert.equal(supplement.ok, true);

  // 新回执与原退回回执同时可查，详情页保留补送链与角色确认快照
  const after = await (await fetch(`${h.url}/filing/receipts?format=json`)).json();
  assert.equal(after.items.length, 2);
  const oldItem = after.items.find((item) => item.fingerprint === 'A-29');
  const newItem = after.items.find((item) => item.fingerprint === 'A-30');
  assert.equal(oldItem.state, 'returned');
  assert.deepEqual(oldItem.retainFields, ['title', 'count']);
  assert.equal(newItem.supplementsTo, oldItem.receipt);
  const newDetail = await h.engine.lookup(newItem.receipt);
  assert.equal(newDetail.state, 'processing');
  assert.equal(newDetail.supplementsTo, oldItem.receipt);
  assert.equal(newDetail.roles.find((r) => r.role === '跨区联络人').fingerprint, 'A-30');

  // 已退回的原申请指纹再次递交 => 门户 409/策略拦截，不会重复交
  const repeat = await h.engine.submit(p3);
  assert.equal(repeat.ok, false);
});

test('端到端：人工修改后保留不冲突字段，冲突与缺失签署交经办人', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const all = await h.packets();
  // 经办人手工改了 intake-1 的 title，count 未改
  await h.engine.noteHumanEdit('intake-1', 'title', '人工改的名称');
  const { report } = await h.engine.sync();
  const d1 = report.find((item) => item.record === 'intake-1').decision;
  const conflict = d1.blockers.find((b) => b.code === BLOCKERS.HUMAN_CONFLICT);
  assert.ok(conflict);
  assert.equal(conflict.field, 'title');
  // count 未冲突，仍在填写计划里保留
  assert.ok(d1.fillPlan.fills.find((f) => f.field === 'count' && f.conflict === undefined));
  // 存在冲突时不能递交
  assert.equal(d1.canSubmit, false);

  // 浏览器实际填写时跳过冲突字段，不覆盖人工值
  const draft = await h.engine.fillDraft(all.get('intake-1'));
  assert.equal(draft.snapshot.fields.title, '');
  assert.equal(draft.snapshot.fields.count, '18');
});

test('端到端：门户按归属地换确认格时不会把上一单签署带过来', async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  // 直接用浏览器驱动验证：每个页面是全新上下文，切区分支后签署框复位
  const { PortalBrowser } = await import('./browser.mjs');
  const browser = new PortalBrowser(h.url, { headless: true });
  await browser.start();
  t.after(() => browser.close());
  const config = await browser.readPortalConfig();
  assert.equal(config.branches.跨区.name, '跨区-R2');
  const page = await browser.openFiling();
  await browser.selectRegion(page, '跨区');
  const cross = await browser.snapshot(page);
  assert.equal(cross.branch, '跨区-R2');
  assert.equal(cross.signedBoxes.liaisonSigned, false);
  await page.getByLabel('跨区联络人已签署').check();
  await browser.selectRegion(page, '本地');
  const back = await browser.snapshot(page);
  assert.equal(back.branch, '国内-R1');
  assert.equal(back.signedBoxes.holderSigned, false);
  await page.close();
});
