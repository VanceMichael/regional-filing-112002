import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORGANIZATIONS } from '../portal.mjs';
import {
  ACTIONS, BLOCKERS, BRANCHES, decide, findValidSignatures,
  planFill, resolveParticipants, verifyPortalState,
} from './policy.mjs';

const basePacket = (overrides = {}) => ({
  record: 'intake-x', case: 'D-1', region: '本地', fingerprint: 'FP-1',
  participants: [
    ['主申请人', 'ORG-02', '远帆'],
    ['素材权利人', 'ORG-03', '远帆'],
    ['跨区联络人', 'ORG-07', '协作站'],
  ],
  fields: { title: '林道影像', count: 18 },
  delegates: ['title', 'count'],
  signatures: [
    { role: '素材权利人', org: 'ORG-03', branch: '国内-R1', fields: ['title', 'count'], fingerprint: 'FP-1' },
  ],
  ...overrides,
});

test('同名机构并存：简称有歧义时按来件统一编号确定，不猜名称', () => {
  const packet = basePacket();
  const plan = resolveParticipants(packet, ORGANIZATIONS);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.selections.applicant.orgId, 'ORG-02');
  assert.equal(plan.selections.holder.orgId, 'ORG-03');
  assert.deepEqual(plan.ambiguousNames.find((a) => a.role === '主申请人').candidates, ['ORG-02', 'ORG-03']);

  const bad = resolveParticipants(
    basePacket({ participants: [['主申请人', 'ORG-99', '远帆']] }), ORGANIZATIONS);
  assert.equal(bad.blockers[0].code, BLOCKERS.ORG_NOT_ON_PORTAL);
});

test('签署绑定分支与材料版本：同名声明跨分支或跨指纹都不可复用', () => {
  // 跨区分支要求两份签署；只带国内-R1 的旧声明 => 两份都缺
  const crossPacket = basePacket({
    region: '跨区',
    fields: { title: '馆藏镜头', count: 13, contact: '桥站' },
    delegates: ['title', 'count', 'contact'],
  });
  const r2 = BRANCHES.跨区;
  const stale = findValidSignatures(crossPacket, r2);
  assert.equal(stale.valid.length, 0);
  assert.equal(stale.missing.length, 2);
  assert.match(stale.missing[0].reason, /不可复用/);

  // 新指纹上的旧版本声明同样无效
  const newVersion = basePacket({
    fingerprint: 'FP-2',
    signatures: [{ role: '素材权利人', org: 'ORG-03', branch: '国内-R1', fields: ['title', 'count'], fingerprint: 'FP-1' }],
  });
  assert.equal(findValidSignatures(newVersion, BRANCHES.本地).valid.length, 0);

  // 字段集合与确认格不一致也无效（跨区格含 contact）
  const wrongSet = basePacket({
    region: '跨区', fingerprint: 'FP-3',
    fields: { title: '馆藏镜头', count: 13, contact: '桥站' },
    delegates: ['title', 'count', 'contact'],
    signatures: [
      { role: '素材权利人', org: 'ORG-03', branch: '跨区-R2', fields: ['title', 'count'], fingerprint: 'FP-3' },
      { role: '跨区联络人', org: 'ORG-07', branch: '跨区-R2', fields: ['title', 'count', 'contact'], fingerprint: 'FP-3' },
    ],
  });
  const checked = findValidSignatures(wrongSet, r2);
  assert.equal(checked.valid.length, 1);
  assert.equal(checked.missing[0].role, '素材权利人');

  // 全部匹配时放行
  const good = basePacket();
  assert.equal(findValidSignatures(good, BRANCHES.本地).valid.length, 1);
});

test('代填字段受授权清单约束，门户必填而来件缺值也阻塞', () => {
  const noDelegate = planFill(basePacket({ delegates: ['title'] }), BRANCHES.本地);
  assert.equal(noDelegate.blockers[0].code, BLOCKERS.FIELD_NOT_DELEGATED);

  const missing = planFill(basePacket({ fields: { title: '林道影像' } }), BRANCHES.本地);
  assert.equal(missing.blockers[0].code, BLOCKERS.FIELD_MISSING_IN_PACKET);
});

test('人工修改：不冲突字段保留，冲突字段不覆盖并交经办人', () => {
  const packet = basePacket();
  const plan = planFill(packet, BRANCHES.本地, { title: '人工改的名称', count: '18' });
  const title = plan.fills.find((f) => f.field === 'title');
  const count = plan.fills.find((f) => f.field === 'count');
  assert.equal(title.value, '人工改的名称');
  assert.equal(title.conflict, true);
  assert.equal(count.source, 'human');
  assert.equal(count.conflict, undefined);
  assert.equal(plan.blockers[0].code, BLOCKERS.HUMAN_CONFLICT);
});

test('页面残留上一单的签署勾选或机构选择时阻止沿用', () => {
  const packet = basePacket();
  const selectionPlan = resolveParticipants(packet, ORGANIZATIONS);
  const blockers = verifyPortalState({
    pageSnapshot: {
      region: '本地', branch: '国内-R1', case: 'D-1', fingerprint: 'FP-1',
      selections: { applicant: 'ORG-02', holder: 'ORG-03', liaison: 'ORG-07' },
      signedBoxes: { holderSigned: true, liaisonSigned: false },
    },
    packet, branch: BRANCHES.本地, selectionPlan,
  });
  assert.equal(blockers[0].code, BLOCKERS.PAGE_STATE_DIRTY);

  const clean = verifyPortalState({
    pageSnapshot: {
      region: '本地', branch: '国内-R1', case: 'D-1', fingerprint: 'FP-1',
      selections: { applicant: 'ORG-02', holder: 'ORG-03', liaison: '' },
      signedBoxes: { holderSigned: false, liaisonSigned: false },
      fields: { title: '林道影像', count: '18', contact: null },
    },
    packet, branch: BRANCHES.本地, selectionPlan,
    expectedValues: { title: '林道影像', count: '18' },
  });
  assert.equal(clean.length, 0);

  // 页面字段与计划值不符也要拦截，不能把错值递交出去
  const mismatched = verifyPortalState({
    pageSnapshot: {
      region: '本地', branch: '国内-R1', case: 'D-1', fingerprint: 'FP-1',
      selections: { applicant: 'ORG-02', holder: 'ORG-03', liaison: '' },
      signedBoxes: { holderSigned: false, liaisonSigned: false },
      fields: { title: '上一单的名称', count: '18', contact: null },
    },
    packet, branch: BRANCHES.本地, selectionPlan,
    expectedValues: { title: '林道影像', count: '18' },
  });
  assert.equal(mismatched[0].code, BLOCKERS.PAGE_STATE_DIRTY);
  assert.equal(mismatched[0].field, 'title');
});

test('决策：已受理不得重复交；处理中等待；退回走补送；缺签署只能草稿', () => {
  const packet = basePacket();

  const accepted = decide({
    packet, portalOrgs: ORGANIZATIONS,
    receipt: { receipt: 'SL-101', state: 'accepted', stateText: '已受理' },
  });
  assert.equal(accepted.action, ACTIONS.NONE);
  assert.ok(accepted.blockers.some((b) => b.code === BLOCKERS.ALREADY_SUBMITTED));

  const processing = decide({
    packet, portalOrgs: ORGANIZATIONS,
    receipt: { receipt: 'SL-102', state: 'processing', stateText: '处理中' },
  });
  assert.equal(processing.action, ACTIONS.WAIT_REVIEW);

  const returned = decide({
    packet, portalOrgs: ORGANIZATIONS,
    receipt: { receipt: 'SL-102', state: 'returned', stateText: '退回补正', reason: '联络资料需补正' },
  });
  assert.ok(returned.blockers.some((b) => b.code === BLOCKERS.RETURNED_NEEDS_SUPPLEMENT));

  // 新指纹 + 同案退回回执 => 补送分支
  const supplement = decide({
    packet: basePacket({ fingerprint: 'FP-9',
      fields: { title: '林道影像', count: 18, contact: '谷站' },
      delegates: ['title', 'count', 'contact'], region: '跨区',
      signatures: [
        { role: '素材权利人', org: 'ORG-03', branch: '跨区-R2', fields: ['title', 'count', 'contact'], fingerprint: 'FP-9' },
        { role: '跨区联络人', org: 'ORG-07', branch: '跨区-R2', fields: ['title', 'count', 'contact'], fingerprint: 'FP-9' },
      ] }),
    portalOrgs: ORGANIZATIONS,
    returnedOrigin: { receipt: 'SL-102', state: 'returned' },
  });
  assert.equal(supplement.action, ACTIONS.SUPPLEMENT);
  assert.equal(supplement.canSubmit, true);

  // 缺有效签署 => 只能填草稿
  const unsigned = decide({
    packet: basePacket({
      region: '跨区',
      fields: { title: '馆藏镜头', count: 13, contact: '桥站' },
      delegates: ['title', 'count', 'contact'],
      signatures: [{ role: '素材权利人', org: 'ORG-03', branch: '国内-R1', fields: ['title', 'count'], fingerprint: 'FP-1' }],
    }),
    portalOrgs: ORGANIZATIONS,
  });
  assert.equal(unsigned.action, ACTIONS.FILL_DRAFT);
  assert.equal(unsigned.canSubmit, false);
  assert.ok(unsigned.blockers.some((b) => b.code === BLOCKERS.MISSING_SIGNATURE));
});
