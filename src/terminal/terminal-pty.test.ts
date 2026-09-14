// 순수 단위 체크(node:assert) — control-mode 클라 의도 → tmux 명령 인코더(인젝션·UTF-8·클램프·청크)
//  + '세션 종료 확답' 판정(#835).
// 실행: npm run build && node dist/terminal/terminal-pty.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inputToSendKeys, inputToSendKeysArgv, isPsmuxBin, psmuxInputLines, psmuxInputSink, resizeToRefresh, captureCmd, stateCmd, mouseResetCmd, STATE_MARKER, handleControlMsg, parseEtimeSec, summarizeAttachProcs, attachClose, attachCwd } from "./terminal-pty.js";
import { isSessionGoneError } from "./terminal-sessions.js";
import { TMUX_BIN } from "./catalog.js";

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

t("로컬 단일호스트 — tmux 서버 접속 불가(소켓 없음·no server running) → 종료 아님(판정 불가)", () => {
  // 로컬(중계 아님, relayManaged=false)에선 종전 그대로 보수적: 서버 부재는 일시장애일 수 있어 재연결 유지.
  assert.equal(isSessionGoneError({ code: 1, stderr: "error connecting to /private/tmp/tmux-501/default (No such file or directory)" }, TMUX_BIN, false), false);
  assert.equal(isSessionGoneError({ code: 1, stderr: "no server running on /private/tmp/tmux-501/default" }, TMUX_BIN, false), false);
});

// ── 관리형 중계(#1437) — tmux 가 테넌트별 컨테이너에 산다. 이미지 롤아웃/OOM 으로 그 서버가 증발하면 인메모리 세션이
//  통째로 사라지고 스스로 돌아오지 않는다(복원만이 길). 그래서 같은 문구를 **확답**으로 승격한다(상민님 실측
//  lively-46e3: has-session → "no server running" 인데 복원이 already 로 막혔다). relayManaged 만 true 로 바뀔 뿐
//  나머지 판정(타임아웃·killed·can't find)은 로컬과 동일해야 한다.
t("관리형 중계 — tmux 서버 부재(no server running·소켓 없음) → 종료됨(확답)", () => {
  assert.equal(isSessionGoneError({ code: 1, stderr: "no server running on /tmp/tmux-200069/lvly-lively-46e3" }, TMUX_BIN, true), true, "스테일 소켓(서버 죽음) = 그 테넌트 세션 증발");
  assert.equal(isSessionGoneError({ code: 1, stderr: "error connecting to /tmp/tmux-200069/lvly-lively-46e3 (No such file or directory)" }, TMUX_BIN, true), true, "소켓 없음(재생성된 빈 컨테이너) = 증발");
  assert.equal(isSessionGoneError({ code: 1, stderr: "error connecting to /tmp/tmux-200069/lvly-x (Connection refused)" }, TMUX_BIN, true), true, "소켓은 있으나 서버 죽는 중 = 증발");
  // 컨테이너 보장/생성 실패는 도커·노드 일시장애 — 중계여도 판정 불가(재연결 유지, 세션을 죽었다고 오판하지 않는다).
  assert.equal(isSessionGoneError({ code: 1, stderr: "tmux 컨테이너 보장 실패: docker daemon 응답 없음" }, TMUX_BIN, true), false, "컨테이너 인프라 장애는 확답 아님");
  assert.equal(isSessionGoneError({ code: 1, stderr: "tmux 컨테이너 생성 실패: no space left on device" }, TMUX_BIN, true), false, "컨테이너 생성 실패도 확답 아님");
  // 타임아웃은 중계여도 판정 불가 — 서버 부재 문구가 섞여도 시그널이 있으면 판정 불가(과부하 오인 방지, #687).
  assert.equal(isSessionGoneError({ killed: true, signal: "SIGTERM", stderr: "no server running on /tmp/tmux-200069/lvly-x" }, TMUX_BIN, true), false, "중계 타임아웃은 판정 불가");
});

// #1791 실측(hammurabi) — psmux 는 `has-session -t <없는 id>` 에 문구 없이 exit 1 만 준다. tmux 규칙(문구 필요)만 있으면
//  윈도우 노드의 죽은 세션이 영영 '판정 불가'라 4410 도, 복원·삭제의 gone 확답도 못 받는다. bin 인자는 실행 파일 판별용(기본 TMUX_BIN).
t("psmux(윈도우) — exit 1 + 빈 stderr 는 '그 세션 없음'(확답) · tmux 에선 같은 입력이 판정 불가 그대로", () => {
  assert.equal(isSessionGoneError({ code: 1, stderr: "" }, "C:\\Users\\y\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe"), true);
  assert.equal(isSessionGoneError({ code: 1, stderr: "   \n" }, "psmux"), true, "공백뿐인 stderr 도 빈 것으로");
  assert.equal(isSessionGoneError({ code: 1, stderr: "" }, "/opt/homebrew/bin/tmux"), false, "tmux 는 문구 없이는 확답 아님(서버 접속불가일 수 있다)");
  assert.equal(isSessionGoneError({ code: 2, stderr: "" }, "psmux"), false, "psmux 라도 exit 1 이 아니면 확답 아님");
  assert.equal(isSessionGoneError({ code: "ENOENT", stderr: "" }, "psmux.exe"), false, "psmux 실행 파일 부재는 확답 아님");
  assert.equal(isSessionGoneError({ killed: true, signal: "SIGTERM", stderr: "" }, "psmux"), false, "psmux 타임아웃도 판정 불가");
  assert.equal(isSessionGoneError({ code: 1, stderr: "can't find session: box-a-0011ffee" }, "psmux"), true, "문구가 오면 그대로 확답");
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
  assert.deepEqual(s, { children: 0, orphans: 0, oldestChildSec: null, orphanMcp: 0, oldestOrphanMcpSec: null });
});

// ── 고아 MCP 축 (#2213) ──────────────────────────────────────────────────────
//  사양: 부모를 잃은(ppid=1) stdio MCP 서버를 센다. 부모가 살아 있으면 그 세션이 **쓰는 중**이라 정상이다.
//  왜 필요한가(2026-08-28 dev 맥미니 실측): 하네스가 죽어도 이 자식들이 안 죽어 고아 19개가
//  CPU 1,540%(코어 9.4개)를 태웠는데 **어떤 화면에도 안 떴다** — 리퍼는 tmux 세션만 세므로
//  그 바깥의 프로세스는 원리적으로 안 잡힌다.
t("고아 MCP — ppid=1 인 세 형태를 세고, 부모 살아있는 것·MCP 아닌 것은 안 센다", () => {
  const out = [
    "  200     1 07:25:46 /opt/homebrew/opt/node@22/bin/node /Users/x/.lively/lib/lively.mjs mcp",       // ① 고아 gateway 프록시
    "  201     1 03:00:00 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp-local",                       // ② 고아 local
    "  202     1 02:00:00 /usr/bin/node /Users/x/.lively/lib/lively-mcp-gateway.mjs",                     // ③ 고아 직접실행형
    "  203  9001 05:00:00 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",                             // ④ 부모 살아있음 → 정상(안 센다)
    "  204     1 09:00:00 /usr/bin/node /Users/x/.lively/lib/lively.mjs status",                          // ⑤ MCP 아님
    "  205     1 04:00:00 /usr/bin/tmux -u -CC attach -t box-test-zzzz",                                  // ⑥ attach 축(다른 축)
    " 4242     1 21:06:27 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",                             // ⑨ 나 자신 → 제외
  ].join("\n");
  const s = summarizeAttachProcs(out, 4242);
  assert.equal(s.orphanMcp, 3, "①②③ 만 — 부모가 살아 있거나(④) MCP 가 아니면(⑤) 세지 않는다");
  assert.equal(s.orphans, 1, "⑥ attach 축은 그대로 — 두 축이 서로 오염되지 않는다");
});

t("고아 MCP — 최고령은 최댓값이고, 하루 넘는 나이도 정확히 읽는다", () => {
  // ⑩ 나이가 길수록 «오래 안 보였다»는 뜻이라 경보 판정의 핵심 값이다. 실측 최고령이 1일 11시간이었다.
  const out = [
    "  200     1 07:25:46 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",
    "  201     1 1-11:19:25 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",   // 최고령
    "  202     1 00:30:00 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",
  ].join("\n");
  const s = summarizeAttachProcs(out, 4242);
  assert.equal(s.orphanMcp, 3);
  assert.equal(s.oldestOrphanMcpSec, 127165, "1-11:19:25 = ((1*24+11)*60+19)*60+25");
});

t("고아 MCP — etime 컬럼이 없는 ps 여도 개수는 세고 나이만 모른다", () => {
  // ⑧ 이번에 새로 얹은 축이 **부재 입력**을 만나는 행. 개수까지 0 으로 떨어지면 릭을 통째로 놓친다.
  //  (그 환경에선 3번째 토큰이 이미 args 의 첫 조각이라 cmd 재조립 경로를 탄다.)
  const out = [
    "  200     1 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",
    "  201  9001 /usr/bin/node /Users/x/.lively/lib/lively.mjs mcp",   // 부모 살아있음 → 여전히 안 센다
  ].join("\n");
  const s = summarizeAttachProcs(out, 4242);
  assert.equal(s.orphanMcp, 1, "나이를 못 읽어도 고아 판정(ppid)은 그대로 선다");
  assert.equal(s.oldestOrphanMcpSec, null, "못 읽은 나이는 null — 0 으로 눕히면 ‘방금 떴다’로 오독된다");
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

// ── psmux 입력 경로(#1541 · #3904) — Windows 네이티브 노드 ────────────────────────────────
// 사양 근거: psmux 3.3.7 은 `send-keys -H`(hex 바이트)를 **받지 않는다**(실측) → 대안 `0xNN` 은 **코드포인트** 단위여야
//  한다(A 절). 그리고 3.3.7 제어 모드는 연속 send 를 합치면서 0xff 를 넘는 토큰을 UTF-8 로 두 번 인코딩한다 →
//  그런 토큰이 실린 줄에만 `-N 1`(합치기를 건너뛰는 표지)을 붙여 **같은 제어 스트림**으로 보낸다(E 절, #3904).
//  아래는 그 사양의 엣지 표를 그대로 옮긴 것 — 표의 행 하나가 곧 사양 한 줄이다.
const ID = "box-test-1541";
const argvOf = (d: string): string[][] => inputToSendKeysArgv(ID, d);
const toksOf = (d: string): string[] => argvOf(d).flatMap((a) => a.slice(3));
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
t("C1·C2 psmux 모드 — 입력만 psmux 싱크로 가르고 나머지는 control 스트림 그대로", () => {
  const lines: string[] = [], typed: string[] = [];
  const run = (msg: any): void => handleControlMsg((l) => lines.push(l), msg, { sendInput: (d) => typed.push(d) });
  run({ t: "i", d: "ls\r" });
  assert.deepEqual(typed, ["ls\r"], "C1: 입력은 psmux 싱크로");
  assert.deepEqual(lines, [], "C1: `send-keys -H` 가 스트림에 실리면 psmux 3.3.7 은 hex 를 리터럴로 찍는다");
  // 나머지는 응답(%begin/%end)이 control 스트림으로 와야 하므로 옮길 수 없다.
  run({ t: "cap", n: 600, st: 1 });
  run({ t: "st" });
  run({ t: "mr" });
  assert.deepEqual(lines, [stateCmd(true), captureCmd(600), stateCmd(true), mouseResetCmd(), stateCmd(true)]);
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

// E. 제어 스트림 줄(#3904) — 0xff 를 넘는 토큰이 실린 줄만 `-N 1`. 판정은 줄 문자열 그대로(= psmux 가 받는 바이트).
//  종전(#1541)엔 그런 입력을 CLI 프로세스로 보냈고, 윈도우에선 그 기동이 한글 한 글자마다 끼었다(사용자 신고 2026-09-11).
const linesOf = (d: string): string[] => psmuxInputLines(ID, d);

t("E1 psmux 줄 — ASCII 만이면 종전 형식 그대로(-N 없음)", () => {
  assert.deepEqual(linesOf("abc"), [`send-keys -t ${ID} 0x61 0x62 0x63`]);
});

t("E2 psmux 줄 — 한글이 실리면 `-N 1`(없으면 3.3.7 제어 모드가 합치면서 UTF-8 을 두 번 인코딩한다)", () => {
  assert.deepEqual(linesOf("한글"), [`send-keys -N 1 -t ${ID} 0xd55c 0xae00`]);
});

t("E3 psmux 줄 — BMP 밖(이모지)도 코드포인트 1토큰 + `-N 1`", () => {
  assert.deepEqual(linesOf("🚀"), [`send-keys -N 1 -t ${ID} 0x1f680`]);
});

t("E4·E5 psmux 줄 — 경계: U+00FF 까지는 종전 형식, U+0100 부터 `-N 1`", () => {
  assert.deepEqual(linesOf("\u00ff"), [`send-keys -t ${ID} 0xff`]);
  assert.deepEqual(linesOf("\u0100"), [`send-keys -N 1 -t ${ID} 0x100`]);
});

t("E6 psmux 줄 — 혼합 입력은 한 줄에 순서 그대로, 줄 전체가 `-N 1`", () => {
  assert.deepEqual(linesOf("a한\r"), [`send-keys -N 1 -t ${ID} 0x61 0xd55c 0x0d`]);
});

t("E7 psmux 줄 — 제어문자·ESC 시퀀스(ASCII)는 종전 형식(실사용으로 검증된 줄을 바꾸지 않는다)", () => {
  assert.deepEqual(linesOf("\x03\t\x1b[A"), [`send-keys -t ${ID} 0x03 0x09 0x1b 0x5b 0x41`]);
});

t("E8 psmux 줄 — 빈 입력은 줄 0개", () => {
  assert.deepEqual(linesOf(""), []);
});

t("E9 psmux 줄 — 청크: 한글 512자는 1줄, 513자는 2줄이고 두 줄 모두 `-N 1 -t <id>`", () => {
  assert.equal(linesOf("가".repeat(512)).length, 1, "정확히 한도면 아직 1줄");
  const ls = linesOf("가".repeat(513));
  assert.equal(ls.length, 2);
  for (const l of ls) assert.ok(l.startsWith(`send-keys -N 1 -t ${ID} `), `청크 머리 위반: ${l.slice(0, 48)}`);
  assert.deepEqual(ls.map((l) => l.split(" ").length - 5), [512, 1]);
});

t("E10 psmux 줄 — 형식은 줄마다 따로: ASCII 512자 + 한글 1자 → [종전 형식, `-N 1`]", () => {
  const ls = linesOf("a".repeat(512) + "가");
  assert.equal(ls.length, 2);
  assert.ok(ls[0].startsWith(`send-keys -t ${ID} 0x61 `), "ASCII 만인 청크까지 형식을 바꾸면 안 된다");
  assert.equal(ls[1], `send-keys -N 1 -t ${ID} 0xac00`);
});

t("E11 psmux 줄 — 인젝션: 입력이 명령·개행이 되지 않는다", () => {
  const ls = linesOf(";kill-server;\nnew-session\n");
  assert.equal(ls.length, 1);
  assert.ok(!ls[0].includes("\n") && !ls[0].includes(";"), "개행·세미콜론이 줄에 남으면 psmux 가 명령으로 읽는다");
  const toks = ls[0].split(" ").slice(3);
  assert.ok(toks.length > 0, "배선 확인: 토큰이 비면 아래 검사는 아무것도 안 본다");
  for (const tk of toks) assert.match(tk, /^0x[0-9a-f]{2,}$/);
});

t("E12 psmux 싱크 — 입력은 부른 자리에서 곧장 나가고(타이머 0), 뒤에 부른 캡처보다 먼저다", () => {
  const out: string[] = [];
  const sink = psmuxInputSink(ID, (l) => { out.push(l); });
  const base = timerCount();
  sink.sendInput("가");
  assert.equal(timerCount(), base, "입력이 타이머를 남기면(디바운스) 그만큼 글자가 늦게 나간다");
  assert.deepEqual(out, [`send-keys -N 1 -t ${ID} 0xac00`], "입력이 기다렸다 나가면 한 글자마다 지연이 붙는다");
  handleControlMsg((l) => { out.push(l); }, { t: "cap", n: 600 }, sink);
  assert.deepEqual(out, [`send-keys -N 1 -t ${ID} 0xac00`, captureCmd(600)], "캡처가 먼저 나가면 방금 친 글자가 빠진 화면을 백필한다");
});

t("E13 psmux 싱크 — 빈 입력은 쓰기 0회", () => {
  let n = 0;
  psmuxInputSink(ID, () => { n++; }).sendInput("");
  assert.equal(n, 0);
});

t("E14 handleControlMsg + psmux 싱크 — 한글 입력이 제어 스트림 한 줄로 나간다", () => {
  const out: string[] = [];
  const write = (l: string): void => { out.push(l); };
  handleControlMsg(write, { t: "i", d: "한" }, psmuxInputSink(ID, write));
  assert.deepEqual(out, [`send-keys -N 1 -t ${ID} 0xd55c`]);
});

t("E15 배선 — attach 경로의 psmux 입력은 싱크로 가고, 입력 때문에 psmux 를 execFile 하지 않는다", () => {
  // attachSession 은 프로세스를 띄우는 I/O 함수라 직접 못 돌린다 → 빌드된 본문에서 그 한 자리를 잰다.
  const src = readFileSync(fileURLToPath(import.meta.url).replace(/\.test\.js$/, ".js"), "utf8");
  const at = src.indexOf("export function attachSession(");
  assert.ok(at >= 0, "배선 확인: attachSession 을 못 찾으면 이 검사는 아무것도 안 본다");
  const next = src.indexOf("\nexport function ", at + 1);
  const body = src.slice(at, next < 0 ? undefined : next);
  assert.match(body, /psmuxInputSink\(id, writeCmd\)/, "psmux 입력이 싱크(제어 스트림)에 안 물려 있다");
  assert.doesNotMatch(body, /execFileP?\(TMUX_BIN/, "입력 때문에 psmux 프로세스를 띄우는 자리가 되살아났다 — 윈도우에서 글자마다 기동 지연");
});

await (async () => {
  // E16 — 실기기 하네스(scripts/psmux-input-probe.mjs)가 **제품과 같은 줄**을 보내는가. 어긋나면 윈도우에서 잰 PASS 가
  //  제품이 아니라 하네스를 증명한 것이 된다(지식 windows-native-node-psmux-1541 §3 — 하네스 결함을 제품 결함으로 오진한 전례).
  const probeUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/psmux-input-probe.mjs")).href;
  const { probeLines } = await import(probeUrl) as { probeLines: (id: string, d: string) => string[] };
  const inputs = ["", "abc", "한글", "🚀", "\u00ff", "\u0100", "a한 b\r", "\x03\t\x1b[A\x7f", "가".repeat(513), "a".repeat(512) + "가", ";kill-server;\n"];
  for (const d of inputs) assert.deepEqual(probeLines(ID, d), psmuxInputLines(ID, d), `하네스와 제품의 줄이 다르다: ${JSON.stringify(d.slice(0, 16))}`);
  pass++; console.log("ok  E16 실기기 하네스 줄 = 제품 줄(psmuxInputLines)");
})();

console.log(`\n${pass} passed`);

// ── attach 판정: 권한과 생사는 **따로** 본다 (2026-08-26 실측 신고) ──────────────
// 종전엔 권한이 없을 때만 생사를 확인했다. 그런데 canAttach→ownerMeta 는 DB desired-state 우선이라
//  **죽은 세션도 권한을 통과**시킨다 → 종료 확답(4410)이 안 나가고, 클라는 이유를 모른 채 영원히
//  재연결했다(화면엔 tmux 의 "can't find session" 한 줄만). 새로고침해야 '열기=복원'으로 살아났다.

t("[attach] 권한 있고 살아 있으면 통과", () => {
  assert.equal(attachClose(true, false), null);
});

t("[attach] ★ 권한이 있어도 세션이 끝났으면 4410 — 클라가 재연결을 멈추고 복원으로 간다", () => {
  assert.deepEqual(attachClose(true, true), { code: 4410, reason: "session-gone" });
});

t("[attach] 권한이 없으면 4403 — 클라는 몇 번 더 재시도(#687 가짜 4403 과 같은 취급)", () => {
  assert.deepEqual(attachClose(false, false), { code: 4403, reason: "no-access" });
});

t("[attach] 권한도 없고 세션도 끝났으면 종료가 더 정확한 사실이다 → 4410", () => {
  assert.deepEqual(attachClose(false, true), { code: 4410, reason: "session-gone" });
});

t("[attach] 판정 불가는 gone 이 아니다 — 살아있는 세션을 '종료됨'으로 오인하지 않는다(#835)", () => {
  // 호출부가 sessionGone 실패를 false 로 접는다. 그 입력에서는 권한만으로 갈린다.
  assert.equal(attachClose(true, false), null);
  assert.deepEqual(attachClose(false, false), { code: 4403, reason: "no-access" });
});

// ── attach cwd 폴백 (#2600 T2 d4 실측 2026-09-08) ──────────────────────────
// 매니지드 세션 호스트의 홈(`/var/lib/lvly-sesshost/<slug>`)은 그 uid 소유였는데 **부모가 root 0700** 이라
//  통과(x)가 안 됐다. node-pty 자식이 exec 직전 chdir 에서 죽으며 pty 로 `chdir(2) failed.: Permission denied`
//  한 줄만 뱉었고, 사람 화면엔 시도할 때마다 그 줄이 하나씩 쌓였다(세션은 영영 안 붙는다).
//  attach 의 cwd 는 세션 pane 에 아무 영향이 없으므로, 못 들어가면 죽지 말고 내려가야 한다.

t("[attach cwd] 홈에 들어갈 수 있으면 홈을 쓴다(종전 동작 무회귀)", () => {
  assert.equal(attachCwd("/home/lvly", () => true), "/home/lvly");
});

t("[attach cwd] ★ 홈에 못 들어가면 루트로 떨어진다 — attach 가 chdir 하나로 죽지 않는다", () => {
  const home = "/var/lib/lvly-sesshost/lively-46e3";
  const root = attachCwd(home, () => false);
  assert.notEqual(root, home);
  //  루트는 **그 홈이 앉은 볼륨의** 루트다(process.cwd() 를 안 본다 — ops/state-dir 가드레일).
  assert.equal(root, path.parse(home).root);
});

t("[attach cwd] 홈이 빈 값이면 들어갈 수 있나 묻지도 않고 루트 — 빈 문자열을 cwd 로 넘기지 않는다", () => {
  let asked = 0;
  assert.equal(attachCwd("", () => { asked++; return true; }), path.sep);
  assert.equal(asked, 0);
});
