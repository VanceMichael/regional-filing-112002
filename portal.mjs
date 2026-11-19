const shell = (content) => `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>联合登记 · 受理台</title>
<style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:48rem;color:#1d292c}nav,fieldset,form{margin:1rem 0}label{display:block;margin:.75rem 0}input,select,button{font:inherit}fieldset{border:1px solid #a2b3b7}output{display:block;min-height:1.5rem}</style>
<nav><a href="/filing">受理表</a> · <a href="/filing/receipts">递交查询</a></nav>${content}</html>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const options = '<option value="">请选择</option><option value="ORG-02">远帆（ORG-02）</option><option value="ORG-03">远帆（ORG-03）</option><option value="ORG-07">协作站（ORG-07）</option>';

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
  output.textContent = reply.message + (reply.receipt ? ' ' + reply.receipt : '');
});
renderBranch();
</script>`);

export function makePortal(sendJson) {
  const submissions = new Map();
  return async (request, response, url, stage) => {
    if (!url.pathname.startsWith('/filing')) return false;
    if (request.method === 'GET' && url.pathname === '/filing/branch') {
      const cross = url.searchParams.get('region') === '跨区';
      sendJson(response, 200, { cross, name: cross ? '跨区-R2' : '国内-R1' });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/filing/submit') {
      let body = '';
      for await (const piece of request) body += piece;
      const fields = new URLSearchParams(body);
      const cross = fields.get('region') === '跨区';
      if (fields.get('branch') !== (cross ? '跨区-R2' : '国内-R1') || !fields.has('holderSigned') ||
          (cross && (!fields.has('liaisonSigned') || !fields.get('contact') || !fields.get('liaison')))) {
        sendJson(response, 422, { message: '本地区分支确认未齐' });
        return true;
      }
      const key = [fields.get('case'), fields.get('fingerprint')].join('/');
      const previous = submissions.get(key);
      if (previous) {
        sendJson(response, 409, { message: '该材料已递交，请查回执', receipt: previous.id });
        return true;
      }
      const id = 'SL-' + (submissions.size + 101);
      submissions.set(key, { id, stage, fields: Object.fromEntries(fields) });
      sendJson(response, 202, { message: '处理中' });
      return true;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/filing') {
      response.end(form);
      return true;
    }
    if (url.pathname === '/filing/receipts') {
      const items = [...submissions.values()].map(({ id, stage: started, fields }) => {
        const state = stage <= started ? '处理中' : (stage === 3 && fields.region === '跨区' ? '退回补正联络资料' : '已受理');
        return `<tr><td>${escape(fields.case)}</td><td>${escape(fields.fingerprint)}</td><td>${escape(fields.branch)}</td><td>${escape(id)}</td><td>${state}</td><td>${escape(fields.holder)}</td></tr>`;
      });
      response.end(shell('<h1>递交查询</h1><table><thead><tr><th>申请</th><th>指纹</th><th>分支</th><th>回执</th><th>状态</th><th>权利人</th></tr></thead><tbody>' + items.join('') + '</tbody></table>'));
      return true;
    }
    response.statusCode = 404;
    response.end();
    return true;
  };
}
