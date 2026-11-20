// 门户的浏览器驱动。门户只能网页操作，所有动作经 Playwright 真实点击/填写完成。
// 安全要点：
//  - 每份资料使用全新页面，杜绝上一份的勾选/分支状态串单；
//  - 机构只按 <option value> 的统一编号选择，并回读确认；
//  - 切换地区后等待门户实际渲染出分支名与字段集，再据实时快照生成计划；
//  - 签署格只在计划明确给出时勾选，勾选发生在最后一次分支渲染之后。

export class PortalDriver {
  constructor(browser, baseUrl) {
    this.browser = browser;
    this.baseUrl = baseUrl;
  }

  async newPage() {
    const page = await this.browser.newPage();
    await page.goto(this.baseUrl + '/filing');
    await page.waitForSelector('#branch');
    return page;
  }

  // 读取统一编号下拉项：{ value, label }，label 含门户显示名。
  async readOptions(page) {
    return page.$$eval('select[name="applicant"] option', (nodes) =>
      nodes
        .map((node) => ({ value: node.value, label: node.textContent.trim() }))
        .filter((option) => option.value),
    );
  }

  // 读取门户当前确认的分支与实际显示的字段/签署格。
  async readSnapshot(page) {
    await page.waitForFunction(() => document.querySelector('#branch')?.textContent);
    return page.evaluate(() => {
      const visibleInput = (name) => {
        const node = document.querySelector(`[name="${name}"]`);
        if (!node) return false;
        return !node.closest('fieldset[hidden]') && node.offsetParent !== null;
      };
      const businessNames = ['title', 'count', 'contact'];
      return {
        branch: document.querySelector('#branch').textContent.trim(),
        visibleFields: businessNames.filter(visibleInput),
        checkboxes: [...document.querySelectorAll('form input[type=checkbox]')]
          .filter((node) => node.offsetParent !== null)
          .map((node) => node.name),
      };
    });
  }

  // 切换登记地区并等待门户分支刷新完成（以页面上的分支名变化为准）。
  // 即使目标地区与当前相同，也以重新读取到的实时快照为准。
  async selectRegion(page, region) {
    await page.getByLabel('登记地区').selectOption(region);
    await page.waitForFunction(
      (expected) => document.querySelector('#branch').textContent.trim() === expected,
      region === '跨区' ? '跨区-R2' : '国内-R1',
    );
    await page.waitForLoadState('networkidle');
    return this.readSnapshot(page);
  }

  async selectOrg(page, selectName, orgId, options) {
    const option = options.find((item) => item.value === orgId);
    if (!option) throw new Error(`下拉项缺少统一编号 ${orgId}`);
    const locator = page.locator(`select[name="${selectName}"]`);
    await locator.selectOption(orgId);
    if ((await locator.inputValue()) !== orgId) {
      throw new Error(`统一编号 ${orgId} 选择后回读不一致`);
    }
  }

  // 按计划填表；humanValues 是经办人人工修改的字段，优先于来件值且不被覆盖。
  // 返回回读冲突列表。
  async fillForm(page, plan, humanValues = {}) {
    const conflicts = [];
    await page.getByLabel('申请编号').fill(plan.caseValue);
    await page.getByLabel('材料指纹').fill(plan.fingerprintValue);
    for (const [selectName, orgId] of Object.entries(plan.selections)) {
      const options = await this.readOptions(page);
      await this.selectOrg(page, selectName, orgId, options);
    }
    for (const [name, planned] of Object.entries(plan.fill)) {
      const value = Object.prototype.hasOwnProperty.call(humanValues, name) ? humanValues[name] : planned;
      if (value === undefined || value === '') {
        conflicts.push(`字段 ${name} 无可填值（人工草稿为空），保留给经办人`);
        continue;
      }
      const locator = page.locator(`[name="${name}"]`);
      await locator.fill(String(value));
      const actual = await locator.inputValue();
      if (actual !== String(value)) conflicts.push(`字段 ${name} 回读不一致：期望 ${value}，实际 ${actual}`);
    }
    // 所有填写完成、且分支已最终确定后，才处理签署格。
    for (const { checkbox } of plan.checks) {
      const locator = page.locator(`input[type=checkbox][name="${checkbox}"]`);
      await locator.waitFor({ state: 'visible' });
      await locator.check();
      if (!(await locator.isChecked())) throw new Error(`签署格 ${checkbox} 勾选失败`);
    }
    // 反向确认：门户上任何未在计划中的签署格都不得被勾选。
    const snapshot = await this.readSnapshot(page);
    for (const name of snapshot.checkboxes) {
      const checked = await page.locator(`input[type=checkbox][name="${name}"]`).isChecked();
      const planned = plan.checks.some((item) => item.checkbox === name);
      if (checked && !planned) conflicts.push(`签署格 ${name} 出现计划外勾选，已停止`);
    }
    return conflicts;
  }

  // 点击递交并捕获门户响应。绝不重试，避免重复交件。
  async submit(page) {
    const [response] = await Promise.all([
      page.waitForResponse((item) => item.url().includes('/filing/submit')),
      page.getByRole('button', { name: '递交' }).click(),
    ]);
    const body = await response.json().catch(() => ({}));
    return { status: response.status(), body };
  }

  // 解析回执查询页：申请/指纹/分支/回执号/状态/权利人统一编号。
  async readReceipts() {
    const page = await this.browser.newPage();
    try {
      await page.goto(this.baseUrl + '/filing/receipts');
      await page.waitForSelector('table');
      return await page.$$eval('tbody tr', (rows) =>
        rows.map((row) => {
          const cell = row.querySelectorAll('td');
          return {
            case: cell[0].textContent.trim(),
            fingerprint: cell[1].textContent.trim(),
            branch: cell[2].textContent.trim(),
            receipt: cell[3].textContent.trim(),
            state: cell[4].textContent.trim(),
            holder: cell[5].textContent.trim(),
          };
        }),
      );
    } finally {
      await page.close();
    }
  }

  async close(page) {
    await page.close();
  }
}
