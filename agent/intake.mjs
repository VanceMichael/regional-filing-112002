// 从演练来源分页拉取来件资料（只读）。
export async function fetchIntake(baseUrl, { limit = 100 } = {}) {
  const records = [];
  let offset = 0;
  for (;;) {
    const response = await fetch(`${baseUrl}/source/intake?offset=${offset}&limit=${limit}`);
    if (!response.ok) {
      throw new Error(`来源拉取失败 ${response.status}: ${await response.text()}`);
    }
    const page = await response.json();
    records.push(...page.records);
    if (page.next === null) return { records, stage: page.stage };
    offset = page.next;
  }
}

// 记录键 -> 资料。同一申请可在不同阶段出现不同指纹（新分支/补送）。
export function indexPackets(records) {
  const packets = new Map();
  for (const entry of records) {
    if (entry.kind !== 'packet') continue;
    packets.set(entry.record, { record: entry.record, availableFrom: entry.availableFrom, ...entry.payload });
  }
  return packets;
}
