#!/usr/bin/env node
// 관리탭 «앱 보관 표» 화면 — 런타임 시험 (#4733 앱 v2-19, 2026-10-15)
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  1 목록 — 요약 줄(보관 표 수 · 크기 · 워크스페이스 표 수/한도) · 행마다 앱(기록 · 이름 짐작 · 주인 모름) · 무엇(칸의 값 · 표 통째) · 행 · 까닭
//  2 아무것도 안 골랐으면 비우기 단추는 막혀 있다 · 둘 고르면 «고른 2개 비우기»
//  3 비우기 → 확인 창(고른 이름이 보인다) → «비우기» → POST /api/ui/app-archives/clear {names:[고른 것]} → 결과 알림 · 목록을 다시 읽는다
//  4 확인 창에서 취소하면 아무것도 보내지 않는다
//  5 보관 표가 없으면 «보관 표가 없습니다»
//  6 목록을 못 읽으면 까닭을 보여 준다(화면이 죽지 않는다)
//
// 왜 런타임인가: 화면은 서버 응답의 칸 이름(archives · table_limit · owner · kind …)에 기대어 그린다 — 타입 검사는 응답 모양을 모른다.
//  실제 화면 모듈(web/admin-app-archives.ts)을 묶어 진짜 DOM 에서 돌리고, 서버 자리(fetch)만 정해진 응답으로 바꾼다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱 보관 표 화면 런타임 검증 미실행");
  process.exit(0);
}
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }

const bundle = execFileSync(ESBUILD, [
  path.join(ROOT, "web/admin-app-archives.ts"), "--bundle", "--format=iife", "--global-name=AA", "--platform=browser", "--log-level=error",
], { encoding: "utf8" });

const LIST = {
  schema: "app_x_archive", count: 3, bytes: 3 * 16384,
  table_limit: { limit: 500, current: 7, archived: 3 },
  archives: [
    { name: "crm__deals__note__20261015094708", app_id: "crm", owner: "recorded", kind: "column", table: "deals", column: "note", rows: 2, bytes: 16384, archived_at: "2026-10-15T09:47:08.000Z", reason: "publish", columns: ["tenant_id", "id", "value"] },
    { name: "old_app__logs__20250101000000", app_id: "old-app", owner: "guessed", kind: "table", table: "logs", column: null, rows: 5, bytes: 16384, archived_at: "2025-01-01T00:00:00.000Z", reason: null, columns: ["tenant_id", "id", "line", "created_at"] },
    { name: "old-backup", app_id: null, owner: "unknown", kind: "table", table: null, column: null, rows: null, bytes: 16384, archived_at: null, reason: null, columns: ["x"] },
  ],
};

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="toasts"></div><div id="d1"></div><div id="d2"></div><div id="d3"></div>
<pre id="out">PENDING</pre>
<script>
  window.__calls = []; window.__mode = 'list';
  const LIST = ${JSON.stringify(LIST)};
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    window.__calls.push({ u, method, body: opts.body || null });
    if (u.indexOf('/api/ui/app-archives/clear') >= 0) {
      const names = JSON.parse(opts.body).names;
      return json({ ok: true, taken_at: '2026-10-15T00:00:00.000Z', cleared: names.map((n) => ({ name: n, app_id: null, rows: 1 })), kept: [], missing: [] });
    }
    if (u.indexOf('/api/ui/app-archives') >= 0) {
      if (window.__mode === 'empty') return json({ schema: 'app_x_archive', count: 0, bytes: 0, table_limit: { limit: 500, current: 7, archived: 0 }, archives: [] });
      if (window.__mode === 'fail') return json({ error: '보관 자리를 읽지 못했습니다' }, 500);
      return json(LIST);
    }
    return json({}, 404);
  };
</script>
<script>${bundle}</script>
<script>
(async function () {
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, n = 100) => { for (let i = 0; i < n; i++) { const v = f(); if (v) return v; await sleep(20); } return null; };
  const gets = () => window.__calls.filter((c) => c.method === 'GET' && c.u.indexOf('/api/ui/app-archives') >= 0).length;
  try {
    // 1 목록
    const d1 = document.getElementById('d1');
    AA.appArchivesEditor(d1, {});
    const rows = await until(() => { const r = d1.querySelectorAll('tbody tr'); return r.length ? r : null; });
    const cells = rows ? Array.from(rows).map((tr) => Array.from(tr.children).slice(1).map((td) => td.textContent.trim())) : [];
    const summary = (d1.querySelector('.storage-calc') || {}).textContent || '';
    R.w_fetch_used = window.__calls.some((c) => c.u.indexOf('/api/ui/app-archives') >= 0);
    R.r1_rows = !!rows && rows.length === 3;
    R.r1_summary = /보관 표 3개/.test(summary) && /워크스페이스 표 10개 \\/ 한도 500개/.test(summary) && /쓰는 표 7 · 보관 표 3/.test(summary);
    R.r1_owner = cells.length === 3 && cells[0][0] === 'crm' && cells[1][0] === 'old-app (이름으로 짐작)' && cells[2][0] === '주인 모름';
    R.r1_what = cells.length === 3 && cells[0][1] === 'deals.note 칸의 값' && cells[1][1] === 'logs 표 통째' && cells[2][1] === '표 통째';
    R.r1_rows_reason = cells.length === 3 && cells[0][2] === '2행' && cells[1][2] === '5행' && cells[2][2] === '?' && cells[0][5] === '공개' && cells[1][5] === '';
    R.cells = cells; R.summary = summary;
    // 2 고르기
    const btn = d1.querySelector('.admin-actions button');
    R.r2_disabled_when_none = !!btn && btn.disabled === true;
    const boxes = Array.from(d1.querySelectorAll('tbody input[type=checkbox]'));
    boxes[0].click(); boxes[2].click();
    R.r2_two_picked = btn.disabled === false && /고른 2개 비우기/.test(btn.textContent);
    // 4 취소 — 아무것도 안 보낸다
    btn.click();
    let dlg = await until(() => document.querySelector('.ov-confirm'));
    const lines = dlg ? Array.from(dlg.querySelectorAll('.ov-confirm-line')).map((p) => p.textContent) : [];
    R.r3_dialog_names = !!dlg && lines.join(',') === 'crm__deals__note__20261015094708,old-backup';
    dlg.querySelector('.ov-confirm-acts .btn-ghost').click();
    await sleep(50);
    R.r4_cancel_sends_nothing = !window.__calls.some((c) => c.method === 'POST') && !document.querySelector('.ov-confirm');
    // 3 비우기
    const before = gets();
    btn.click();
    dlg = await until(() => document.querySelector('.ov-confirm'));
    dlg.querySelector('.ov-confirm-acts .btn-danger').click();
    const post = await until(() => window.__calls.find((c) => c.method === 'POST'));
    R.r3_post_names = !!post && post.u.indexOf('/api/ui/app-archives/clear') >= 0 && JSON.stringify(JSON.parse(post.body)) === JSON.stringify({ names: ['crm__deals__note__20261015094708', 'old-backup'] });
    R.r3_reloaded = !!(await until(() => gets() > before));
    R.r3_toast = !!(await until(() => /2개 비웠어요/.test((document.getElementById('toasts') || {}).textContent || '')));
    // 5 비었음
    window.__mode = 'empty';
    const d2 = document.getElementById('d2');
    AA.appArchivesEditor(d2, {});
    R.r5_empty = !!(await until(() => /보관 표가 없습니다/.test(d2.textContent)));
    // 6 못 읽음
    window.__mode = 'fail';
    const d3 = document.getElementById('d3');
    AA.appArchivesEditor(d3, {});
    R.r6_error = !!(await until(() => /보관 표를 불러오지 못했습니다/.test(d3.textContent)));
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "admin-app-archives-", virtualTimeBudget: 8000 });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  결과 표지를 못 받았다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 600)); process.exit(1); }
const R = JSON.parse(res.text.trim());
if (R.error) console.error("페이지 예외:", R.error);
let fails = 0;
const check = (k, why) => { const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
check("w_fetch_used", "(배선) 화면이 서버 자리(/api/ui/app-archives)를 실제로 불렀다 — 가짜 응답이 화면에 닿는다는 증거");
check("r1_rows", "1 보관 표 셋이 표의 행 셋으로");
check("r1_summary", "1 요약 줄 — 보관 표 수 · 워크스페이스 표 수/한도 · 쓰는 표/보관 표");
check("r1_owner", "1 앱 칸 — 기록이면 앱 id · 짐작이면 «(이름으로 짐작)» · 모르면 «주인 모름»");
check("r1_what", "1 무엇 칸 — 칸 보관은 «표.칸 칸의 값» · 통째는 «표 표 통째»");
check("r1_rows_reason", "1 행 · 까닭 칸 — 모르는 행 수는 «?» · 까닭 publish 는 «공개»");
check("r2_disabled_when_none", "2 아무것도 안 골랐으면 비우기 단추가 막혀 있다");
check("r2_two_picked", "2 둘 고르면 «고른 2개 비우기» 로 열린다");
check("r3_dialog_names", "3 확인 창에 고른 이름이 보인다");
check("r4_cancel_sends_nothing", "4 확인 창에서 취소하면 아무것도 보내지 않는다");
check("r3_post_names", "3 «비우기» 를 누르면 고른 이름으로 POST /api/ui/app-archives/clear");
check("r3_reloaded", "3 비운 뒤 목록을 다시 읽는다");
check("r3_toast", "3 비운 결과를 알린다(«2개 비웠어요»)");
check("r5_empty", "5 보관 표가 없으면 «보관 표가 없습니다»");
check("r6_error", "6 목록을 못 읽으면 까닭을 보여 준다");
if (fails) console.log(JSON.stringify({ cells: R.cells, summary: R.summary }));
console.log(fails ? `\n${fails}건 실패` : "\n15건 통과");
process.exit(fails ? 1 : 0);
