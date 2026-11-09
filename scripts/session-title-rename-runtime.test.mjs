#!/usr/bin/env node
// 세션 제목 편집의 권한·상태별 동작을 실제 화면 모듈에서 확인한다.
import path from 'node:path';
import { buildSync } from 'esbuild';
import { dumpDom, findChrome, readOut } from './headless-chrome.mjs';

const chrome = findChrome();
if (!chrome) { console.log('skip  크롬 없음'); process.exit(0); }
const root = path.resolve(import.meta.dirname, '..');
const bundle = buildSync({ stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'SC', write: false, platform: 'browser', target: 'es2020', logLevel: 'silent' }).outputFiles[0].text;
const page = `<!doctype html><html><meta charset="utf-8"><div id="toasts"></div><pre id="out">PENDING</pre><script type="text/plain" id="src">${bundle.replace(/<\/script/gi, '<\\/script')}</script><script>
(async () => {
  const S = (new Function(document.querySelector('#src').textContent + ';return SC;'))();
  const cases = [
    { id: 'running', live: true, owned: true, rename: true, expectEdit: true },
    { id: 'stopped', live: false, owned: true, rename: true, expectEdit: true },
    { id: 'missing', live: false, owned: true, rename: false, expectEdit: false },
    { id: 'other', live: true, owned: false, rename: true, expectEdit: false },
    { id: 'archived', live: false, owned: true, restorable: false, rename: true, expectEdit: false },
  ];
  const results = [];
  for (const c of cases) {
    const host = document.createElement('div'); document.body.append(host);
    const target = { id: c.id, label: 'box-' + c.id, live: c.live, alive: c.live, owned: c.owned, node: null,
      projectId: null, projectName: '', raw: { title: '진행하는 일', restorable: c.restorable ?? !c.live, harness: 'claude' } };
    let saved = '';
    const h = S.mountSessionChat(host, target, c.rename ? { onRename: async (v) => { saved = v; } } : {});
    const button = host.querySelector('.sc-title-btn');
    button?.click();
    const input = host.querySelector('.sc-title-in');
    if (input) { input.value = c.id + ' 새 이름'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    await new Promise((resolve) => setTimeout(resolve, 30));
    results.push({ id: c.id, expected: c.expectEdit, edited: !!input, saved,
      shown: host.querySelector('.sc-title')?.textContent?.trim() });
    h.destroy(); host.remove();
  }
  document.querySelector('#out').textContent = JSON.stringify(results) + 'ENDRESULT';
})().catch((e) => { document.querySelector('#out').textContent = JSON.stringify({ error: String(e?.stack || e) }) + 'ENDRESULT'; });
</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: 'session-title-rename-', virtualTimeBudget: 5000, timeoutMs: 20000 });
const result = JSON.parse(readOut(dom).text || '{}');
if (!Array.isArray(result) || result.length !== 5 || result.some((r) => r.edited !== r.expected ||
  (r.expected && (r.saved !== r.id + ' 새 이름' || r.shown !== r.saved)) || (!r.expected && r.saved))) {
  throw new Error('세션 제목 편집 실패: ' + JSON.stringify(result));
}
console.log('session-title-rename: 5 cases passed');
