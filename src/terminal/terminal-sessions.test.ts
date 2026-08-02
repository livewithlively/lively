// 단위 체크(node:assert) — '확인 필요'(waiting) pane 판정. 픽스처는 tmux capture-pane 실측(#853).
// 실행: npm run build && node dist/terminal/terminal-sessions.test.js
import assert from "node:assert/strict";
import { detectAwaiting, modeEnvArgs, canSeeSession, resolveAgentPhase, parseReportedPhase, isPhaseFresh, isActivityProgress, PHASE_TTL_SEC } from "./terminal-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 입력창(모드 푸터 포함) — 다이얼로그가 없을 때 pane 하단에 늘 있는 것.
const INPUT_BOX = [
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

t("끝난 대화 + 하단 입력창 → 대기 아님", () => {
  assert.equal(detectAwaiting(["⏺ 답변입니다.", "", INPUT_BOX].join("\n")), false);
});

// #853 회귀: Claude Code 는 과거 사용자 메시지도 '❯ ' 로 그린다 → 번호목록을 보낸 세션의 전사에
// "❯ 1. …" 이 남아 승인 커서로 오인됐다(끝난 대화가 영구 '확인 필요' 빨강).
t("전사에 남은 사용자의 번호목록 메시지 → 대기 아님(#853 오탐)", () => {
  const pane = [
    "❯ 1. 최근에 위키를 열어보셨던 때에는 무엇을 하려고 들어가셨나요?",
    "",
    "  2. 노션에서는 늘 하는데 라이블리 위키에서는 안 되거나 훨씬 번거로운 것 2~3개만 꼽아주신다면?",
    "",
    "⏺ 비나용 2차 질문 세트입니다 — 확정하신 1차 5문항과 겹치지 않는 각도로 6문항입니다.",
    "",
    "✻ Baked for 2m 17s",
    INPUT_BOX,
  ].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

t("사용자가 입력창에 번호목록을 타이핑 중 → 대기 아님", () => {
  const pane = ["⏺ 네.", "─".repeat(120), "❯ 1. 첫째 2. 둘째", "─".repeat(120), "  ⏸ manual mode on · ? for shortcuts"].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

// 실측: Write 툴 승인 다이얼로그. 문구가 "Do you want to proceed?" 가 아니라 툴별로 다르다.
t("승인 다이얼로그(파일 생성) → 대기", () => {
  const pane = [
    "❯ Create a file named hello.txt containing the word hi, in the current directory.",
    "",
    "⏺ Write(hello.txt)",
    "─".repeat(120),
    " Create file",
    " hello.txt",
    "╌".repeat(120),
    "  1 hi",
    "╌".repeat(120),
    " Do you want to create hello.txt?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

// 실측: AskUserQuestion 선택 메뉴.
t("질문 선택 메뉴 → 대기", () => {
  const pane = [
    "❯ Ask me which color I prefer.",
    " ☐ Color",
    "Which color do you prefer, red or blue?",
    "",
    "❯ 1. Red",
    "     Warm, bold, high-energy.",
    "  2. Blue",
    "     Cool, calm, steady.",
    "  3. Type something.",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("Bash 승인 다이얼로그(Do you want to proceed?) → 대기", () => {
  const pane = [
    "⏺ Bash(rm -rf build)",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("빈 pane → 대기 아님", () => {
  assert.equal(detectAwaiting(""), false);
});

// ── 실행 모드(#1007+) 격리 pane env 인자 — 전이기 dual-env 계약(x-lively-mode 미전파 박스 안전, #1007 리뷰 지적) ──
t("modeEnvArgs: normal(플래그 없음) → env 인자 없음", () => {
  assert.deepEqual(modeEnvArgs({}), []);
  assert.deepEqual(modeEnvArgs({ readOnly: false, incognito: false }), []);
});
t("modeEnvArgs: readonly → LIVELY_MODE=readonly + 전이기 구 LIVELY_READONLY=1", () => {
  assert.deepEqual(modeEnvArgs({ readOnly: true }), ["-e", "LIVELY_MODE=readonly", "-e", "LIVELY_READONLY=1"]);
});
t("modeEnvArgs: incognito → LIVELY_MODE=incognito + 구 LIVELY_INCOGNITO=1 + LIVELY_OFF=1(훅 off)", () => {
  assert.deepEqual(modeEnvArgs({ incognito: true }), ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"]);
});
t("modeEnvArgs: 둘 다면 incognito 가 이긴다(더 강한 격리)", () => {
  assert.deepEqual(modeEnvArgs({ readOnly: true, incognito: true }), ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"]);
});

console.log(`\n${pass} passed`);

import path from "node:path";
import os from "node:os";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";

const ok2 = (cond: boolean, name: string): void => { if (!cond) { console.error("FAIL " + name); process.exitCode = 1; } else console.log("ok  " + name); };

// ── 가시성 술어(#1059) — 라이브·복원목록이 같은 규칙을 써야 한다 ────────────────────────
// 실측 사고(2026-07-28): 복원목록만 '내 것만' 이어서, F 회수로 tmux 에서 사라진 **남의 프로젝트 세션이 팀원
//  화면에서 통째로 없어졌다**(삭제된 줄 알았고 데이터는 그대로였다). 라이브일 때 보이던 게 회수되면 안 보이는
//  건 그 자체로 버그다 — 그래서 술어를 하나로 뽑고 여기서 고정한다.
{
  // 프로젝트 폴더 판정은 PROJECT_SHARED_BASE(TERMINAL_ROOT_SHARED || ~/workspace) 기준이라 환경에서 유도한다
  //  — 경로를 하드코딩하면 박스마다 base 가 달라(고객사 A=/srv/lively/shared, dev=~/.openclaw/...) 헛통과한다.
  const proj = path.join(PROJECT_SHARED_BASE, "project", "714", "repo");
  const priv = path.join(os.homedir(), "box", "work");
  ok2(canSeeSession({ dir: proj, owner: "mike", invites: [] }, "haru"), "프로젝트 폴더 세션은 남이어도 보인다(#452)");
  ok2(!canSeeSession({ dir: priv, owner: "mike", invites: [] }, "haru"), "개인 세션은 남에게 안 보인다");
  ok2(canSeeSession({ dir: priv, owner: "mike", invites: [] }, "mike"), "개인 세션은 소유자에게 보인다");
  ok2(canSeeSession({ dir: priv, owner: "mike", invites: ["haru"] }, "haru"), "초대된 사람에게 보인다");
  ok2(!canSeeSession({ dir: proj, owner: "mike", invites: [] }, ""), "신원 미상은 아무것도 못 본다");
  ok2(!canSeeSession({ dir: null, owner: "mike", invites: null }, "haru"), "dir·invites 가 비어도 남의 것은 안 보인다");
}

// ── 실행 단계 판정(#1221) — 하네스 보고 vs 화면 스크래핑 **우선순위표** ──────────────────
// 왜 표를 테스트로 못박나: busy·waiting 은 지금까지 게이트웨이가 tmux 화면을 훔쳐본 결과였다(pane 제목의 브라유
//  스피너 · capture-pane 승인 패턴). 그래서 Claude Code UI 가 바뀌면 조용히 깨졌고(#853 오탐 이력), 5분 폴링
//  사이의 변화를 놓쳤고, 스피너를 안 그리는 코덱스는 영영 '작업 중'이 안 됐다. 이제 훅이 직접 알리지만 **두 출처가
//  공존**한다(보고 없는 구 세션·incognito 는 스크래핑에 남는다) — 어느 쪽이 이기는지가 곧 계약이다.
{
  const T = 1_700_000_000;                     // 기준 '지금'(epoch초)
  const rep = (phase: "busy" | "waiting" | "idle", ago = 0) => ({ phase, at: T - ago });
  const phase = (i: Partial<Parameters<typeof resolveAgentPhase>[0]>): string =>
    resolveAgentPhase({ reported: null, nowSec: T, spinning: false, scrapedWaiting: false, ...i });

  // 1·2) 신선한 waiting 보고가 **스피너보다 위**다 — 스피너는 글리프 추측이고 이건 하네스가 알린 이벤트다.
  ok2(phase({ reported: rep("waiting"), spinning: true }) === "waiting", "보고된 '확인 필요'가 스피너를 이긴다");
  ok2(phase({ reported: rep("waiting") }) === "waiting", "보고된 '확인 필요'(기본형)");
  // 3·4) 신선한 busy 보고가 스크래핑 대기 판정을 이긴다 — #853 류 오탐(전사에 남은 '❯ 1. …')이 턴 진행 중엔 무력화.
  ok2(phase({ reported: rep("busy"), scrapedWaiting: true }) === "busy", "보고된 '작업 중'이 화면 오탐을 덮는다(#853)");
  ok2(phase({ reported: rep("busy") }) === "busy", "보고된 '작업 중'(기본형)");
  // 5·6) 보고가 idle 인데 스피너가 돌면 스피너를 믿는다 — Stop 훅이 block 돼 턴이 이어진 경우를 구제한다.
  ok2(phase({ reported: rep("idle"), spinning: true }) === "busy", "idle 보고 + 스피너 → 작업 중(Stop 뒤 턴이 이어진 경우 구제)");
  ok2(phase({ reported: rep("idle") }) === "idle", "idle 보고 + 아무 관측 없음 → 대기 중");
  // 7·8·9) 보고가 없으면 **종전 그대로** — 훅이 아직 안 붙은 세션(구 세션·incognito)의 무회귀 보장.
  ok2(phase({ spinning: true }) === "busy", "보고 없음 → 스피너 폴백(무회귀)");
  ok2(phase({ scrapedWaiting: true }) === "waiting", "보고 없음 → capture-pane 폴백(무회귀)");
  ok2(phase({}) === "idle", "신호가 하나도 없으면 대기 중");
  // 10·11) 만료된 보고는 없는 것과 같다 — 훅은 데몬이 아니라 이벤트가 나야 도니, 오래된 보고를 계속 믿으면
  //    Stop 훅이 못 뜬 세션이 영원히 '작업 중'으로 굳는다(회수도 막히고 색도 틀린다).
  ok2(phase({ reported: rep("busy", PHASE_TTL_SEC + 1) }) === "idle", "TTL 지난 보고는 무시된다");
  ok2(phase({ reported: rep("busy", PHASE_TTL_SEC + 1), spinning: true }) === "busy", "만료돼도 스크래핑이 답을 이어받는다");

  // 경계값 — `>` 와 `>=` 의 오프바이원은 이 두 행이 없으면 영영 안 잡힌다.
  ok2(isPhaseFresh({ at: T - PHASE_TTL_SEC }, T) === true, "경계: 정확히 TTL 지난 보고는 아직 신선");
  ok2(isPhaseFresh({ at: T - PHASE_TTL_SEC - 1 }, T) === false, "경계: TTL+1초는 만료");
  // 미래 시각도 만료로 본다 — 노드(#869) 훅은 **멤버 PC 시계**로 찍혀, 스큐가 있으면 '영원히 신선한' 보고가 굳는다.
  ok2(isPhaseFresh({ at: T + 60 }, T) === true, "경계: 허용 스큐(+60초)까지는 신선");
  ok2(isPhaseFresh({ at: T + 61 }, T) === false, "경계: 그보다 미래로 찍힌 보고는 신뢰하지 않는다(노드 시계 스큐)");
  ok2(isPhaseFresh(null, T) === false, "보고 자체가 없으면 신선하지 않다");

  // 파싱 — 세션 메타는 **옛 세션엔 아예 없다.** 깨진 값은 언제나 '보고 없음'으로 안전 폴백해야 한다.
  ok2(parseReportedPhase("busy 1700000000")?.at === 1_700_000_000, "정상값 파싱(단계+시각)");
  ok2(parseReportedPhase("") === null, "빈 값(옛 세션) → 보고 없음");
  ok2(parseReportedPhase("busy") === null, "시각 없음 → 보고 없음");
  ok2(parseReportedPhase("running 1700000000") === null, "모르는 단계 → 보고 없음");
  ok2(parseReportedPhase("busy abc") === null, "시각이 숫자가 아님 → 보고 없음");
  ok2(parseReportedPhase("busy 0") === null, "시각이 0 → 보고 없음");
}

// ── 활동 시각을 언제 올리나(#1221) ─────────────────────────────────────────────────
// lastActive 는 회수(idle TTL)와 '작업 완료(안 본 채 끝난 작업)' 배지가 **함께** 보는 값이다. 하트비트까지
//  활동으로 세면 며칠 방치된 세션이 영원히 '방금 작업함'이 되어 둘 다 무의미해지고, 반대로 전이를 안 세면
//  턴이 끝난 시각을 놓쳐 '작업 완료' 가 안 뜬다.
{
  ok2(isActivityProgress("busy", "busy") === true, "작업중 반복도 진행이다(지금 돌고 있다)");
  ok2(isActivityProgress("busy", "idle") === true, "대기→작업 = 턴 시작");
  ok2(isActivityProgress("idle", "busy") === true, "작업→대기 = **방금 턴이 끝난 시각**('작업 완료' 배지의 근거)");
  ok2(isActivityProgress("idle", "idle") === false, "대기 하트비트는 활동이 아니다");
  ok2(isActivityProgress("waiting", "busy") === true, "작업→확인필요 = 전이");
  ok2(isActivityProgress("waiting", "waiting") === false, "확인필요 하트비트는 활동이 아니다");
  ok2(isActivityProgress(undefined, null) === true, "단계 없는 구 훅의 활동 보고는 종전대로 올린다");
  ok2(isActivityProgress("idle", null) === true, "첫 보고는 전이로 본다");
}
