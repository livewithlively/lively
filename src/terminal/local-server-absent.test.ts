// 셀프호스트에서 tmux 서버가 «아예 없다» 는 답을 끝남으로 읽는 자리 — 그리고 **모름으로 남아야 하는** 갈래 (#4940).
//
// 실측(2026-10-23, 셀프호스트 테스트 박스): 세션이 다 끝나 tmux 서버가 내려간 뒤, 멈춘 리브 세션에 [연결 도와줘]가 말을 죽은
//  아웃박스에만 쌓았고 [삭제]가 500, 되살리기가 «모름» 에 막혔다. 끝남으로 읽는 갈래 자체는 진짜 tmux 로 session-gone-node 4행이 잰다.
//  이 파일은 그 반대편 — **확답이 아닌 것은 계속 모름(null)** 인지를 가짜 tmux 로 잰다(진짜 tmux 로는 경합·시그널을 못 만든다):
//
//   행 | has-session          | list-sessions        | 배포            | 기대
//   L1 | 서버 없음            | 서버 없음            | 셀프호스트       | 끝남(true) — sessionGone 도 true
//   L2 | 서버 없음            | 성공(그새 서버가 떴다) | 셀프호스트       | 모름(null)
//   L3 | 서버 없음            | 권한 거부(다른 접속 오류) | 셀프호스트    | 모름
//   L4 | 서버 없음            | 시그널로 끝남        | 셀프호스트       | 모름(타임아웃류는 답이 아니다)
//   L5 | 시그널로 끝남        | —                    | 셀프호스트       | 모름
//   L6 | 권한 거부            | —                    | 셀프호스트       | 모름
//   L7a| 서버 없음            | —                    | registry · 전용 소켓(lvly-*) 있음 | 모름 — 컨텍스트를 잃은 호출이 기본 소켓으로 샐 수 있다(격리 리뷰)
//   L7b| 서버 없음            | 서버 없음            | registry · 전용 소켓 없음 | 끝남 — 셀프호스트 기본 설치가 이 모양이다(부팅이 registry 로 뜬다 · 워크스페이스 primary 하나)
//   L7c| 서버 없음            | 서버 없음            | registry · 소켓 폴더 없음 | 끝남 — 서버가 한 번도 안 떴다(새 박스)
//   L8 | 그 세션 없음         | —                    | 셀프호스트       | 끝남(종전 확답 — 무회귀)
//   L9 | (직접) 타임아웃 오류 객체 | 부르지 않음      | 셀프호스트       | 모름 · list-sessions 를 부르지 않는다
//   W1 | 배선 — tmuxKill 이 같은 확답을 «이미 없음» 으로 받는다([보관 ×]·관리자 회수가 서버 부재로 500 이던 자리)
import { strict as assert } from "node:assert";
import test, { after, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//  ⚠ tmux-exec 는 모듈을 읽을 때 실행 파일 자리(catalog TMUX_BIN)를 굳힌다 — **import 전에** 가짜를 세운다.
//   가짜는 고정 경로의 두 파일(has · list)에서 갈래를 읽는다(env 는 로드 때 복사돼 나중에 바꿔도 자식에게 안 간다).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "local-server-absent-"));
const BIN = path.join(DIR, "tmux.sh");
const CALLS = path.join(DIR, "calls.log");
fs.writeFileSync(BIN, [
  "#!/bin/sh",
  `echo "$1" >> ${JSON.stringify(CALLS)}`,
  `case "$1" in has-session) m=$(cat ${JSON.stringify(path.join(DIR, "has"))});; list-sessions) m=$(cat ${JSON.stringify(path.join(DIR, "list"))});; *) m=ok;; esac`,
  'case "$m" in',
  '  absent) echo "no server running on /tmp/tmux-1000/default" >&2; exit 1;;',
  '  perm) echo "error connecting to /tmp/tmux-1000/default (Permission denied)" >&2; exit 1;;',
  '  nosuch) echo "can\'t find session: box-tester-11111111" >&2; exit 1;;',
  '  signal) kill -TERM $$; sleep 1; exit 0;;',
  '  ok) echo "box-other-22222222"; exit 0;;',
  "esac",
  "exit 1",
].join("\n") + "\n", { mode: 0o755 });
process.env.TMUX_BIN = BIN;
//  tmux 소켓 폴더(`${TMUX_TMPDIR}/tmux-<uid>`) — registry 갈래가 «전용 서버 소켓이 있나» 를 여기서 본다. 이것도 로드 때 복사된다.
const SOCK_ROOT = path.join(DIR, "sock");
const SOCK_DIR = path.join(SOCK_ROOT, `tmux-${process.getuid?.() ?? 0}`);
process.env.TMUX_TMPDIR = SOCK_ROOT;
for (const k of ["LIVELY_TMUX_EXEC", "LIVELY_TENANCY_MODE", "LIVELY_NODE_TOKEN", "TMUX"]) delete process.env[k];
const { sessionGoneVerdict, sessionGone, localServerAbsentVerdict } = await import("./tmux-exec.js");
const { unfreezeExecTopology } = await import("../exec-topology.js");

const ID = "box-tester-11111111";
const set = (has: string, list: string): void => {
  fs.writeFileSync(path.join(DIR, "has"), has);
  fs.writeFileSync(path.join(DIR, "list"), list);
  fs.writeFileSync(CALLS, "");
};
const calls = (): string[] => fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean);
afterEach(() => { delete process.env.LIVELY_TENANCY_MODE; unfreezeExecTopology(); });
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("L1 셀프호스트 · 서버 없음 두 번 → 끝남(true) · sessionGone 도 끝남", async () => {
  set("absent", "absent");
  assert.equal(await sessionGoneVerdict(ID), true);
  assert.deepEqual(calls(), ["has-session", "list-sessions"], "배선 — 가짜가 실제로 불렸고, 목록으로 한 번 더 확인했다");
  set("absent", "absent");
  assert.equal(await sessionGone(ID), true);
});

test("L2 그새 서버가 떴다(목록 성공) → 모름", async () => {
  set("absent", "ok");
  assert.equal(await sessionGoneVerdict(ID), null, "서버가 있는데 끝났다고 하면 갓 만든 세션이 복원으로 끌려간다(#3626)");
});

test("L3 목록이 다른 접속 오류(권한 거부) → 모름", async () => {
  set("absent", "perm");
  assert.equal(await sessionGoneVerdict(ID), null);
});

test("L4 목록이 시그널로 끝남 → 모름(타임아웃류는 답이 아니다)", async () => {
  set("absent", "signal");
  assert.equal(await sessionGoneVerdict(ID), null);
});

test("L5 has-session 이 시그널로 끝남 → 모름 · 목록을 부르지 않는다", async () => {
  set("signal", "absent");
  assert.equal(await sessionGoneVerdict(ID), null);
  assert.deepEqual(calls(), ["has-session"]);
});

test("L6 has-session 이 권한 거부 → 모름 · 목록을 부르지 않는다", async () => {
  set("perm", "absent");
  assert.equal(await sessionGoneVerdict(ID), null);
  assert.deepEqual(calls(), ["has-session"]);
});

const registry = (): void => { process.env.LIVELY_TENANCY_MODE = "registry"; unfreezeExecTopology(); };

test("L7a registry · 다른 워크스페이스 전용 서버 소켓(lvly-*)이 있다 → 모름 · 목록으로 되묻지도 않는다", async () => {
  registry();
  fs.mkdirSync(SOCK_DIR, { recursive: true });
  fs.writeFileSync(path.join(SOCK_DIR, "default"), "");
  fs.writeFileSync(path.join(SOCK_DIR, "lvly-acme"), "");
  try {
    set("absent", "absent");
    assert.equal(await sessionGoneVerdict(ID), null, "primary 엔 서버가 없다 ≠ 그 세션이 끝났다(acme 전용 소켓에 살아 있을 수 있다)");
    assert.deepEqual(calls(), ["has-session"]);
  } finally { fs.rmSync(SOCK_DIR, { recursive: true, force: true }); }
});

test("L7b registry · 전용 서버 소켓이 없다(primary 하나 — 셀프호스트 기본 설치) → 끝남", async () => {
  registry();
  fs.mkdirSync(SOCK_DIR, { recursive: true });
  fs.writeFileSync(path.join(SOCK_DIR, "default"), "");   // 서버가 죽고 남은 낡은 기본 소켓(실측 모양 — tmux 가 «no server running» 을 낸다)
  try {
    set("absent", "absent");
    assert.equal(await sessionGoneVerdict(ID), true, "셀프호스트 기본 설치(registry · primary 하나)에서 고쳐지지 않으면 이 수정은 거기서 아무것도 안 한다(실측)");
    assert.deepEqual(calls(), ["has-session", "list-sessions"]);
  } finally { fs.rmSync(SOCK_DIR, { recursive: true, force: true }); }
});

test("L7c registry · 소켓 폴더가 아예 없다(서버가 한 번도 안 떴다) → 끝남", async () => {
  registry();
  fs.rmSync(SOCK_DIR, { recursive: true, force: true });
  set("absent", "absent");
  assert.equal(await sessionGoneVerdict(ID), true);
});

test("L8 «그 세션 없음» 은 종전 확답 그대로(무회귀)", async () => {
  set("nosuch", "absent");
  assert.equal(await sessionGoneVerdict(ID), true);
  assert.deepEqual(calls(), ["has-session"]);
});

test("L9 타임아웃으로 죽인 오류 객체는 답이 아니다 — 목록을 부르지 않는다", async () => {
  set("absent", "absent");
  assert.equal(await localServerAbsentVerdict({ killed: true, signal: "SIGTERM", stderr: "no server running on /tmp/tmux-1000/default" }), null);
  assert.equal(await localServerAbsentVerdict({ code: 1, stderr: "can't find session: x" }), null, "서버 부재 문구가 아니면 이 술어의 일이 아니다");
  assert.deepEqual(calls(), []);
});

test("W1 배선 — tmuxKill 이 같은 확답(서버 없음 두 번)을 «이미 없음» 으로 받는다", () => {
  const src = fs.readFileSync("src/terminal/sessions.ts", "utf8");
  assert.match(src, /async function tmuxKill\(id: string\): Promise<void> \{[\s\S]{0,1600}?catch \(err\) \{ if \(!isSessionGoneError\(err\) && \(await localServerAbsentVerdict\(err\)\) !== true\) throw err; \}/,
    "★ 세션이 다 끝난 셀프호스트에서 [보관 ×]·관리자 회수가 \"no server running\" 으로 실패한다(killSession 이 훅 토큰·행 정리 전에 멈춘다)");
});
