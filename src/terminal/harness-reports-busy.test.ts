// #3894 — «하네스가 스스로 말하는 작업 중» 판정(phase.ts harnessReportsBusy)과, 그 값이 목록 행까지 실리는 배선.
//
//  왜 따로 있나: 회수 상한(busy_idle_minutes)은 스스로 증명 못 하는 보호(승인 대기·pane 포그라운드 추정)에만 걸린다.
//   그 구분을 agentState·offline 으로 하면 틀린다 — 셸 세션 안 `lively run` 의 AI 는 셸 하네스라 늘 offline 이고 스피너·훅
//   busy 가 버려진다(적대검토 지적 · tmux 표식이 빈 claude 세션의 같은 모양은 #3892 가 관측 쪽에서 닫았다).
//   그러면 살아 있는 AI 를 «사람이 안 봤다» 로 걷는다. 그래서 하네스 종류와 무관한 판정을 따로 두고, 표로 못박는다.
//  표는 스크래치패드 spec.md 의 H1~H8 이다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harnessReportsBusy, PHASE_TTL_SEC } from "./phase.js";

const NOW = 2_000_000;
const SPIN = "⠂ 코드 읽는 중";          // 브라유 스피너(작업 중 제목)
const STAR = "✳ 코드 읽는 중";          // 끝난 턴의 정적 별
let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("H1 포그라운드가 하네스이고 스피너가 돈다 → 작업 중", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "claude", paneTitle: SPIN, reported: null, nowSec: NOW }), true);
});
t("H2 ★ 포그라운드가 셸인데 제목에 스피너가 남았다 → 작업 중이 아니다(끝난 하네스가 남긴 제목)", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "bash", paneTitle: SPIN, reported: null, nowSec: NOW }), false);
});
t("H3 ★ 포그라운드가 무엇이든 신선한 훅 busy 보고가 있으면 작업 중(tmux 하네스 옵션과 무관)", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "bash", paneTitle: "", reported: { phase: "busy", at: NOW - 60 }, nowSec: NOW }), true);
  assert.equal(harnessReportsBusy({ paneCmd: "node", paneTitle: STAR, reported: { phase: "busy", at: NOW - 60 }, nowSec: NOW }), true);
});
t("H4 경계 — 보고가 정확히 TTL 이면 신선, 1초 넘으면 만료(멈춘 보고가 영구 보호가 되지 않는다)", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "bash", paneTitle: "", reported: { phase: "busy", at: NOW - PHASE_TTL_SEC }, nowSec: NOW }), true);
  assert.equal(harnessReportsBusy({ paneCmd: "bash", paneTitle: "", reported: { phase: "busy", at: NOW - PHASE_TTL_SEC - 1 }, nowSec: NOW }), false);
});
t("H5 승인 대기·idle 보고는 작업 중이 아니다", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "claude", paneTitle: STAR, reported: { phase: "waiting", at: NOW - 5 }, nowSec: NOW }), false);
  assert.equal(harnessReportsBusy({ paneCmd: "claude", paneTitle: STAR, reported: { phase: "idle", at: NOW - 5 }, nowSec: NOW }), false);
});
t("H6 ★ 로그인 TUI·vim 처럼 오래 떠 있는 포그라운드(스피너·보고 없음) → 작업 중이 아니다(AI 로그인 자리 모양)", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "codex", paneTitle: "", reported: null, nowSec: NOW }), false);
  assert.equal(harnessReportsBusy({ paneCmd: "vim", paneTitle: "notes.md", reported: null, nowSec: NOW }), false);
});
t("H7 시계가 틀어진 미래 보고(60초 넘게 앞섬)는 신선하지 않다", () => {
  assert.equal(harnessReportsBusy({ paneCmd: "bash", paneTitle: "", reported: { phase: "busy", at: NOW + 120 }, nowSec: NOW }), false);
});

// H8 배선 — 판정 값이 «구조분해 → 중간 객체 → rows.push → SessionInfo» 네 자리를 끝까지 지난다.
//  collectSessions 의 rows.push 는 필드를 **하나씩 골라** 담으므로 위에서 만든 값이라도 거기 안 적으면 조용히 사라진다
//  (#2439 runtimeChoice 가 386행 중 0행만 값을 가졌던 사고와 같은 자리).
t("H8 harnessWorking·paneWorking 이 목록 행까지 실린다", () => {
  const here = new URL(".", import.meta.url).pathname.replace(/\/dist\//, "/src/");
  const src = readFileSync(`${here}sessions.ts`, "utf8");
  const obsAt = src.indexOf("observeAgentRun({");
  const judgeAt = src.indexOf("const harnessBusy = harnessReportsBusy(");
  assert.ok(obsAt > 0 && judgeAt > obsAt, "관측(observeAgentRun) 바로 뒤, 같은 2차 패스에서 잰다(#3892 — 1차 파싱은 관측하지 않는다)");
  assert.match(src.slice(judgeAt, src.indexOf(");", judgeAt)),
    /paneCmd: p\.paneCmdRaw, paneTitle: p\.paneTitleRaw, reported: parseReportedPhase\(p\.stateRaw\), nowSec/,
    "원문(pane·제목·@box_state)으로 판정한다 — offline 에 묶인 reportedFresh 를 다시 쓰지 않는다");
  const pushAt = src.indexOf("rows.push({", judgeAt);
  assert.match(src.slice(pushAt, src.indexOf("});", pushAt)), /\bharnessBusy\b/, "★ rows.push 가 실제로 담는다");
  assert.match(src, /harnessWorking: appServer \? asPhase === "busy" : !!r\.harnessBusy/, "SessionInfo 가 싣는다(app-server 는 턴 상태가 정본)");
  assert.match(src, /paneWorking: !!r\.shellWorking/, "SessionInfo 가 pane 추정을 싣는다");
});

console.log(`\n${pass} passed`);
