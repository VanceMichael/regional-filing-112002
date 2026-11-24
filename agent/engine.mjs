// 编排引擎：把策略、浏览器驱动、本地状态和门户回执对账串起来。
import { fetchIntake, indexPackets } from './intake.mjs';
import { PortalBrowser } from './browser.mjs';
import { decide, verifyPortalState, ACTIONS } from './policy.mjs';

export class Engine {
  constructor({ baseUrl, store, headless = true }) {
    this.baseUrl = baseUrl;
    this.store = store;
    this.headless = headless;
  }

  // 拉取当前阶段全部来件，并入本地状态，再与门户回执索引对账。
  async sync() {
    const { records, stage } = await fetchIntake(this.baseUrl);
    this.store.data.baseUrl = this.baseUrl;
    const packets = indexPackets(records);
    for (const [record, packet] of packets) this.store.ensurePacket(record);

    const browser = new PortalBrowser(this.baseUrl, { headless: this.headless });
    await browser.start();
    let index;
    let orgs;
    try {
      ({ orgs } = await browser.readPortalConfig());
      index = await browser.readReceiptIndex();
      for (const item of index.items) this.store.cacheReceipt(item);
    } finally {
      await browser.close();
    }

    const report = [];
    for (const [record, packet] of packets) {
      const entry = this.store.getPacket(record);
      const receipt = index.items.find((item) =>
        item.case === packet.case && item.fingerprint === packet.fingerprint) ?? null;
      if (receipt) entry.receiptId = receipt.receipt;
      const returnedOrigin = index.items.find((item) =>
        item.case === packet.case && item.state === 'returned' &&
        item.fingerprint !== packet.fingerprint) ?? null;
      const decision = decide({
        packet, portalOrgs: orgs, receipt, returnedOrigin,
        humanOverrides: entry.humanOverrides,
      });
      this.store.setDecision(record, {
        action: decision.action, blockers: decision.blockers, receiptState: decision.receiptState,
      });
      report.push({ record, packet, receipt, returnedOrigin, decision, entry });
    }
    await this.store.save();
    return { stage, report };
  }

  // 与 sync 相同的决策构造，但需要门户机构目录（sync 时顺手取一次）。
  async _evaluate(browser, packet) {
    const { orgs } = await browser.readPortalConfig();
    const index = await browser.readReceiptIndex();
    const entry = this.store.ensurePacket(packet.record);
    const receipt = index.items.find((item) =>
      item.case === packet.case && item.fingerprint === packet.fingerprint) ?? null;
    if (receipt) {
      entry.receiptId = receipt.receipt;
      this.store.cacheReceipt(receipt);
    }
    const returnedOrigin = index.items.find((item) =>
      item.case === packet.case && item.state === 'returned' &&
      item.fingerprint !== packet.fingerprint) ?? null;
    const decision = decide({
      packet, portalOrgs: orgs, receipt, returnedOrigin,
      humanOverrides: entry.humanOverrides,
    });
    this.store.setDecision(packet.record, {
      action: decision.action, blockers: decision.blockers, receiptState: decision.receiptState,
    });
    return { decision, receipt, returnedOrigin, index };
  }

  // 填草稿：只写允许代填的字段，任何签署框都不碰。
  async fillDraft(packet) {
    const browser = new PortalBrowser(this.baseUrl, { headless: this.headless });
    await browser.start();
    try {
      const { decision } = await this._evaluate(browser, packet);
      const page = await browser.openFiling();
      try {
        await browser.selectRegion(page, packet.region);
        await browser.fillIdentity(page, packet, decision.selectionPlan);
        await browser.fillFields(page, decision.fillPlan.fills.filter((fill) => !fill.conflict));
        const snapshot = await browser.snapshot(page);
        const expectedValues = Object.fromEntries(
          decision.fillPlan.fills.filter((fill) => !fill.conflict).map((fill) => [fill.field, fill.value]));
        const dirty = verifyPortalState({
          pageSnapshot: snapshot, packet, branch: decision.branch,
          selectionPlan: decision.selectionPlan, expectedValues,
        });
        this.store.addAttempt(packet.record, {
          kind: 'draft', snapshot, blockers: decision.blockers.map((b) => b.code),
        });
        await this.store.save();
        return { ok: dirty.length === 0, decision, snapshot, pageBlockers: dirty };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  // 递交（含补送）。策略未放行、页面状态不干净、门户回 409/422 一律不重试硬交。
  async submit(packet) {
    const browser = new PortalBrowser(this.baseUrl, { headless: this.headless });
    await browser.start();
    try {
      const { decision, returnedOrigin } = await this._evaluate(browser, packet);
      if (!decision.canSubmit) {
        this.store.addAttempt(packet.record, {
          kind: 'submit-blocked', blockers: decision.blockers,
        });
        await this.store.save();
        return { ok: false, reason: 'blocked', decision };
      }
      const page = await browser.openFiling();
      try {
        await browser.selectRegion(page, packet.region);
        await browser.fillIdentity(page, packet, decision.selectionPlan);
        await browser.fillFields(page, decision.fillPlan.fills);

        // 递交前核对页面实际归属与字段值，防止上一单残留被顺手提交。
        const preSnapshot = await browser.snapshot(page);
        const expectedValues = Object.fromEntries(
          decision.fillPlan.fills.map((fill) => [fill.field, fill.value]));
        const dirty = verifyPortalState({
          pageSnapshot: preSnapshot, packet, branch: decision.branch,
          selectionPlan: decision.selectionPlan, expectedValues,
        });
        if (dirty.length) {
          this.store.addAttempt(packet.record, { kind: 'submit-dirty', blockers: dirty });
          await this.store.save();
          return { ok: false, reason: 'page-dirty', pageBlockers: dirty, decision };
        }

        await browser.applySignatures(page, decision.signaturePlan.valid, decision.branch);

        // 补送必须把原退回回执编号一并提交，绑定新确认的申请分支。
        if (decision.action === ACTIONS.SUPPLEMENT) {
          await page.evaluate((receiptId) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'supplementsTo';
            input.value = receiptId;
            document.querySelector('form').appendChild(input);
          }, returnedOrigin.receipt);
        }

        const { reply, output } = await browser.clickSubmit(page);
        this.store.addAttempt(packet.record, {
          kind: 'submit', reply, output, at: new Date().toISOString(),
        });

        if (reply?.message === '处理中') {
          // 当场没有回执号：重开后以门户回执索引为准对账，不自行编号。
          await this.store.save();
          return { ok: true, acceptedForProcessing: true, output, decision };
        }
        if (reply?.receipt) {
          // 门户提示已递交（409）：以门户回执为准，本地不重复交。
          this.store.setReceipt(packet.record, reply.receipt);
          await this.store.save();
          return { ok: false, reason: 'already-submitted', reply, decision };
        }
        await this.store.save();
        return { ok: false, reason: 'rejected', reply, decision };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  // 重开/对账：判断每一次递交当前归属与状态，处理“处理中但其实已受理”的情形。
  async reconcile(packets) {
    const browser = new PortalBrowser(this.baseUrl, { headless: this.headless });
    await browser.start();
    try {
      const index = await browser.readReceiptIndex();
      const results = [];
      for (const item of index.items) this.store.cacheReceipt(item);
      for (const [record, packet] of packets) {
        const entry = this.store.ensurePacket(record);
        const receipt = index.items.find((item) =>
          item.case === packet.case && item.fingerprint === packet.fingerprint) ?? null;
        const attempts = entry.attempts.filter((a) => a.kind === 'submit');
        let status;
        if (receipt) {
          entry.receiptId = receipt.receipt;
          status = { known: true, receipt: receipt.receipt, state: receipt.state, source: 'portal-index' };
        } else if (attempts.length) {
          // 有递交动作但索引暂时查不到：可能仍在处理，也可能页面关闭导致结果未知，禁止重交。
          status = { known: false, state: 'unknown-processing', source: 'local-attempt',
            message: '已递交但门户索引暂未出现回执，保持等待，不得重复递交' };
        } else {
          status = { known: false, state: 'never-submitted', source: 'local' };
        }
        results.push({ record, packet, status });
      }
      await this.store.save();
      return results;
    } finally {
      await browser.close();
    }
  }

  // 从受理号反查当时按各角色确认的材料（读门户回执详情页）。
  async lookup(receiptId) {
    const browser = new PortalBrowser(this.baseUrl, { headless: this.headless });
    await browser.start();
    try {
      const detail = await browser.readReceiptDetail(receiptId);
      this.store.cacheReceipt(detail);
      await this.store.save();
      return detail;
    } finally {
      await browser.close();
    }
  }

  // 经办人手工改字段：登记到本地，后续决策保留人工值并对冲突报阻塞。
    noteHumanEdit(record, field, value) {
    this.store.setHumanOverride(record, field, value);
    return this.store.save();
  }
}
