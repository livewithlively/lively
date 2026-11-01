#!/usr/bin/env node
// 증류를 손으로 돌리기 전의 확인창 — **런타임** 회귀 테스트(#5235).
//
// 사양(엣지 표 Q — 카드의 [지금 한 번 실행] 을 실제로 누른다):
//  Q1 기본 기준으로 나갈 자료가 없으면 묻지 않고 실행한다(본문 {}).
//  Q2 증류기 몫과 함께 나갈 때 취소하면 실행 0건 · 단추가 돌아온다.
//  Q3 체크를 끈 채 [실행] → 본문 {"lanes_only":true} — 읽지 않고 눌러도 안전한 쪽이 기본이다.
//  Q4 체크를 켜고 [실행] → 본문 {}.
//  Q5 기본 기준 배치뿐일 때 취소 → 실행 0건. Q6 [실행] → 본문 {}.
//  Q7 ★ 옛 게이트웨이(계획 경로 404) → 창 없이 **실행 0건** · 실패 알림. 배포·롤백 중 새 화면이 옛 코어를 만나는 자리다.
//  Q8 ★ 계획 응답에 plan 이 없음(200) → 실행 0건 · 실패 알림. «모름» 을 «물을 것 없음» 으로 접지 않는다.
//  Q9 Esc 로 닫아도 취소다.
//
// 왜 런타임인가: 취소 뒤 실행이 안 나가는지 · 체크 기본값이 무엇인지는 소스 모양으로 안 보인다. 소스 정규식 시험은 이 동작을 뒤집는
//  변이 다섯에 전부 초록이었다(#5235 격리 리뷰). 카드와 확인창을 esbuild 로 묶어 헤드리스 크롬에 올리고 fetch 만 대역으로 준다.
// ⚠ 문구가 한국어라 페이지를 통째로 숨긴다(body display:none) — stage-job-card-runtime 머리말과 같은 까닭. 결과는 DOM 덤프에서 읽는다.
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
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 증류 확인창 런타임 검증 미실행");
  process.exit(0);
}

// 실제 소스 그대로 — 대역은 fetch 하나뿐.
const bundle = buildSync({
  stdin: {
    contents: "export { stageJobCard } from './web/context-stage-job.ts';\nexport { confirmDistillRun } from './web/distill-run-check.ts';\n",
    resolveDir: ROOT, loader: "ts", sourcefile: "distill-run-check-entry.ts",
  },
  bundle: true, format: "iife", globalName: "DRC", platform: "browser", target: "es2020",
  write: false, logLevel: "silent",
}).outputFiles[0].text;
const work = mkdtempSync(path.join(tmpdir(), "drc-bundle-"));
const bundlePath = path.join(work, "drc.js");
writeFileSync(bundlePath, bundle);

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{display:none}</style><body>
<div id="host"></div><div id="toasts"></div><pre id="out"></pre>
<script>
window.__runs = []; window.__plans = 0; window.__plan = null;
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = String(opts.method || 'GET').toUpperCase();
  if (/\\/api\\/ui\\/cron\\/[^/?]+\\/run-plan/.test(u)) { window.__plans++; return J(window.__plan.body, window.__plan.status); }
  if (/\\/api\\/ui\\/cron\\/[^/?]+\\/run/.test(u) && m === 'POST') { window.__runs.push(String(opts.body || '')); return J({ status: 'ok' }); }
  if (u.includes('/api/ui/cron')) return J({ jobs: [{ id: 'distill-sources-headless', label: 'x', action: 'distill_sources_headless', params: {}, interval_sec: 1800, enabled: true, note: '', last_run_at: null, last_status: null, created_by: 'alice', sort: 0 }] });
  if (u.includes('/api/ui/me/headless')) return J({ runner: { member: 'alice', source: 'db' } });
  if (u.includes('/api/ui/dash/members')) return J({ members: [{ id: 'alice', display_name: 'Alice Kim' }] });
  return J({}, 404);
};
</script>
<script src="drc.js"></script>
<script>
const MK = ['DRC' + 'RESULT:', ':DRC' + 'END'];
(async () => {
  const R = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById('host');
  const SPEC = {
    stage: 'Distill', actions: ['distill_sources_headless'], missingLine: 'none', usesAi: true,
    create: { id: 'distill-sources-headless', label: 'x', action: 'distill_sources_headless', params: {}, interval_sec: 1800, note: 'x' },
    beforeRun: (job) => DRC.confirmDistillRun(String(job.id)),
  };
  const lane = { distiller: 'liv-a', sources: 2, backlog: 2 };
  const PLAN = {
    none: { status: 200, body: { id: 'x', plan: { lanes: [lane], unassigned: null } } },
    choose: { status: 200, body: { id: 'x', plan: { lanes: [lane], unassigned: { sources: 50, total: 62 } } } },
    only: { status: 200, body: { id: 'x', plan: { lanes: [], unassigned: { sources: 3, total: 3 } } } },
    gone: { status: 404, body: { error: 'not found' } },
    empty: { status: 200, body: { id: 'x' } },
  };
  const scene = async (name, plan, act) => {
    window.__runs = []; window.__plans = 0; window.__plan = PLAN[plan];
    document.getElementById('toasts').replaceChildren();
    document.querySelectorAll('.ov-confirm-back').forEach((n) => n.remove());
    const card = await DRC.stageJobCard(SPEC, () => {});
    host.replaceChildren(card);
    await wait(30);
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('\\uc9c0\\uae08 \\ud55c \\ubc88 \\uc2e4\\ud589'));
    btn.click();
    await wait(60);
    const box = document.querySelector('.ov-confirm');
    const info = { hadDialog: !!box, checkbox: box ? !!box.querySelector('input[type=checkbox]') : null, checked: box && box.querySelector('input[type=checkbox]') ? box.querySelector('input[type=checkbox]').checked : null };
    if (box) await act(box);
    await wait(60);
    R[name] = Object.assign(info, { runs: window.__runs.slice(), plans: window.__plans,
      left: !!document.querySelector('.ov-confirm'), btnBack: !btn.disabled,
      failed: [...document.querySelectorAll('#toasts .toast')].some((t) => t.classList.contains('coral')) });
  };
  const ok = (box) => box.querySelector('.btn-primary').click();
  const cancel = (box) => box.querySelector('.btn-ghost').click();
  await scene('q1', 'none', async () => {});
  await scene('q2', 'choose', cancel);
  await scene('q3', 'choose', ok);
  await scene('q4', 'choose', (box) => { box.querySelector('input[type=checkbox]').click(); ok(box); });
  await scene('q5', 'only', cancel);
  await scene('q6', 'only', ok);
  await scene('q7', 'gone', async () => {});
  await scene('q8', 'empty', async () => {});
  await scene('q9', 'choose', async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  document.getElementById('out').textContent = MK[0] + JSON.stringify(R) + MK[1];
})().catch((e) => { document.getElementById('out').textContent = MK[0] + JSON.stringify({ error: String((e && e.stack) || e) }) + MK[1]; });
</script>`;

let R;
try {
  const dom = await dumpDom(chrome, { html, copy: [bundlePath], prefix: "drc-", marker: ":DRCEND" });
  const m = /DRCRESULT:(.*?):DRCEND/s.exec(dom);
  assert.ok(m, "결과 표지가 안 나왔다 — 페이지 스크립트가 끝나지 않았다\n" + dom.slice(0, 600));
  R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
assert.ok(!R.error, "페이지 오류: " + R.error);

// 배선 — 계획을 실제로 물었다(안 물으면 아래 «실행 0건» 이 헛돈다)
for (const k of ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"]) assert.equal(R[k].plans, 1, `${k} 계획을 한 번 읽었다 — ${R[k].plans}`);

assert.equal(R.q1.hadDialog, false, "Q1 나갈 자료가 없으면 묻지 않는다");
assert.deepEqual(R.q1.runs, ["{}"], "Q1 그대로 실행");

assert.equal(R.q2.hadDialog, true, "Q2 묻는다");
assert.equal(R.q2.checkbox, true, "Q2 뺄 수 있으니 고를 칸이 있다");
assert.equal(R.q2.checked, false, "★ 체크 기본값은 꺼짐 — 읽지 않고 눌러도 안전한 쪽");
assert.deepEqual(R.q2.runs, [], "★ Q2 취소하면 실행 0건");
assert.equal(R.q2.left, false, "Q2 창이 닫힌다");
assert.equal(R.q2.btnBack, true, "Q2 단추가 돌아온다");

assert.deepEqual(R.q3.runs, ['{"lanes_only":true}'], "★ Q3 체크를 끈 채 실행 → 증류기 몫만");
assert.deepEqual(R.q4.runs, ["{}"], "Q4 체크를 켜고 실행 → 함께 나간다");

assert.equal(R.q5.checkbox, false, "Q5 뺄 것이 없으면 고를 칸이 없다");
assert.deepEqual(R.q5.runs, [], "Q5 취소하면 실행 0건");
assert.deepEqual(R.q6.runs, ["{}"], "Q6 실행하면 그대로 나간다");

assert.equal(R.q7.hadDialog, false, "Q7 옛 게이트웨이 — 물을 재료가 없다");
assert.deepEqual(R.q7.runs, [], "★ Q7 옛 게이트웨이를 만나면 실행하지 않는다");
assert.equal(R.q7.failed, true, "★ Q7 실패를 알린다 — 조용히 멈추지 않는다");
assert.equal(R.q7.btnBack, true, "Q7 단추가 돌아온다");

assert.deepEqual(R.q8.runs, [], "★ Q8 계획이 없으면 실행하지 않는다 — «모름» 을 «물을 것 없음» 으로 접지 않는다");
assert.equal(R.q8.failed, true, "★ Q8 실패를 알린다");

assert.deepEqual(R.q9.runs, [], "Q9 Esc 도 취소다");

console.log("ok  증류 확인창 — 취소·체크 기본값·옛 게이트웨이에서 실행이 안 나간다");
