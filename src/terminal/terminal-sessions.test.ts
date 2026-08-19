// 단위 체크(node:assert) — '확인 필요'(waiting) pane 판정. 픽스처는 tmux capture-pane 실측(#853).
// 실행: npm run build && node dist/terminal/terminal-sessions.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAwaiting, modeEnvArgs, canSeeSession, resolveAgentPhase, parseReportedPhase, isPhaseFresh, isActivityProgress, PHASE_TTL_SEC } from "./terminal-sessions.js";
// 배럴(terminal-sessions.ts)엔 새 심볼을 늘리지 않는다 — 그 파일의 재수출 집합은 #1313 R15 분할의 계약이다.
import { harnessLaunchArgv, harnessLoginArgv, harnessFailNotice, HARNESSES, RESUME_ID_RE } from "./catalog.js";
import { SHELL_CMDS, isAgentOffline } from "./phase.js";  // E12 — 런처가 pane 포그라운드를 무엇으로 보이게 하는가(#1535)

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
t("detectAwaiting — Antigravity 신뢰 대화상자('Do you trust'·'↑/↓ Navigate · enter Confirm')도 확인 필요다(실측 2026-08-18)", () => {
  const ag = [
    " Accessing workspace: /Users/lively/box/yoon/sessions/box-yoon-ca3037ee",
    " Do you trust the contents of this project?",
    " > Yes, I trust this folder",
    "   No, exit",
    " ↑/↓ Navigate · enter Confirm",
  ].join("\n");
  assert.equal(detectAwaiting(ag), true);
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

// ── 세션 런처 / 로그인 세션(#1516) ────────────────────────────────────────────────
// 사양: 하네스가 죽어도 세션은 살아야 하고, 사람은 무엇을 할지 알아야 한다.
//  이 계약은 **문자열 모양이 아니라 실행 결과**로만 증명된다(그 셸 스크립트가 정말 그렇게 도는가) →
//  런처 argv 를 실제로 실행한다. 폴백 셸(`exec … -il`)이 살아 있으면 stdin 으로 준 명령이 실행되므로,
//  'SHELL_ALIVE' 의 유무가 곧 **세션이 살아남았는가**의 관측이다(문구가 아니라 부작용으로 단언).
//  회귀 시나리오: codex 는 인증 만료 시 stderr 한 줄 뒤 exit 1 로 즉사한다 → 종전엔 pane 이 사라져 tmux
//   세션이 통째로 닫혔고 사용자는 에러를 읽을 기회조차 없었다(상민님 신고 2026-08-04 · 실측 재현).
{
  // pane 이 실제로 보게 되는 것 = stdout + stderr(같은 tty 로 섞인다). 둘 다 합쳐 돌려준다.
  const runLaunch = (argv: string[], stdin = "", opts: { noShell?: boolean } = {}): string => {
    // ⚠ 'SHELL 없음'은 **빈 문자열**로 재현한다. env 에서 지우면(unset) 재현이 안 된다 — macOS 의 /bin/sh(bash)는
    //  SHELL 이 unset 이면 passwd 의 로그인 셸로 **스스로 채워** 폴백 경로를 타지 않는다(실측: unset 인데 $SHELL=/bin/zsh).
    //  그러면 이 시나리오는 통과하면서 아무것도 안 보는 vacuous 테스트가 된다(mutation 으로 실제 확인함).
    //  빈 문자열은 어느 셸에서도 유지되고 `${SHELL:-…}` 폴백을 실제로 발동시킨다(dash 처럼 안 채워주는 셸의 대역).
    const env: Record<string, string | undefined> = { ...process.env, SHELL: opts.noShell ? "" : "/bin/sh", ENV: "" };
    const r = spawnSync(argv[0], argv.slice(1), { input: stdin, encoding: "utf8", env: env as NodeJS.ProcessEnv });
    // [배선] 관측 장치가 죽어 있으면 아래 단언은 통과하면서 아무것도 안 본다(vacuous).
    ok2(!r.error && r.status !== null, "[배선] 런처가 실제로 실행됐다");
    return (r.stdout || "") + (r.stderr || "");
  };
  const ALIVE = "echo SHELL_ALIVE\n";   // 폴백 셸이 살아 있을 때만 실행된다

  // E1 — 정상 종료(사용자 /exit): 종전대로 세션이 끝나야 한다. 여기서 셸을 남기면 '사용자가 끝낸 세션'이
  //  안 끝나 #1059(restorable·회수) 설계가 통째로 어긋난다.
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["sh", "-c", "echo HARNESS_BYE; exit 0"]), ALIVE);
    ok2(/HARNESS_BYE/.test(out), "E1 정상 종료: 하네스 출력은 그대로 남는다");
    ok2(!/SHELL_ALIVE/.test(out), "E1 정상 종료(exit 0)는 종전대로 세션을 끝낸다(셸 폴백 없음)");
    ok2(!/codex logout/.test(out), "E1 정상 종료엔 실패 안내를 찍지 않는다");
  }
  // E2 — 비정상 종료(= 인증 만료로 즉사한 codex): 세션이 살아남고, 원문 에러와 조치 안내가 함께 남는다.
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["sh", "-c", "echo HARNESS_ERR >&2; exit 1"]), ALIVE);
    ok2(/SHELL_ALIVE/.test(out), "E2 비정상 종료(exit≠0): **세션이 살아남는다**(셸이 자리를 이어받음)");
    ok2(/HARNESS_ERR/.test(out), "E2 하네스가 stderr 로 남긴 원문 에러가 화면에 보존된다");
    ok2(/codex logout && codex login --device-auth/.test(out), "E2 비개발자가 그대로 붙여넣을 로그인 한 줄을 준다");
  }
  // E3 — 127(명령 없음)은 **전용 안내**를 받는다(#1541): "다시 시작하세요"는 같은 실패를 반복시키는 안내다.
  //  원인은 대개 좁은 PATH(GUI 가 재시작한 노드) — 터미널에서 노드 재시작 한 줄을 처방한다.
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["sh", "-c", "exit 127"]), ALIVE);
    ok2(/SHELL_ALIVE/.test(out), "E3 다른 실패 코드(127)도 세션을 살린다(코드 값에 무관)");
    ok2(/PATH 에서 찾지 못했습니다/.test(out), "E3 127 은 '실행 파일을 못 찾았다' 안내다(죽었다는 안내가 아니라)");
    ok2(/lively node stop && lively node --daemon/.test(out), "E3 처방 한 줄(노드 재시작)이 그대로 붙여넣을 수 있게 나온다");
    ok2(!/예기치 않게 종료/.test(out), "E3 127 에 일반 실패 안내를 겹쳐 찍지 않는다");
  }
  // E3b — 일반 실패(exit 1)에는 127 안내가 새지 않는다(갈래 분리 확인).
  {
    const out = runLaunch(harnessLaunchArgv("claude", ["sh", "-c", "exit 1"]), ALIVE);
    ok2(!/PATH 에서 찾지 못했습니다/.test(out), "E3b 일반 실패에 not-found 안내가 새지 않는다");
    ok2(/예기치 않게 종료/.test(out), "E3b 일반 실패 안내는 그대로");
  }
  // E4 — 새로 도입한 헬퍼의 **빈 입력**: POSIX 셸 세션은 감쌀 하네스가 없다.
  ok2(harnessLaunchArgv("shell", [], "linux").length === 0, "E4 POSIX 셸 세션(빈 cmd)은 감싸지 않는다");
  ok2(harnessLaunchArgv("shell", [], "darwin").length === 0, "E4 darwin 도 동일");

  // ── E4c ★ Windows pane 셸의 UTF-8 프렐류드(#1541) ──────────────────────────────
  //  계기(실측 hammurabi): pane 은 chcp 949 · [Console]::OutputEncoding=ks_c_5601-1987 로 시작해
  //   `node x.mjs | Out-String` 과 `type <UTF-8 로그>` 의 한글이 깨졌다(직접 출력은 정상 — 읽는 층만 틀렸다).
  //  이 분기는 mac/linux CI 에서 **한 번도 실행되지 않으므로**(#1510 §5) 계약을 정적으로 못박는다.
  {
    const sh = harnessLaunchArgv("shell", [], "win32");
    // 배선 단언 — argv 가 비면 아래 루프·정규식이 **아무것도 검사하지 않고 통과한다**(실측: red 상태에서
    //  빈 배열이면 `.test(undefined)` 가 "undefined" 를 검사해 true 가 됐다). 먼저 존재를 못박는다.
    ok2(sh.length === 5, `E4c 배선: Windows 셸 argv 가 5토큰이어야 한다 — 실제 ${sh.length}: ${JSON.stringify(sh)}`);
    ok2(sh[0] === "powershell", `E4c Windows 셸 세션은 powershell 을 띄운다: ${sh[0]}`);
    ok2(sh.includes("-NoExit"), "E4c -NoExit — 프렐류드 뒤 대화형 프롬프트로 남는다(셸 세션이니까)");
    ok2(!sh.includes("-NoProfile"), "E4c 사용자 프로필은 그대로 로드한다(사용자 설정이 이긴다)");
    const i = sh.indexOf("-EncodedCommand");
    ok2(i > 0 && i === sh.length - 2, "E4c -EncodedCommand 페이로드는 마지막 토큰이다");

    // ★ psmux 통과 조건 — 이 계약이 깨지면 스크립트가 pane 에 도착하지 못한다.
    //  psmux 3.3.7 은 인자의 `"` · `'` · 탭을 삼키고(opt-json.test.ts), 공백은 인자를 쪼갠다.
    for (const tok of sh) {
      ok2(!/["'\t ]/.test(tok), `E4c ★ 토큰에 psmux 소실·분해 문자가 없다: ${JSON.stringify(tok)}`);
    }
    const b64 = sh[sh.length - 1];
    ok2(/^[A-Za-z0-9+/]+={0,2}$/.test(b64), `E4c ★ 페이로드는 base64 알파벳만 (${b64.length}자)`);

    // 페이로드가 **실제로 네 축을 다 세우는지** — UTF-16LE 로 되돌려 내용을 본다(문구가 아니라 설정 대상).
    const ps = Buffer.from(b64, "base64").toString("utf16le");
    ok2(/chcp\s+65001/.test(ps), `E4c 네이티브 자식용 콘솔 코드페이지(chcp 65001)를 세운다`);
    ok2(/\[Console\]::OutputEncoding\s*=/.test(ps), "E4c ★ 파이프 정상화의 핵심([Console]::OutputEncoding)을 세운다 — chcp 만으론 안 고쳐진다(실측)");
    ok2(/\[Console\]::InputEncoding\s*=/.test(ps), "E4c 타이핑한 한글이 네이티브 자식에게 갈 때(InputEncoding)");
    ok2(/\$OutputEncoding\s*=/.test(ps), "E4c 네이티브 자식 stdin 으로 보낼 때($OutputEncoding)");
    ok2(/UTF8Encoding\(\$false\)/.test(ps), "E4c BOM 없는 UTF-8 (BOM 이 붙으면 파이프 첫 바이트가 오염된다)");
    // 프렐류드가 실패해도 셸은 떠야 한다 — 설정마다 try/catch.
    ok2((ps.match(/try\{/g) || []).length >= 4, "E4c 설정마다 try/catch — 한 줄이 실패해도 셸은 뜬다");

    // 하네스 세션은 감싸지 않는다 — 감싸려면 하네스 argv 를 PowerShell 문자열에 이어붙여야 하고
    //  그게 catalog.ts 가 막는 인젝션 경계다(E4b 와 같은 규칙).
    const h = harnessLaunchArgv("claude", ["claude", "--model", "opus"], "win32");
    ok2(h.join(" ") === "claude --model opus", `E4c 하네스 세션엔 프렐류드를 끼우지 않는다: ${h.join(" ")}`);
    ok2(!h.includes("-EncodedCommand"), "E4c ★ 하네스 argv 가 PowerShell 스크립트에 섞이지 않는다");

    // 엣지: 새로 도입한 분기에 cmd 가 아예 없을 때(null/undefined) 크래시하지 않는다.
    ok2(harnessLaunchArgv("shell", null as unknown as string[], "win32")[0] === "powershell", "E4c cmd=null 도 셸 세션으로 취급");
    ok2(harnessLaunchArgv("shell", undefined as unknown as string[], "linux").length === 0, "E4c POSIX cmd=undefined 는 빈 argv");
    // 경계: 빈 문자열 한 개는 length>0 이므로 하네스 취급(프렐류드로 갈아치우지 않는다).
    ok2(harnessLaunchArgv("shell", [""], "win32").length === 1, "E4c cmd=[''] 는 하네스 취급(길이 1 유지)");
  }
  // E4b ★ Windows(psmux 노드)는 감싸지 않는다 (#1541 실측) — 이 런처는 POSIX 셸 스크립트인데 pane 셸이
  //  PowerShell 이라 그대로 파싱돼(`'[' 뒤에 형식 이름이 없습니다`) 하네스가 시작조차 못 하고 세션이 즉사했다.
  //  Windows 분기는 mac/linux CI 에서 한 번도 실행되지 않으므로(#1510 §5) 계약을 여기서 못박는다.
  {
    const win = harnessLaunchArgv("claude", ["claude", "--model", "opus"], "win32");
    ok2(win.join(" ") === "claude --model opus", "E4b Windows 는 하네스를 직접 띄운다(sh 래퍼 없음)");
    ok2(!win.includes("sh") && !win.some((a) => a.includes('[ "$rc"')), "E4b Windows argv 에 POSIX 스크립트가 섞이지 않는다");
    // POSIX 는 종전 그대로 감싼다(#1516 사후회복 유지) — 회귀 방지.
    const posix = harnessLaunchArgv("claude", ["claude"], "linux");
    ok2(posix[0] === "sh" && posix[1] === "-c" && posix[2].includes('[ "$rc" -eq 0 ]'), "E4b POSIX 는 종전대로 런처로 감싼다");
  }
  // E5 — 인젝션: 하네스·플래그는 위치인자로만 들어가 셸이 값을 해석하지 않는다.
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["echo", "$(echo PWNED)"]));
    ok2(/\$\(echo PWNED\)/.test(out), "E5 하네스 argv 의 명령치환이 실행되지 않고 값 그대로 전달된다");
  }
  // E6 — 여러 줄·유니코드 박스문자 안내가 깨지지 않고 그대로 나온다(pane 에서 사람이 읽는 형태).
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["sh", "-c", "exit 1"]));
    const notice = harnessFailNotice("codex");
    ok2(out.includes(notice), "E6 안내가 여러 줄·박스문자 그대로 온전히 출력된다");
    ok2(notice.split("\n").length >= 5, "E6 안내는 한 줄짜리가 아니다(따라 할 절차가 있다)");
  }
  // E7 — **SHELL 이 비어 있는 환경**(격리 경로의 sudo 는 env_reset 으로 env 를 턴다). 새로 기댄 변수의 부재 엣지 —
  //  여기서 폴백이 없으면 '세션을 살리는' 수정이 정작 격리 박스(리눅스 고객 설치)에서만 조용히 안 먹는다.
  {
    const out = runLaunch(harnessLaunchArgv("codex", ["sh", "-c", "exit 1"]), ALIVE, { noShell: true });
    ok2(/SHELL_ALIVE/.test(out), "E7 SHELL 이 비어 있어도 폴백 셸이 떠서 세션이 살아남는다");
  }
  // E11 — 모르는 하네스도 빈 안내를 주지 않는다(장래에 하네스가 늘어도 사용자는 조치를 안다).
  ok2(harnessFailNotice("codex").includes("device-auth"), "E11a codex 안내는 device-auth 를 지목한다");
  ok2(harnessFailNotice("claude").includes("/login"), "E11b claude 안내는 TUI 안 /login 을 지목한다");
  ok2(harnessFailNotice("gemini").includes("gemini"), "E11c 모르는 하네스도 그 이름으로 재실행 안내를 준다");
  // E11d~ (#1695) — 안내에 적히는 명령은 **사용자가 그대로 치는 문자열**이다. 라벨도 내부 식별자도 아닌
  //  실행 파일이어야 한다: antigravity 의 명령은 `agy` 라, 종전 폴백('그 이름으로 재실행')을 그대로 두면
  //  하네스가 죽은 뒤 안내대로 쳤는데 command not found 로 **두 번** 막힌다.
  //  ⚠ 명령 줄은 4칸 들여쓰기 한 줄이다 — 그 형태로 봐야 '문구 어딘가에 단어가 있다'와 구분된다.
  const cmdLines = (notice: string): string[] =>
    notice.split("\n").filter((l) => /^ {4}\S/.test(l)).map((l) => l.trim());
  {
    const n = harnessFailNotice("antigravity");
    ok2(cmdLines(n).includes("agy"), "E11d antigravity 안내가 주는 명령은 실행 파일(agy)");
    ok2(!cmdLines(n).includes("antigravity"), "E11e 내부 식별자를 명령으로 주지 않는다(command not found)");
    ok2(n.includes("Antigravity"), "E11f 무엇이 죽었는지는 사람이 읽는 이름으로 알린다");
    ok2(/주소|코드/.test(n), "E11g agy 는 로그인 명령이 없어 하네스가 띄우는 절차를 대신 안내한다");
  }
  ok2(cmdLines(harnessFailNotice("opencode")).some((c) => c.startsWith("opencode auth login")),
    "E11h opencode 안내는 제공자 로그인 명령을 지목한다");
  ok2(cmdLines(harnessFailNotice("codex")).some((c) => c.includes("codex login --device-auth")),
    "E11i codex 는 종전대로 로그인 한 줄이 먼저다(무회귀)");
  // 새로 도입한 '로그인 힌트' 필드가 **없는** 하네스 — 꼬리에 빈 줄·빈 항목이 붙으면 안 된다.
  //  (필드를 도입하면 '그 필드가 빈 경우'라는 엣지가 새로 생긴다.)
  {
    const n = harnessFailNotice("shell");
    ok2(!/\n\n─+$/.test(n) && !/\n\n\n/.test(n), "E11j 힌트 없는 하네스는 안내 꼬리에 빈 줄이 안 붙는다");
    // ⚠ '빈 명령 줄이 없다'만 단언하면 vacuous 다 — 빈 줄은 cmdLines 필터에 애초에 안 잡혀 항상 통과한다(실측).
    //  실행 파일이 비어도 **무언가 칠 것**을 줘야 한다는 쪽으로 단언한다.
    ok2(cmdLines(n).includes("shell") && !/^ {4}\s*$/m.test(n),
      "E11k 실행 파일이 빈 하네스는 빈 명령 줄 대신 그 이름으로 안내한다");
  }

  // E13 (#1695) — 웹 세션 카탈로그: **배선이 끝난 하네스로 세션을 만들 수 있는가.**
  //  #1519(opencode)·#1689(antigravity) 로 훅·MCP·자산은 다 붙었는데 이 표에만 없어서, 웹에서는 그 하네스로
  //  세션을 여는 것 자체가 불가능했다(선택지에 없으면 서버 검증이 400 을 낸다).
  {
    const keys = HARNESSES.map((h) => h.key);
    ok2(keys.includes("opencode") && keys.includes("antigravity"), "E13a 배선된 4하네스가 모두 세션 선택지에 있다");
    const agy = HARNESSES.find((h) => h.key === "antigravity");
    ok2(agy?.bin === "agy", "E13b antigravity 의 실행 파일은 agy(key 로 spawn 하면 ENOENT)");
    ok2(agy?.autoApproveFlag === "--dangerously-skip-permissions", "E13c 자동승인은 그 하네스가 실제로 받는 플래그");
    ok2((agy?.flags.find((f) => f.name === "--effort")?.choices || []).join(",") === ",low,medium,high",
      "E13d agy 의 추론강도는 3단계 — 다른 하네스의 목록을 복사해 두면 고른 값이 거부된다");
    ok2(HARNESSES.find((h) => h.key === "opencode")?.autoApproveFlag === "--auto", "E13e opencode 자동승인은 --auto");
    ok2(HARNESSES.every((h) => h.key === "shell" || !!h.bin), "E13f 셸 말고는 실행 파일이 반드시 있다");
    // 어느 하네스든 '하네스 기본'을 고를 수 있어야 낡은 모델 문자열에 사용자가 묶이지 않는다.
    const modelFlags = HARNESSES.flatMap((h) => h.flags.filter((f) => f.name === "--model"));
    ok2(modelFlags.length > 0 && modelFlags.every((f) => (f.choices || [])[0] === ""),
      "E13g 모델 목록의 첫 옵션은 언제나 '하네스 기본'(빈 값)");
  }
  ok2(harnessLoginArgv("antigravity") === null, "E13h agy 는 로그인 서브커맨드가 없어 로그인 전용 세션을 만들지 않는다");
  ok2(harnessLoginArgv("opencode") === null, "E13i opencode 로그인은 대화형 제공자 선택이라 무인 한 줄이 아니다");

  // E14 (#1711) — **이어서 열기가 그 대화를 실제로 이어받는가.** 종전엔 이 주입이 sessions.ts 에서
  //  `harness.key === "claude"` 로 잠겨 있어, 다른 하네스는 복원해도 늘 새 대화로 시작했다(상민님 신고).
  //  수단은 하네스마다 다르고 **위치도 다르다**(codex 는 플래그가 아니라 서브커맨드).
  {
    const r = (k: string, id?: string): string[] => HARNESSES.find((h) => h.key === k)?.resumeArgv?.(id) ?? [];
    ok2(r("claude", "u1").join(" ") === "--resume u1", "E14a claude 는 --resume <id>");
    ok2(r("claude").join(" ") === "--resume", "E14b id 를 모르면 피커(인자 없는 --resume)");
    ok2(r("codex", "s1")[0] === "resume", "E14c codex 는 서브커맨드 — bin 바로 뒤 첫 자리여야 한다(플래그가 아니다)");
    ok2(r("codex").join(" ") === "resume --last", "E14d codex 피커는 대화형이라 무인 복원엔 --last");
    ok2(r("opencode", "ses_1").join(" ") === "--session ses_1", "E14e opencode 는 --session <id>");
    ok2(r("antigravity", "c1").join(" ") === "--conversation c1", "E14f antigravity 는 --conversation <id>");
    ok2(r("antigravity").join(" ") === "--continue", "E14g id 를 모르면 가장 최근 대화");
    ok2(r("shell", "x").length === 0 && r("shell").length === 0, "E14h 셸은 이어받을 대화가 없다 — 아무 인자도 만들지 않는다");
    // 새 하네스가 조용히 빠지지 않게 — 빠지면 그 하네스만 '이어서 열기'가 새 대화로 열린다(발견이 어렵다).
    ok2(HARNESSES.filter((h) => h.bin).every((h) => typeof h.resumeArgv === "function"),
      "E14i 실행 파일이 있는 하네스는 모두 이어받기 수단을 가진다");
    // id 형식은 하네스마다 다르다 — 하나라도 막히면 그 하네스는 정밀 복원이 통째로 400 이 된다.
    ok2(RESUME_ID_RE.test("ses_8f3a_bc"), "E14j opencode 형 id(밑줄)가 형식 검증을 통과한다");
    ok2(RESUME_ID_RE.test("0199b1a2-1f3e-7c44-9c2a-3b0f5d6e7a8b"), "E14k UUID 형 id 가 통과한다");
    ok2(!RESUME_ID_RE.test("../etc/passwd") && !RESUME_ID_RE.test("a b") && !RESUME_ID_RE.test(""),
      "E14l 경로·공백·빈값은 막는다");
  }

  // E12 — 런처의 **부작용**: pane 의 foreground 프로세스가 무엇으로 보이는가 (#1535).
  //  래퍼를 씌운다는 건 pane 에 프로세스를 하나 더 만든다는 뜻이다. job control 이 없으면 그 래퍼
  //  (`sh` — macOS 실체는 bash)가 tty 의 foreground pgrp 리더로 눌러앉아, 하네스가 도는 중에도 tmux 의
  //  `#{pane_current_command}` 가 **`bash`** 로 나온다. 그 한 값이 두 판정의 유일한 입력이라 둘 다 뒤집힌다:
  //   · stale 마우스 게이팅(#1302) — 살아있는 앱의 마우스를 끄고(alt-screen 휠이 화살표 키로 폴백 =
  //     2026-08-05 상민님 신고 증상) pane tty 에 DECRST 를 써서 tmux 의 진실까지 파괴
  //   · isAgentOffline — 살아있는 하네스를 '종료됨'으로 표시
  //  둘 다 **웹 UI 에서만** 보이는 증상이라 서버 테스트로는 안 잡힌다 → 계약을 여기서 tmux 로 직접 고정한다.
  //  (문자열 검사로는 못 한다. `set -m` 이 든 스크립트를 확인해봐야 그게 정말 pgrp 을 옮겼는지는 tmux 만 안다.)
  {
    const haveTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
    if (!haveTmux) console.log("skip E12 (tmux 없음 — 윈도우/최소 컨테이너)");
    else {
      // ⚠ 소켓 경로는 짧아야 한다(unix sun_path ≈104바이트). macOS 의 tmpdir() 은 /var/folders/… 라 길어서 실패한다.
      const sock = `/tmp/lv-e12-${process.pid}.sock`;
      const tmux = (...a: string[]): string =>
        (spawnSync("tmux", ["-S", sock, ...a], { encoding: "utf8" }).stdout || "").trim();
      // pane 기동을 기다린다(최대 ~3s) — done(cmd) 이 참이 되면 즉시 반환. 고정 sleep 은 느리거나 불안정하다.
      const paneCmd = (sess: string, done: (c: string) => boolean): string => {
        let c = "";
        for (let i = 0; i < 30; i++) {
          c = tmux("display-message", "-p", "-t", sess, "#{pane_current_command}");
          if (done(c)) break;
          spawnSync("sleep", ["0.1"]);
        }
        return c;
      };
      try {
        tmux("kill-server");
        // 하네스 대역 = `sleep`(셸이 아닌 이름이면 무엇이든 된다). 실제 하네스는 부르지 않는다 — 설치·인증에 기대지 않게.
        tmux("new-session", "-d", "-s", "e12a", "-x", "80", "-y", "24", ...harnessLaunchArgv("claude", ["sleep", "120"]));
        const alive = paneCmd("e12a", (c) => c === "sleep");
        ok2(alive === "sleep", `E12a 하네스가 도는 동안 tmux 의 foreground 는 하네스여야 한다(실측 '${alive}')`);
        ok2(!SHELL_CMDS.has(alive), `E12b 그게 셸로 보이면 마우스 게이팅·offline 판정이 동시에 뒤집힌다(실측 '${alive}')`);
        ok2(!isAgentOffline("claude", alive), "E12c 살아있는 하네스를 '종료됨'으로 판정하지 않는다");
        // 반대 축 — 하네스가 죽으면 폴백 셸이 foreground 를 되찾아 '종료됨'·'stale 마우스'가 **그때** 참이 된다.
        //  (이게 없으면 E12a~c 는 "게이팅을 통째로 무력화하라"는 요구로 오독될 수 있다.)
        tmux("new-session", "-d", "-s", "e12d", "-x", "80", "-y", "24", ...harnessLaunchArgv("claude", ["sh", "-c", "exit 1"]));
        const dead = paneCmd("e12d", (c) => SHELL_CMDS.has(c));
        ok2(isAgentOffline("claude", dead), `E12d 하네스가 죽은 뒤엔 셸이 foreground → '종료됨'이 참이 된다(실측 '${dead}')`);
      } finally { tmux("kill-server"); }
    }
  }

  // ── 로그인 세션 — 만료 자격으로는 하네스가 즉사해 로그인 화면조차 못 뜨던 데드락을 끊는다 ──
  {
    const argv = harnessLoginArgv("codex");
    ok2(!!argv && argv[0] === "sh", "E8a codex 로그인은 셸에서 명령을 돌린다(하네스 TUI 아님)");
    ok2(!!argv && argv.join(" ").includes("codex logout"), "E8b 만료 자격을 먼저 지운다");
    ok2(!!argv && argv.join(" ").includes("codex login --device-auth"), "E8c 원격에서도 되는 주소+코드 방식으로 로그인한다");
    // L3 — 로그인이 끝나면 셸로 남는다(codex 를 스텁으로 가려 실제 로그인 없이 흐름만 관측).
    const stub = mkdtempSync(join(tmpdir(), "lively-1516-"));
    writeFileSync(join(stub, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = spawnSync(argv![0], argv!.slice(1), {
      input: ALIVE, encoding: "utf8",
      env: { ...process.env, SHELL: "/bin/sh", ENV: "", PATH: `${stub}:${process.env.PATH ?? ""}` },
    });
    rmSync(stub, { recursive: true, force: true });
    ok2(/SHELL_ALIVE/.test((r.stdout || "") + (r.stderr || "")), "E8d 로그인 절차가 끝나면 셸로 남아 그 자리에서 바로 쓸 수 있다");
  }
  ok2(harnessLoginArgv("claude") === null, "E9 claude 는 /login 이 TUI 안이라 자동화 불가 → 종전 경로 유지");
  ok2(harnessLoginArgv("nope") === null, "E10 모르는 하네스는 로그인 명령을 만들지 않는다");
}
