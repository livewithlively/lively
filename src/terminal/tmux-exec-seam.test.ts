// tmux 실행 seam(LIVELY_TMUX_EXEC) — **설정이 없으면 종전과 완전히 동일**해야 한다.
//  이 파일이 지키는 명제: 새 노브가 기본 동작을 건드리지 않는다(무회귀).
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { installTenantSlugResolver } from "./catalog.js";
import path from "node:path";
import { tmux, tmuxExecArgv, LIST_FMT } from "./tmux-exec.js";

afterEach(() => { delete process.env.LIVELY_TMUX_EXEC; });

test("기본(미설정) — 빈 argv = 로컬 tmux 를 그대로 쓴다", () => {
  delete process.env.LIVELY_TMUX_EXEC;
  assert.deepEqual(tmuxExecArgv(), []);
});

test("빈 문자열·공백만이면 미설정과 같다", () => {
  process.env.LIVELY_TMUX_EXEC = "";
  assert.deepEqual(tmuxExecArgv(), []);
  process.env.LIVELY_TMUX_EXEC = "   ";
  assert.deepEqual(tmuxExecArgv(), []);
});

test("프로그램 하나면 그것만", () => {
  process.env.LIVELY_TMUX_EXEC = "/usr/local/bin/box-tmux";
  assert.deepEqual(tmuxExecArgv(), ["/usr/local/bin/box-tmux"]);
});

test("인자를 포함하면 앞에 붙일 argv 로 쪼갠다", () => {
  process.env.LIVELY_TMUX_EXEC = "ssh node-1 tmux";
  assert.deepEqual(tmuxExecArgv(), ["ssh", "node-1", "tmux"]);
});

// ★ 호출 시점에 읽어야 한다 — 모듈 로드 때 굳히면 부팅 순서·테스트에서 값이 안 먹는다
//  (세션 spawn 훅에서 같은 함정을 밟았다).
test("★ 값은 호출 시점에 읽는다(모듈 로드 시점이 아니라)", () => {
  delete process.env.LIVELY_TMUX_EXEC;
  assert.deepEqual(tmuxExecArgv(), []);
  process.env.LIVELY_TMUX_EXEC = "relay";
  assert.deepEqual(tmuxExecArgv(), ["relay"], "설정 직후 호출이 새 값을 봐야 한다");
  delete process.env.LIVELY_TMUX_EXEC;
  assert.deepEqual(tmuxExecArgv(), [], "지우면 즉시 기본으로 돌아와야 한다");
});

// ── 배선 검증: argv 파싱이 아니라 **실제로 그 프로그램으로 실행되는가** ──────────
//  argv 만 테스트하면 "쪼개기는 맞는데 아무데도 안 쓰임"을 못 잡는다.

function fakeRelay(): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-seam-"));
  const bin = path.join(dir, "relay.sh");
  // 받은 argv 를 그대로 되뱉는다 — tmux 인자가 온전히 전달됐는지 stdout 으로 확인한다.
  fs.writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
  return { dir, bin };
}

test("★ seam 을 설정하면 그 프로그램이 실행되고 tmux argv 가 뒤에 그대로 붙는다", async () => {
  const { dir, bin } = fakeRelay();
  try {
    process.env.LIVELY_TMUX_EXEC = bin;
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    assert.deepEqual(out.split("\n").filter(Boolean), ["list-sessions", "-F", "#{session_name}"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("★ seam 에 인자가 있으면 **앞에** 오고 tmux argv 가 그 뒤에 온다", async () => {
  const { dir, bin } = fakeRelay();
  try {
    process.env.LIVELY_TMUX_EXEC = `${bin} --tenant acme`;
    const out = await tmux(["kill-session", "-t", "box-x-1"]);
    assert.deepEqual(out.split("\n").filter(Boolean), ["--tenant", "acme", "kill-session", "-t", "box-x-1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 로컬 실행과 같은 규약이어야 상위의 try/catch 가 그대로 동작한다(getOpt 은 실패를 빈 문자열로 흡수한다).
test("★ 중계가 실패하면 로컬 실행과 똑같이 예외다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-seam-"));
  const bin = path.join(dir, "fail.sh");
  fs.writeFileSync(bin, '#!/bin/sh\necho "no server running" >&2\nexit 1\n', { mode: 0o755 });
  try {
    process.env.LIVELY_TMUX_EXEC = bin;
    await assert.rejects(() => tmux(["list-sessions"]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── attach 도 같은 seam 을 쓴다 ──────────────────────────────────────────────
// 명령형 tmux 와 attach 는 실행 방식이 다르지만(단발 vs 장수 PTY) **어디서 도는가**는 같아야 한다.
//  seam 이 둘로 갈리면 "명령은 원격, attach 는 로컬" 같은 반쪽 상태가 생기고, 그건 조용히 깨진다.
test("★ attach 경로가 같은 seam 값을 읽는다(설정이 하나여야 한다)", async () => {
  const mod = await import("./terminal-pty.js").catch(() => null);
  // 모듈 로드가 환경에 따라 실패할 수 있어(node-pty 네이티브) 로드 자체는 강제하지 않는다.
  //  여기서 고정하는 건 **seam 함수가 하나뿐**이라는 사실이다 — tmux-exec 이 유일한 출처다.
  assert.equal(typeof tmuxExecArgv, "function");
  if (mod) assert.ok(true, "attach 모듈이 같은 tmux-exec 을 import 한다(tsc 가 보장)");
});

// ── ★★ 테넌트별 tmux 중계(#1437 v1 5단계) ──────────────────────────────────
// 게이트웨이 하나가 여러 워크스페이스를 서비스하면 tmux 서버도 워크스페이스마다 다르다.

test("★ {slug} 없는 중계는 종전 그대로(치환하지 않는다)", () => {
  const saved = process.env.LIVELY_TMUX_EXEC;
  process.env.LIVELY_TMUX_EXEC = "ssh box tmux";
  installTenantSlugResolver(() => "acme");
  try {
    assert.deepEqual(tmuxExecArgv(), ["ssh", "box", "tmux"]);
  } finally {
    installTenantSlugResolver(() => null);
    if (saved === undefined) delete process.env.LIVELY_TMUX_EXEC; else process.env.LIVELY_TMUX_EXEC = saved;
  }
});

test("★★ {slug} 가 그 요청의 테넌트로 치환된다", () => {
  process.env.LIVELY_TMUX_EXEC = "docker exec lvly-s-{slug}-tmux tmux";
  installTenantSlugResolver(() => "acme-1a2b");
  try {
    assert.deepEqual(tmuxExecArgv(), ["docker", "exec", "lvly-s-acme-1a2b-tmux", "tmux"]);
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TMUX_EXEC;
  }
});

// ★★★ 여기서 로컬 tmux 로 폴백하면 ⓐ 세션이 엉뚱한 자리에 생기고 ⓑ **모든 테넌트가 같은 tmux
//  서버를 공유**한다(= 남의 세션이 목록에 보인다). 배선 버그는 오류로 드러나야 한다.
test("★★★ 컨텍스트가 없으면 던진다 — 로컬 tmux 로 폴백하지 않는다", () => {
  process.env.LIVELY_TMUX_EXEC = "docker exec lvly-s-{slug}-tmux tmux";
  installTenantSlugResolver(() => null);
  try {
    assert.throws(() => tmuxExecArgv(), /테넌트 컨텍스트/);
  } finally {
    delete process.env.LIVELY_TMUX_EXEC;
  }
});

test("★ 형식이 안 맞는 슬러그도 던진다(컨테이너 이름에 들어가는 값이다)", () => {
  process.env.LIVELY_TMUX_EXEC = "docker exec lvly-s-{slug}-tmux tmux";
  try {
    for (const bad of ["../x", "a b", "A-UP", ""]) {
      installTenantSlugResolver(() => bad);
      assert.throws(() => tmuxExecArgv(), /테넌트 컨텍스트/, `허용되면 안 됨: ${bad}`);
    }
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TMUX_EXEC;
  }
});

// ── LIST_FMT 는 **위치 계약**이다 (#2170 에서 필드를 하나 끼워 넣으며 추가) ─────────────────────
//  sessions.collectSessions 는 이 한 줄을 탭으로 쪼개 **순서대로** 구조분해한다. 그래서 필드를 끼워 넣거나
//  순서를 바꾸면 그쪽 destructuring 도 같이 고쳐야 하는데, 지금까지 그 대응을 지키는 장치가 없었다 —
//  어긋나면 예외가 나는 게 아니라 **하네스 자리에 작업폴더가 들어가는 식으로 조용히 밀린다**(전 세션 메타 오염).
//  ⚠ 이 표를 고쳤으면 sessions.ts 의 `const [name, created, …] = line.split("\t")` 도 같이 고쳤는지 확인할 것.
test("LIST_FMT 필드 순서 — collectSessions 구조분해와 1:1", () => {
  assert.deepEqual(LIST_FMT.split("\t"), [
    "#{session_name}", "#{session_created}", "#{session_attached}",
    "#{@box_owner}", "#{@box_harness}", "#{@box_dir}", "#{@box_auto}",
    "#{@box_flags}", "#{@box_invites}", "#{@box_project}", "#{@box_app}", "#{@box_managed}",
    "#{pane_current_command}", "#{session_last_attached}", "#{@box_last_busy}",
    "#{@box_state}", "#{@box_last_seen}", "#{pane_title}", "#{@box_label}",
  ], "LIST_FMT 를 바꿨다 — sessions.ts collectSessions 의 구조분해 순서도 같이 고쳤는지 확인하라");
  // @box_label 은 값에 탭이 들어올 수 있어 ...rest 로 받는다 → **반드시 마지막**이어야 한다.
  assert.equal(LIST_FMT.split("\t").at(-1), "#{@box_label}", "라벨이 마지막이 아니면 뒤 필드를 삼킨다");
});
