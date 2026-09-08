// tmux 호출 계수 — 창 단위 전수 계수 (#2600 T2 d4).
//
//  ── 왜 이 시험이 있나 ──
//  이 계수기는 완료 조건 «게이트웨이가 그 테넌트에 tmux 를 부른 횟수 0» 을 재는 **계기**다. 계기가 틀리면
//   그 조건은 «검증했다» 는 말만 남고 아무것도 안 지킨다 — 2026-09-08 에 실제로 그렇게 됐다: 그림자 로그로
//   동사를 세고 «list-sessions 0건» 이라 결론했는데, 같은 창의 요약은 compared 100 이었다(그림자는 불일치와
//   첫 건에만 동사를 싣는다). **틀린 계기로 «닫혔다» 고 말하는 것이 이 시험이 막으려는 것이다.**
//
//  엣지 표는 스크래치패드 `spec-census.md` 의 11행(C1~C11) + 호출부 칸의 11행(S1~S11) — 행마다 시나리오 하나.
import assert from "node:assert/strict";
import test from "node:test";
import { makeTmuxCallCensus, censusSite, CENSUS_NONE } from "./tmux-call-census.js";

// ── 창이 언제 닫히나 ────────────────────────────────────────────────────────
test("C1/C2 everyN 번째 호출에서만 창이 닫힌다", () => {
  const c = makeTmuxCallCensus(3);
  assert.equal(c.record("t", "list-sessions"), null);
  assert.equal(c.record("t", "list-sessions"), null);
  const rows = c.record("t", "list-sessions");
  assert.deepEqual(rows, [{ slug: "t", verb: "list-sessions", site: CENSUS_NONE, n: 3 }]);
});

test("C3 표는 (슬러그,동사)별 건수다", () => {
  const c = makeTmuxCallCensus(4);
  c.record("a", "list-sessions"); c.record("a", "set-option");
  c.record("b", "list-sessions"); const rows = c.record("a", "list-sessions");
  assert.deepEqual(rows, [
    { slug: "a", verb: "list-sessions", site: CENSUS_NONE, n: 2 },
    { slug: "a", verb: "set-option", site: CENSUS_NONE, n: 1 },
    { slug: "b", verb: "list-sessions", site: CENSUS_NONE, n: 1 },
  ]);
});

test("C4 ★ 보고 뒤 창이 비워진다 — 옛 창 숫자가 다음 창에 안 섞인다", () => {
  //  누적을 내면 «지금도 부르고 있나» 를 못 읽는다. 이 프로젝트가 재려는 것은 «남았나» 다.
  const c = makeTmuxCallCensus(2);
  c.record("t", "list-sessions"); c.record("t", "list-sessions");   // 창 1 닫힘
  c.record("t", "set-option");
  assert.deepEqual(c.record("t", "set-option"), [{ slug: "t", verb: "set-option", site: CENSUS_NONE, n: 2 }]);
});

// ── 없는 값 ─────────────────────────────────────────────────────────────────
test("C5 ★ 슬러그가 null·undefined·빈 문자열이면 이름 있는 버킷으로", () => {
  for (const v of [null, undefined, ""] as (string | null | undefined)[]) {
    const c = makeTmuxCallCensus(1);
    assert.deepEqual(c.record(v, "ls"), [{ slug: CENSUS_NONE, verb: "ls", site: CENSUS_NONE, n: 1 }], `slug=${JSON.stringify(v)}`);
  }
});

test("C6 ★ 동사가 null·undefined·빈 문자열이면 이름 있는 버킷으로", () => {
  //  argv 가 옵션뿐이면 동사가 없다(`tmuxSessionOf` 가 null 을 준다). 그 호출도 세야 «전수» 다.
  for (const v of [null, undefined, ""] as (string | null | undefined)[]) {
    const c = makeTmuxCallCensus(1);
    assert.deepEqual(c.record("t", v), [{ slug: "t", verb: CENSUS_NONE, site: CENSUS_NONE, n: 1 }], `verb=${JSON.stringify(v)}`);
  }
});

// ── 끄기·경계 ───────────────────────────────────────────────────────────────
test("C7 ★ everyN 이 0·음수면 영원히 보고하지 않는다 — 그래도 세기는 한다", () => {
  for (const n of [0, -1]) {
    const c = makeTmuxCallCensus(n);
    for (let i = 0; i < 50; i++) assert.equal(c.record("t", "ls"), null, `everyN=${n}`);
    assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 50 }], `everyN=${n} 는 세기는 한다`);
  }
});

test("C8 ★ everyN=1(경계 최소)이면 매 호출마다 보고한다", () => {
  const c = makeTmuxCallCensus(1);
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 1 }]);
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 1 }]);   // 창이 매번 비워지므로 계속 1
});

// ── 정렬 ────────────────────────────────────────────────────────────────────
test("C9 ★ 많은 것부터, 동률이면 슬러그→동사 이름순", () => {
  //  창끼리 눈으로 견주려면 순서가 흔들리면 안 된다(삽입순으로 두면 로그가 매번 달라 보인다).
  const c = makeTmuxCallCensus(5);
  c.record("b", "zz"); c.record("a", "zz"); c.record("a", "aa"); c.record("c", "kill");
  const rows = c.record("c", "kill");
  assert.deepEqual(rows, [
    { slug: "c", verb: "kill", site: CENSUS_NONE, n: 2 },
    { slug: "a", verb: "aa", site: CENSUS_NONE, n: 1 },
    { slug: "a", verb: "zz", site: CENSUS_NONE, n: 1 },
    { slug: "b", verb: "zz", site: CENSUS_NONE, n: 1 },
  ]);
});

// ── 관측 장치 ───────────────────────────────────────────────────────────────
test("C10 peek 은 비우지 않는다", () => {
  const c = makeTmuxCallCensus(0);
  c.record("t", "ls");
  assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 1 }]);
  assert.deepEqual(c.peek(), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 1 }], "두 번 읽어도 같다");
});

test("C11 ★ 돌려준 표를 호출자가 고쳐도 내부가 안 망가진다", () => {
  const c = makeTmuxCallCensus(1);
  const rows = c.record("t", "ls")!;
  rows[0]!.n = 999; rows.push({ slug: "x", verb: "y", site: "z:1", n: 7 });
  assert.deepEqual(c.record("t", "ls"), [{ slug: "t", verb: "ls", site: CENSUS_NONE, n: 1 }], "다음 창은 영향 없다");
});

// ── 호출부 칸(`censusSite`) ─────────────────────────────────────────────────
//  왜: 두 칸(슬러그·동사)만으로는 **남은 표면을 못 짚는다.** 첫 창에서 「list-sessions 최다」를 보고 범인을
//   지목할 수 있었던 것은 «빈 시험 테넌트까지 정확히 16» 이라는 모양이 우연히 고정 주기를 드러냈기
//   때문이고, 남은 자리들은 요청에 실려 돌아 그런 모양이 안 나온다. 그리고 그중 셋은 **파괴적 소비자**의
//   입력이라 근거 없이 손대면 안 된다 — 이 칸이 그 근거다.
const STACK = (...frames: string[]) => ["Error", ...frames.map((f) => `    at ${f}`)].join("\n");

test("S1 ★ 스택이 없으면 지어내지 않는다", () => {
  for (const v of [undefined, null, ""] as (string | null | undefined)[]) {
    assert.equal(censusSite(v), CENSUS_NONE, `stack=${JSON.stringify(v)}`);
  }
});

test("S2 ★ seam 자신의 배관(tmux*)은 건너뛴다 — 첫 «우리 코드» 프레임이 답이다", () => {
  //  tmux-exec 는 어느 호출에서든 스택에 있다. 그걸 답으로 내면 모든 줄이 같은 값이 되어 계기가 죽는다.
  const s = STACK("tmux (/app/dist/terminal/tmux-exec.js:131:20)", "collectSessions (/app/dist/terminal/sessions.js:196:9)");
  assert.equal(censusSite(s), "sessions:196");
});

test("S3 ★ 두 칸을 얕은 것부터 `<` 로 잇는다 — 잎만으로는 «누가 그 헬퍼를 불렀나» 를 못 본다", () => {
  const s = STACK(
    "tmux (/app/dist/terminal/tmux-exec.js:131:20)",
    "collectSessions (/app/dist/terminal/sessions.js:196:9)",
    "listProjects (/app/dist/capabilities/projects-v6.js:194:15)",
  );
  assert.equal(censusSite(s), "sessions:196<projects-v6:194");
});

test("S4 depth 를 넘는 프레임은 안 싣는다", () => {
  const s = STACK("a (/x/one.js:1:1)", "b (/x/two.js:2:2)", "c (/x/three.js:3:3)");
  assert.equal(censusSite(s), "one:1<two:2");
  assert.equal(censusSite(s, 1), "one:1", "depth=1 이면 한 칸");
  assert.equal(censusSite(s, 3), "one:1<two:2<three:3", "depth=3 이면 세 칸");
});

test("S5 괄호 없는 프레임 형식도 읽는다", () => {
  assert.equal(censusSite(STACK("/app/dist/sessions/session-reaper.js:361:7")), "session-reaper:361");
});

test("S6 ★ node: 내부 프레임은 건너뛴다 — 우리 코드가 아니다", () => {
  const s = STACK("process.processTicksAndRejections (node:internal/process/task_queues:95:5)", "tick (/app/dist/ops/box-watch.js:380:20)");
  assert.equal(censusSite(s), "box-watch:380");
});

test("S7 위치 없는 프레임은 건너뛴다", () => {
  const s = STACK("native", "<anonymous>", "Object.foo (/app/dist/apps/x.js:7:1)");
  assert.equal(censusSite(s), "x:7");
});

test("S8 ★ 전부 배관이면 `(없음)` — 없는 것을 지어내지 않는다", () => {
  const s = STACK(
    "tmux (/app/dist/terminal/tmux-exec.js:131:20)",
    "shadowTmux (/app/dist/terminal/tmux-shadow.js:88:3)",
    "record (/app/dist/terminal/tmux-call-census.js:70:5)",
  );
  assert.equal(censusSite(s), CENSUS_NONE);
});

test("S9 ★ 경로·확장자는 벗고 파일명만 — 절대경로를 실으면 창마다 수 KB 가 는다", () => {
  assert.equal(censusSite(STACK("f (C:\\app\\dist\\terminal\\phase.js:61:9)")), "phase:61", "윈도우 경로");
  assert.equal(censusSite(STACK("f (/a/b/tool.mjs:5:1)")), "tool:5", ".mjs");
  assert.equal(censusSite(STACK("f (/a/b/thing.ts:9:1)")), "thing:9", ".ts(소스맵·tsx 실행)");
});

test("S10 async 프레임도 같다", () => {
  assert.equal(censusSite(STACK("async sweepAwaitingNotifications (/app/dist/sessions/awaiting-notifier.js:52:15)")), "awaiting-notifier:52");
});

test("S11 ★ 같은 (슬러그,동사)라도 호출부가 다르면 다른 줄이다 — 이게 이 칸의 전부다", () => {
  const c = makeTmuxCallCensus(3);
  c.record("t", "list-sessions", "sessions:196<projects-v6:194");
  c.record("t", "list-sessions", "sessions:196<projects-v6:194");
  const rows = c.record("t", "list-sessions", "sessions:146<session-reaper:361");
  assert.deepEqual(rows, [
    { slug: "t", verb: "list-sessions", site: "sessions:196<projects-v6:194", n: 2 },
    { slug: "t", verb: "list-sessions", site: "sessions:146<session-reaper:361", n: 1 },
  ]);
});
