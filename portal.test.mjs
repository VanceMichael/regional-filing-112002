import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { makePortal } from './portal.mjs';
import { start } from './source-server.mjs';

test('实际浏览器刷新登记分支并从查询页读到受理回执', async (t) => {
  const { server, url } = await start({ portal: makePortal() });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url + '/filing');
  await page.getByText('国内-R1', { exact: true }).waitFor();
  await page.getByLabel('登记地区').selectOption('跨区');
  await page.getByText('跨区-R2', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('跨区联络资料').count(), 1);
  await page.getByLabel('登记地区').selectOption('本地');
  await page.getByText('国内-R1', { exact: true }).waitFor();
  for (const [label, value] of [['申请编号','D-21'],['材料指纹','A-27'],['资料名称','林道影像'],['镜头数量','18']]) {
    await page.getByLabel(label).fill(value);
  }
  await page.getByLabel('主申请人').selectOption('ORG-02');
  await page.getByLabel('素材权利人', { exact: true }).selectOption('ORG-03');
  await page.getByLabel('素材权利人已签署').check();
  await page.getByRole('button', { name: '递交' }).click();
  await page.getByText('处理中', { exact: true }).waitFor();
  await page.getByRole('link', { name: '递交查询' }).click();
  await page.getByRole('cell', { name: '处理中' }).waitFor();
  await fetch(url + '/control?stage=2', { method: 'POST' });
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: 'D-21' });
  await row.getByRole('cell', { name: '已受理' }).waitFor();
  assert.match(await row.innerText(), /A-27.*国内-R1.*SL-101.*已受理.*ORG-03/s);
});
