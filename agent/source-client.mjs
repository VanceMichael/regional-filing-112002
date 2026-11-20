// 从来件服务分页拉取当前阶段可见的资料记录。
export async function fetchIntake(baseUrl, { limit = 100 } = {}) {
  const records = [];
  let offset = 0;
  for (;;) {
    const response = await fetch(`${baseUrl}/source/intake?offset=${offset}&limit=${limit}`);
    if (!response.ok) throw new Error(`来源读取失败 HTTP ${response.status}`);
    const page = await response.json();
    records.push(...page.records);
    if (page.next === null) break;
    offset = page.next;
  }
  return records;
}

export async function currentStage(baseUrl) {
  const response = await fetch(baseUrl);
  if (!response.ok) throw new Error(`来源概览读取失败 HTTP ${response.status}`);
  return (await response.json()).stage;
}
