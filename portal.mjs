// 演练门户：只能通过网页操作的联合登记受理台。
// 表单分支按登记地区刷新；递交先“处理中”，评审后才出受理/退回结果。
const shell = (content) => `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>联合登记 · 受理台</title>
<style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:56rem;color:#1d292c}nav,fieldset,form{margin:1rem 0}label{display:block;margin:.75rem 0}input,select,button{font:inherit}fieldset{border:1px solid #a2b3b7}output{display:block;min-height:1.5rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #c5d0d3;padding:.35rem .5rem;text-align:left}.muted{color:#5a6b70}</style>
<nav><a href="/filing">受理表</a> · <a href="/filing/receipts">递交查询</a></nav>${content}</html>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// <script type="application/json"> 内只需防止序列闭合脚本标签，不做 HTML 属性转义。
const jsonIsland = (id, data) =>
  `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

// 门户机构目录：法务清单常写简称，门户上同名单位靠统一编号区分。
export const ORGANIZATIONS = [
  { id: 'ORG-02', shortName: '远帆', fullName: '远帆文化服务站（本部）' },
  { id: 'ORG-03', shortName: '远帆', fullName: '远帆影像协作中心（分站）' },
  { id: 'ORG-07', shortName: '协作站', fullName: '跨区协作联络站' },
];
const options = '<option value="">请选择</option>' + ORGANIZATIONS
  .map((org) => `<option value="${org.id}">${escape(org.shortName)}（${org.id}）</option>`).join('');

// 分支定义：归属地切换后，确认格的字段集合随之变化。
export const BRANCHES = {
  本地: { name: '国内-R1', cross: false, requiredFields: ['title', 'count'], signRoles: ['素材权利人'] },
  跨区: { name: '跨区-R2', cross: true, requiredFields: ['title', 'count', 'contact'],
    signRoles: ['素材权利人', '跨区联络人'] },
};

const form = shell(`<h1>联合登记受理</h1><form>
<label>申请编号 <input name="case" required></label>
<label>材料指纹 <input name="fingerprint" required></label>
<label>登记地区 <select name="region"><option>本地</option><option>跨区</option></select></label>
<fieldset><legend>统一编号</legend>
<label>主申请人 <select name="applicant" required>${options}</select></label>
<label for="holder">素材权利人</label><select id="holder" name="holder" required>${options}</select>
<label>跨区联络人 <select name="liaison">${options}</select></label></fieldset>
<label>资料名称 <input name="title" required></label>
<label>镜头数量 <input type="number" name="count" min="1" required></label>
<fieldset><legend>确认范围</legend><p id="branch"></p><div id="branch-fields"></div>
<label><input type="checkbox" name="holderSigned"> 素材权利人已签署</label></fieldset>
<button type="submit">递交</button></form><output aria-live="polite"></output>
${jsonIsland('portal-orgs', ORGANIZATIONS)}
${jsonIsland('portal-branches', BRANCHES)}
<script>
const form = document.querySelector('form');
const output = document.querySelector('output');
let view = 0;
async function renderBranch() {
  const turn = ++view;
  const region = form.elements.region.value;
  const response = await fetch('/filing/branch?region=' + encodeURIComponent(region));
  const branch = await response.json();
  if (turn !== view) return;
  document.querySelector('#branch').textContent = branch.name;
  document.querySelector('#branch-fields').innerHTML = branch.cross ?
    '<label>跨区联络资料 <input name="contact" required></label><label><input name="liaisonSigned" type="checkbox"> 跨区联络人已签署</label>' : '';
  form.elements.holderSigned.checked = false;
  output.textContent = '';
}
form.elements.region.addEventListener('change', renderBranch);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = new URLSearchParams(new FormData(form));
  fields.set('branch', document.querySelector('#branch').textContent);
  const response = await fetch('/filing/submit', { method: 'POST', body: fields });
  const reply = await response.json();
  document.querySelector('#last-submit').textContent = JSON.stringify(reply);
  output.textContent = reply.message + (reply.receipt ? ' ' + reply.receipt : '');
});
renderBranch();
</script>
<script type="application/json" id="last-submit">null</script>`);

const STATE_TEXT = { processing: '处理中', accepted: '已受理', returned: '退回补正' };

export function makePortal(sendJson) {
  // 键：申请编号/材料指纹；门户内全部记录仅存于进程内存。
  const submissions = new Map();
  // 显式评审结果：receiptId -> { decision, reason, retainFields }
  const reviews = new Map();
  let sequence = 100;

  const branchOf = (region) => BRANCHES[region] ?? null;

  const receiptState = (entry, stage) => {
    const review = reviews.get(entry.id);
    if (review) return review.decision === 'accept' ? 'accepted' : 'returned';
    return stage <= entry.startedStage ? 'processing' : 'accepted';
  };

  const publicEntry = (entry, stage) => {
    const state = receiptState(entry, stage);
    const review = reviews.get(entry.id);
    return {
      receipt: entry.id,
      case: entry.case,
      fingerprint: entry.fingerprint,
      branch: entry.branch,
      region: entry.region,
      state,
      stateText: STATE_TEXT[state],
      startedStage: entry.startedStage,
      supplementsTo: entry.supplementsTo ?? null,
      reason: review?.reason ?? null,
      retainFields: review?.retainFields ?? null,
      roles: entry.roles,
      fields: entry.publicFields,
    };
  };

  return async (request, response, url, stage) => {
    if (!url.pathname.startsWith('/filing')) return false;

    if (request.method === 'GET' && url.pathname === '/filing/branch') {
      const branch = branchOf(url.searchParams.get('region'));
      if (!branch) {
        sendJson(response, 400, { message: '登记地区无效' });
        return true;
      }
      sendJson(response, 200, branch);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/filing/submit') {
      let body = '';
      for await (const piece of request) body += piece;
      const fields = new URLSearchParams(body);
      const region = fields.get('region');
      const branch = branchOf(region);
      if (!branch) {
        sendJson(response, 400, { message: '登记地区无效' });
        return true;
      }
      const caseId = fields.get('case') ?? '';
      const fingerprint = fields.get('fingerprint') ?? '';
      const cross = branch.cross;

      // 门户只按当前归属地分支校验确认格，旧分支声明无法通过。
      if (fields.get('branch') !== branch.name || !fields.has('holderSigned') ||
          (cross && (!fields.has('liaisonSigned') || !fields.get('contact') || !fields.get('liaison'))) ||
          !fields.get('applicant') || !fields.get('holder') ||
          !fields.get('title') || !fields.get('count')) {
        sendJson(response, 422, { message: '本地区分支确认未齐' });
        return true;
      }

      const key = `${caseId}/${fingerprint}`;
      const previous = submissions.get(key);
      if (previous) {
        sendJson(response, 409, {
          message: '该材料已递交，请查回执',
          receipt: previous.id,
          state: receiptState(previous, stage),
        });
        return true;
      }

      // 同一申请的新材料（新指纹）只允许作为退回补送，并须绑定原退回回执。
      const sameCase = [...submissions.values()].filter((entry) => entry.case === caseId);
      const supplementsTo = fields.get('supplementsTo') || null;
      if (sameCase.length > 0) {
        const origin = supplementsTo ? submissions.get(`__receipt__/${supplementsTo}`) : null;
        if (!origin || origin.case !== caseId || receiptState(origin, stage) !== 'returned') {
          sendJson(response, 422, {
            message: '同申请的新材料只能补送，且必须绑定已退回的原回执',
          });
          return true;
        }
      } else if (supplementsTo) {
        sendJson(response, 422, { message: '原回执不存在，无法补送' });
        return true;
      }

      sequence += 1;
      const id = `SL-${sequence}`;
      const entry = {
        id,
        case: caseId,
        fingerprint,
        region,
        branch: branch.name,
        startedStage: stage,
        supplementsTo,
        publicFields: {
          title: fields.get('title'),
          count: fields.get('count'),
          ...(cross ? { contact: fields.get('contact') } : {}),
        },
        roles: [
          { role: '主申请人', org: fields.get('applicant') },
          { role: '素材权利人', org: fields.get('holder'),
            signed: true, branch: branch.name, fields: [...branch.requiredFields], fingerprint },
          ...(cross ? [{ role: '跨区联络人', org: fields.get('liaison'),
            signed: true, branch: branch.name, fields: [...branch.requiredFields], fingerprint }] : []),
        ],
      };
      submissions.set(key, entry);
      submissions.set(`__receipt__/${id}`, entry);
      // 递交当场只回“处理中”，回执编号要在递交查询/受理后才能查到。
      sendJson(response, 202, { message: '处理中', state: 'processing' });
      return true;
    }

    // 评审控制：受理或退回。退回时注明补正项与仍有效（保留）的字段。
    if (request.method === 'POST' && url.pathname === '/filing/review') {
      const receipt = url.searchParams.get('receipt') ?? '';
      const decision = url.searchParams.get('decision') ?? '';
      const entry = submissions.get(`__receipt__/${receipt}`);
      if (!entry) {
        sendJson(response, 404, { message: '回执不存在' });
        return true;
      }
      if (!['accept', 'return'].includes(decision)) {
        sendJson(response, 400, { message: '评审决定无效' });
        return true;
      }
      const reason = url.searchParams.get('reason') ?? (decision === 'return' ? '请补正后重新递交' : '');
      const retain = url.searchParams.getAll('retain');
      reviews.set(receipt, {
        decision,
        reason,
        retainFields: decision === 'return'
          ? retain.filter((name) => name in entry.publicFields)
          : null,
      });
      sendJson(response, 200, { receipt, decision, review: reviews.get(receipt) });
      return true;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { message: '仅支持 GET' });
      return true;
    }

    if (url.pathname === '/filing') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(form);
      return true;
    }

    if (url.pathname === '/filing/receipts') {
      const items = [...submissions.entries()]
        .filter(([key]) => !key.startsWith('__receipt__/'))
        .map(([, entry]) => publicEntry(entry, stage));
      if (url.searchParams.get('format') === 'json') {
        sendJson(response, 200, { stage, items });
        return true;
      }
      const rows = items.map((item) => `<tr>
<td>${escape(item.case)}</td><td>${escape(item.fingerprint)}</td><td>${escape(item.branch)}</td>
<td><a href="/filing/receipts/${encodeURIComponent(item.receipt)}">${escape(item.receipt)}</a></td>
<td>${escape(item.stateText)}</td><td>${escape(item.roles.find((r) => r.role === '素材权利人')?.org ?? '')}</td>
<td>${item.supplementsTo ? escape(item.supplementsTo) : '<span class="muted">—</span>'}</td></tr>`).join('');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(shell(`<h1>递交查询</h1>
${jsonIsland('receipt-index', { stage, items })}
<table><thead><tr><th>申请</th><th>指纹</th><th>分支</th><th>回执</th><th>状态</th><th>权利人</th><th>补送自</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">暂无递交记录</td></tr>'}</tbody></table>`));
      return true;
    }

    const detail = /^\/filing\/receipts\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (detail) {
      const entry = submissions.get(`__receipt__/${detail[1]}`);
      if (!entry) {
        response.statusCode = 404;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(shell('<h1>回执不存在</h1>'));
        return true;
      }
      const item = publicEntry(entry, stage);
      if (url.searchParams.get('format') === 'json') {
        sendJson(response, 200, item);
        return true;
      }
      const roleRows = item.roles.map((r) => `<tr><td>${escape(r.role)}</td><td>${escape(r.org)}</td>
<td>${r.signed ? escape(r.branch) : '<span class="muted">—</span>'}</td>
<td>${r.signed ? escape(r.fields.join('、')) : '<span class="muted">未签署</span>'}</td>
<td>${r.signed ? escape(r.fingerprint) : '<span class="muted">—</span>'}</td></tr>`).join('');
      const fieldRows = Object.entries(item.fields)
        .map(([name, value]) => `<tr><td>${escape(name)}</td><td>${escape(value)}</td></tr>`).join('');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(shell(`<h1>回执 ${escape(item.receipt)}</h1>
${jsonIsland('receipt-detail', item)}
<p>申请编号：<b>${escape(item.case)}</b> · 材料指纹：<b>${escape(item.fingerprint)}</b> ·
分支：<b>${escape(item.branch)}</b> · 状态：<b>${escape(item.stateText)}</b></p>
${item.supplementsTo ? `<p>本回执为补送，绑定原退回回执：<a href="/filing/receipts/${encodeURIComponent(item.supplementsTo)}">${escape(item.supplementsTo)}</a></p>` : ''}
${item.state === 'returned' ? `<p>退回原因：${escape(item.reason ?? '')}<br>仍有效字段：${escape((item.retainFields ?? []).join('、') || '无')}</p>` : ''}
<h2>受理时按角色确认的材料</h2>
<table><thead><tr><th>角色</th><th>统一编号</th><th>签署分支</th><th>字段集合</th><th>材料版本</th></tr></thead><tbody>${roleRows}</tbody></table>
<h2>字段归属</h2>
<table><thead><tr><th>字段</th><th>门户确认值</th></tr></thead><tbody>${fieldRows}</tbody></table>
<p><a href="/filing/receipts">返回递交查询</a></p>`));
      return true;
    }

    response.statusCode = 404;
    response.end();
    return true;
  };
}
