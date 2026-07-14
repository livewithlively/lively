// 순수 단위 체크(node:assert) — control-mode 클라 의도 → tmux 명령 인코더(인젝션·UTF-8·클램프·청크)
//  + '세션 종료 확답' 판정(#835).
// 실행: npm run build && node dist/terminal-pty.test.js
import assert from "node:assert/strict";
import { inputToSendKeys, resizeToRefresh, captureCmd } from "./terminal-pty.js";
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
