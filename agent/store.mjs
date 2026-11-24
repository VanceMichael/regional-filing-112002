// 代办本地状态：草稿、人工修改、递交尝试、回执缓存。原子写，文件与门户内存数据分离。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = () => ({
  version: 1,
  baseUrl: null,
  packets: {}, // record -> { packet 摘要, humanOverrides, lastDecision, attempts: [], receiptId }
  receipts: {}, // receiptId -> 门户回执快照
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

export class Store {
  constructor(path) {
    this.path = path;
    this.data = EMPTY();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      this.data = { ...EMPTY(), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = EMPTY();
    }
    return this.data;
  }

  async save() {
    this.data.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }

  ensurePacket(record) {
    if (!this.data.packets[record]) {
      this.data.packets[record] = { humanOverrides: {}, attempts: [], receiptId: null, lastDecision: null };
    }
    return this.data.packets[record];
  }

  getPacket(record) {
    return this.data.packets[record] ?? null;
  }

  listPackets() {
    return Object.entries(this.data.packets);
  }

  addAttempt(record, attempt) {
    const entry = this.ensurePacket(record);
    entry.attempts.push({ at: new Date().toISOString(), ...attempt });
  }

  setHumanOverride(record, field, value) {
    const entry = this.ensurePacket(record);
    entry.humanOverrides[field] = value;
  }

  setDecision(record, decision) {
    this.ensurePacket(record).lastDecision = { at: new Date().toISOString(), ...decision };
  }

  setReceipt(record, receiptId) {
    this.ensurePacket(record).receiptId = receiptId;
  }

  cacheReceipt(item) {
    this.data.receipts[item.receipt] = { cachedAt: new Date().toISOString(), ...item };
  }
}
