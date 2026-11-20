import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  planSubmission,
  validateSignature,
  resolveParticipants,
  confirmationManifest,
  evaluate,
  receiptStateOf,
  sameSet,
  branchForRegion,
} from './policy.mjs';

const packets = JSON.parse(
  await readFile(new URL('../source-data/intake.json', import.meta.url), 'utf8'),
).map((entry) => entry.payload);
const byKey = (key) => packets.find((packet) => `${packet.case}/${packet.fingerprint}` === key);

const portalOptions = [
  { value: 'ORG-02', label: '远帆（ORG-02）' },
  { value: 'ORG-03', label: '远帆（ORG-03）' },
  { value: 'ORG-07', label: '协作站（ORG-07）' },
];
const snapshotLocal = { branch: '国内-R1', visibleFields: ['title', 'count'], checkboxes: ['holderSigned'] };
const snapshotCross = {
  branch: '跨区-R2',
  visibleFields: ['title', 'count', 'contact'],
  checkboxes: ['holderSigned', 'liaisonSigned'],
};

test('分支归属由登记地区推导，跨区对应跨区-R2', () => {
  assert.equal(branchForRegion('本地'), '国内-R1');
  assert.equal(branchForRegion('跨区'), '跨区-R2');
  assert.ok(sameSet(['a', 'b'], ['b', 'a']));
  assert.equal(receiptStateOf('退回补正联络资料'), 'returned');
  assert.equal(receiptStateOf('已受理'), 'accepted');
});

test('机构只按统一编号解析；门户找不到编号且简称同名时报角色歧义', () => {
  const ok = resolveParticipants(byKey('D-21/A-27'), portalOptions, false);
  assert.deepEqual(ok.selections, { applicant: 'ORG-02', holder: 'ORG-03' });
  assert.deepEqual(ok.blockers, []);

  const ambiguous = resolveParticipants(
    {
      participants: [
        ['主申请人', 'ORG-99', '远帆'],
        ['素材权利人', 'ORG-03', '远帆'],
      ],
    },
    portalOptions,
    false,
  );
  assert.equal(ambiguous.selections.applicant, undefined);
  assert.match(ambiguous.blockers.join(' '), /角色歧义.*远帆/);
});

test('本地单（D-21/A-27）计划无阻塞，只勾选匹配的素材权利人声明', () => {
  const plan = planSubmission(byKey('D-21/A-27'), snapshotLocal, portalOptions);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.selections, { applicant: 'ORG-02', holder: 'ORG-03' });
  assert.deepEqual(plan.fill, { title: '林道影像', count: '18' });
  assert.deepEqual(plan.checks.map((item) => item.checkbox), ['holderSigned']);
});

test('同名声明不得跨分支复用：D-22/A-28 的国内-R1 声明在跨区-R2 失效且联络人缺签署', () => {
  const plan = planSubmission(byKey('D-22/A-28'), snapshotCross, portalOptions);
  assert.ok(plan.blockers.some((text) => text.includes('不得跨分支复用')));
  assert.ok(plan.blockers.some((text) => text.includes('跨区联络人')));
  assert.deepEqual(plan.checks, []); // 没有任何一格允许代办勾选
});

test('声明校验：指纹变化即失效，字段集合必须与分支显示字段完全一致', () => {
  const signature = byKey('D-21/A-27').signatures[0];
  assert.equal(
    validateSignature(signature, byKey('D-21/A-27'), '国内-R1', ['title', 'count'], ['holderSigned']).ok,
    true,
  );
  const wrongVersion = { ...signature, fingerprint: 'A-99' };
  assert.match(
    validateSignature(wrongVersion, byKey('D-21/A-27'), '国内-R1', ['title', 'count'], ['holderSigned']).reason,
    /指纹/,
  );
  const extraField = ['title', 'count', 'contact'];
  assert.match(
    validateSignature(signature, byKey('D-21/A-27'), '国内-R1', extraField, ['holderSigned']).reason,
    /字段/,
  );
  assert.match(
    validateSignature(signature, byKey('D-21/A-27'), '跨区-R2', ['title', 'count'], ['holderSigned']).reason,
    /跨分支复用/,
  );
});

test('未授权字段不代填：delegates 之外的 contact 必须留给经办人', () => {
  const packet = structuredClone(byKey('D-22/A-28'));
  packet.delegates = ['title', 'count']; // contact 未授权
  const plan = planSubmission(packet, snapshotCross, portalOptions);
  assert.ok(!('contact' in plan.fill));
  assert.ok(plan.blockers.some((text) => text.includes('contact') && text.includes('未获授权')));
});

test('分支实际渲染与归属地不符时拒绝继续', () => {
  const packet = byKey('D-22/A-28'); // 跨区
  const plan = planSubmission(packet, { ...snapshotCross, branch: '国内-R1' }, portalOptions);
  assert.ok(plan.blockers.some((text) => text.includes('门户实际分支')));
});

test('补正单 D-22/A-29 携带两份跨区-R2 声明时，两格签署均可确认', () => {
  const plan = planSubmission(byKey('D-22/A-29'), snapshotCross, portalOptions);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.checks.map((item) => item.checkbox).sort(), ['holderSigned', 'liaisonSigned']);
  assert.equal(plan.fill.contact, '谷站');
  const manifest = confirmationManifest(byKey('D-22/A-29'), plan);
  assert.equal(manifest.branch, '跨区-R2');
  assert.deepEqual(manifest.confirmations.map((item) => item.role), ['素材权利人', '跨区联络人']);
  assert.ok(manifest.confirmations.every((item) => sameSet(item.fields, ['title', 'count', 'contact'])));
});

test('evaluate：已受理/处理中/退回/在途未确认 给出不同安全动作', () => {
  const packet = byKey('D-21/A-27');
  const rec = (extra) => ({ key: 'D-21/A-27', packet, planBlockers: [], ...extra });

  assert.equal(
    evaluate(rec(), [{ key: 'D-21/A-27', state: 'accepted', receipt: 'SL-101', holder: 'ORG-03' }]).state,
    'accepted',
  );
  // 门户确认的权利人编号与来件不符 -> 冲突，只能人工复核
  const conflict = evaluate(rec(), [
    { key: 'D-21/A-27', state: 'accepted', receipt: 'SL-101', holder: 'ORG-02' },
  ]);
  assert.equal(conflict.state, 'conflict');
  assert.deepEqual(conflict.actions, ['manual-review']);

  const processing = evaluate(rec(), [{ key: 'D-21/A-27', state: 'processing', receipt: 'SL-101' }]);
  assert.equal(processing.state, 'processing');
  assert.deepEqual(processing.actions, ['recheck']);

  const returned = evaluate(rec(), [
    { key: 'D-21/A-27', state: 'returned', receipt: 'SL-101', holder: 'ORG-03' },
  ]);
  assert.equal(returned.state, 'returned');
  assert.match(returned.blockers.join(' '), /禁止按原键重交/);

  // 202 已点但回执索引还没有 -> 在途未确认，只能对账
  const uncertain = evaluate(rec({ submission: { status: 'processing' } }), []);
  assert.equal(uncertain.state, 'uncertain');
  assert.deepEqual(uncertain.actions, ['recheck']);

  const fresh = evaluate(rec(), []);
  assert.deepEqual(fresh.actions, ['draft', 'submit']);
});
