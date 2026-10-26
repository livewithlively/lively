#!/usr/bin/env node
// [외부 앱 연결] ▸ 노션 ▸ «자료 가져오기» ▸ 어디서 — 워크스페이스 [연결 끊기] 런타임 시험 (#4991 격리 리뷰 후속).
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  W1 워크스페이스 하나 → 줄 하나 · 이름(+모은 페이지 수) · 토글 없음(켜고 끄기는 위 대표 토글) · [연결 끊기]
//  W2 워크스페이스 둘 → 줄 둘 · 줄마다 토글 + [연결 끊기]
//  W3 [연결 끊기] → [취소] → 확인 창 제목에 그 이름 · 사실 세 줄(자료 남음 · 다시 연결하고 켜면 이어서 · 노션 쪽은 노션에서) · 보내지 않는다
//  W4 [연결 끊기] → 확인 → POST /api/ui/org/notion/workspace/disconnect {workspace_id} · 다시 그려 그 줄이 사라진다 · 다른 줄은 남는다
//  W5 워크스페이스 없음 → [연결 끊기] 없음
//  W6 어느 경우든 «null»·«undefined» 없음
//
// 왜 런타임인가: 서버 쪽 끊기는 유닛(notion-connect F1~F8)과 실제 DB(connect-unregister.pg-test R6~R8)가 본다. 이 칸은 화면 접착부
//  (줄 · 단추 · 확인 창 · 전송 · 다시 그리기)라 실제 화면 모듈(web/v2/connect.ts renderConnectApp)을 묶어 진짜 DOM 에서 돌린다.
//  서버 자리(fetch)만 정해진 응답으로 바꾸고, 권한은 화면 상태(state.me.scopes)로 준다. 크롬이 없는 면에서는 조용히 건너뛴다.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BREATHE_URL, dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 노션 워크스페이스 끊기 화면 런타임 검증 미실행");
  process.exit(0);
}
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
//  화면 상태(권한)와 상세 화면을 한 묶음에서 꺼낸다 — 같은 state 인스턴스여야 hasScope 가 시험이 준 권한을 본다.
const bundle = execFileSync(ESBUILD, [
  "--bundle", "--format=iife", "--global-name=CN", "--platform=browser", "--log-level=error", "--loader=ts", "--sourcefile=entry.ts",
], {
  input: "export { state } from './web/lib/state.ts';\nexport { renderConnectApp } from './web/v2/connect.ts';\n",
  cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 27,
});

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="toasts"></div><div id="one"></div><div id="two"></div><div id="none"></div>
<pre id="out">PENDING</pre>
<script>
  window.__calls = [];
  const realFetch = window.fetch.bind(window);
  window.__breathe = () => realFetch("${BREATHE_URL}").then((r) => r.text()).catch(() => '');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const W = (id, name, extra) => Object.assign({ id, name, icon: null, connected_by: 'me', created_at: '2026-10-20T00:00:00Z', updated_at: null,
    collector_id: 1, enabled: true, instance: id, pages: 12, first_sync_done: true }, extra || {});
  window.__W = W;
  window.__ws = [];
  const notionState = () => ({ enabled: window.__ws.some((w) => w.enabled), workspaces: window.__ws, ready: true });
  window.open = () => null;
  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    window.__calls.push({ u, method, body: opts.body || null });
    if (u.indexOf('/api/ui/org/notion/workspace/disconnect') >= 0) {
      const id = JSON.parse(opts.body).workspace_id;
      window.__ws = window.__ws.filter((w) => w.id !== id);
      return json({ ok: true, workspace_id: id, deleted: true, stopped: [1], state: notionState() });
    }
    if (u.indexOf('/api/ui/org/notion/collect') >= 0) return json(notionState());
    if (u.indexOf('/api/ui/me/credentials') >= 0) return json({ credentials: [], encryption_ready: true });
    if (u.indexOf('/api/ui/me/oauth/connectors') >= 0) return json({ connectors: [] });
    if (u.indexOf('/api/ui/org/collectors') >= 0) return json({ collectors: [] });
    if (u.indexOf('/api/ui/org/connect-status') >= 0) return json({ variant: 'selfhost', prereq: { vault_ready: true, callback_url: null }, can_collect: true, gateway_url: null,
      apps: [{ app: 'notion', label: '노션', app_ready: true, routes: [{ kind: 'app', state: 'collecting' }], recommended: 0, blocked_before: [],
        can_register: true, can_edit_registration: false, connect_url: null, skill: 'liv-connect-notion', note: null }] });
    return json({});
  };
</script>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(async function () {
  const R = {};
  const until = async (f, n = 200) => { for (let i = 0; i < n; i++) { const v = f(); if (v) return v; await window.__breathe(); } return null; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowsOf = (host) => Array.from(host.querySelectorAll('.cn-ws-row'));
  const cutOf = (row) => Array.from(row.querySelectorAll('button')).find((b) => b.textContent === '연결 끊기');
  const posts = () => window.__calls.filter((c) => c.method === 'POST' && c.u.indexOf('/api/ui/org/notion/workspace/disconnect') >= 0);
  const reads = () => window.__calls.filter((c) => c.method === 'GET' && c.u.indexOf('/api/ui/org/notion/collect') >= 0).length;
  const bad = (t) => /\\bnull\\b|\\bundefined\\b/.test(t);
  try {
    CN.state.me = { id: 'me', scopes: ['memory', 'admin'] };
    // W1 — 하나
    window.__ws = [window.__W('ws-1', '위시스트')];
    const one = document.getElementById('one');
    await CN.renderConnectApp(one, 'notion');
    const r1 = await until(() => { const r = rowsOf(one); return r.length ? r : null; });
    R.w1 = !!r1 && r1.length === 1 && r1[0].textContent.indexOf('위시스트') >= 0 && r1[0].textContent.indexOf('페이지 12개') >= 0
      && !r1[0].querySelector('input[type=checkbox]') && !!cutOf(r1[0]);
    // W2 — 둘
    window.__ws = [window.__W('ws-1', '위시스트'), window.__W('ws-2', '디자인', { enabled: false })];
    const two = document.getElementById('two');
    await CN.renderConnectApp(two, 'notion');
    const r2 = await until(() => { const r = rowsOf(two); return r.length === 2 ? r : null; });
    R.w2 = !!r2 && r2.every((row) => !!row.querySelector('input[type=checkbox]') && !!cutOf(row));
    // W3 — 취소
    const target = r2 && r2.find((row) => row.textContent.indexOf('디자인') >= 0);
    const p0 = posts().length;
    cutOf(target).click();
    const dlg = await until(() => document.querySelector('.ov-confirm'));
    const title = dlg ? (dlg.querySelector('h3') || {}).textContent || '' : '';
    const lines = dlg ? Array.from(dlg.querySelectorAll('.ov-confirm-line')).map((x) => x.textContent) : [];
    R.w3_dialog = title.indexOf('디자인') >= 0 && lines.length === 3
      && lines.some((l) => /이미 가져온 자료는 자료함에 남아요/.test(l)) && lines.some((l) => /다시 연결하고 켜면/.test(l)) && lines.some((l) => /노션에서 지울 수 있어요/.test(l));
    if (dlg) Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent === '취소').click();
    await sleep(80);
    R.w3_cancel = posts().length === p0 && !document.querySelector('.ov-confirm') && rowsOf(two).length === 2;
    // W4 — 확인
    const before = reads();
    cutOf(rowsOf(two).find((row) => row.textContent.indexOf('디자인') >= 0)).click();
    const dlg2 = await until(() => document.querySelector('.ov-confirm'));
    if (dlg2) Array.from(dlg2.querySelectorAll('button')).find((b) => b.textContent === '연결 끊기').click();
    const sent = await until(() => posts()[p0]);
    R.w4_post = !!sent && JSON.stringify(JSON.parse(sent.body)) === JSON.stringify({ workspace_id: 'ws-2' });
    const after = await until(() => { const r = rowsOf(two); return r.length === 1 && reads() > before ? r : null; });
    R.w4_repaint = !!after && after[0].textContent.indexOf('위시스트') >= 0 && after[0].textContent.indexOf('디자인') < 0;
    // W5 — 없음
    window.__ws = [];
    const none = document.getElementById('none');
    await CN.renderConnectApp(none, 'notion');
    await until(() => /노션|Notion/.test(none.innerText) && none.querySelector('#cn-collect-sect'));
    await until(() => reads() > 0 && !/불러오는 중/.test((none.querySelector('#cn-collect-sect') || {}).innerText || ''));
    R.w5 = !!none.querySelector('#cn-collect-sect') && rowsOf(none).length === 0
      && !Array.from(none.querySelectorAll('button')).some((b) => b.textContent === '연결 끊기');
    // W6
    R.w6 = !bad(one.innerText + two.innerText + none.innerText);
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = JSON.stringify(R) + 'ENDRESULT';
})();
</script></body></html>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "connect-notion-ws-", virtualTimeBudget: 30000, timeoutMs: 60000 });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  결과 표지를 못 받았다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 600)); process.exit(1); }
const R = JSON.parse(res.text.trim());
if (R.error) console.error("페이지 예외:", R.error);
let fails = 0, total = 0;
const check = (k, why) => { total++; const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
check("w1", "W1 워크스페이스 하나 — 줄 하나 · 이름 · 모은 페이지 수 · 토글 없음 · [연결 끊기]");
check("w2", "W2 워크스페이스 둘 — 줄마다 토글 + [연결 끊기]");
check("w3_dialog", "W3 확인 창 — 제목에 그 이름 · 사실 세 줄(자료 남음 · 다시 연결하고 켜면 이어서 · 노션 쪽은 노션에서)");
check("w3_cancel", "★W3 [취소] 면 보내지 않고 줄도 그대로");
check("w4_post", "W4 확인하면 POST /api/ui/org/notion/workspace/disconnect {workspace_id}");
check("w4_repaint", "W4 다시 그려 그 줄이 사라지고 다른 줄은 남는다");
check("w5", "W5 워크스페이스가 없으면 [연결 끊기] 가 없다");
check("w6", "W6 «null» · «undefined» 가 없다");
console.log(fails ? `\n${fails}건 실패` : `\n${total}건 통과`);
process.exit(fails ? 1 : 0);
