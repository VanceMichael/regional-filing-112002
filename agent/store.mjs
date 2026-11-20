// 代办的本地持久化：草稿、递交在途记录、确认清单、对账结果。
// 原子写入，避免重开时读到半截文件。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { packetKey } from './policy.mjs';

const emptyState = () => ({ version: 1, baseUrl: null, packets: {}, keys: [], manifests: {} });

export class Store {
  constructor(path) {
    this.path = path;
    this.state = emptyState();
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.path, 'utf8'));
      if (!this.state.packets || !Array.isArray(this.state.keys)) this.state = emptyState();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = emptyState();
    }
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.path);
  }

  #ensureKey(key) {
    if (!this.state.packets[key]) {
      this.state.packets[key] = { key, draft: null, planBlockers: [] };
      this.state.keys.push(key);
    }
  }

  // 同步来件：保留草稿等本地状态，更新 packet 内容与来源 record 键。
  syncPacket(record) {
    const packet = record.payload;
    const key = packetKey(packet);
    this.#ensureKey(key);
    this.state.packets[key].packet = packet;
    this.state.packets[key].record = record.record;
    this.state.packets[key].availableFrom = record.availableFrom;
    return this.state.packets[key];
  }

  get(key) {
    return this.state.packets[key] ?? null;
  }

  list() {
    return this.state.keys.map((key) => this.state.packets[key]);
  }

  saveDraft(key, fields, fieldSources, blockers) {
    const rec = this.state.packets[key];
    if (!rec) throw new Error(`未知资料 ${key}`);
    rec.draft = { ...fields };
    rec.fieldSources = { ...fieldSources };
    rec.planBlockers = [...blockers];
    rec.updatedAt = new Date().toISOString();
  }

  // 人工改动草稿字段：保留来源标记，供 reconcile 判断。
  markHumanEdit(key, field, value) {
    const rec = this.state.packets[key];
    if (!rec?.draft) return false;
    rec.draft[field] = value;
    rec.fieldSources = { ...(rec.fieldSources ?? {}), [field]: 'human' };
    rec.updatedAt = new Date().toISOString();
    return true;
  }

  markSubmission(key, submission, manifest) {
    const rec = this.state.packets[key];
    if (!rec) throw new Error(`未知资料 ${key}`);
    rec.submission = { ...submission, at: new Date().toISOString() };
    rec.planBlockers = [];
    this.state.manifests[key] = manifest;
  }

  // 回执对账：把门户实际确认的归属与状态写回。
  reconcile(key, receipt) {
    const rec = this.state.packets[key];
    if (!rec) return;
    if (receipt) {
      rec.receipt = { ...receipt, at: new Date().toISOString() };
      if (rec.submission && receipt.receipt) rec.submission.receipt = receipt.receipt;
    }
  }

  // 门户先于本地确认（如人工已递交）：仍登记回执索引，便于反查。
  rememberExternalReceipt(key, packet, receipt) {
    if (!this.state.packets[key]) {
      this.state.packets[key] = { key, packet, draft: null, planBlockers: [] };
      this.state.keys.push(key);
    }
    this.state.packets[key].receipt = { ...receipt, at: new Date().toISOString() };
  }

  manifest(key) {
    return this.state.manifests[key] ?? null;
  }
}
