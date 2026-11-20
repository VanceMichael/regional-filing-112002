// 编排层：把纯规则、浏览器驱动与本地存储串成完整代办流程。
import { chromium } from 'playwright';
import { PortalDriver } from './driver.mjs';
import {
  planSubmission,
  confirmationManifest,
  packetKey,
  receiptStateOf,
  evaluate,
} from './policy.mjs';
import { fetchIntake, currentStage } from './source-client.mjs';

export async function withDriver(baseUrl, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    return await run(new PortalDriver(browser, baseUrl));
  } finally {
    await browser.close();
  }
}

// 打开一份资料的表单页面，等门户按归属地刷新后，以实时快照生成递交计划。
async function inspectPacket(driver, packet) {
  const page = await driver.newPage();
  try {
    const options = await driver.readOptions(page);
    await driver.selectRegion(page, packet.region);
    const snapshot = await driver.readSnapshot(page);
    const plan = planSubmission(packet, snapshot, options);
    plan.caseValue = packet.case;
    plan.fingerprintValue = packet.fingerprint;
    return { page, plan };
  } catch (error) {
    await driver.close(page);
    throw error;
  }
}

// 同步来件：只更新来源侧内容，不动本地草稿与回执。
export async function sync(store, baseUrl) {
  store.state.baseUrl = baseUrl;
  const stage = await currentStage(baseUrl);
  const records = await fetchIntake(baseUrl);
  for (const record of records) store.syncPacket(record);
  return { stage, count: records.length };
}

// 回执对账：判断同一次递交的归属和状态。处理中与草稿索引可能短时并存，
// 一切以回执查询页的实际行为准。
export async function reconcile(store, driver) {
  const rows = await driver.readReceipts();
  const indexed = rows.map((row) => ({ ...row, key: `${row.case}/${row.fingerprint}` }));
  for (const rec of store.list()) {
    const row = indexed.find((item) => item.key === rec.key);
    store.reconcile(rec.key, row ? { ...row, state: receiptStateOf(row.state) } : null);
  }
  // 门户已确认但本地没有的记录（如人工递交），也登记索引以便反查。
  for (const row of indexed) {
    if (!store.get(row.key)) store.rememberExternalReceipt(row.key, null, { ...row, state: receiptStateOf(row.state) });
  }
  await store.save();
  return indexed;
}

// 起草：把可授权代填的字段写入本地草稿；有阻塞也保留已确认不冲突的字段。
export async function draft(store, driver, key) {
  const rec = store.get(key);
  if (!rec?.packet) throw new Error(`本地无资料 ${key}，先执行 sync`);
  const { page, plan } = await inspectPacket(driver, rec.packet);
  try {
    const humanValues = {};
    for (const [name, source] of Object.entries(rec.fieldSources ?? {})) {
      if (source === 'human' && rec.draft && name in rec.draft) humanValues[name] = rec.draft[name];
    }
    // 计划可填字段与人工保留字段合并：人工值优先，不被代办覆盖。
    const fields = { ...plan.fill };
    const sources = { ...plan.fieldSources };
    for (const [name, value] of Object.entries(humanValues)) {
      if (plan.fill[name] !== undefined) {
        if (String(plan.fill[name]) !== String(value)) {
          plan.blockers.push(`人工修改与来件不一致，已保留人工值：${name}=${value}（来件 ${plan.fill[name]}）`);
        }
        fields[name] = value;
        sources[name] = 'human';
      }
    }
    store.saveDraft(key, fields, sources, plan.blockers);
    await store.save();
    return { plan, fields, sources };
  } finally {
    await driver.close(page);
  }
}

// 递交：计划无阻塞且无已确认回执时才允许。只点击一次，绝不重试。
export async function submit(store, driver, key) {
  const rec = store.get(key);
  if (!rec?.packet) throw new Error(`本地无资料 ${key}，先执行 sync`);

  // 递交前先查回执索引：已确认接收的材料不能重复交。
  const rows = await reconcile(store, driver);
  const existing = rows.find((row) => row.key === key);
  if (existing) {
    return { skipped: true, reason: `门户已有回执 ${existing.receipt}（${existing.state}），禁止重复递交`, receipt: existing };
  }
  if (rec.submission) {
    return { skipped: true, reason: '上一次递交仍在处理中且回执未确认归属，先 recheck，禁止重复递交' };
  }

  const { page, plan } = await inspectPacket(driver, rec.packet);
  try {
    if (plan.blockers.length) {
      store.saveDraft(key, plan.fill, plan.fieldSources, plan.blockers);
      await store.save();
      return { skipped: true, reason: '存在阻塞，仅保存草稿', blockers: plan.blockers, plan };
    }

    // 人工草稿值优先（经办人改过且不冲突的字段继续保留）。
    const humanValues = {};
    for (const [name, source] of Object.entries(rec.fieldSources ?? {})) {
      if (source === 'human' && rec.draft && name in rec.draft) humanValues[name] = rec.draft[name];
    }
    const conflicts = await driver.fillForm(page, plan, humanValues);
    if (conflicts.length) {
      plan.blockers.push(...conflicts);
      store.saveDraft(key, plan.fill, plan.fieldSources, plan.blockers);
      await store.save();
      return { skipped: true, reason: '页面回读冲突，仅保存草稿', blockers: plan.blockers };
    }

    const result = await driver.submit(page);
    if (result.status === 202) {
      const manifest = confirmationManifest(rec.packet, plan);
      store.markSubmission(key, { status: 'processing', branch: plan.branch }, manifest);
      await store.save();
      return { submitted: true, status: 202, message: result.body.message, manifest };
    }
    if (result.status === 409) {
      // 门户先确认了接收：绑定其回执号，本地不重复交。
      await reconcile(store, driver);
      return { skipped: true, status: 409, reason: result.body.message, receipt: result.body.receipt };
    }
    if (result.status === 422) {
      plan.blockers.push(`门户 422：${result.body.message ?? '分支确认未齐'}`);
      store.saveDraft(key, plan.fill, plan.fieldSources, plan.blockers);
      await store.save();
      return { skipped: true, status: 422, reason: '门户判定确认未齐，保留草稿交经办人', blockers: plan.blockers };
    }
    plan.blockers.push(`门户返回未知状态 HTTP ${result.status}，未登记递交，交经办人`);
    store.saveDraft(key, plan.fill, plan.fieldSources, plan.blockers);
    await store.save();
    return { skipped: true, status: result.status, blockers: plan.blockers };
  } finally {
    await driver.close(page);
  }
}

// 列表视图：每份资料当前可安全执行的动作与阻塞原因。
// 传入 driver 时先与门户回执页对账；否则使用 store 中最近一次对账写入的回执。
export async function overview(store, driver) {
  const rows = driver ? await reconcile(store, driver) : [];
  const byKey = new Map(
    rows.map((row) =>
      row.state && !['processing', 'accepted', 'returned', 'unknown'].includes(row.state)
        ? [`${row.case}/${row.fingerprint}`, { ...row, state: receiptStateOf(row.state) }]
        : [`${row.case}/${row.fingerprint}`, row],
    ),
  );
  return store.list().map((rec) => {
    // 优先用本次实时对账行；没有 driver 时回退到 store 已保存的回执（已是内部状态）。
    const receiptRows = byKey.has(rec.key) ? [byKey.get(rec.key)] : rec.receipt ? [rec.receipt] : [];
    const status = evaluate(rec, receiptRows);
    return { key: rec.key, packet: rec.packet, ...status };
  });
}

// 受理号反查：当时按各角色确认的材料清单。
// 代办递交的有完整确认清单；人工递交、代办仅事后登记回执的，明确标注无本地清单。
export function lookupReceipt(store, receiptId) {
  const key = store.state.keys.find((item) => store.state.packets[item].receipt?.receipt === receiptId);
  if (!key) return null;
  const rec = store.get(key);
  const manifest = store.manifest(key);
  return {
    receipt: rec.receipt,
    manifest,
    manifestSource: manifest ? 'agent' : 'external（非代办递交，无本地确认清单，请以门户回执为准）',
    packet: rec.packet,
  };
}

export { packetKey };
