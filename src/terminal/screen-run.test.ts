// #4502 — «아직 안 끝난 세션» 을 화면으로 읽는다(어댑터 run · phase.resolveAgentPhase 5번 · 목록 배선).
//
//  신고(원준님 2026-09-30): «이 세션 아직 분명히 안 끝났는데 파란색 점이 안 깜빡여» — 세션 box-wonjoon-jang-4b1b4cd6.
//  그 세션의 화면(맥미니 노드, 읽기 전용 캡처):
//    ⏺ PR이 머지 대기열 3번째에 들어갔어요. 머지되면 바로 이미지를 굽고 롤하겠습니다.
//    ✻ Cogitated for 45s · done 5:50 PM · 1 shell still running
//  턴은 17:50 에 끝났고(Stop 훅 = idle 보고) AI 는 백그라운드 셸이 끝나면 스스로 이어 간다. 목록은 idle · working=false.
//  같은 날 확인한 두 번째 구멍: Claude Code 2.1.285 는 pane 제목에 스피너를 안 그린다(도는 세션 4개 · 2분 표본 전부 «✳»).
//   그래서 도구 하나가 10분 넘게 돌거나 훅이 안 걸린 도구만 쓰는 턴도 보고가 만료되면 idle 로 떨어진다.
//
//  표의 화면은 **실측 원문**이다(빈 줄만 뺐다). 실측에서 한 칸을 비튼 행은 비튼 방식을, 지어낸 행은 그렇다고 적었다.
//  행 이름이 곧 엣지 표다 — R 화면 판정(claude) · A 하네스 표 · S 한 화면 두 판정 · E 행에 주는 것 · P 우선순위 · W 배선.
//  사이드바 점이 background 를 «작업 중» 으로 그리는 표는 scripts/session-status.test.mjs ㉓~㉗.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claudeRun } from "./harness-io/claude.js";
import { harnessIo } from "./harness-io/adapter.js";
import { detectRun, readScreen, screenRunEffects, resolveAgentPhase, PHASE_TTL_SEC } from "./phase.js";
import { RUN_FROM_SCREEN_LINES } from "./harness-io/screen-run.js";
import { projectNodeSession } from "../node/protocol.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const RULE = "─".repeat(118);
const lines = (s: string): string[] => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");

// ── 실측 화면(Claude Code 2.1.285) ──
//  R1 도는 턴 — 이 세션 자신(맥북에어, 도구 실행 중).
const TURN = [
  "⏺ Capturing bottom of busy and idle panes",
  "  ⎿  $ echo \"=== MINE (busy, tool running)\"; tmux capture-pane -p -t box-wonjoon-jang-23544062 | grep -v '^\\s*$' | tail",
  "✽ Architecting… (6m 28s · ↓ 17.8k tokens)",
  RULE, "❯ ", RULE,
  "  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← 1 agent · ↓ to manage",
].join("\n");
//  R2 도는 턴 — 스피너 밑에 팁 줄이 붙은 모양(box-wonjoon-jang-effa1255).
const TURN_TIP = [
  "     '.[]|[.databaseId,.status,.conclusion,.displayTitle,.createdAt]|@tsv'",
  "✽ Osmosing… (running PreToolUse hook · 1h 10m 39s · ↓ 270.1k tokens)",
  "  ⎿  Tip: Use /clear to start fresh when switching topics and free up context",
  RULE, "❯ ", RULE,
  "  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← 1 agent · ↓ to manage",
].join("\n");
//  R3 ★ 신고된 세션 — 턴은 끝났고 백그라운드 셸이 남았다(box-wonjoon-jang-4b1b4cd6, 맥미니).
const BACKGROUND = [
  "⏺ PR이 머지 대기열 3번째에 들어갔어요. 머지되면 바로 이미지를 굽고 롤하겠습니다.",
  "✻ Cogitated for 45s · done 5:50 PM · 1 shell still running",
  RULE, "❯ 프리뷰 링크 먼저 줘봐 직접 볼게", RULE,
  "  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage",
].join("\n");
//  R4 끝난 턴 — 남은 작업 없음(box-wonjoon-jang-92b02ea7). 오른쪽 정렬 안내 줄이 완료 줄과 입력창 사이에 낀다.
const DONE = [
  "  둘 다 답을 못 받아서 그대로 뒀어요. 이메일 표시는 서버 작업이 필요합니다.",
  "  작업 기록과 지식 me-modal-copy-layout-asbuilt-4135는 #4135에 연결해 뒀어요.",
  "✻ Worked for 47m 43s · done 9:20 PM",
  "                                                                                                           new task? /clear to save 721.6k tokens",
  RULE, "❯ 이메일 표시도 서버 작업해서 넣어줘", RULE,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ⧉ profile-modal-review · ← 1 agent",
].join("\n");

t("R1 도는 턴(푸터 «esc to interrupt») → turn", () => assert.equal(claudeRun(lines(TURN)), "turn"));
t("R2 스피너 밑 팁 줄이 붙어도 → turn", () => assert.equal(claudeRun(lines(TURN_TIP)), "turn"));
t("R3 ★ 턴이 끝났는데 백그라운드 셸이 남았다(신고 화면) → background", () => assert.equal(claudeRun(lines(BACKGROUND)), "background"));
t("R4 끝난 턴·남은 작업 없음 → null(대기)", () => assert.equal(claudeRun(lines(DONE)), null));

// ── 모양을 한 칸씩 비튼 행 ──
t("R5 ★ 좁은 창에서 푸터가 잘려도 스피너 줄이 있으면 → turn(R1 에서 푸터의 «esc to interrupt» 를 뺐다)", () => {
  assert.equal(claudeRun(lines(TURN.replace(" · esc to interrupt", ""))), "turn");
});
t("R6 ★ 완료 줄이 좁은 창에서 접혀 «still running» 이 다음 줄로 넘어가도 → background(R3 을 접었다)", () => {
  assert.equal(claudeRun(lines(BACKGROUND.replace(" · 1 shell still running", " · 1 shell\n  still running"))), "background");
});
t("R7 ★ 대화 본문에 «still running» 이 있어도 완료 줄이 아니면 세지 않는다(R4 의 본문 줄을 ⏺ 줄로 바꿨다)", () => {
  const s = DONE.replace("  작업 기록과 지식", "⏺ 빌드가 still running 이라 기다렸다가 작업 기록과 지식")
    .replace("✻ Worked for 47m 43s · done 9:20 PM\n", "");   // 완료 줄이 스크롤로 빠진 모양 — 본문 줄이 입력창 바로 위에 선다
  assert.equal(claudeRun(lines(s)), null);
});
t("R8 ★ 입력 중인 도는 턴 — 푸터가 «enter to interrupt and send» 로 바뀌어도 → turn(문구는 2.1.285 번들 원문 · 스피너 줄은 뺐다)", () => {
  const s = TURN.replace("esc to interrupt", "enter to interrupt and send · ctrl+x then enter to queue").replace("✽ Architecting… (6m 28s · ↓ 17.8k tokens)\n", "");
  assert.equal(claudeRun(lines(s)), "turn");
});
t("R9 백그라운드 에이전트만 남은 완료 줄 «Waiting for … to finish» → background(문구는 2.1.285 번들 렌더 코드 원문)", () => {
  assert.equal(claudeRun(lines(BACKGROUND.replace("✻ Cogitated for 45s · done 5:50 PM · 1 shell still running", "✻ Waiting for 1 background agent to finish"))), "background");
});
t("R10 옛 판의 둥근 입력 상자 — 스피너 줄에 «esc to interrupt» (지어낸 화면: 옛 판 모양 · 괄호 앞 말줄임 없음)", () => {
  assert.equal(claudeRun(lines("⏺ 읽는 중\n✻ Thinking (12s · esc to interrupt)\n╭──────────╮\n│ >        │\n╰──────────╯\n  ? for shortcuts")), "turn");
});
t("R11 입력창이 안 보이는 화면(승인 대화상자)·빈 꼬리는 모른다 → null", () => {
  assert.equal(claudeRun(lines(" Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend")), null);
  assert.equal(claudeRun([]), null);
});
t("R13 ★ 대화 본문의 «to interrupt»·«…(» 는 턴 표시가 아니다(R4 의 완료 줄을 본문 줄로 바꿨다 — ⏺ 답 · 옛 판 > 입력 메아리 · 글자로 시작하는 줄)", () => {
  for (const line of ["⏺ 푸터에 esc to interrupt 가 보이면 도는 중입니다", "> 로딩…(중)", "Stop hook running… (2s)"]) {
    assert.equal(claudeRun(lines(DONE.replace("✻ Worked for 47m 43s · done 9:20 PM", line))), null, line);
  }
});
t("R12 경계 — 가로줄이 하나만 보이면(입력창을 못 짚는다) 모른다 → null(R1 의 윗 가로줄을 뺐다)", () => {
  const one = TURN.replace(`${RULE}\n❯ \n`, "❯ \n");
  assert.equal(lines(one).filter((l) => l.startsWith("─")).length, 1, "배선: 가로줄이 정확히 하나");
  assert.equal(claudeRun(lines(one)), null);
});

// ── 하네스 표 — 어댑터가 run 을 답하고, detectRun 이 꼬리를 잘라 그 답을 쓴다 ──
t("A1 어댑터 표: claude 는 claudeRun · codex 화면 busy → turn · ready → null · shell 은 null", () => {
  assert.equal(harnessIo("claude")?.run, claudeRun);
  assert.equal(harnessIo("codex")?.run?.(lines("› 현재 폴더에서 ls -la 를 실행해서 보여줘\n• Working (2s • esc to interrupt)\n› Explain this codebase\n  gpt-5.6-terra medium · ~/box/yoon")), "turn");
  assert.equal(harnessIo("codex")?.run?.(lines("  Tip: Press ctrl+t to open the full transcript.\n› Ask Codex to do anything\n  GPT-5.6-Terra medium · /work/box-yoon-1")), null);
  assert.equal(harnessIo("shell")?.run, null);
});
t("A2 ★ detectRun — 입력창에 16줄을 쳐 둬도(대기 판정의 14줄 꼬리 밖) 완료 줄을 읽는다 · run 이 없는 하네스는 모른다", () => {
  const typed = Array.from({ length: 16 }, (_, i) => `  입력 ${i + 1}번째 줄`).join("\n");
  const pane = BACKGROUND.replace("❯ 프리뷰 링크 먼저 줘봐 직접 볼게", `❯ 프리뷰 링크 먼저 줘봐\n${typed}`);
  assert.equal(detectRun(pane, harnessIo("claude")?.run), "background");
  assert.equal(detectRun(pane, null), null);
});

t("A3 ★ 다른 하네스는 맨 아래 몇 줄의 표시만 믿는다 — 본문에 남은 «esc to interrupt» 는 턴이 아니다(격리 리뷰 재현 모양)", () => {
  const codexIdle = "  Tip: Press ctrl+t to open the full transcript.\n› Ask Codex to do anything\n  GPT-5.6-Terra medium · /work/box-yoon-1";
  const stale = ["• Ran rg 'esc to interrupt' src", "  └ src/terminal/phase.ts: esc to interrupt", ...Array.from({ length: RUN_FROM_SCREEN_LINES }, (_, i) => `    결과 ${i + 1}`)].join("\n");
  const pane = `${stale}\n${codexIdle}`;
  assert.equal(detectRun(pane, harnessIo("codex")?.run), null, "창 밖 본문");
  assert.equal(harnessIo("codex")?.screen?.(lines(pane).slice(-14)), "busy", "배선: 종전 screen 꼬리(14줄)는 이 화면을 busy 로 읽는다 — 그래서 창을 줄였다");
  const busy = "› 현재 폴더에서 ls -la 를 실행해서 보여줘\n• Working (2s • esc to interrupt)\n› Explain this codebase\n  gpt-5.6-terra medium · ~/box/yoon";
  assert.equal(detectRun(`${stale}\n${busy}`, harnessIo("codex")?.run), "turn", "도는 표시는 맨 아래에 있다");
  //  창 안(맨 아래 3줄)의 인용 — 재검토 재현 모양. 상태줄은 «(경과 시간 • esc to interrupt)» 괄호 모양이라 인용과 갈린다.
  const quoted = `• 화면의 «esc to interrupt» 표시로 도는 중인지 봅니다\n${codexIdle}`;
  assert.equal(detectRun(quoted, harnessIo("codex")?.run), null, "맨 아래의 인용");
  assert.equal(harnessIo("codex")?.screen?.(lines(quoted)), "busy", "배선: screen 은 이 화면을 busy 로 읽는다 — run 이 따로 좁게 본다");
});

// ── 한 화면 두 판정(phase.readScreen) ──
t("S1 ★ 사람이 답할 화면이면 실행 상태를 내지 않는다 — 스피너 줄과 승인 대화상자가 함께 보여도(지어낸 화면: 격리 리뷰 재현 모양)", () => {
  const pane = ["✽ Architecting… (6m 28s · ↓ 17.8k tokens)", RULE, " Do you want to create hello.txt?", " ❯ 1. Yes", "   2. No", RULE, " Esc to cancel · Tab to amend"].join("\n");
  assert.equal(claudeRun(lines(pane)), "turn", "배선: 실행 판정기만 보면 이 화면은 turn 이다");
  assert.deepEqual(readScreen(pane, harnessIo("claude")), { waiting: true, run: null });
  assert.deepEqual(readScreen(BACKGROUND, harnessIo("claude")), { waiting: false, run: "background" });
  assert.deepEqual(readScreen(TURN, null), { waiting: false, run: null }, "하네스를 모르면 실행 상태도 모른다");
});

// ── 화면 실행 상태가 행에 주는 것(phase.screenRunEffects) ──
t("E1 turn → 작업 중(working·harnessWorking·마지막 작업 시각) · 표식 없음", () => {
  assert.deepEqual(screenRunEffects("turn", false), { turn: true, background: false });
});
t("E2 ★ background → 표식 하나만(파란 점) — working 이 아니다(리브 2턴·대화창·회수·CP 유휴가 «턴이 돈다» 로 읽는다)", () => {
  assert.deepEqual(screenRunEffects("background", false), { turn: false, background: true });
});
t("E3 모른다 → 아무것도 없다 · app-server 세션은 화면이 정본이 아니다", () => {
  assert.deepEqual(screenRunEffects(null, false), { turn: false, background: false });
  assert.deepEqual(screenRunEffects("turn", true), { turn: false, background: false });
  assert.deepEqual(screenRunEffects("background", true), { turn: false, background: false });
});

// ── 우선순위표(phase.resolveAgentPhase 5번) ──
{
  const T = 1_700_000_000;
  const phase = (i: Partial<Parameters<typeof resolveAgentPhase>[0]>): string =>
    resolveAgentPhase({ reported: null, nowSec: T, spinning: false, scrapedWaiting: false, ...i });
  t("P1 ★ idle 보고(Stop 뒤 턴이 이어짐) + 화면 turn → busy", () => {
    assert.equal(phase({ reported: { phase: "idle", at: T - 60 }, scrapedTurn: true }), "busy");
  });
  t("P2 ★ 만료된 busy 보고(10분 넘는 도구) + 화면 turn → busy", () => {
    assert.equal(phase({ reported: { phase: "busy", at: T - PHASE_TTL_SEC - 1 }, scrapedTurn: true }), "busy");
  });
  t("P3 신선한 waiting 보고 · 화면 대기는 화면 turn 보다 위(사람이 답할 일을 먼저)", () => {
    assert.equal(phase({ reported: { phase: "waiting", at: T - 5 }, scrapedTurn: true }), "waiting");
    assert.equal(phase({ scrapedWaiting: true, scrapedTurn: true }), "waiting");
  });
  t("P4 화면이 turn 이 아니다(false)·안 줬다(undefined) → 종전 그대로 idle", () => {
    assert.equal(phase({ scrapedTurn: false }), "idle");
    assert.equal(phase({}), "idle");
  });
}

// ── 배선 — 판정이 목록 행(agentState·working·harnessWorking·lastActive)까지 간다 ──
//  collectSessions 는 tmux 를 직접 부르는 함수라 여기서 못 돌린다(가짜 tmux 없음). harness-reports-busy.test H8 과 같은 방식으로
//  **소스 자리를 못박는다** — 값이 만들어지고도 rows·SessionInfo 에 안 적혀 조용히 사라진 사고(#2439)가 이 자리였다.
t("W1 화면 판정이 대기 판정과 같은 캡처에서 나와 screenRunEffects 를 거쳐 목록 행의 다섯 자리에 실린다", () => {
  const here = new URL(".", import.meta.url).pathname.replace(/\/dist\//, "/src/");
  const src = readFileSync(`${here}sessions.ts`, "utf8");
  assert.match(src, /const v = await scrapePane\(r\.name, harnessIo\(r\.harness\)\);[\s\S]{0,120}if \(v\.run\) screenRuns\.set\(r\.name, v\.run\);/, "캡처 한 번에서 run 을 모은다");
  assert.match(src, /const screen = screenRunEffects\(screenRuns\.get\(r\.name\) \?\? null, appServer\);/, "행에 주는 것은 screenRunEffects 가 정한다");
  assert.match(src, /resolveAgentPhase\(\{[^}]*scrapedTurn: screen\.turn \}\)/, "단계 판정(agentState)엔 turn 만");
  assert.match(src, /working: appServer \? asPhase === "busy" : !!\([^)]*\|\| screen\.turn\)/, "working 엔 turn 만");
  assert.match(src, /harnessWorking: appServer \? asPhase === "busy" : !!r\.harnessBusy \|\| screen\.turn,/, "하네스가 말하는 작업 중도 turn 만");
  assert.match(src, /\.\.\.\(screen\.background \? \{ background: true \} : \{\}\)/, "background 는 따로 실린다(사이드바 점)");
  assert.match(src, /if \(screen\.turn\) \{[^\n]*\n\s*r\.lastBusy = nowSec;/, "turn 만 마지막 작업 시각을 민다");
  const pushAt = src.indexOf("sessions.push({");
  assert.ok(pushAt > 0 && src.indexOf("if (screen.turn) {") < pushAt, "시각을 민 뒤에 행을 만든다(lastActive 에 실린다)");
  //  캡처 경로가 두 판정을 **readScreen 한 곳**에서 낸다(S1 의 «대화상자면 실행 상태 없음» 이 실제 경로에 걸린다).
  const phaseSrc = readFileSync(`${here}phase.ts`, "utf8");
  assert.match(phaseSrc, /try \{ v = readScreen\(await tmux\(\["capture-pane", "-t", sessionId, "-p"\]\), io\); \}/, "scrapePane → readScreen");
});
t("W2 노드 스냅샷 투영이 background 를 싣고, 끊긴 노드에선 접는다(working·awaiting 과 같은 라이브 신호 · #2533)", () => {
  const row = { id: "box-x", owner: "a", invites: [], agentState: "idle", attached: true, background: true } as unknown as Parameters<typeof projectNodeSession>[0];
  assert.equal(projectNodeSession(row, true, "a").background, true, "붙은 노드 — 그대로");
  assert.equal(projectNodeSession(row, false, "a").background, false, "끊긴 노드 — 얼어붙은 과거라 접는다");
});

console.log(`\n${pass} passed`);
