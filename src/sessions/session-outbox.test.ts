// 순수 단위 체크(node:assert) — 아웃박스(#1753)의 정책·에코 바늘. 배달자(파일·tmux·DB)는 여기서 안 띄운다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliveryTransport, echoNeedle, flatOneLine, needsSubmitRetry, readyVerdictOnError, retryDelayMs, stallAction, unreachableDelayMs,
  READY_WINDOW_MS, NOT_READY_TTL_MS, UNREACHABLE_TTL_MS, STALE_SENDING } from "./session-outbox.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] flatOneLine — 개행은 공백 하나로(send-keys 규약 ①과 같은 변환이어야 에코가 맞는다)", () => {
  assert.equal(flatOneLine("a\nb"), "a b");
  assert.equal(flatOneLine("  a \n  b \n\n c  "), "a b c");
  assert.equal(flatOneLine(""), "");
});
t("[2] echoNeedle — JSON 이스케이프 형태(따옴표·역슬래시·한글 원문 유지)", () => {
  assert.equal(echoNeedle('say "hi"'), 'say \\"hi\\"');
  assert.equal(echoNeedle("경로는 C:\\tmp"), "경로는 C:\\\\tmp");
  assert.equal(echoNeedle("안녕하세요"), "안녕하세요");
  // 트랜스크립트 한 줄에 실제로 들어가는 형태 — JSON.stringify 로 감싼 문서에서 부분일치해야 한다.
  const line = JSON.stringify({ type: "user", message: { role: "user", content: 'say "hi"' } });
  assert.ok(line.includes(echoNeedle('say "hi"')));
});
t("[2b] echoNeedle — 접두 160자만(긴 텍스트 꼬리 뒤섞임 내성): 꼬리가 달라져도 매치된다", () => {
  const long = "가".repeat(200) + " 꼬리";
  const mangled = "가".repeat(200) + " 리꼬";           // 꼬리가 뒤섞인 주입 결과
  const doc = JSON.stringify({ content: mangled });
  assert.ok(doc.includes(echoNeedle(long)));
});
t("[3] retryDelayMs — 완만히 늘고 30초에 멈춘다(로그인 화면을 계속 두드리지 않는다)", () => {
  assert.equal(retryDelayMs(1), 15_000);
  assert.equal(retryDelayMs(4), 30_000);
  assert.equal(retryDelayMs(100), 30_000);
});
t("[4] 창 상수 — 한 번의 준비 대기(20s)와 TTL(30분)의 관계가 뒤집히지 않는다", () => {
  assert.ok(READY_WINDOW_MS < NOT_READY_TTL_MS);
});

console.log(`session-outbox: ${pass} passed`);

// ── #1867 실측(dev 2026-08-25): 첫 지시로 프로젝트를 만들면 세션이 **새 빈 폴더**에서 시작한다 → 대화 파일이 아직
//  없어 에코가 `unreadable` 이고, 종전 조건(timeout 만)은 Enter 를 안 눌러 지시가 입력칸에 남았다(sent/echo-unreadable).
t("[미제출 방어] 에코를 확인 못 했으면(timeout·unreadable 둘 다) Enter 를 한 번 더 — 확인됐으면 안 누른다", () => {
  assert.equal(needsSubmitRetry("timeout", "claude"), true);
  assert.equal(needsSubmitRetry("unreadable", "claude"), true, "새 폴더 세션의 첫 지시가 여기서 막혔다");
  assert.equal(needsSubmitRetry("confirmed", "claude"), false, "이미 제출됐는데 또 누르지 않는다");
});
t("[미제출 방어] claude 외 하네스는 입력칸 문법을 모르므로 누르지 않는다(종전과 같다)", () => {
  for (const h of ["codex", "opencode", "antigravity", "grok", ""]) {
    assert.equal(needsSubmitRetry("unreadable", h), false, h);
    assert.equal(needsSubmitRetry("timeout", h), false, h);
  }
});

// ── #2154 매니지드 첫 지시 유실 — '못 닿음'과 '죽음'을 가르는 표 ──────────────────────────────
//  실측 2026-08-27: 홈 컴포저 첫 지시가 6시간 뒤에도 실행조차 안 됨. 아웃박스 40건 중 session-gone 6 ·
//  not-ready 4 · 채널없음 1 이 진짜 유실이었다. 원인은 waitReady 의 `catch { return "gone" }` —
//  tmux 가 던지기만 하면 죽음으로 단정하고 그 세션의 대기분을 **전부 failed** 로 버렸다.
t("[#2154 ②] 던진 오류의 결말 — #835 확답만 gone, 나머지는 모름(unknown)", () => {
  const saved = process.env.LIVELY_TMUX_EXEC;
  delete process.env.LIVELY_TMUX_EXEC;                                    // 로컬(비중계) 규약으로 먼저
  assert.equal(readyVerdictOnError({ stderr: "can't find session: box-x" }), "gone", "tmux 가 없다고 답했다");
  // ↓ 종전 코드가 전부 'gone' 으로 단정하던 것들 — 세션의 생사를 **모르는** 자리다.
  assert.equal(readyVerdictOnError({ stderr: "lvly tmux-relay: 브로커 응답 없음: http://hub" }), "unknown", "노드 채널 무응답");
  assert.equal(readyVerdictOnError({ stderr: '{"message":"node channel unavailable"}' }), "unknown", "허브 503(파킹 소켓 좀비)");
  assert.equal(readyVerdictOnError({ killed: true, signal: "SIGTERM", stderr: "" }), "unknown", "5초 타임아웃 kill");
  assert.equal(readyVerdictOnError({ stderr: "no server running on /tmp/tmux-1000/default" }), "unknown", "로컬은 서버 부재를 확답으로 안 본다");
  assert.equal(readyVerdictOnError(new Error("ECONNREFUSED")), "unknown");
  process.env.LIVELY_TMUX_EXEC = "node /opt/lively/libexec/tmux-relay.cjs {slug}";   // 매니지드 중계
  assert.equal(readyVerdictOnError({ stderr: "no server running on /tmp/tmux-acme/lvly-acme" }), "gone",
    "중계에선 tmux 서버 증발이 확답이다(#1437 — 그 테넌트 세션의 영구 소실)");
  if (saved === undefined) delete process.env.LIVELY_TMUX_EXEC; else process.env.LIVELY_TMUX_EXEC = saved;
});
t("[#2154 ②] 배달 못 한 순간의 처분 — 못 닿거나 되살릴 수 있으면 **들고 있는다**", () => {
  const fresh = { ageMs: 5_000, restorable: true };
  assert.deepEqual(stallAction("unknown", fresh), { action: "requeue", reason: "unreachable" });
  assert.deepEqual(stallAction("unknown", { ageMs: 5_000, restorable: false }), { action: "requeue", reason: "unreachable" },
    "생사를 모르는데 복원 여부로 버리지 않는다");
  assert.deepEqual(stallAction("gone", fresh), { action: "requeue", reason: "session-gone-restorable" },
    "확답으로 죽었어도 '이어서 열기'가 되면 그 복원이 큐를 승계한다");
  assert.deepEqual(stallAction("gone", { ageMs: 5_000, restorable: false }), { action: "fail", reason: "session-gone" },
    "되살릴 자리가 없으면 종전대로 실패(화면이 사유와 함께 보여준다)");
  assert.deepEqual(stallAction("not-ready", fresh), { action: "requeue", reason: "not-ready" });
});
t("[#2154 ②] 그래도 영원히 들고 있지는 않는다 — 각자의 상한을 넘으면 failed", () => {
  assert.equal(stallAction("not-ready", { ageMs: NOT_READY_TTL_MS, restorable: true }).action, "fail");
  assert.equal(stallAction("not-ready", { ageMs: NOT_READY_TTL_MS - 1, restorable: true }).action, "requeue");
  assert.equal(stallAction("unknown", { ageMs: UNREACHABLE_TTL_MS, restorable: true }).action, "fail");
  assert.equal(stallAction("gone", { ageMs: UNREACHABLE_TTL_MS, restorable: true }).action, "fail");
  // 입력창을 기다리는 일(세션은 살아 있다)보다 못 닿는 일(노드 재기동·사람의 복원)이 더 오래 걸린다.
  assert.ok(NOT_READY_TTL_MS < UNREACHABLE_TTL_MS);
});
t("[#2154 ②] 못 닿는 동안의 재시도는 분 단위로 벌어지고 5분에서 멈춘다(로그인 화면 폴링과 다른 시간축)", () => {
  assert.equal(unreachableDelayMs(0), 30_000);
  assert.equal(unreachableDelayMs(3), 120_000);
  assert.equal(unreachableDelayMs(100), 5 * 60_000);
  assert.ok(unreachableDelayMs(0) >= retryDelayMs(99), "가장 느린 입력창 재시도보다도 성기게");
});

// ── #2169 전송수단은 하네스 모드가 정한다 ──────────────────────────────────────────────
//  codex app-server 세션의 pane 은 **codex TUI 가 아니다**(#2055 — TUI 와 app-server 가 같은 대화를 동시에
//  쥘 수 없어 pane 을 셸로 둔다). 그래서 send-keys 는 **그 대화에 닿는 길이 아예 없다**: 준비 판정이 send 를
//  주면 사람의 첫 문장이 셸에 타이핑되고(실측 2026-08-26, "첫 프롬프트도 씹히고"), 안 주면 TTL 까지 기다렸다
//  버려진다. 어느 쪽이든 배달이 아니다 — 고치는 근거는 통계가 아니라 **구조**다.
t("[#2169] codex(app-server 기본)는 프로토콜로 나른다 — 셸 pane 에 글자를 넣지 않는다", () => {
  assert.equal(deliveryTransport("codex", {} as NodeJS.ProcessEnv), "codex-chat");
});
t("[#2169] 그 외 하네스는 종전대로 화면(send-keys) — 무회귀", () => {
  for (const h of ["claude", "opencode", "antigravity", "grok", "shell", ""]) {
    assert.equal(deliveryTransport(h, {} as NodeJS.ProcessEnv), "send-keys", h);
  }
});
t("[#2169] codex 를 tmux 모드로 되돌리면(LIVELY_CODEX_CHAT=tmux) 화면 경로로 돌아온다", () => {
  assert.equal(deliveryTransport("codex", { LIVELY_CODEX_CHAT: "tmux" } as NodeJS.ProcessEnv), "send-keys");
  // 되돌리는 길이 살아 있어야 한다 — app-server 는 공식 문서상 experimental 이다(codex-chat-mode 머리말).
});

// dist 에서 도는 테스트라 소스는 **cwd 기준**으로 읽는다(이 레포 관용구 — housekeeping-tenancy.test.ts 와 같다).
const SRC = "src/sessions/session-outbox.ts";

// ── #2244 매니지드에는 전역 스윕이 없다 — 회수를 테넌트 컨텍스트 안으로 ──────────────────────
//  실측 2026-08-28(프로덕션 c77): 이미지 롤로 게이트웨이가 재생성되며 배달 루프가 죽었고, 첫 지시가
//  `sending` 인 채 13분 넘게 갇혔다. 원인은 `boot/housekeeping` 의 requestScopedTenancy — 요청별 테넌시에서는
//  `gate:"scheduler"` 스텝(= resumeOutbox 를 부르는 background-sweeps)이 통째로 안 돈다.
//  같은 배포에서 하루 넘은 delivered/sent 30건이 안 지워진 것이 "그 경로가 아예 안 돈다"의 대조 증거였다.
t("[#2244] 잔재 판정 시간은 resumeOutbox 와 recoverStaleSending 이 **같은 자**를 쓴다", () => {
  // 두 회수가 다른 자를 쓰면 한쪽만 고쳐지는 날이 온다 — 상수 하나로 묶어 둔 이유.
  assert.equal(STALE_SENDING, "2 minutes");
  const src = readFileSync(SRC, "utf8");
  const hardcoded = src.match(/interval '(\d+ minutes?)'/g) ?? [];
  assert.deepEqual(hardcoded, [], `SQL 에 시간을 직접 적은 자리가 남아 있다: ${hardcoded.join(", ")}`);
  assert.equal((src.match(/interval '\$\{STALE_SENDING\}'/g) ?? []).length, 2, "두 회수가 그 상수를 쓴다");
});
t("[#2244] 잔재 회수는 **세션 스코프**다 — 전역 스윕을 흉내내지 않는다", () => {
  const src = readFileSync(SRC, "utf8");
  const fn = src.slice(src.indexOf("export async function recoverStaleSending"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(/WHERE session_id=\$1/.test(body),
    "session_id 로 안 좁히면 housekeeping 이 거부한 그 '누구의 것인지 모르는 정리'가 된다");
  assert.ok(/attempts=attempts\+1/.test(body),
    "되살린 행은 다시 보내지므로 중복 위험이 있다 — attempts 를 올려 반복되면 실패로 떨어지게(종전 resumeOutbox 와 같은 판단)");
});
t("[#2244] 배달자는 돌기 전에 자기 잔재를 회수하고, 대화창 읽기는 배달자를 깨운다", () => {
  const src = readFileSync(SRC, "utf8");
  const loop = src.slice(src.indexOf("async function deliverLoop"));
  assert.ok(/recoverStaleSending\(sessionId\)/.test(loop.slice(0, loop.indexOf("for (;;)"))),
    "회수가 루프 **진입 전**에 있어야 그 행이 이번 회차에 잡힌다");
  const list = src.slice(src.indexOf("export async function listOutbox"));
  const body = list.slice(0, list.indexOf("\n}"));
  assert.ok(/kickOutbox\(sessionId\)/.test(body),
    "매니지드엔 전역 스윕이 없어 재기동 뒤 큐를 깨울 자리가 필요하다");
  // 화면이 이 엔드포인트를 3초마다 친다 — 조건 없이 깨우면 아무것도 안 걸린 세션에서도 매번 배달 루프가 뜬다.
  assert.match(body, /if \(rows\.some\([\s\S]*?\) kickOutbox\(sessionId\)/,
    "깨우기는 **덜 끝난 행이 보일 때만** — 무조건 kick 은 3초 폴링에 얹혀 헛돈다");
});
