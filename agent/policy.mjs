// 代办的纯业务规则：不依赖浏览器、文件系统，全部可单测。
// 来件 packet 结构见 source-data/intake.json：
// { case, region, fingerprint, participants:[[角色,统一编号,简称]], fields, delegates, signatures }

export const BUSINESS_FIELDS = ['title', 'count', 'contact'];

// 门户表单上的角色 -> 控件名。checkbox 在门户不存在时不能代签。
export const ROLE_CONTROLS = [
  { role: '主申请人', select: 'applicant', checkbox: null, when: 'always' },
  { role: '素材权利人', select: 'holder', checkbox: 'holderSigned', when: 'always' },
  { role: '跨区联络人', select: 'liaison', checkbox: 'liaisonSigned', when: 'cross' },
];

export const packetKey = (packet) => `${packet.case}/${packet.fingerprint}`;

export const branchForRegion = (region) => (region === '跨区' ? '跨区-R2' : '国内-R1');

export const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

// 门户回执页的中文状态 -> 代办内部状态
export const RECEIPT_STATES = {
  处理中: 'processing',
  已受理: 'accepted',
};
export const receiptStateOf = (text) =>
  text.startsWith('退回') ? 'returned' : (RECEIPT_STATES[text] ?? 'unknown');

// 依据门户当前可选项，解析来件各角色的统一编号。
// 返回 { selections: {selectName: orgId}, blockers: [] }
export function resolveParticipants(packet, options, cross) {
  const selections = {};
  const blockers = [];
  const byRole = new Map(packet.participants.map(([role, org, alias]) => [role, { org, alias }]));
  const optionIds = options.map((option) => option.value);
  for (const control of ROLE_CONTROLS) {
    if (control.when === 'cross' && !cross) continue;
    const participant = byRole.get(control.role);
    if (!participant) {
      blockers.push(`缺少角色：${control.role}`);
      continue;
    }
    if (optionIds.includes(participant.org)) {
      selections[control.select] = participant.org;
      continue;
    }
    // 统一编号在门户找不到时，检查是否落入同名机构歧义。
    const sameAlias = options.filter((option) => option.label.includes(participant.alias));
    if (sameAlias.length > 1) {
      blockers.push(
        `角色歧义：${control.role} 来件简称「${participant.alias}」在门户对应 ${sameAlias
          .map((option) => option.label)
          .join('、')}，来件统一编号 ${participant.org} 不在选项中，需经办人确认`,
      );
    } else {
      blockers.push(`门户缺少统一编号 ${participant.org}（${control.role}），需经办人处理`);
    }
  }
  return { selections, blockers };
}

// 校验一份已签署声明能否用于当前页面。
// 条件：材料指纹一致、分支一致（同名声明也不得跨分支复用）、
// 字段集合与当前分支显示的字段集合完全一致、签署机构与来件角色归属一致、门户有对应签署格。
export function validateSignature(signature, packet, branch, fieldSet, availableCheckboxes) {
  const control = ROLE_CONTROLS.find((item) => item.role === signature.role);
  if (!control || !control.checkbox || !availableCheckboxes.includes(control.checkbox)) {
    return { ok: false, reason: `门户没有「${signature.role}」的签署格，无法代为确认` };
  }
  const participant = packet.participants.find(([role]) => role === signature.role);
  if (!participant || participant[1] !== signature.org) {
    return { ok: false, reason: `${signature.role} 签署机构 ${signature.org} 与来件角色归属不符` };
  }
  if (signature.fingerprint !== packet.fingerprint) {
    return { ok: false, reason: '声明绑定的材料指纹与本来件不一致（材料版本已变化）' };
  }
  if (signature.branch !== branch) {
    return { ok: false, reason: `声明绑定分支 ${signature.branch}，当前门户分支为 ${branch}，同名声明不得跨分支复用` };
  }
  if (!sameSet([...signature.fields].sort(), [...fieldSet].sort())) {
    return { ok: false, reason: `声明确认字段 [${signature.fields}] 与当前分支显示字段 [${fieldSet}] 不一致` };
  }
  return { ok: true, checkbox: control.checkbox };
}

// 依据来件与门户实时快照，生成一份递交计划。计划为空阻塞时才允许递交。
// snapshot: { branch, visibleFields: [控件名], checkboxes: [勾选框名] }
export function planSubmission(packet, snapshot, options) {
  const cross = packet.region === '跨区';
  const expectedBranch = branchForRegion(packet.region);
  const blockers = [];
  const fieldSet = BUSINESS_FIELDS.filter((name) => snapshot.visibleFields.includes(name));

  if (snapshot.branch !== expectedBranch) {
    blockers.push(`门户实际分支 ${snapshot.branch} 与归属地应得分支 ${expectedBranch} 不符`);
  }

  const { selections, blockers: roleBlockers } = resolveParticipants(packet, options, cross);
  blockers.push(...roleBlockers);

  // 只代填来件 delegates 明确授权、且当前分支页面实际显示的字段。
  const fill = {};
  const fieldSources = {};
  for (const name of packet.delegates ?? []) {
    if (!(name in (packet.fields ?? {}))) {
      blockers.push(`授权代填字段 ${name} 在来件中缺值`);
    } else if (!snapshot.visibleFields.includes(name)) {
      blockers.push(`授权字段 ${name} 不在当前分支页面显示，不能代填`);
    } else {
      fill[name] = String(packet.fields[name]);
      fieldSources[name] = 'agent';
    }
  }
  // 当前分支要求填写、但代办未获授权的字段，必须留给经办人。
  for (const name of fieldSet) {
    if (!(name in fill)) blockers.push(`字段 ${name} 未获授权代填，需经办人处理`);
  }

  // 门户必填的签署格，逐格匹配有效声明；绝不在缺少有效声明时勾选。
  const checks = [];
  const requiredRoles = ROLE_CONTROLS.filter(
    (item) => item.checkbox && (item.when === 'always' || cross),
  );
  for (const control of requiredRoles) {
    const signature = (packet.signatures ?? []).find((item) => item.role === control.role);
    if (!signature) {
      blockers.push(`缺少「${control.role}」针对当前分支与材料版本的签署`);
      continue;
    }
    const result = validateSignature(signature, packet, snapshot.branch, fieldSet, snapshot.checkboxes);
    if (!result.ok) blockers.push(`「${control.role}」声明不可用：${result.reason}`);
    else checks.push({ checkbox: result.checkbox, signature });
  }

  // 来件里带了门户无法落格的声明，也要提示，不能静默丢弃。
  for (const signature of packet.signatures ?? []) {
    const control = ROLE_CONTROLS.find((item) => item.role === signature.role);
    if (!control || !control.checkbox || !snapshot.checkboxes.includes(control.checkbox)) {
      blockers.push(`来件含「${signature.role}」声明，但门户无对应签署格，需经办人处理`);
    }
  }

  return {
    key: packetKey(packet),
    region: packet.region,
    branch: snapshot.branch,
    expectedBranch,
    fieldSet,
    selections,
    fill,
    fieldSources,
    checks,
    blockers,
  };
}

// 递交时点的确认清单：回执反查时，说明各角色当时确认了什么。
export function confirmationManifest(packet, plan) {
  return {
    key: plan.key,
    case: packet.case,
    fingerprint: packet.fingerprint,
    branch: plan.branch,
    fieldSet: [...plan.fieldSet],
    participants: packet.participants.map(([role, org, alias]) => ({ role, org, alias })),
    fields: Object.fromEntries(
      Object.entries(plan.fill).map(([name, value]) => [name, { value, source: plan.fieldSources[name] }]),
    ),
    confirmations: plan.checks.map(({ checkbox, signature }) => ({
      checkbox,
      role: signature.role,
      org: signature.org,
      branch: signature.branch,
      fields: [...signature.fields],
      fingerprint: signature.fingerprint,
    })),
  };
}

// 本地状态 + 门户回执行 -> 资料当前状态、可安全执行动作与阻塞原因（纯函数，便于单测）。
// receiptRows 的 state 可为门户中文原文，也可为 receiptStateOf 归一化后的内部状态。
export function evaluate(rec, receiptRows) {
  const receipt = receiptRows.find((row) => row.key === rec.key);
  const blockers = [...(rec.planBlockers ?? [])];
  if (receipt) {
    const state = ['processing', 'accepted', 'returned', 'unknown'].includes(receipt.state)
      ? receipt.state
      : receiptStateOf(receipt.state);
    if (state === 'accepted') {
      // 门户实际确认的统一编号必须与来件相符，不符就是冲突，交经办人。
      const holder = rec.packet?.participants?.find(([role]) => role === '素材权利人');
      if (holder && receipt.holder && receipt.holder !== holder[1]) {
        blockers.push(`冲突：门户回执权利人 ${receipt.holder} 与来件 ${holder[1]} 不一致`);
        return { state: 'conflict', actions: ['manual-review'], blockers };
      }
      return { state: 'accepted', receipt, actions: ['receipt-lookup'], blockers };
    }
    if (state === 'returned') {
      blockers.push('已退回补正：原受理凭据仍有效，补正材料须以新确认的申请分支重新递交，禁止按原键重交');
      return { state: 'returned', receipt, actions: ['receipt-lookup'], blockers };
    }
    return { state: 'processing', receipt, actions: ['recheck'], blockers };
  }
  if (rec.submission && !receipt) {
    blockers.push('上次递交仅见处理中、回执索引暂未确认归属：禁止重复递交，先 recheck 对账');
    return { state: 'uncertain', actions: ['recheck'], blockers };
  }
  const actions = ['draft'];
  if (blockers.length === 0) actions.push('submit');
  return { state: rec.draft ? 'draft' : 'new', actions, blockers };
}
