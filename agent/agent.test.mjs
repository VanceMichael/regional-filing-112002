import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { makePortal } from '../portal.mjs';
import { start, sendJson } from '../source-server.mjs';
import { Store } from './store.mjs';
import { withDriver, sync, reconcile, draft, submit, overview, lookupReceipt } from './orchestrator.mjs';

let server;
let baseUrl;
let browser;
let tempDir;

// 门户的受理记录存在服务进程内，每个测试重启一个全新门户，避免相互污染。
async function restartPortal() {
  if (server) await new Promise((resolve) => server.close(resolve));
  const app = await start({ portal: makePortal(sendJson) });
  server = app.server;
  baseUrl = app.url;
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  tempDir = await mkdtemp(join(tmpdir(), 'agent-e2e-'));
  await restartPortal();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

const newStore = () => new Store(join(tempDir, `state-${Math.random().toString(36).slice(2)}.json`));

const setStage = async (stage) => {
  const response = await fetch(`${baseUrl}/control?stage=${stage}`, { method: 'POST' });
  assert.equal(response.status, 200);
};

beforeEach(async () => {
  await restartPortal();
  await setStage(1);
});

test('阶段1：本地单可递交；跨区单因声明跨分支与缺联络人签署被阻塞，且不会误勾任何签署格', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();

  await withDriver(baseUrl, async (driver) => {
    const local = await submit(store, driver, 'D-21/A-27');
    assert.equal(local.submitted, true);
    assert.equal(local.status, 202);
    assert.equal(local.manifest.branch, '国内-R1');
    assert.deepEqual(local.manifest.confirmations.map((item) => item.role), ['素材权利人']);

    const blocked = await submit(store, driver, 'D-22/A-28');
    assert.equal(blocked.skipped, true);
    assert.ok(blocked.blockers.some((text) => text.includes('不得跨分支复用')));
    assert.ok(blocked.blockers.some((text) => text.includes('跨区联络人')));
  });

  // 门户侧只应有 D-21/A-27 一条递交，D-22/A-28 绝未被提交。
  const rows = await withDriver(baseUrl, (driver) => driver.readReceipts());
  assert.deepEqual(rows.map((row) => row.key ?? `${row.case}/${row.fingerprint}`), ['D-21/A-27']);
});

test('在途未确认：本地已点递交但回执索引暂查不到时，重开只允许对账、禁止重复交', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  // 模拟页面关闭后回执索引尚未可查：本地有在途记录，门户回执为空。
  const rec = store.get('D-21/A-27');
  rec.submission = { status: 'processing', branch: '国内-R1', at: new Date().toISOString() };
  await store.save();

  await withDriver(baseUrl, async (driver) => {
    const items = await overview(store, driver);
    const status = items.find((item) => item.key === 'D-21/A-27');
    assert.equal(status.state, 'uncertain');
    assert.deepEqual(status.actions, ['recheck']);
    assert.ok(status.blockers.some((text) => text.includes('禁止重复递交')));

    const attempt = await submit(store, driver, 'D-21/A-27');
    assert.equal(attempt.skipped, true);
    assert.match(attempt.reason, /禁止重复递交/);
    // 门户侧确实没有产生新递交
    assert.deepEqual(await driver.readReceipts(), []);
  });
});

test('门户先确认接收：前置对账拦截重复递交并绑定回执，不产生重复件', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  // 先经人工在门户递交一次
  await withDriver(baseUrl, async (driver) => {
    const page = await driver.newPage();
    await driver.selectRegion(page, '本地');
    await page.getByLabel('申请编号').fill('D-21');
    await page.getByLabel('材料指纹').fill('A-27');
    await page.getByLabel('主申请人').selectOption('ORG-02');
    await page.getByLabel('素材权利人', { exact: true }).selectOption('ORG-03');
    await page.getByLabel('资料名称').fill('林道影像');
    await page.getByLabel('镜头数量').fill('18');
    await page.getByLabel('素材权利人已签署').check();
    await driver.submit(page);
    await driver.close(page);

    // 代办递交前先对账，发现门户已确认接收：直接拦截，不发出第二次提交
    const result = await submit(store, driver, 'D-21/A-27');
    assert.equal(result.skipped, true);
    assert.match(result.reason, /禁止重复递交/);
    assert.equal(result.receipt.receipt, 'SL-101');
    const rows = await driver.readReceipts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].receipt, 'SL-101');
  });
});

test('竞态兜底：点击后门户回 409 时绑定回执而非重试（桩驱动验证响应处理）', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  const packet = store.get('D-21/A-27').packet;
  // 桩驱动：模拟对账为空（点击前尚不可查）、点击后门户返回 409。
  const stubDriver = {
    readReceipts: async () => [],
    newPage: async () => ({}),
    readOptions: async () => [
      { value: 'ORG-02', label: '远帆（ORG-02）' },
      { value: 'ORG-03', label: '远帆（ORG-03）' },
      { value: 'ORG-07', label: '协作站（ORG-07）' },
    ],
    selectRegion: async () => ({ branch: '国内-R1', visibleFields: ['title', 'count'], checkboxes: ['holderSigned'] }),
    readSnapshot: async () => ({ branch: '国内-R1', visibleFields: ['title', 'count'], checkboxes: ['holderSigned'] }),
    fillForm: async () => [],
    submit: async () => ({ status: 409, body: { message: '该材料已递交，请查回执', receipt: 'SL-101' } }),
    close: async () => {},
  };
  const { submit: submitPacket } = await import('./orchestrator.mjs');
  const result = await submitPacket(store, stubDriver, 'D-21/A-27');
  assert.equal(result.skipped, true);
  assert.equal(result.status, 409);
  assert.equal(result.receipt, 'SL-101');
  assert.ok(packet.case === 'D-21'); // 来件未被改动
});

test('重开对账：处理中 -> 阶段推进后已受理；已受理材料重复递交被拒绝并绑定回执', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  await withDriver(baseUrl, (driver) => submit(store, driver, 'D-21/A-27'));

  // 重开（新 Store 实例模拟进程重启，状态来自磁盘）
  const reopened = new Store(store.path);
  await reopened.load();
  await withDriver(baseUrl, async (driver) => {
    let items = await overview(reopened, driver);
    const processing = items.find((item) => item.key === 'D-21/A-27');
    assert.equal(processing.state, 'processing');
    assert.deepEqual(processing.actions, ['recheck']);

    await setStage(2);
    // 进程重开：磁盘上的旧状态仍是处理中，不带 driver 时如实反映上次对账结果
    const reopened2 = new Store(reopened.path);
    await reopened2.load();
    const stale = await overview(reopened2, null);
    assert.equal(stale.find((item) => item.key === 'D-21/A-27').state, 'processing');

    // 经办人执行 recheck 与门户对账：第一次对账就必须读到已受理（回归在途误判 uncertain）
    const rows = await reconcile(reopened2, driver);
    assert.equal(rows[0].state, '已受理');
    items = await overview(reopened2, null);
    assert.equal(items.find((item) => item.key === 'D-21/A-27').state, 'accepted');

    items = await overview(reopened, driver);
    assert.equal(items.find((item) => item.key === 'D-21/A-27').state, 'accepted');

    // 已接收材料不能重复交
    const again = await submit(reopened, driver, 'D-21/A-27');
    assert.equal(again.skipped, true);
    assert.match(again.reason, /禁止重复递交/);
  });
});

test('回执反查：受理号能查到当时按各角色确认的材料与字段归属', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  await withDriver(baseUrl, (driver) => submit(store, driver, 'D-21/A-27'));
  await setStage(2);
  await withDriver(baseUrl, (driver) => reconcile(store, driver));

  const found = lookupReceipt(store, 'SL-101');
  assert.ok(found);
  assert.equal(found.manifest.fingerprint, 'A-27');
  assert.deepEqual(found.manifest.participants, [
    { role: '主申请人', org: 'ORG-02', alias: '远帆' },
    { role: '素材权利人', org: 'ORG-03', alias: '远帆' },
    { role: '跨区联络人', org: 'ORG-07', alias: '协作站' },
  ]);
  assert.equal(found.manifest.fields.title.source, 'agent');
});

test('阶段3补正单：新指纹 A-29 按跨区-R2 新分支递交，与已退回的 A-28 互不覆盖', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();

  // 先模拟 A-28 被人工递交并在阶段3退回（门户要求联络资料）。
  await withDriver(baseUrl, async (driver) => {
    const page = await driver.newPage();
    await driver.selectRegion(page, '跨区');
    await page.getByLabel('申请编号').fill('D-22');
    await page.getByLabel('材料指纹').fill('A-28');
    await page.getByLabel('主申请人').selectOption('ORG-03');
    await page.getByLabel('素材权利人', { exact: true }).selectOption('ORG-02');
    await page.locator('select[name="liaison"]').selectOption('ORG-07');
    await page.getByLabel('资料名称').fill('馆藏镜头');
    await page.getByLabel('镜头数量').fill('13');
    await page.getByLabel('跨区联络资料').fill('桥站');
    await page.getByLabel('素材权利人已签署').check();
    await page.getByLabel('跨区联络人已签署').check();
    await driver.submit(page);
    await driver.close(page);
  });

  await setStage(3);
  const synced = await sync(store, baseUrl); // A-29 在阶段3才可见
  assert.equal(synced.count, 3);
  await store.save();

  await withDriver(baseUrl, async (driver) => {
    const rows = await reconcile(store, driver);
    const a28 = rows.find((row) => row.fingerprint === 'A-28');
    assert.equal(a28.state, '退回补正联络资料');
    const a28Status = (await overview(store, driver)).find((item) => item.key === 'D-22/A-28');
    assert.equal(a28Status.state, 'returned');
    assert.ok(a28Status.blockers.some((text) => text.includes('禁止按原键重交')));

    // 补正材料绑定新确认的申请分支（新指纹 A-29，跨区-R2）
    const correction = await submit(store, driver, 'D-22/A-29');
    assert.equal(correction.submitted, true);
    assert.equal(correction.manifest.branch, '跨区-R2');
    assert.deepEqual(correction.manifest.confirmations.map((item) => item.role).sort(), [
      '素材权利人',
      '跨区联络人',
    ]);
  });

  // 两条索引并存：A-28 退回凭据仍有效，A-29 为新受理分支
  const rows = await withDriver(baseUrl, (driver) => driver.readReceipts());
  const fingerprints = rows.map((row) => row.fingerprint).sort();
  assert.deepEqual(fingerprints, ['A-28', 'A-29']);
});

test('人工修改草稿：保留人工值与不冲突字段，冲突转经办人；代办不覆盖人工输入', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();

  await withDriver(baseUrl, async (driver) => {
    const result = await draft(store, driver, 'D-21/A-27');
    assert.equal(result.fields.title, '林道影像');

    // 经办人人工改标题
    assert.ok(store.markHumanEdit('D-21/A-27', 'title', '林道影像（修订）'));
    await store.save();

    const again = await draft(store, driver, 'D-21/A-27');
    assert.equal(again.fields.title, '林道影像（修订）'); // 人工值保留
    assert.equal(again.sources.title, 'human');
    assert.equal(again.fields.count, '18'); // 无冲突字段继续保留
    assert.ok(again.plan.blockers.some((text) => text.includes('人工修改与来件不一致')));
  });
});

test('每份资料使用独立页面：跨区单的签署状态不会串到后续本地单', async () => {
  const store = newStore();
  await sync(store, baseUrl);
  await store.save();
  await withDriver(baseUrl, async (driver) => {
    // 先碰跨区单（被阻塞，只存草稿）
    const blocked = await submit(store, driver, 'D-22/A-28');
    assert.equal(blocked.skipped, true);
    // 再办本地单，页面为全新打开，holderSigned 初始必须未勾选，由计划单独勾选
    const local = await submit(store, driver, 'D-21/A-27');
    assert.equal(local.submitted, true);
    const row = (await driver.readReceipts()).find((item) => item.fingerprint === 'A-27');
    assert.equal(row.branch, '国内-R1');
  });
});
