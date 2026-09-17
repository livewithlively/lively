#!/usr/bin/env node
// 자동 실행 카드 — 대표 잡과 끄기 — **런타임** 회귀 테스트 (#4052 끝단 확인 후속)
//
// 사양(엣지 표 S3 — 실측 2026-09-17: 한 단계에 같은 일을 하는 잡이 둘 켜진 워크스페이스):
//  K1 ★ 켜진 전용 잡(local-files 10분)이 목록 앞이어도 증류 카드는 전체 잡(30분)을 대표로 보인다 —
//      주기 칸의 값과 [지금 한 번 실행] 이 부르는 잡이 그 잡이다.
//  K2 ★ 스위치를 끄면 이 단계의 켜진 잡을 **전부** 끈다(요청이 잡마다 한 번) · 알림이 개수를 말한다.
//  K3 모두 꺼진 상태에서 켜면 전체 잡 **하나만** 켠다(꺼 둔 전용 잡은 되살리지 않는다).
//  K4 대표 조건이 없는 단계는 종전처럼 첫 켜진 잡이 대표 — 끄기는 역시 켜진 잡 전부.
//  K5 켜진 잡이 하나면 그 하나만 끄고, 알림에 개수를 붙이지 않는다.
//
// 왜 런타임인가: 스위치 → 요청의 대상·횟수는 소스 모양으로 안 보인다(#4052 사람 고르기 칸에서 소스 정규식이 놓친 교훈).
//  카드 모듈을 esbuild 로 묶어 헤드리스 크롬에 올리고, cron·실행 계정·명부 API 는 fetch 대역으로 준다.
// ⚠ 카드 문구가 한국어라 페이지를 통째로 숨긴다(body display:none) — 글자 조판 없이 이벤트·요청만 잰다
//  (글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다 — side-past-dim-runtime 머리말). 결과는 DOM 덤프에서 읽는다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 자동 실행 카드 런타임 검증 미실행");
  process.exit(0);
}

// 실제 소스 그대로 — 카드와 증류 명세가 넘기는 판정 함수. 대역은 fetch 하나뿐.
const bundle = buildSync({
  stdin: {
    contents: "export { stageJobCard } from './web/context-stage-job.ts';\nexport { isWholeDistillJob } from './web/lib/stage-job-pick.ts';\n",
    resolveDir: ROOT, loader: "ts", sourcefile: "stage-job-card-entry.ts",
  },
  bundle: true, format: "iife", globalName: "SJC", platform: "browser", target: "es2020",
  write: false, logLevel: "silent",
}).outputFiles[0].text;
const work = mkdtempSync(path.join(tmpdir(), "sjc-bundle-"));
const bundlePath = path.join(work, "sjc.js");
writeFileSync(bundlePath, bundle);

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{display:none}</style><body>
<div id="host"></div><div id="toasts"></div><pre id="out"></pre>
<script>
window.__posts = []; window.__runs = []; window.__jobs = []; window.__gets = 0;
const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = String(opts.method || 'GET').toUpperCase();
  const run = /\\/api\\/ui\\/cron\\/([^/?]+)\\/run/.exec(u);
  if (run && m === 'POST') { window.__runs.push(decodeURIComponent(run[1])); return J({ status: 'ok' }); }
  if (u.includes('/api/ui/cron') && m === 'POST') {
    const b = JSON.parse(opts.body || '{}');
    window.__posts.push({ id: b.id, enabled: b.enabled });
    const j = window.__jobs.find((x) => x.id === b.id);
    if (j && typeof b.enabled === 'boolean') j.enabled = b.enabled;
    return J({ job: j || null });
  }
  if (u.includes('/api/ui/cron')) { window.__gets++; return J({ jobs: JSON.parse(JSON.stringify(window.__jobs)) }); }
  if (u.includes('/api/ui/me/headless')) return J({ runner: { member: 'alice', source: 'db' } });
  if (u.includes('/api/ui/dash/members')) return J({ members: [{ id: 'alice', display_name: 'Alice Kim' }] });
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};
</script>
<script src="sjc.js"></script>
<script>
//  결과 표지는 실행 중에 조립한다 — 스크립트 본문의 표지 글자가 덤프에서 먼저 걸리지 않게.
const MK = ['SJC' + 'RESULT:', ':SJC' + 'END'];
//  알림 문구는 한국어다 — 덤프가 엔티티·인코딩을 거쳐도 깨지지 않게 \\u 로 적어 둔다.
const asc = (s) => String(s).replace(/[\\u0080-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
(async () => {
  const R = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById('host');
  const job = (id, enabled, interval_sec, params) => ({ id, label: id, action: 'distill_sources_headless', params, interval_sec, enabled,
    note: '', last_run_at: null, last_status: null, created_by: 'alice', sort: 0 });
  const DISTILL = {
    stage: 'Distill', actions: ['distill_sources_headless'], missingLine: 'none', usesAi: true, prefer: SJC.isWholeDistillJob,
    create: { id: 'distill-sources-headless', label: 'x', action: 'distill_sources_headless', params: {}, interval_sec: 1800, note: 'x' },
  };
  const PLAIN = Object.assign({}, DISTILL, { prefer: undefined });
  const render = async (spec) => { const card = await SJC.stageJobCard(spec, () => {}); host.replaceChildren(card); await wait(30); return card; };
  const sw = (card) => card.querySelector('input.cxc-sw');
  const flip = async (card) => { const s = sw(card); s.checked = !s.checked; s.dispatchEvent(new Event('change', { bubbles: true })); await wait(80); };
  const toasts = () => [...document.querySelectorAll('#toasts .toast')].map((t) => asc(t.textContent));
  const reset = (jobs) => { window.__jobs = jobs; window.__posts = []; window.__runs = []; document.getElementById('toasts').replaceChildren(); };

  // K1·K2 — 전용(앞) + 전체, 둘 다 켜짐
  reset([job('distill-local-files', true, 600, { distiller: 'local-files' }), job('distill-sources-headless', true, 1800, {})]);
  let card = await render(DISTILL);
  const sel = card.querySelector('select.cxr-sel');
  const runBtn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('\\uc9c0\\uae08 \\ud55c \\ubc88 \\uc2e4\\ud589'));
  R.k1 = { interval: sel ? sel.value : null, checked: sw(card) ? sw(card).checked : null, hasRun: !!runBtn };
  if (runBtn) { runBtn.click(); await wait(60); }
  R.k1.runs = window.__runs.slice();
  window.__posts = []; document.getElementById('toasts').replaceChildren();
  await flip(card);
  R.k2 = { posts: window.__posts.slice(), toasts: toasts() };

  // K3 — 모두 꺼짐에서 켜기
  reset([job('distill-local-files', false, 600, { distiller: 'local-files' }), job('distill-sources-headless', false, 1800, {})]);
  card = await render(DISTILL);
  R.k3 = { checkedBefore: sw(card) ? sw(card).checked : null, interval: card.querySelector('select.cxr-sel') ? card.querySelector('select.cxr-sel').value : null };
  await flip(card);
  R.k3.posts = window.__posts.slice();

  // K4 — 대표 조건 없음(종전 규칙) — 첫 켜진 잡이 대표, 끄기는 전부
  reset([job('distill-local-files', true, 600, { distiller: 'local-files' }), job('distill-sources-headless', true, 1800, {})]);
  card = await render(PLAIN);
  R.k4 = { interval: card.querySelector('select.cxr-sel') ? card.querySelector('select.cxr-sel').value : null };
  await flip(card);
  R.k4.posts = window.__posts.slice();

  // K5 — 켜진 잡 하나
  reset([job('distill-sources-headless', true, 1800, {})]);
  card = await render(DISTILL);
  await flip(card);
  R.k5 = { posts: window.__posts.slice(), toasts: toasts() };

  R.gets = window.__gets;
  document.getElementById('out').textContent = MK[0] + JSON.stringify(R) + MK[1];
})().catch((e) => { document.getElementById('out').textContent = MK[0] + JSON.stringify({ error: String((e && e.stack) || e) }) + MK[1]; });
</script>`;

let R;
try {
  const dom = await dumpDom(chrome, { html, copy: [bundlePath], prefix: "sjc-", marker: ":SJCEND" });
  const m = /SJCRESULT:(.*?):SJCEND/s.exec(dom);
  assert.ok(m, "결과 표지가 안 나왔다 — 페이지 스크립트가 끝나지 않았다\n" + dom.slice(0, 600));
  R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
assert.ok(!R.error, "페이지 오류: " + R.error);
const un = (s) => s.replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const OFF = (id) => ({ id, enabled: false });

// 배선 — cron 대역이 실제로 불렸다(안 불리면 카드는 «권한 없음» 으로 끝나 아래 단언이 헛돈다)
assert.ok(R.gets >= 4, `cron 목록을 장면마다 읽었다 — ${R.gets}`);
assert.equal(R.k1.checked, true, "K1 배선 — 켜진 카드가 그려졌다(스위치가 있다)");
assert.equal(R.k1.hasRun, true, "K1 배선 — [지금 한 번 실행] 이 있다");

// ★ K1
assert.equal(R.k1.interval, "1800", "★ K1 주기 칸이 전체 잡(30분)의 값이다 — 앞의 전용 잡(10분)이 아니다");
assert.deepEqual(R.k1.runs, ["distill-sources-headless"], "★ K1 [지금 한 번 실행] 이 전체 잡을 부른다");
// ★ K2
assert.deepEqual(R.k2.posts, [OFF("distill-local-files"), OFF("distill-sources-headless")], "★ K2 끄면 켜진 잡 둘 다 끈다");
assert.equal(R.k2.toasts.length, 1, "K2 알림 한 번");
assert.match(un(R.k2.toasts[0]), /2개/, "K2 알림이 끈 개수를 말한다");
// K3
assert.equal(R.k3.checkedBefore, false, "K3 배선 — 꺼진 카드");
assert.equal(R.k3.interval, "1800", "K3 모두 꺼져 있어도 대표는 전체 잡");
assert.deepEqual(R.k3.posts, [{ id: "distill-sources-headless", enabled: true }], "K3 켜면 전체 잡 하나만 — 전용 잡은 꺼진 채");
// K4
assert.equal(R.k4.interval, "600", "K4 대표 조건이 없으면 종전처럼 첫 켜진 잡");
assert.deepEqual(R.k4.posts, [OFF("distill-local-files"), OFF("distill-sources-headless")], "K4 끄기는 켜진 잡 전부");
// K5
assert.deepEqual(R.k5.posts, [OFF("distill-sources-headless")], "K5 하나면 그 하나만");
assert.equal(R.k5.toasts.length, 1, "K5 알림 한 번");
assert.doesNotMatch(un(R.k5.toasts[0]), /개\)/, "K5 하나일 땐 개수를 붙이지 않는다");

console.log("✓ stage-job-card-runtime — K1~K5 (전체 잡 대표 · 끄기 전부 · 켜기 하나 · 종전 규칙 · 하나)");
