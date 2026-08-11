// 순수 단위 체크(node:assert) — control-mode 클라 의도 → tmux 명령 인코더(인젝션·UTF-8·클램프·청크)
//  + '세션 종료 확답' 판정(#835).
// 실행: npm run build && node dist/terminal/terminal-pty.test.js
import assert from "node:assert/strict";
import { inputToSendKeys, inputToSendKeysArgv, isPsmuxBin, createInputPump, resizeToRefresh, captureCmd, stateCmd, mouseResetCmd, STATE_MARKER, handleControlMsg, parseEtimeSec, summarizeAttachProcs } from "./terminal-pty.js";
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

t("백필 → capture-pane(-N 줄끝 보존 · -J 논리적 줄 이어붙임 #1117), 0..100000 클램프 + 비정상 입력 방어", () => {
  assert.equal(captureCmd(600), "capture-pane -peqJN -S -600 -E -");
  assert.equal(captureCmd(-1), "capture-pane -peqJN -S -0 -E -");
  assert.equal(captureCmd(1e9), "capture-pane -peqJN -S -100000 -E -");
  assert.equal(captureCmd(NaN), "capture-pane -peqJN -S -0 -E -");
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
  // ★ 백엔드 식별(#1541) — psmux 는 alt-screen 팬에 capture-pane 을 걸면 **제어 스트림 전체가 멈춘다**.
  //  클라는 '이 백엔드엔 캡처를 걸면 안 된다'를 알아야 그 명령을 처음부터 안 보낼 수 있다. 리터럴이라
  //  멀티플렉서가 그대로 되돌려준다(포맷변수가 아니다 — psmux 가 모르는 변수를 쓰면 빈 값이 된다).
  assert.ok(stateCmd(true).includes("mux=psmux"), "psmux 를 알려주지 않으면 클라가 캡처를 걸어 스트림을 멈춘다");
  assert.ok(stateCmd(false).includes("mux=tmux"));
  assert.ok(cmd.includes("mux=tmux"), "기본값은 tmux(종전 경로 무변화)");
});

// 디스패치 시퀀스 — 상태 동기화의 핵심 행위: cap 은 '상태→capture' 순서, st 는 상태만, i/r 은 상태 미첨부.
//  (변경 전 코드에선 cap→[capture]뿐·st 미처리라 이 표가 red 가 된다 = fail-first.)
const seqOf = (msg: any): string[] => { const out: string[] = []; handleControlMsg((l) => out.push(l), msg); return out; };

t("cap+st → 상태질의를 capture '앞'에 보낸다(클라가 렌더 전 alt/mouse 동기화·렌더 후 커서 복원)", () => {
  assert.deepEqual(seqOf({ t: "cap", n: 600, st: 1 }), [stateCmd(), captureCmd(600)]);
  // ★ psmux 는 -q/-N 이 alt-screen 캡처를 죽인다(실측) → 그 백엔드엔 -peJ 로 나가야 한다.
  assert.equal(captureCmd(600, true), "capture-pane -peJ -S -600 -E -");
  assert.equal(captureCmd(600, false), "capture-pane -peqJN -S -600 -E -", "tmux 경로는 무변화");
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

// ── stale 마우스모드(#1092 재발분) — 사양 spec.md 표 C ──
// tmux 는 앱이 켠 마우스모드를 앱이 죽어도 지우지 않는다. 클라가 stale 을 가리려면 foreground 명령이 필요하고,
//  tmux 쪽 잘못된 상태 자체도 고쳐야 한다(안 그러면 다른 클라·실 터미널 attach 가 계속 flood 를 받는다).
t("C1·C2 상태질의 — foreground 명령을 마지막 항목으로 싣는다", () => {
  const cmd = stateCmd();
  assert.ok(cmd.includes("#{pane_current_command}"), "C1: foreground 가 없으면 클라가 stale 을 가릴 축이 없다");
  // C2 경계 — 프로세스명에 공백이 섞여도 앞 항목(cx/cy 등) 파싱이 깨지지 않으려면 반드시 마지막.
  assert.ok(/cmd=#\{pane_current_command\}'$/.test(cmd), "C2: foreground 는 마커의 마지막 항목이어야 한다");
});

t("C3·C4·C5·C6 복구 명령 — 마우스 모드만 전부 해제, 화면은 안 건드림", () => {
  const cmd = mouseResetCmd();
  for (const m of ["1000", "1002", "1003", "1005", "1006", "1015"]) {
    assert.ok(cmd.includes(`[?${m}l`), `C3: 모드 ${m} 해제 누락 — 하나라도 남으면 리포트가 계속 흐른다`);
  }
  assert.ok(!cmd.includes("1049"), "C4: alt-screen 을 서버가 끄면 사용자 화면 내용이 통째로 바뀐다");
  // C5 — pane 모드는 '그 pane 의 출력'으로만 바뀐다. tmux 명령으로는 못 고치고 pane tty 에 직접 써야 한다.
  assert.ok(cmd.includes("#{pane_tty}") && cmd.includes(">"), "C5: pane tty 로 리다이렉트해야 pane 출력으로 처리된다");
  assert.ok(cmd.startsWith("run-shell"), "C5: #{pane_tty} 확장은 run-shell 이 해준다");
  assert.ok(!cmd.includes("\n"), "C6: control-mode 는 개행이 명령 구분자");
});

t("C7 복구 요청 → 복구 후 상태질의(고쳐진 상태를 되돌려 클라가 확인)", () => {
  assert.deepEqual(seqOf({ t: "mr" }), [mouseResetCmd(), stateCmd()]);
  assert.equal(seqOf({ t: "mr" }).indexOf(mouseResetCmd()), 0, "복구가 상태질의보다 앞이어야 고쳐진 상태가 돌아온다");
});

t("C8 복구 명령은 다른 경로로 새지 않는다(입력·리사이즈·백필)", () => {
  for (const msg of [{ t: "i", d: "x" }, { t: "r", c: 80, r: 24 }, { t: "cap", n: 600, st: 1 }, { t: "st" }]) {
    assert.ok(!seqOf(msg).some((l) => l.includes("pane_tty")), `${msg.t} 경로에 복구 명령이 섞였다`);
  }
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

// ── ps 관측(#687 후속) — 자식/고아/최고령 ──
//  판정이 틀리면 화면·경보가 **조용히** 거짓말한다("안 세는 것"이 "0"으로 보임). ps 를 띄우지 않고 파싱만 검증한다.

t("etime 파싱 — mm:ss · hh:mm:ss · dd-hh:mm:ss · 공백패딩", () => {
  assert.equal(parseEtimeSec("03:36"), 216);
  assert.equal(parseEtimeSec("01:00:16"), 3616);
  assert.equal(parseEtimeSec("2-22:49:53"), 254993); // 실측: 누수 상태의 최고령 attach
  assert.equal(parseEtimeSec("  03:36 "), 216);      // ps 는 컬럼을 공백 패딩한다
});

t("etime 경계 — 방금 뜬 0:00 은 0(‘모름’이 아니다) · 파싱 불가는 null", () => {
  assert.equal(parseEtimeSec("0:00"), 0);
  assert.equal(parseEtimeSec("abc"), null);
  assert.equal(parseEtimeSec(""), null);
});

t("attach 요약 — 내 자식만 children, 고아는 별도 축, 남의 자식·비-attach 는 제외", () => {
  const out = [
    "  100  4242 01:00:16 /usr/bin/tmux -u -CC attach -t box-test-aaaa",   // 내 자식
    "  101  4242 03:36:48 /usr/bin/tmux -u -CC attach -t box-test-bbbb",   // 내 자식(더 오래됨)
    "  102     1 2-22:49:53 /usr/bin/tmux -u -CC attach -t box-test-cccc", // 고아 — 부모가 죽었다
    "  103  9999 01:00:00 /usr/bin/tmux -u -CC attach -t box-test-dddd",   // 살아있는 다른 부모 → 우리 소관 아님
    "  104  4242 05:00:00 /usr/bin/tmux new-session -d -s box-test-eeee",  // attach 아님(세션 생성)
    " 4242     1 21:06:27 /usr/bin/node dist/index.js",                    // 나 자신
    "", "쓰레기 줄",
  ].join("\n");
  const s = summarizeAttachProcs(out, 4242);
  assert.equal(s.children, 2, "내 자식 attach 만");
  assert.equal(s.orphans, 1, "고아는 children 에 섞이지 않는다");
  assert.equal(s.oldestChildSec, 13008, "자식 중 최댓값(03:36:48) — 고아(2일)에 오염되지 않는다");
});

t("attach 요약 — 하나도 없으면 0/0 이고 최고령은 null(0 이 아니다)", () => {
  const s = summarizeAttachProcs("  1     0 21:06:27 /sbin/init\n", 4242);
  assert.deepEqual(s, { children: 0, orphans: 0, oldestChildSec: null });
});

t("attach 요약 — etime 컬럼이 없는 ps 여도 개수는 센다(나이만 모름)", () => {
  // 일부 환경의 ps 는 요청한 컬럼을 안 준다. 그때 개수까지 0 으로 떨어지면 누수를 통째로 놓친다.
  const out = [
    "  100  4242 /usr/bin/tmux -u -CC attach -t box-test-aaaa",
    "  102     1 /usr/bin/tmux -u -CC attach -t box-test-cccc",
  ].join("\n");
  const s = summarizeAttachProcs(out, 4242);
  assert.equal(s.children, 1);
  assert.equal(s.orphans, 1);
  assert.equal(s.oldestChildSec, null, "못 읽은 나이는 null — 0 으로 눕히면 ‘방금 떴다’로 오독된다");
});

// ── psmux 입력 경로(#1541) — Windows 네이티브 노드 ────────────────────────────────
// 사양 근거(실기기 실측): psmux 는 `send-keys -H`(hex)를 **받지 않고**(공식 docs 가 "Not accepted: -H"),
//  대안 `0xNN` 은 **코드포인트** 단위여야 하며, 그마저 **CLI 표면에서만** 멀티바이트가 통한다
//  (control mode stdin 은 ASCII 2자리만). → 출력은 control mode 유지, 입력만 CLI 로 가른다.
//  아래는 그 사양의 엣지 표를 그대로 옮긴 것 — 표의 행 하나가 곧 실기기에서 확인한 깨짐 하나다.
const ID = "box-test-1541";
const argvOf = (d: string): string[][] => inputToSendKeysArgv(ID, d);
const toksOf = (d: string): string[] => argvOf(d).flatMap((a) => a.slice(3));
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const timerCount = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

// A. 인코딩
t("A1 psmux 입력 — ASCII 는 코드포인트 토큰(`send-keys -t <id> 0x..`), -H 없음", () => {
  assert.deepEqual(argvOf("ls\r"), [["send-keys", "-t", ID, "0x6c", "0x73", "0x0d"]]);
  assert.ok(!argvOf("ls").some((a) => a.includes("-H")), "-H 가 섞이면 psmux 가 그 뒤를 리터럴로 찍는다");
});

t("A2 psmux 입력 — 한글은 **코드포인트 1토큰**(UTF-8 바이트 3토큰이면 화면이 깨진다)", () => {
  // '한' = U+D55C. 바이트 인코딩(ed 95 9c)이면 실기기에서 `íU\` 로 들어갔다.
  assert.deepEqual(toksOf("한"), ["0xd55c"]);
  assert.deepEqual(toksOf("가나"), ["0xac00", "0xb098"]);
  assert.equal(String.fromCodePoint(...toksOf("가나").map((h) => parseInt(h, 16))), "가나", "왕복 복원");
});

t("A3 psmux 입력 — BMP 밖(이모지)은 서로게이트 2개가 아니라 코드포인트 1토큰", () => {
  // '🚀' = U+1F680. UTF-16 코드유닛으로 쪼개면 0xd83d 0xde80 이 되어 깨진다.
  assert.deepEqual(toksOf("🚀"), ["0x1f680"]);
  assert.ok(!toksOf("🚀").includes("0xd83d"), "서로게이트를 그대로 보내면 안 된다");
});

t("A4 psmux 입력 — 토큰 폭은 **2자리 이상**(Ctrl-C 가 `0x3` 이면 미검증 형태)", () => {
  // 실측에서 통과한 형태는 `0x0d`(2자리)·ASCII 자연폭(2자리)·`0xd55c`·`0x1f680` 뿐이다.
  //  Ctrl-C(0x03)·Tab(0x09) 이 안 먹으면 터미널을 통째로 못 쓴다 → 폭을 계약으로 고정한다.
  assert.deepEqual(toksOf("\x03"), ["0x03"]);
  assert.deepEqual(toksOf("\x09"), ["0x09"]);
  assert.deepEqual(toksOf("\x1b[A"), ["0x1b", "0x5b", "0x41"]); // 방향키(ESC 시퀀스)
  for (const tk of toksOf("\x01\x02\x03\r\n")) assert.match(tk, /^0x[0-9a-f]{2,}$/, `토큰 폭 위반: ${tk}`);
});

t("A5 psmux 입력 — 빈 입력은 호출 0건(키 없는 프로세스 스폰 금지)", () => {
  assert.deepEqual(argvOf(""), []);
});

t("A6 psmux 입력 — 청크 경계: 512 는 1회, 513 은 2회(명령줄 한도)", () => {
  assert.equal(argvOf("a".repeat(512)).length, 1, "정확히 한도면 아직 1회");
  const cmds = argvOf("a".repeat(513));
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].length - 3, 512);
  assert.equal(cmds[1].length - 3, 1);
});

t("A7 psmux 입력 — 모든 청크가 대상 세션을 달고 나간다", () => {
  // 하나라도 -t 가 빠지면 그 조각이 '현재 세션'(엉뚱한 곳)으로 간다.
  for (const a of argvOf("a".repeat(1500))) assert.deepEqual(a.slice(0, 3), ["send-keys", "-t", ID]);
});

t("A8 psmux 입력 — 인젝션 차단: 값이 전부 0x 토큰이라 명령이 되지 않는다", () => {
  const cmds = argvOf(";kill-server;\nnew-session\n");
  assert.equal(cmds.length, 1);
  for (const tk of cmds[0].slice(3)) assert.match(tk, /^0x[0-9a-f]+$/);
  assert.ok(!cmds[0].some((a) => /kill-server|new-session|\n/.test(a)), "리터럴·개행이 argv 에 남으면 안 된다");
});

// B. 백엔드 판정 — 이 한 줄이 attach 백엔드와 입력 경로를 **동시에** 가른다.
t("B1·B2·B3 psmux 판정 — 파일명으로만(경로·확장자·대소문자 무관), tmux·빈값은 절대 아님", () => {
  for (const b of ["psmux", "psmux.exe", "C:\\psmux\\psmux.exe", "C:/Users/y/.lively/bin/psmux/PSMUX.EXE", "/opt/psmux"]) {
    assert.equal(isPsmuxBin(b), true, `psmux 로 안 잡힘 → Windows 입력이 통째로 안 먹는다: ${b}`);
  }
  for (const b of ["tmux", "/opt/homebrew/bin/tmux", "C:\\tmux\\tmux.exe", "psmuxx", "psmux-old", "", null as unknown as string]) {
    assert.equal(isPsmuxBin(b), false, `tmux 인데 psmux 로 잡힘 → 매 키마다 프로세스: ${b}`);
  }
});

// C. 디스패치
t("C1·C2 psmux 모드 — 입력만 CLI 싱크로 가르고 나머지는 control 스트림 그대로", () => {
  const lines: string[] = [], typed: string[] = [];
  const run = (msg: any): void => handleControlMsg((l) => lines.push(l), msg, { sendInput: (d) => typed.push(d) });
  run({ t: "i", d: "ls\r" });
  assert.deepEqual(typed, ["ls\r"], "C1: 입력은 CLI 싱크로");
  assert.deepEqual(lines, [], "C1: control 스트림에 send-keys 가 실리면 psmux 는 리터럴로 찍는다");
  // 나머지는 응답(%begin/%end)이 control 스트림으로 와야 하므로 옮길 수 없다.
  run({ t: "cap", n: 600, st: 1 });
  run({ t: "st" });
  run({ t: "mr" });
  assert.deepEqual(lines, [stateCmd(true), captureCmd(600, true), stateCmd(true), mouseResetCmd(), stateCmd(true)]);
  assert.deepEqual(typed, ["ls\r"], "C2: 입력 싱크는 그 뒤로 안 늘어난다");
});

t("C3 싱크가 없으면(=tmux) 기존 `send-keys -H` 그대로(회귀 방지)", () => {
  assert.deepEqual(seqOf({ t: "i", d: "ls\r" }), ["send-keys -H 6c 73 0d"]);
});

t("C4 psmux 모드 + 빈 입력 → control 스트림에 아무것도 안 실린다", () => {
  const lines: string[] = [];
  handleControlMsg((l) => lines.push(l), { t: "i", d: "" }, { sendInput: () => { /* 싱크 */ } });
  assert.deepEqual(lines, []);
});

// C5·C6 — 리사이즈 구분자. psmux 는 `WxH` 를 **오류 없이 조용히 무시**한다(실측: 창이 안 변한다).
//  조용한 무시라 이 계약이 깨져도 로그·종료코드엔 아무 흔적이 없고, 증상은 "웹터미널이 브라우저 크기를
//  안 따라간다"로만 나타난다 → 형식 자체를 테스트로 못박는다.
t("C5 psmux 모드 리사이즈 → 콤마 형식(`W,H`) — WxH 는 psmux 가 조용히 무시한다", () => {
  const lines: string[] = [];
  handleControlMsg((l) => lines.push(l), { t: "r", c: 120, r: 40 }, { sendInput: () => { /* noop */ } });
  assert.deepEqual(lines, ["refresh-client -C 120,40"]);
  assert.equal(resizeToRefresh(120, 40, ","), "refresh-client -C 120,40");
  // 클램프는 형식과 무관하게 동일해야 한다(psmux 만 경계 검사가 빠지는 일 없게).
  assert.equal(resizeToRefresh(0, -5, ","), "refresh-client -C 1,1");
  assert.equal(resizeToRefresh(99999, 99999, ","), "refresh-client -C 2000,2000");
});

t("C6 tmux 모드 리사이즈 → 기존 `WxH` 유지(tmux 하한을 안 정했으므로 회귀 위험 0)", () => {
  assert.deepEqual(seqOf({ t: "r", c: 120, r: 40 }), ["refresh-client -C 120x40"]);
  assert.equal(resizeToRefresh(120, 40), "refresh-client -C 120x40");
});

// D. 입력 펌프 — 신규 도입물이 만든 새 엣지(배치·순서·종료·실패).
//  전부 **부작용**(run 호출 argv·호출 순서·활성 타이머 수)으로 판정한다.
await ta("D1 펌프 — 디바운스 창 안의 키는 한 번으로 묶이고, ASCII 는 프로세스 없이 스트림으로 간다", async () => {
  const calls: string[][] = [], lines: string[] = [];
  const pump = createInputPump(ID, async (argv) => { calls.push(argv); }, (l) => { lines.push(l); }, 5);
  pump.sendInput("a"); pump.sendInput("b"); pump.sendInput("c");
  assert.equal(calls.length + lines.length, 0, "창이 닫히기 전엔 나가지 않는다");
  await sleep(25); await pump.idle();
  // ★ ASCII 는 **프로세스 0개** — psmux 는 배치마다 CLI 를 띄우는데 Windows 에서 그게 수십 ms 라
  //  중앙 세션과 나란히 두면 타이핑이 눈에 띄게 늦다(사용자 실측). 2자리 토큰은 제어 스트림이 받아준다.
  assert.equal(calls.length, 0, "ASCII 인데 프로세스를 띄웠다 — 타이핑 지연의 원인");
  assert.equal(lines.length, 1, "키 3개는 한 줄로 묶여야 한다(폭풍 금지)");
  assert.deepEqual(lines[0].split(" ").slice(3), ["0x61", "0x62", "0x63"]);
});

await ta("D1b 펌프 — 3자리 이상 토큰(한글)이 섞이면 CLI 로 보낸다(정확성 우선)", async () => {
  const calls: string[][] = [], lines: string[] = [];
  const pump = createInputPump(ID, async (argv) => { calls.push(argv); }, (l) => { lines.push(l); }, 5);
  pump.sendInput("가");                       // U+AC00 → 0xac00 (4자리) — 스트림이 못 받는다
  await sleep(25); await pump.idle();
  assert.equal(lines.length, 0, "한글을 스트림으로 보내면 글자가 깨진다");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(3), ["0xac00"]);
});

await ta("D2 펌프 — 청크가 여러 개여도 **순차** 실행(겹치면 글자가 섞인다)", async () => {
  const order: string[] = [];
  let releaseFirst = (): void => { /* 채워짐 */ };
  const gate = new Promise<void>((r) => { releaseFirst = r; });
  let n = 0;
  const pump = createInputPump(ID, async () => {
    const i = ++n; order.push(`start${i}`);
    if (i === 1) await gate;
    order.push(`end${i}`);
  }, () => { /* noop */ }, 5);
  // 한글로 보낸다 — ASCII 는 이제 프로세스 없이 스트림으로 가므로(D1), 순차성은 **CLI 경로**에서 확인해야 한다.
  pump.sendInput("가".repeat(513)); // 2 청크
  await sleep(25);
  assert.deepEqual(order, ["start1"], "첫 호출이 끝나기 전에 두 번째가 시작되면 순서 보장이 없다");
  releaseFirst();
  await pump.idle();
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
});

await ta("D3 펌프 — 백필/상태 명령보다 **방금 친 키가 먼저** 나간다", async () => {
  // 이게 깨지면 capture-pane 이 '마지막 입력이 빠진 화면'을 백필한다(재접속마다 글자가 사라져 보임).
  const order: string[] = [];
  const pump = createInputPump(ID, async () => { order.push("keys"); }, (l) => order.push(`cmd:${l}`), 50);
  pump.sendInput("x");
  pump.sendCmd(captureCmd(600));   // 디바운스 창이 아직 안 닫힌 시점
  await pump.idle();
  // ASCII 는 스트림으로 나가므로 `cmd:send-keys …` 로 관측된다 — 확인하려는 것은 **순서**다(키가 먼저).
  assert.deepEqual(order, [`cmd:send-keys -t ${ID} 0x78`, `cmd:${captureCmd(600)}`]);
});

await ta("D4 펌프 — 닫히면 대기 입력을 버리고 타이머도 해제한다", async () => {
  const calls: string[][] = [];
  const pump = createInputPump(ID, async (argv) => { calls.push(argv); }, () => { /* noop */ }, 5);
  const base = timerCount();
  pump.sendInput("abc");
  assert.equal(timerCount(), base + 1, "배선 확인: 디바운스 타이머가 실제로 떠 있어야 이 관측이 의미를 갖는다");
  pump.close();
  assert.equal(timerCount(), base, "close 가 타이머를 해제하지 않으면 연결마다 타이머가 남는다");
  pump.sendInput("def");
  await sleep(25); await pump.idle();
  assert.deepEqual(calls, [], "닫힌 세션에 유령 입력이 가면 안 된다");
});

await ta("D5 펌프 — 전송 1건이 실패해도 다음 입력은 계속 흐른다", async () => {
  const calls: string[][] = [];
  let first = true;
  const pump = createInputPump(ID, async (argv) => {
    calls.push(argv);
    if (first) { first = false; throw new Error("psmux timeout"); }
  }, () => { throw new Error("write boom"); }, 5);
  pump.sendInput("가");
  await sleep(25); await pump.idle();
  pump.sendCmd("refresh-client -C 80x24");  // 명령 쪽 예외도 체인을 끊지 않는다
  await pump.idle();
  pump.sendInput("나");
  await sleep(25); await pump.idle();
  assert.equal(calls.length, 2, "실패 1건이 체인을 끊으면 터미널이 그대로 먹통이 된다");
  assert.deepEqual(calls[1].slice(3), ["0xb098"]);
});

console.log(`\n${pass} passed`);
