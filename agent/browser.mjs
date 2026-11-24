// 浏览器驱动：代办的一切门户操作都经由真实网页完成，不直接调门户内部接口。
import { chromium } from 'playwright';

export class PortalBrowser {
  constructor(baseUrl, { headless = true } = {}) {
    this.baseUrl = baseUrl;
    this.headless = headless;
    this.browser = null;
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless });
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
  }

  // 读取页面内嵌的机器可读数据（机构目录、分支定义）。隐藏 script 直接走 DOM 求值。
  async _island(page, id) {
    await page.waitForFunction((target) => document.getElementById(target) !== null, id);
    return page.$eval(`#${id}`, (el) => JSON.parse(el.textContent));
  }

  async readPortalConfig() {
    const page = await this.browser.newPage();
    try {
      await page.goto(`${this.baseUrl}/filing`);
      // 必须先 await 再 return，否则 finally 的 close 会在页面求值前关闭它。
      const orgs = await this._island(page, 'portal-orgs');
      const branches = await this._island(page, 'portal-branches');
      return { orgs, branches };
    } finally {
      await page.close();
    }
  }

  // 抓取页面表单的实际状态：归属地、分支、机构选择、勾选框、关键字段。
  async snapshot(page) {
    return page.evaluate(() => {
      const form = document.querySelector('form');
      const elements = form.elements;
      return {
        region: elements.region.value,
        branch: document.querySelector('#branch').textContent,
        case: elements.case.value,
        fingerprint: elements.fingerprint.value,
        selections: {
          applicant: elements.applicant.value,
          holder: elements.holder.value,
          liaison: elements.liaison.value,
        },
        fields: {
          title: elements.title.value,
          count: elements.count.value,
          contact: elements.contact ? elements.contact.value : null,
        },
        signedBoxes: {
          holderSigned: elements.holderSigned.checked,
          liaisonSigned: elements.liaisonSigned ? elements.liaisonSigned.checked : false,
        },
      };
    });
  }

  async openFiling() {
    const page = await this.browser.newPage();
    await page.goto(`${this.baseUrl}/filing`);
    await page.getByText('国内-R1', { exact: true }).waitFor();
    return page;
  }

  // 切换归属地并等待确认格刷新完成。
  async selectRegion(page, region) {
    await page.getByLabel('登记地区').selectOption(region);
    const expected = region === '跨区' ? '跨区-R2' : '国内-R1';
    await page.getByText(expected, { exact: true }).waitFor();
    if (region === '跨区') await page.getByLabel('跨区联络资料').waitFor();
  }

  async fillIdentity(page, packet, selectionPlan) {
    await page.getByLabel('申请编号').fill(packet.case);
    await page.getByLabel('材料指纹').fill(packet.fingerprint);
    // 下拉框与签署复选框的可访问名称可能互相包含，按 select 字段名精确定位。
    for (const [field, plan] of Object.entries(selectionPlan.selections)) {
      await page.locator(`select[name="${field}"]`).selectOption(plan.orgId);
    }
  }

  // 只填字段，不碰任何签署勾选框——草稿永远不代替角色签署。
  async fillFields(page, fills) {
    const labels = { title: '资料名称', count: '镜头数量', contact: '跨区联络资料' };
    for (const { field, value } of fills) {
      await page.getByLabel(labels[field]).fill(String(value));
    }
  }

  // 仅当策略引擎确认存在有效签署时才允许勾选确认格。
  async applySignatures(page, validSignatures, branch) {
    const byRole = new Map(validSignatures.map((item) => [item.role, item]));
    if (byRole.has('素材权利人')) {
      await page.getByLabel('素材权利人已签署').check();
    }
    if (branch.cross && byRole.has('跨区联络人')) {
      await page.getByLabel('跨区联络人已签署').check();
    }
  }

  async clickSubmit(page) {
    await page.getByRole('button', { name: '递交' }).click();
    await page.locator('#last-submit').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#last-submit').textContent !== 'null');
    const reply = await this._island(page, 'last-submit');
    const output = await page.locator('output').textContent();
    return { reply, output };
  }

  // 从递交查询页读取回执索引（受理后才能查到编号，草稿期可能还没有）。
  async readReceiptIndex() {
    const page = await this.browser.newPage();
    try {
      await page.goto(`${this.baseUrl}/filing/receipts`);
      return await this._island(page, 'receipt-index');
    } finally {
      await page.close();
    }
  }

  async readReceiptDetail(receiptId) {
    const page = await this.browser.newPage();
    try {
      await page.goto(`${this.baseUrl}/filing/receipts/${encodeURIComponent(receiptId)}`);
      return await this._island(page, 'receipt-detail');
    } finally {
      await page.close();
    }
  }
}
