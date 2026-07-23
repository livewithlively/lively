// 순수 단위 체크(node:assert) — control-mode 클라 의도 → tmux 명령 인코더(인젝션·UTF-8·클램프·청크)
//  + '세션 종료 확답' 판정(#835).
// 실행: npm run build && node dist/terminal-pty.test.js
import assert from "node:assert/strict";
import { inputToSendKeys, resizeToRefresh, captureCmd, stateCmd, STATE_MARKER, handleControlMsg } from "./terminal-pty.js";
import { isSessionGoneError } from "./terminal-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("ASCII 입력 → send-keys -H (hex, 공백구분)", () => {
  assert.deepEqual(inputToSendKeys("ls\r"), ["send-keys -H 6c 73 0d"]);
});

t("방향키(ESC 시퀀스) → 원시 바이트 hex", () => {
  assert.deepEqual(inputToSendKeys("\x1b[A"), ["send-keys -H 1b 5b 41"]);
});

t("한글 입력 → UTF-8 바이트 hex (라운드트립 가능)", () => {
  // '한' = U+D55C = ED 95 9C
  assert.deepEqual(inputToSendKeys("한"), ["send-keys -H ed 95 9c"]);
  const cmd = inputToSendKeys("가나")[0];
  const hex = cmd.replace("send-keys -H ", "").split(" ").map((h) => parseInt(h, 16));
  assert.equal(Buffer.from(hex).toString("utf8"), "가나");
});

t("빈 입력 → 명령 없음", () => {
  assert.deepEqual(inputToSendKeys(""), []);
});

t("긴 입력 → 512B 청크로 분할(다중 send-keys)", () => {
  const cmds = inputToSendKeys("a".repeat(513));
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].replace("send-keys -H ", "").split(" ").length, 512); // 첫 청크 512바이트
  assert.equal(cmds[1].replace("send-keys -H ", "").split(" ").length, 1);   // 나머지 1바이트
});

t("인젝션 방지: 개행/세미콜론 포함 입력도 hex 로만 인코딩(명령 분리 불가)", () => {
  const cmds = inputToSendKeys("\nkill-server\n");
  assert.equal(cmds.length, 1);
  // 결과 명령 문자열엔 'kill-server' 리터럴이나 raw 개행이 없다(전부 hex).
  assert.match(cmds[0], /^send-keys -H [0-9a-f ]+$/);
  assert.ok(!cmds[0].includes("kill-server"));
});

t("리사이즈 → refresh-client -C, 1..2000 클램프", () => {
  assert.equal(resizeToRefresh(120, 40), "refresh-client -C 120x40");
  assert.equal(resizeToRefresh(0, -5), "refresh-client -C 1x1");
  assert.equal(resizeToRefresh(99999, 99999), "refresh-client -C 2000x2000");
});

t("백필 → capture-pane(-N 줄끝 보존), 0..100000 클램프 + 비정상 입력 방어", () => {
  assert.equal(captureCmd(600), "capture-pane -peqN -S -600 -E -");
  assert.equal(captureCmd(-1), "capture-pane -peqN -S -0 -E -");
  assert.equal(captureCmd(1e9), "capture-pane -peqN -S -100000 -E -");
  assert.equal(captureCmd(NaN), "capture-pane -peqN -S -0 -E -");
});

t("상태질의 → display-message(마커 + alt/mouse/cursor 포맷변수, 단일 -p 라인)", () => {
  const cmd = stateCmd();
  // 마커로 시작해야 클라 파서가 '캡처 백필'과 구분한다.
  assert.ok(cmd.startsWith(`display-message -p '${STATE_MARKER} `));
  // 클라가 파싱하는 키(alt/any/btn/std/sgr/cx/cy) 전부 tmux 포맷변수로 존재.
  for (const [key, fmt] of [["alt", "alternate_on"], ["any", "mouse_any_flag"], ["btn", "mouse_button_flag"],
    ["std", "mouse_standard_flag"], ["sgr", "mouse_sgr_flag"], ["cx", "cursor_x"], ["cy", "cursor_y"]] as const) {
    assert.ok(cmd.includes(`${key}=#{${fmt}}`), `${key} 포맷 누락`);
  }
  // 단일 라인(개행 인젝션 없음) — control-mode 는 개행 = 명령 구분자.
  assert.ok(!cmd.includes("\n"));
});

// 디스패치 시퀀스 — 상태 동기화의 핵심 행위: cap 은 '상태→capture' 순서, st 는 상태만, i/r 은 상태 미첨부.
//  (변경 전 코드에선 cap→[capture]뿐·st 미처리라 이 표가 red 가 된다 = fail-first.)
const seqOf = (msg: any): string[] => { const out: string[] = []; handleControlMsg((l) => out.push(l), msg); return out; };

t("cap+st → 상태질의를 capture '앞'에 보낸다(클라가 렌더 전 alt/mouse 동기화·렌더 후 커서 복원)", () => {
  assert.deepEqual(seqOf({ t: "cap", n: 600, st: 1 }), [stateCmd(), captureCmd(600)]);
  // 순서가 핵심 — 상태가 반드시 capture 앞.
  assert.equal(seqOf({ t: "cap", n: 600, st: 1 }).indexOf(stateCmd()), 0);
  // n 부재도 방어(0 강제) + 상태는 여전히 앞.
  assert.deepEqual(seqOf({ t: "cap", st: 1 }), [stateCmd(), captureCmd(0)]);
});

t("cap(st 플래그 없음) → 상태 없이 capture 만(옛 클라 버전 스큐 안전: 마커 출력 회귀 방지)", () => {
  assert.deepEqual(seqOf({ t: "cap", n: 600 }), [captureCmd(600)]);
  // 옛 클라(st 미첨부)는 상태 블록을 못 받아 __LTSTATE__ 를 화면에 찍지 않는다.
  assert.ok(!seqOf({ t: "cap", n: 600 }).some((l) => l.includes(STATE_MARKER)));
});

t("st → 상태질의만(capture 없음) — 재접속 시 스크롤백 truncate 없이 stuck 해소", () => {
  assert.deepEqual(seqOf({ t: "st" }), [stateCmd()]);
});

t("i/r → 상태질의를 첨부하지 않는다(입력·리사이즈는 순수 번역)", () => {
  assert.deepEqual(seqOf({ t: "i", d: "ls\r" }), ["send-keys -H 6c 73 0d"]);
  assert.deepEqual(seqOf({ t: "r", c: 80, r: 24 }), ["refresh-client -C 80x24"]);
  // 상태 마커가 새지 않는다(입력/리사이즈 경로엔 stateCmd 없음).
  assert.ok(!seqOf({ t: "i", d: "x" }).some((l) => l.includes(STATE_MARKER)));
});

t("미지/불완전 메시지 → 명령 없음(비정수 리사이즈 가드 포함)", () => {
  assert.deepEqual(seqOf({ t: "zzz" }), []);
  assert.deepEqual(seqOf({ t: "r", c: 1.5, r: 24 }), []); // Number.isInteger 가드
  assert.deepEqual(seqOf({}), []);
});

// ── 세션 종료 확답 판정(#835) ──
// 핵심 비대칭: '종료됨'은 tmux 가 응답해서 없다고 말할 때만. 판정 불가(타임아웃·소켓 접속불가)를 종료로 넘기면
//  살아있는 세션을 죽었다고 알리게 된다(#687 이 막으려던 오인) → 그 경우들은 전부 false 여야 한다.
t("tmux 확답 'can't find session' → 종료됨", () => {
  assert.equal(isSessionGoneError({ code: 1, stderr: "can't find session: box-a-0011ffee\n" }), true);
});

t("타임아웃(kill/SIGTERM, tmux 과부하 #687) → 종료 아님(판정 불가)", () => {
  assert.equal(isSessionGoneError({ killed: true, signal: "SIGTERM", stderr: "" }), false);
  // 타임아웃인데 직전 stderr 가 우연히 섞여 들어와도 시그널이 있으면 판정 불가로 본다.
  assert.equal(isSessionGoneError({ killed: true, signal: "SIGTERM", stderr: "can't find session: box-a-0011ffee" }), false);
});

t("tmux 서버 접속 불가(소켓 없음·no server running) → 종료 아님(판정 불가)", () => {
  assert.equal(isSessionGoneError({ code: 1, stderr: "error connecting to /private/tmp/tmux-501/default (No such file or directory)" }), false);
  assert.equal(isSessionGoneError({ code: 1, stderr: "no server running on /private/tmp/tmux-501/default" }), false);
});

t("tmux 실행 자체 실패·알 수 없는 오류 → 종료 아님", () => {
  assert.equal(isSessionGoneError({ code: "ENOENT", stderr: "" }), false);
  assert.equal(isSessionGoneError(new Error("boom")), false);
  assert.equal(isSessionGoneError(null), false);
  assert.equal(isSessionGoneError(undefined), false);
});

console.log(`\n${pass} passed`);
