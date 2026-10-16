#!/usr/bin/env node
// 관리탭 «앱 보관» 화면 — 런타임 시험 (#4733 앱 v2-19 보관 표 2026-10-15 · #4778 앱 폴더 2026-10-16)
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  ① 보관 표 카드
//  1 목록 — 요약 줄(보관 표 수 · 크기 · 워크스페이스 표 수/한도) · 행마다 앱(기록 · 이름 짐작 · 주인 모름) · 무엇(칸의 값 · 표 통째) · 행 · 까닭
//  2 아무것도 안 골랐으면 비우기 단추는 막혀 있다 · 둘 고르면 «고른 2개 비우기»
//  3 비우기 → 확인 창(고른 이름이 보인다) → «비우기» → POST /api/ui/app-archives/clear {names:[고른 것]} → 결과 알림 · 목록을 다시 읽는다
//  4 확인 창에서 취소하면 아무것도 보내지 않는다
//  5 보관 표가 없으면 «보관 표가 없습니다»
//  6 목록을 못 읽으면 까닭을 보여 준다(화면이 죽지 않는다)
//  ② 보관한 앱 폴더 카드(#4778)
//  F1 목록 — 요약 줄(수 · 크기 · 보관 일수) · 행마다 앱(파일 없으면 «(파일 없음)») · 크기 · 파일(세다 멈췄으면 «이상») · 어디서(입구 · 누가) · 지울 때(«N일 뒤»)
//  F2 «되돌리기» 단추는 같은 이름의 앱이 지금 있고 파일이 있는 보관에만
//  F3 비우기 → 확인 창(앱 이름이 보인다 · 되살릴 수 없다) → POST /api/ui/app-folder-archives/clear {names} → 알림 · 다시 읽는다
//  F4 되돌리기 → 확인 창 → 취소면 아무것도 안 보냄 · 확인이면 POST …/restore {name} → 알림 · 다시 읽는다
//  F5 보관이 없으면 «보관한 앱 폴더가 없습니다» · 앱 폴더 자리를 못 훑었으면 그 까닭 한 줄 · 고아가 없으면 고아 카드를 숨긴다
//  F6 목록을 못 읽으면 까닭(화면이 죽지 않는다 · 보관 표 카드는 그대로)
//  ③ 앱 없는 앱 폴더 카드(#4778)
//  O1 고아가 있으면 카드가 보이고 행마다 앱 이름 · 크기 · 파일 · 아무것도 안 골랐으면 단추가 막혀 있다
//  O2 고르고 «보관으로 옮기기» → 확인 창 → POST /api/ui/app-folder-archives/orphans {app_ids} → 알림 · 다시 읽는다
//
// 왜 런타임인가: 화면은 서버 응답의 칸 이름(archives · table_limit · owner · kind · entry · app_exists · missing …)에 기대어 그린다 —
//  타입 검사는 응답 모양을 모른다. 실제 화면 모듈(web/admin-app-archives.ts)을 묶어 진짜 DOM 에서 돌리고, 서버 자리(fetch)만 정해진 응답으로 바꾼다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱 보관 화면 런타임 검증 미실행");
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

//  보관한 앱 폴더 — 되돌릴 수 있는 것(crm) · 같은 이름의 앱이 없는 것(memo · 세다 멈춤) · 파일이 사라진 것(gone).
const FN = { crm: ".archived-app.crm.20261015000000Z.aaaaaa", memo: ".archived-app.memo.20261014000000Z.bbbbbb", gone: ".archived-app.gone.20261013000000Z.cccccc" };
const FLIST = (expiresAt) => ({
  keep_days: 7, count: 3, bytes: 5000, orphan_count: 1, orphan_bytes: 7,
  archives: [
    { name: FN.crm, app_id: "crm", archived_at: "2026-10-15T00:00:00.000Z", archived_by: "pgt-admin", entry: "remove", kind: "dir", files: 3, bytes: 4096, truncated: false, expires_at: expiresAt, app_exists: true },
    { name: FN.memo, app_id: "memo", archived_at: "2026-10-14T00:00:00.000Z", archived_by: "pgt-maker", entry: "create", kind: "dir", files: 50000, bytes: 904, truncated: true, expires_at: expiresAt, app_exists: false },
    { name: FN.gone, app_id: "gone", archived_at: "2026-10-13T00:00:00.000Z", archived_by: null, entry: "unknown", kind: "dir", files: 1, bytes: 0, truncated: false, expires_at: expiresAt, app_exists: true, missing: true },
  ],
  orphans: [{ app_id: "lost-app", kind: "dir", files: 1, bytes: 7, truncated: false }],
});

const PAGE = `<!doctype html><meta charset="utf-8">
<div id="toasts"></div><div id="d1"></div><div id="d2"></div><div id="d3"></div>
<pre id="out">PENDING</pre>
<script>
  window.__calls = []; window.__mode = 'list'; window.__fmode = 'list';
  const LIST = ${JSON.stringify(LIST)};
  const FN = ${JSON.stringify(FN)};
  const FLIST = (${FLIST.toString()})(new Date(Date.now() + 3 * 864e5 + 2 * 3600e3).toISOString());
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    window.__calls.push({ u, method, body: opts.body || null });
    if (u.indexOf('/api/ui/app-folder-archives/clear') >= 0) {
      const names = JSON.parse(opts.body).names;
      return json({ ok: true, cleared: names.map((n) => ({ name: n, app_id: 'x' })), kept: [], missing: [] });
    }
    if (u.indexOf('/api/ui/app-folder-archives/restore') >= 0) return json({ ok: true, restored: JSON.parse(opts.body).name, app_id: 'crm' });
    if (u.indexOf('/api/ui/app-folder-archives/orphans') >= 0) {
      const ids = JSON.parse(opts.body).app_ids;
      return json({ ok: true, archived: ids.map((id) => ({ app_id: id, name: '.archived-app.' + id + '.20261016000000Z.dddddd' })), skipped: [] });
    }
    if (u.indexOf('/api/ui/app-folder-archives') >= 0) {
      if (window.__fmode === 'empty') return json({ keep_days: 7, count: 0, bytes: 0, orphan_count: 0, orphan_bytes: 0, archives: [], orphans: [], scan_error: 'EACCES: 헬퍼가 없다' });
      if (window.__fmode === 'fail') return json({ error: '앱 폴더 자리를 읽지 못했습니다' }, 500);
      return json(FLIST);
    }
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
  const gets = (p) => window.__calls.filter((c) => c.method === 'GET' && c.u.indexOf(p) >= 0 && c.u.indexOf(p + '/') < 0).length;
  const posts = () => window.__calls.filter((c) => c.method === 'POST');
  const toasts = () => (document.getElementById('toasts') || {}).textContent || '';
  const confirmDlg = () => until(() => document.querySelector('.ov-confirm'));
  try {
    // ── ① 보관 표 ──
    const d1 = document.getElementById('d1');
    AA.appArchivesEditor(d1, {});
    const tables = await until(() => d1.querySelector('.aa-tables'));
    const rows = await until(() => { const r = tables.querySelectorAll('tbody tr'); return r.length ? r : null; });
    const cells = rows ? Array.from(rows).map((tr) => Array.from(tr.children).slice(1).map((td) => td.textContent.trim())) : [];
    const summary = (tables.querySelector('.storage-calc') || {}).textContent || '';
    R.w_fetch_used = window.__calls.some((c) => c.u.indexOf('/api/ui/app-archives') >= 0);
    R.r1_rows = !!rows && rows.length === 3;
    R.r1_summary = /보관 표 3개/.test(summary) && /워크스페이스 표 10개 \\/ 한도 500개/.test(summary) && /쓰는 표 7 · 보관 표 3/.test(summary);
    R.r1_owner = cells.length === 3 && cells[0][0] === 'crm' && cells[1][0] === 'old-app (이름으로 짐작)' && cells[2][0] === '주인 모름';
    R.r1_what = cells.length === 3 && cells[0][1] === 'deals.note 칸의 값' && cells[1][1] === 'logs 표 통째' && cells[2][1] === '표 통째';
    R.r1_rows_reason = cells.length === 3 && cells[0][2] === '2행' && cells[1][2] === '5행' && cells[2][2] === '?' && cells[0][5] === '공개' && cells[1][5] === '';
    R.cells = cells; R.summary = summary;
    const btn = tables.querySelector('.admin-actions button');
    R.r2_disabled_when_none = !!btn && btn.disabled === true;
    const boxes = Array.from(tables.querySelectorAll('tbody input[type=checkbox]'));
    boxes[0].click(); boxes[2].click();
    R.r2_two_picked = btn.disabled === false && /고른 2개 비우기/.test(btn.textContent);
    btn.click();
    let dlg = await confirmDlg();
    const lines = dlg ? Array.from(dlg.querySelectorAll('.ov-confirm-line')).map((p) => p.textContent) : [];
    R.r3_dialog_names = !!dlg && lines.join(',') === 'crm__deals__note__20261015094708,old-backup';
    dlg.querySelector('.ov-confirm-acts .btn-ghost').click();
    await sleep(50);
    R.r4_cancel_sends_nothing = !posts().length && !document.querySelector('.ov-confirm');
    const before = gets('/api/ui/app-archives');
    btn.click();
    dlg = await confirmDlg();
    dlg.querySelector('.ov-confirm-acts .btn-danger').click();
    const post = await until(() => posts().find((c) => c.u.indexOf('/api/ui/app-archives/clear') >= 0));
    R.r3_post_names = !!post && JSON.stringify(JSON.parse(post.body)) === JSON.stringify({ names: ['crm__deals__note__20261015094708', 'old-backup'] });
    R.r3_reloaded = !!(await until(() => gets('/api/ui/app-archives') > before));
    R.r3_toast = !!(await until(() => /2개 비웠어요/.test(toasts())));

    // ── ② 보관한 앱 폴더 ──
    const folders = d1.querySelector('.aa-folders');
    const frows = await until(() => { const r = folders.querySelectorAll('tbody tr'); return r.length === 3 ? r : null; });
    const fcells = frows ? Array.from(frows).map((tr) => Array.from(tr.children).slice(1).map((td) => td.textContent.trim())) : [];
    const fsum = (folders.querySelector('.storage-calc') || {}).textContent || '';
    R.f_fetch_used = gets('/api/ui/app-folder-archives') >= 1;
    R.f1_summary = /보관한 앱 폴더 3개/.test(fsum) && /보관 기간 7일/.test(fsum);
    R.f1_cells = fcells.length === 3
      && fcells[0][0] === 'crm' && /KB/.test(fcells[0][1]) && fcells[0][2] === '3개' && fcells[0][4] === '관리자가 앱을 지움 · pgt-admin' && fcells[0][5] === '3일 뒤'
      && / 이상$/.test(fcells[1][1]) && fcells[1][2] === '50000개 이상' && fcells[1][4] === '같은 이름으로 새로 만듦 · pgt-maker'
      && fcells[2][0] === 'gone (파일 없음)' && fcells[2][1] === '—' && fcells[2][2] === '—' && fcells[2][4] === '기록 없음';
    R.fcells = fcells;
    const restoreBtns = frows ? Array.from(frows).map((tr) => !!tr.querySelector('.aa-restore')) : [];
    R.f2_restore_only_restorable = restoreBtns.join(',') === 'true,false,false';
    //  F4 되돌리기 — 취소 먼저
    const fposts0 = posts().length;
    frows[0].querySelector('.aa-restore').click();
    dlg = await confirmDlg();
    R.f4_dialog = !!dlg && /「crm」 앱 폴더를 되돌릴까요/.test(dlg.textContent);
    dlg.querySelector('.ov-confirm-acts .btn-ghost').click();
    await sleep(50);
    R.f4_cancel_sends_nothing = posts().length === fposts0 && !document.querySelector('.ov-confirm');
    const fbefore = gets('/api/ui/app-folder-archives');
    frows[0].querySelector('.aa-restore').click();
    dlg = await confirmDlg();
    dlg.querySelector('.ov-confirm-acts button:last-child').click();
    const rpost = await until(() => posts().find((c) => c.u.indexOf('/api/ui/app-folder-archives/restore') >= 0));
    R.f4_post = !!rpost && JSON.stringify(JSON.parse(rpost.body)) === JSON.stringify({ name: '${FN.crm}' });
    R.f4_toast_reload = !!(await until(() => /crm.{0,3}앱 폴더를 되돌렸어요/.test(toasts()))) && !!(await until(() => gets('/api/ui/app-folder-archives') > fbefore));
    //  F3 비우기
    const frows2 = await until(() => { const r = d1.querySelectorAll('.aa-folders tbody tr'); return r.length === 3 ? r : null; });
    const fbtn = d1.querySelector('.aa-folders .admin-actions button');
    R.f3_disabled_when_none = !!fbtn && fbtn.disabled === true;
    frows2[1].querySelector('input[type=checkbox]').click();
    R.f3_one_picked = fbtn.disabled === false && /고른 1개 비우기/.test(fbtn.textContent);
    const fbefore2 = gets('/api/ui/app-folder-archives');
    fbtn.click();
    dlg = await confirmDlg();
    const flines = dlg ? Array.from(dlg.querySelectorAll('.ov-confirm-line')).map((p) => p.textContent) : [];
    R.f3_dialog = !!dlg && flines.join(',') === 'memo' && /되살릴 수 없습니다/.test(dlg.textContent);
    dlg.querySelector('.ov-confirm-acts .btn-danger').click();
    const cpost = await until(() => posts().find((c) => c.u.indexOf('/api/ui/app-folder-archives/clear') >= 0));
    R.f3_post = !!cpost && JSON.stringify(JSON.parse(cpost.body)) === JSON.stringify({ names: ['${FN.memo}'] });
    R.f3_toast_reload = !!(await until(() => /1개 비웠어요/.test(toasts()))) && !!(await until(() => gets('/api/ui/app-folder-archives') > fbefore2));

    // ── ③ 앱 없는 앱 폴더 ──
    const orph = await until(() => { const c = d1.querySelector('.aa-orphans'); return c && !c.hidden && c.querySelector('tbody tr') ? c : null; });
    const orows = orph ? Array.from(orph.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).slice(1).map((td) => td.textContent.trim())) : [];
    const obtn = orph ? orph.querySelector('.admin-actions button') : null;
    R.o1_card = !!orph && orows.length === 1 && orows[0][0] === 'lost-app' && orows[0][1] === '7B' && orows[0][2] === '1개' && !!obtn && obtn.disabled === true;
    R.orows = orows;
    orph.querySelector('tbody input[type=checkbox]').click();
    R.o2_picked = /고른 1개 보관으로 옮기기/.test(obtn.textContent) && obtn.disabled === false;
    const obefore = gets('/api/ui/app-folder-archives');
    obtn.click();
    dlg = await confirmDlg();
    R.o2_dialog = !!dlg && /앱 없는 앱 폴더 1개를 보관으로 옮길까요/.test(dlg.textContent) && /보관 기간\\(7일\\)/.test(dlg.textContent);
    dlg.querySelector('.ov-confirm-acts button:last-child').click();
    const opost = await until(() => posts().find((c) => c.u.indexOf('/api/ui/app-folder-archives/orphans') >= 0));
    R.o2_post = !!opost && JSON.stringify(JSON.parse(opost.body)) === JSON.stringify({ app_ids: ['lost-app'] });
    R.o2_toast_reload = !!(await until(() => /1개 옮겼어요/.test(toasts()))) && !!(await until(() => gets('/api/ui/app-folder-archives') > obefore));

    // ── 비었음 · 못 읽음 ──
    window.__mode = 'empty'; window.__fmode = 'empty';
    const d2 = document.getElementById('d2');
    AA.appArchivesEditor(d2, {});
    R.r5_empty = !!(await until(() => /보관 표가 없습니다/.test(d2.textContent)));
    R.f5_empty = !!(await until(() => /보관한 앱 폴더가 없습니다/.test(d2.textContent))) && /앱 폴더 자리를 훑지 못해 기록만 보입니다: EACCES/.test(d2.textContent)
      && d2.querySelector('.aa-orphans').hidden === true;
    window.__mode = 'fail'; window.__fmode = 'fail';
    const d3 = document.getElementById('d3');
    AA.appArchivesEditor(d3, {});
    R.r6_error = !!(await until(() => /보관 표를 불러오지 못했습니다/.test(d3.textContent)));
    R.f6_error = !!(await until(() => /보관한 앱 폴더를 불러오지 못했습니다/.test(d3.textContent))) && d3.querySelector('.aa-orphans').hidden === true;
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "admin-app-archives-", virtualTimeBudget: 12000 });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  결과 표지를 못 받았다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 600)); process.exit(1); }
const R = JSON.parse(res.text.trim());
if (R.error) console.error("페이지 예외:", R.error);
let fails = 0, total = 0;
const check = (k, why) => { total++; const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
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
check("f_fetch_used", "(배선) 앱 폴더 카드가 /api/ui/app-folder-archives 를 실제로 불렀다");
check("f1_summary", "F1 요약 줄 — 보관한 앱 폴더 수 · 보관 기간");
check("f1_cells", "F1 칸 — 앱(파일 없으면 «(파일 없음)») · 크기 · 파일(세다 멈췄으면 «이상») · 어디서(입구 · 누가) · 지울 때(«3일 뒤»)");
check("f2_restore_only_restorable", "F2 «되돌리기» 는 같은 이름의 앱이 있고 파일이 있는 보관에만");
check("f4_dialog", "F4 되돌리기 확인 창에 앱 이름");
check("f4_cancel_sends_nothing", "F4 취소하면 아무것도 보내지 않는다");
check("f4_post", "F4 확인하면 POST /api/ui/app-folder-archives/restore {name}");
check("f4_toast_reload", "F4 되돌린 결과 알림 · 다시 읽는다");
check("f3_disabled_when_none", "F3 아무것도 안 골랐으면 비우기 단추가 막혀 있다");
check("f3_one_picked", "F3 하나 고르면 «고른 1개 비우기»");
check("f3_dialog", "F3 확인 창에 앱 이름 · «되살릴 수 없습니다»");
check("f3_post", "F3 «비우기» → POST /api/ui/app-folder-archives/clear {names}");
check("f3_toast_reload", "F3 비운 결과 알림 · 다시 읽는다");
check("o1_card", "O1 고아 카드 — 앱 이름 · 크기 · 파일 · 고르기 전엔 단추가 막혀 있다");
check("o2_picked", "O2 고르면 «고른 1개 보관으로 옮기기»");
check("o2_dialog", "O2 확인 창 — 몇 개 · 보관 기간");
check("o2_post", "O2 확인하면 POST /api/ui/app-folder-archives/orphans {app_ids}");
check("o2_toast_reload", "O2 옮긴 결과 알림 · 다시 읽는다");
check("r5_empty", "5 보관 표가 없으면 «보관 표가 없습니다»");
check("f5_empty", "F5 보관한 앱 폴더가 없으면 «없습니다» · 훑기 실패 까닭 한 줄 · 고아 카드 숨김");
check("r6_error", "6 목록을 못 읽으면 까닭을 보여 준다");
check("f6_error", "F6 앱 폴더 목록을 못 읽으면 까닭 · 고아 카드 숨김");
if (fails) console.log(JSON.stringify({ cells: R.cells, summary: R.summary, fcells: R.fcells, orows: R.orows }));
console.log(fails ? `\n${fails}건 실패` : `\n${total}건 통과`);
process.exit(fails ? 1 : 0);
