// 纯策略引擎：机构歧义、签署有效性、字段计划、可执行动作判定。
// 不做任何 IO，全部输入显式传入，便于单测与复核。

export const BLOCKERS = Object.freeze({
  ORG_AMBIGUOUS: 'ORG_AMBIGUOUS',         // 门户上有同名单位，简称无法唯一确定
  ORG_NOT_ON_PORTAL: 'ORG_NOT_ON_PORTAL', // 来件统一编号不在门户目录
  MISSING_SIGNATURE: 'MISSING_SIGNATURE', // 分支要求的角色没有有效签署
  FIELD_NOT_DELEGATED: 'FIELD_NOT_DELEGATED', // 字段不在允许代填清单
  FIELD_MISSING_IN_PACKET: 'FIELD_MISSING_IN_PACKET', // 门户必填而来件没有值
  HUMAN_CONFLICT: 'HUMAN_CONFLICT',       // 人工修改与来件不一致
  ALREADY_SUBMITTED: 'ALREADY_SUBMITTED', // 门户确认已接收，不得重复递交
  RETURNED_NEEDS_SUPPLEMENT: 'RETURNED_NEEDS_SUPPLEMENT', // 已退回，须补送绑定新分支
  PORTAL_MISMATCH: 'PORTAL_MISMATCH',     // 门户实际显示与来件不符（编号/归属/指纹）
  PAGE_STATE_DIRTY: 'PAGE_STATE_DIRTY',   // 页面残留上一单的签署或字段
});

export const ACTIONS = Object.freeze({
  FILL_DRAFT: 'fill-draft',
  SUBMIT: 'submit',
  SUPPLEMENT: 'supplement',
  WAIT_REVIEW: 'wait-review',
  NONE: 'none',
});

// 门户两个分支的确认格定义，需与 portal.mjs 的 BRANCHES 保持一致。
export const BRANCHES = Object.freeze({
  本地: { name: '国内-R1', cross: false, requiredFields: ['title', 'count'], signRoles: ['素材权利人'] },
  跨区: { name: '跨区-R2', cross: true, requiredFields: ['title', 'count', 'contact'],
    signRoles: ['素材权利人', '跨区联络人'] },
});

const ROLE_FIELD = { 主申请人: 'applicant', 素材权利人: 'holder', 跨区联络人: 'liaison' };

// 按角色解析门户统一编号。简称同名时必须以来件统一编号为准。
export function resolveParticipants(packet, portalOrgs) {
  const result = { selections: {}, blockers: [] };
  const byShortName = new Map();
  for (const org of portalOrgs) {
    if (!byShortName.has(org.shortName)) byShortName.set(org.shortName, []);
    byShortName.get(org.shortName).push(org.id);
  }
  for (const [role, orgId, shortName] of packet.participants) {
    const portalOrg = portalOrgs.find((org) => org.id === orgId);
    if (!portalOrg) {
      result.blockers.push({ code: BLOCKERS.ORG_NOT_ON_PORTAL, role, orgId, shortName,
        message: `${role}的统一编号 ${orgId} 不在门户机构目录` });
      continue;
    }
    const sameName = byShortName.get(shortName) ?? [];
    if (sameName.length > 1) {
      // 同名单位并存：记录歧义事实，但只要来件给了编号即可按编号确定，不构成阻塞；
      // 若编号本身缺失/对不上才阻塞，由上面的分支处理。
      result.ambiguousNames ??= [];
      result.ambiguousNames.push({ role, shortName, candidates: [...sameName], resolved: orgId });
    }
    result.selections[ROLE_FIELD[role] ?? role] = { role, orgId, shortName, field: ROLE_FIELD[role] };
  }
  return result;
}

// 签署必须同时满足：角色匹配、当前分支匹配、材料指纹（版本）匹配、
// 且字段集合与分支确认格完全一致。同名声明跨分支/跨版本一律不可复用。
export function findValidSignatures(packet, branch) {
  const valid = [];
  const missing = [];
  for (const role of branch.signRoles) {
    const match = packet.signatures.find((signature) => {
      if (signature.role !== role || signature.branch !== branch.name) return false;
      if (signature.fingerprint !== packet.fingerprint) return false;
      const declared = [...signature.fields].sort();
      const required = [...branch.requiredFields].sort();
      return declared.length === required.length && declared.every((field, index) => field === required[index]);
    });
    if (match) valid.push({ role, signature: match });
    else {
      // 给出更具体的原因，方便经办人知道为什么旧声明不能用。
      const stale = packet.signatures.find((signature) => signature.role === role);
      missing.push({ role, reason: stale
        ? `已有「${role}」声明绑定 ${stale.branch}/${stale.fingerprint}，与当前分支 ${branch.name}/${packet.fingerprint} 不符，不可复用`
        : `缺少「${role}」在 ${branch.name} 分支的签署` });
    }
  }
  return { valid, missing };
}

// 生成字段填写计划。代办只能填 delegates 内的字段；人工修改与来件冲突时保留人工值并报阻塞。
export function planFill(packet, branch, humanOverrides = {}) {
  const fills = [];
  const blockers = [];
  for (const field of branch.requiredFields) {
    if (!(field in packet.fields)) {
      blockers.push({ code: BLOCKERS.FIELD_MISSING_IN_PACKET, field,
        message: `门户必填字段 ${field} 在来件中没有取值` });
      continue;
    }
    if (!packet.delegates.includes(field)) {
      blockers.push({ code: BLOCKERS.FIELD_NOT_DELEGATED, field,
        message: `字段 ${field} 不在允许代填清单，不能代填` });
      continue;
    }
    const sourceValue = String(packet.fields[field]);
    const human = humanOverrides[field];
    if (human !== undefined && human !== null && String(human) !== sourceValue) {
      // 人工修改：不覆盖，标记为冲突交经办人；未冲突的其他字段照常保留。
      blockers.push({ code: BLOCKERS.HUMAN_CONFLICT, field, humanValue: String(human),
        sourceValue, message: `字段 ${field} 已被人工改为「${human}」，与来件「${sourceValue}」不一致` });
      fills.push({ field, value: String(human), source: 'human', conflict: true });
    } else {
      fills.push({ field, value: sourceValue, source: human !== undefined ? 'human' : 'packet' });
    }
  }
  return { fills, blockers };
}

// 填写前/递交前核对门户页面实际状态，防止把上一单的内容或签署带过来。
export function verifyPortalState({ pageSnapshot, packet, branch, selectionPlan, expectedValues = {} }) {
  const blockers = [];
  if (pageSnapshot.region !== packet.region) {
    blockers.push({ code: BLOCKERS.PORTAL_MISMATCH, field: 'region',
      expected: packet.region, actual: pageSnapshot.region, message: '门户归属地与来件不一致' });
  }
  if (pageSnapshot.branch !== branch.name) {
    blockers.push({ code: BLOCKERS.PORTAL_MISMATCH, field: 'branch',
      expected: branch.name, actual: pageSnapshot.branch, message: '门户确认格分支与来件归属地不一致' });
  }
  if (pageSnapshot.fingerprint && pageSnapshot.fingerprint !== packet.fingerprint) {
    blockers.push({ code: BLOCKERS.PORTAL_MISMATCH, field: 'fingerprint',
      expected: packet.fingerprint, actual: pageSnapshot.fingerprint, message: '页面残留其他材料的指纹' });
  }
  if (pageSnapshot.case && pageSnapshot.case !== packet.case) {
    blockers.push({ code: BLOCKERS.PORTAL_MISMATCH, field: 'case',
      expected: packet.case, actual: pageSnapshot.case, message: '页面残留其他申请的编号' });
  }
  for (const [field, plan] of Object.entries(selectionPlan.selections)) {
    const actual = pageSnapshot.selections?.[field];
    if (actual && actual !== plan.orgId) {
      blockers.push({ code: BLOCKERS.PAGE_STATE_DIRTY, field, expected: plan.orgId, actual,
        message: `页面上 ${plan.role} 的机构选择与本单不符` });
    }
  }
  if (pageSnapshot.signedBoxes?.holderSigned || pageSnapshot.signedBoxes?.liaisonSigned) {
    blockers.push({ code: BLOCKERS.PAGE_STATE_DIRTY, field: 'signedBoxes',
      message: '页面残留上一单的签署勾选，已阻止沿用' });
  }
  // 回读已填字段，确认页面实际值与计划值逐字一致（防止页面残留或前端改写）。
  if (pageSnapshot.fields) {
    for (const [field, expected] of Object.entries(expectedValues ?? {})) {
      const actual = pageSnapshot.fields[field];
      if (actual === null || actual === undefined || actual === '') continue; // 该分支未渲染的字段跳过
      if (String(actual) !== String(expected)) {
        blockers.push({ code: BLOCKERS.PAGE_STATE_DIRTY, field, expected: String(expected), actual: String(actual),
          message: `页面字段 ${field} 的实际值「${actual}」与计划值「${expected}」不一致` });
      }
    }
  }
  return blockers;
}

// 汇总一份资料当前可安全执行的动作与全部阻塞原因。
// receipt：门户回执索引中同 case+fingerprint 的记录（可能为空）；
// returnedOrigin：同 case 下已退回的原回执（补送场景）。
export function decide({ packet, portalOrgs, receipt = null, returnedOrigin = null, humanOverrides = {} }) {
  const branch = BRANCHES[packet.region];
  const blockers = [];
  const selectionPlan = resolveParticipants(packet, portalOrgs);
  blockers.push(...selectionPlan.blockers);
  const fillPlan = planFill(packet, branch, humanOverrides);
  blockers.push(...fillPlan.blockers);
  const signaturePlan = findValidSignatures(packet, branch);
  for (const item of signaturePlan.missing) {
    blockers.push({ code: BLOCKERS.MISSING_SIGNATURE, role: item.role, message: item.reason });
  }

  let action = ACTIONS.NONE;
  let receiptState = null;
  if (receipt) {
    receiptState = receipt.state;
    if (receipt.state === 'accepted') {
      action = ACTIONS.NONE;
      blockers.push({ code: BLOCKERS.ALREADY_SUBMITTED, receipt: receipt.receipt,
        message: `门户已受理（回执 ${receipt.receipt}），不得重复递交` });
    } else if (receipt.state === 'processing') {
      action = ACTIONS.WAIT_REVIEW;
    } else if (receipt.state === 'returned') {
      action = ACTIONS.NONE;
      blockers.push({ code: BLOCKERS.RETURNED_NEEDS_SUPPLEMENT, receipt: receipt.receipt,
        reason: receipt.reason,
        message: `原回执 ${receipt.receipt} 已退回（${receipt.reason ?? '补正'}），新材料须走补送并绑定该回执` });
    }
  } else if (returnedOrigin) {
    // 同申请存在退回回执而本指纹尚未递交：这是补送分支。
    const canSubmit = blockers.length === 0;
    action = canSubmit ? ACTIONS.SUPPLEMENT : ACTIONS.FILL_DRAFT;
  } else {
    const canSubmit = blockers.length === 0;
    action = canSubmit ? ACTIONS.SUBMIT : ACTIONS.FILL_DRAFT;
  }

  return {
    action,
    branch,
    receiptState,
    selectionPlan,
    fillPlan,
    signaturePlan,
    blockers,
    canSubmit: action === ACTIONS.SUBMIT || action === ACTIONS.SUPPLEMENT,
  };
}
