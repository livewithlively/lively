// #4783 — «끝난 사유» 의 배선을 고정한다(누가 적고 · 누가 싣고 · 누가 그리나). 사양: 스크래치패드 spec.md 표 B·J·K.
//  순수 판정은 session-end.test.ts · session-end-web.test.mjs · terminal-end-handoff.test.mjs 가 본다. 여기는 **그 판정이 실제 자리에 꽂혔나** 다 —
//  판정이 맞아도 부르는 자리가 없으면 화면은 종전대로다(#3846 «표식을 읽는 코드가 화면에 0줄» · #443 «판정은 고쳤는데 부르지도 않았다»).
//  행위로 볼 수 있는 것은 행위로 본다(sess-fold 산출 모듈). 나머지는 소스 텍스트로 «무엇이 무엇보다 먼저» 를 잰다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
/** 함수(또는 화살표 const) 하나의 본문 — 다음 최상위 선언 전까지. */
function fn(src, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:export )?(?:async )?(?:function ${name}\\(|const ${name} = )`);
  const m = re.exec(src);
  assert.ok(m, `[배선] ${name} 를 찾았다`);
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*\n|\n\/\/ ── /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test("B1 시스템 끄기의 공용 문(reapCentralSession)이 **끄기 전에** 사유를 적는다 · 기본 reclaim · 안 본 결과를 잰다", () => {
  const b = fn(read("src/terminal/sessions.ts"), "reapCentralSession");
  const iMark = b.indexOf("markSessionEnded(");
  const iKill = b.indexOf("tmuxKill(");
  assert.ok(iMark >= 0 && iKill > iMark, "🔴 끈 뒤에 적으면 런처의 뒤늦은 보고가 먼저 적힌다");
  assert.match(read("src/terminal/sessions.ts"), /reapCentralSession\(id: string, end: SessionEndInput = \{ why: "reclaim" \}\)/);
  assert.match(b, /lastResultSeen\(id\)/);
});

test("B2 사람의 멈춤(killSession end) — 행을 남기는 끄기에서만, 끄기 전에 적는다", () => {
  const b = fn(read("src/terminal/sessions.ts"), "killSession");
  const iMark = b.indexOf("markSessionEnded(");
  const iKill = b.indexOf("tmuxKill(");
  assert.ok(iMark >= 0 && iKill > iMark);
  assert.match(b, /opts\?\.preserveState && opts\.end/);
});

test("B3 사람이 멈추는 길 셋이 «stop» 을 넘긴다 — DELETE ?reclaim=1(박스) · DELETE ?reclaim=1(노드) · 휴지통 완전 삭제 전 멈춤", () => {
  const r = read("src/terminal/routes.ts");
  assert.match(r, /killSession\(u, req\.params\.id, \{ admin, preserveState: reclaim, \.\.\.\(reclaim \? \{ end: \{ why: "stop" as const, by: idOf\(u\) \} \} : \{\}\) \}\)/);
  assert.match(r, /if \(st\) await markSessionEnded\(id, \{ why: "stop", by: me \}\)/);
  assert.match(read("src/sessions/session-trash-ops.ts"), /killSession\(u, id, \{ preserveState: true, end: \{ why: "stop", by: me \} \}\)/);
});

test("B4 런처 보고 라우트 — 판정은 harnessEndVerdict · 주인 행만 · 그 판의 보고만(t0)", () => {
  const r = read("src/terminal/routes.ts");
  const i = r.indexOf('app.post("/api/ui/terminal/sessions/:id/ended"');
  assert.ok(i >= 0, "[배선] /ended 라우트가 있다");
  const seg = r.slice(i, i + 900);
  assert.match(seg, /harnessEndVerdict\(req\.body\)/);
  assert.match(seg, /\{ owner: idOf\(userOf\(req\)\), t0: v\.t0 \}/);
});

test("B5 열람 도장이 꺼진 세션의 «안 본 결과» 를 걷는다 · 사라짐 확인은 정비 틱에 걸렸다", () => {
  const c = read("src/terminal/chat-routes.ts");
  const i = c.indexOf('"/api/ui/terminal/sessions/:id/seen"');
  assert.ok(i >= 0);
  assert.match(c.slice(i, i + 3000), /markSessionEndSeen\(id\)/);
  assert.match(read("src/web.ts"), /step\("session-end-lost", async \(\) => \(await import\("\.\/sessions\/session-end-lost\.js"\)\)\.sweepLostSessions\(\)\)/);
});

test("B6 판 시작 upsert — 보고 런처로 뜬 판에만 표식을 찍고(INSERT) · 같은 id 다시 쓰기는 지난 사유를 지운다(ON CONFLICT) · 표식 여부는 런처 대조로 정한다", () => {
  const b = fn(read("src/sessions/session-state.ts"), "upsertSessionState");
  assert.match(b, /CASE WHEN \$23::boolean THEN '\$\{END_NOTE_LIFE_MARK\}'::jsonb ELSE NULL END/, "🔴 보고하지 않는 판(셸·grok·opencode)에도 표식을 찍으면 그 정상 종료가 «오류» 가 된다");
  assert.match(b, /end_note=EXCLUDED\.end_note,/);
  assert.match(b, /!!s\.end_mark\]/);
  const ss = read("src/terminal/sessions.ts");
  assert.match(ss, /end_mark: launchReportsEnd\(launch\),/);
  assert.match(read("src/terminal/catalog.ts"), /return argv\.length > 3 && argv\[0\] === "sh" && argv\[1\] === "-c" && argv\[2\] === LAUNCH_STOP_SH;/);
  //  되살리기가 실패하면 지난 판의 사유를 되돌린다 — 실패한 시도는 판이 아니다.
  assert.match(ss, /mirrored && reuseId && prevEnd !== undefined \? restoreSessionEndNote\(id, prevEnd\)/);
});

test("J1 액자가 넘긴 끝난 사실로 대화창 안내를 고른다 · 목록이 사유를 실어 오면 액자를 걷는다(살아 있는 행은 안 걷는다)", () => {
  const s = read("web/session-chat.ts");
  assert.match(s, /dropTermFrame\(!!m\.canRestore, m\.end && typeof m\.end === 'object' \? \(m\.end as EndFactsMsg\) : null\)/);
  const d = fn(s, "dropTermFrame");
  assert.match(d, /endedSessPhrase\(end \? sessLikeOfFacts\(end\) : null\) \|\| endedSessPhrase\(target\.raw\)/);
  assert.match(s, /if \(mode === 'term' && termFrame && !t\.alive && t\.raw\?\.endNote\?\.why\) dropTermFrame\(/, "🔴 목록이 확정 사실을 말해도 액자가 남는다");
  assert.match(s, /const why = endedSessPhrase\(target\.raw\) \|\| \(/, "멈춘 세션 안내도 같은 이름");
});

test("K1 홈 ① · ①″ · ①‴ — 꺼진 행의 점은 stopDot · «지난 세션» 은 stopPast(사람이 끝냈을 때만)", () => {
  const m = read("web/v2/main.ts");
  const hits = m.match(/liveNow \? s\.stateKey : \(s\.stopDot \|\| ''\), false, undefined, !liveNow && s\.stopPast !== false/g) || [];
  assert.equal(hits.length, 3, "🔴 ①(내 세션)·①″(초대받은 세션)·①‴(초대한 세션, #4785) 셋 다 같은 규칙");
  assert.doesNotMatch(m, /liveNow \? s\.stateKey : '', false, undefined, !liveNow\)/, "🔴 종전 규칙(꺼지면 무조건 점 없음·지난 세션)이 남아 있다");
  assert.match(m, /error:\s+\{ label: '오류',\s+rank: 0 \}/, "오류는 «지금 볼 것» 에 선다");
  const v = fn(m, "viewedSessionId");
  assert.match(v, /s\.live && !s\.alive && s\.stopDot === 'done'/, "꺼진 «작업 완료» 행을 보는 동안 열람 도장");
});

test("K2 행 자료(mergeSessions)가 꺼진 박스에만 겉모습을 정한다 · 관측 못 한 행은 안 정한다", () => {
  const v = read("web/v2/views.ts");
  assert.match(v, /if \(!s\.alive && r\.observed !== false\) \{ s\.stopDot = stoppedDotKey\(r, now\); s\.stopPast = stoppedIsPast\(r\); \}/);
});

test("K3 트리·[AI 세션] 줄도 같은 규칙 — 점은 stopDot · 흐림은 stopPast · 카드 머리 요약에 오류", () => {
  const s = read("web/v2/side.ts");
  assert.match(s, /const st = !pastRow \? \(isDotState\(s\.stateKey\) \? s\.stateKey : ''\) : \(s\.stopDot \|\| ''\);/);
  assert.match(s, /past: pastRow && s\.stopPast !== false,/);
  assert.match(s, /const cls = rowDotCls\(pastRow && s\.stopDot \? s\.stopDot : s\.stateKey\);/);
  assert.match(s, /\(dimRow \? ' past' : ''\)/);
  assert.match(s, /const x = part\('error', 'err'\);/);
});

test("K4 트리 폴더 — 점이 선 꺼진 세션은 하루가 지나도 «지금 일감» (행위)", async () => {
  const F = await import(pathToFileURL(path.join(ROOT, "public/app/lib/sess-fold.js")).href);
  const now = 2_000_000_000_000;
  const old = now - 3 * 86_400_000;
  assert.equal(F.isWarmSess({ live: true, alive: false, lastSeen: old }, now), false, "점 없는 사흘 전 꺼진 세션은 접힌다(종전)");
  assert.equal(F.isWarmSess({ live: true, alive: false, lastSeen: old, stopDot: "waiting" }, now), true);
  assert.equal(F.isWarmSess({ live: true, alive: false, lastSeen: old, stopDot: "error" }, now), true);
  assert.equal(F.isWarmSess({ live: true, alive: false, lastSeen: old, stopDot: "" }, now), false);
  const { now: nowRows, cold } = F.splitFolderRows([], [{ id: "a", live: true, alive: false, lastSeen: old, stopDot: "waiting" }, { id: "b", live: true, alive: false, lastSeen: old }], now);
  assert.deepEqual(nowRows.map((x) => x.id), ["a"]);
  assert.deepEqual(cold.map((x) => x.id), ["b"]);
});

test("K5 오류 점 모양(CSS) — 트리 점·카드 요약·**홈·카드 줄 점**(주 화면) 모두 · 점 상태마다 홈 줄 규칙이 있다", async () => {
  const css = read("public/styles/40-v2.css");
  assert.match(css, /\.v2-dot\.err \{[^}]*rotate\(45deg\)/);
  assert.match(css, /\.v2-sum\.err \{ color: var\(--danger\); \}/);
  assert.match(css, /\.v2-app-inst-st\[data-st="error"\] \{[^}]*rotate\(45deg\)/, "🔴 홈·카드 줄(appRowEl)의 오류 점에 규칙이 없으면 글자색 원이 된다(격리 리뷰)");
  //  드리프트 가드 — 목록 줄에 점으로 서는 상태(DOT_STATES)마다 홈 줄 규칙이 있어야 한다. 새 점 상태가 생기면 여기서 걸린다.
  const S = await import(pathToFileURL(path.join(ROOT, "public/app/session-status.js")).href);
  for (const k of S.DOT_STATES) assert.match(css, new RegExp(`\\.v2-app-inst-st\\[data-st="${k}"\\]`), `홈 줄 점 규칙 없음: ${k}`);
});

test("K6 트리 프로젝트 줄 요약 — 접힌 프로젝트도 꺼진 세션의 «확인 필요»·«오류» 를 센다", () => {
  const b = fn(read("web/v2/side.ts"), "sumEl");
  assert.match(b, /if \(s\.stopDot === 'waiting'\) att\.wait\+\+; else if \(s\.stopDot === 'error'\) att\.err\+\+;/);
  assert.match(b, /part\(att\.err, 'err', '오류'\)/);
});
