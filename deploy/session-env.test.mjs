// 세션 env 계약 — **정본 한 벌이 실제로 그 값을 내는가** (#2258 이동 2)
//  실행: node deploy/session-env.test.mjs
//
// ── 왜 이렇게 검증하나 ──────────────────────────────────────────────────────
// 이 계약이 갈리면 «그 표면에서만 나는 버그» 가 난다(PATH 순서 하나가 #1023 이었다). 그래서
//  소스 문자열을 대조하지 않고 **실제로 셸을 돌려 env 를 받아** 본다 — 문구는 바뀌어도 값은
//  바뀌면 안 되는 자리다.
// ⚠ 리팩터링 안전판: 옛 box-spawn(정본 도입 전)과 새 box-spawn 이 **같은 env** 를 내는지도 본다.
//   그 비교가 이 변경의 유일한 «무회귀» 증거다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, "linux", "session-env.sh");
const BOX = path.join(here, "linux", "box-spawn");

let pass = 0;
const ok = (m) => { pass++; console.log(`ok  ${m}`); };

/** 계약을 실제로 적용한 뒤의 env 를 읽는다. opts 로 표면 차이를 고른다. */
function envAfter({ home, args = [], seed = {} }) {
  const script = `set -euo pipefail
. ${JSON.stringify(LIB)}
lvly_session_env "tester" ${JSON.stringify(home)} ${args.join(" ")}
/usr/bin/env`;
  const out = execFileSync("bash", ["-c", script], {
    env: { PATH: "/inherited/bin:/usr/bin:/bin", HOME: home, ...seed },
    encoding: "utf8",
  });
  const m = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
  }
  return m;
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-env-"));

// ── ① 세 표면 공통 항목 ─────────────────────────────────────────────────────
{
  const e = envAfter({ home: HOME });
  assert.equal(e.HOME, HOME);
  assert.equal(e.USER, "tester");
  assert.equal(e.LOGNAME, "tester", "USER 만 두고 LOGNAME 을 빠뜨리면 일부 툴이 uid 를 숫자로 본다");
  ok("① 신원 셋(HOME·USER·LOGNAME)");

  assert.equal(e.LANG, "C.UTF-8");
  assert.equal(e.LC_ALL, "C.UTF-8");
  assert.equal(e.LC_CTYPE, "C.UTF-8");
  ok("① 로케일 기본값 — 없으면 tmux 한글 렌더가 깨진다");

  //  xterm.js 렌더러와 일치해야 하고 terminfo 가 어디에나 있다(#524).
  assert.equal(e.TERM, "xterm-256color");
  ok("① TERM 강제 — tmux-256color terminfo 부재 박스에서 Ink TUI 가 죽는 것을 막는다");
}

// ── ② PATH — 멤버 소유 bin 이 시스템보다 **앞**(#1023) ─────────────────────
{
  const e = envAfter({ home: HOME });
  const parts = e.PATH.split(":");
  assert.equal(parts[0], `${HOME}/.local/bin`, `PATH 첫 항목이 아니다: ${e.PATH}`);
  assert.equal(parts[1], `${HOME}/.npm-global/bin`);
  assert.ok(parts.indexOf("/usr/bin") > 1, "시스템 경로가 멤버 bin 보다 앞이면 스테일 claude 가 이긴다");
  ok("② PATH — 멤버 bin 이 시스템보다 앞");

  //  상속은 **표면이 고른다**. 컨테이너엔 이어받을 PATH 가 없다(도커가 준 최소값).
  assert.ok(!e.PATH.includes("/inherited/bin"), "기본은 상속 안 함(컨테이너 표면)");
  const inh = envAfter({ home: HOME, args: ["--inherit-path"] });
  assert.ok(inh.PATH.includes("/inherited/bin"), "--inherit-path 면 이어받는다(박스 표면)");
  assert.ok(inh.PATH.indexOf(`${HOME}/.local/bin`) < inh.PATH.indexOf("/inherited/bin"),
    "상속분이 멤버 bin 보다 앞이면 #1023 이 되살아난다");
  ok("② PATH 상속은 표면이 고른다 — 「다르다」가 아니라 「고른다」");
}

// ── ③ 통과 항목 — 설정된 것만 손댄다(미설정이면 종전 동작) ─────────────────
{
  const bare = envAfter({ home: HOME });
  for (const k of ["TZ", "LIVELY_SESSION_ID", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    assert.equal(bare[k], undefined, `${k} 를 미설정인데 만들어 냈다`);
  }
  const seeded = envAfter({
    home: HOME,
    seed: { TZ: "Asia/Seoul", LIVELY_SESSION_ID: "box-abc", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
  });
  assert.equal(seeded.TZ, "Asia/Seoul");
  assert.equal(seeded.LIVELY_SESSION_ID, "box-abc");
  assert.equal(seeded.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  ok("③ 통과 항목 — 있으면 싣고 없으면 안 만든다");
}

// ── ③b ★ 아무것도 안 설정된 세션에서 **0 을 반환**한다 ───────────────────
//  호출자(box-spawn)는 `set -euo pipefail` 이다. 실측으로 확인한 규칙: set -e 는 함수 **중간의**
//  실패한 `&&` 리스트엔 안 걸리지만, 그런 줄이 **마지막 명령**이면 그 값이 함수의 반환값이 되어
//  호출자가 거기서 죽는다. TZ 없는 세션이 대부분이라 그러면 «어떤 박스에서는 세션이 아예 안 뜬다».
//  그래서 반환값 자체를 못박는다 — 끝의 `return 0` 을 지우면 이 시험이 빨간불이 된다.
{
  const script = `set -euo pipefail
. ${JSON.stringify(LIB)}
lvly_session_env "tester" ${JSON.stringify(HOME)}
echo "RC=$?"`;
  const out = execFileSync("bash", ["-c", script], { env: { PATH: "/usr/bin:/bin", HOME }, encoding: "utf8" });
  assert.match(out, /RC=0/, `통과 항목 미설정에서 0 이 아닌 값을 반환했다: ${out.trim().slice(-40)}`);
  ok("③b 아무것도 안 설정된 세션에서 0 을 반환한다(호출자 set -e 안전)");
}

// ── ④ 토큰 파일 읽기도 표면이 고른다 ───────────────────────────────────────
{
  fs.mkdirSync(path.join(HOME, ".lively"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".lively", "token"), "FILE_TOKEN\n");
  assert.equal(envAfter({ home: HOME }).LIVELY_TOKEN, undefined, "기본은 안 읽는다(매니지드는 브로커가 준다)");
  assert.equal(envAfter({ home: HOME, args: ["--read-token-file"] }).LIVELY_TOKEN, "FILE_TOKEN");
  //  이미 실려 있으면 파일이 이기면 안 된다 — 리스 토큰(#1289)이 디스크본에 덮이면 남의 자격으로 돈다.
  assert.equal(
    envAfter({ home: HOME, args: ["--read-token-file"], seed: { LIVELY_TOKEN: "ENV_TOKEN" } }).LIVELY_TOKEN,
    "ENV_TOKEN", "env 로 실린 토큰을 파일이 덮었다");
  ok("④ 토큰 — 표면이 고르고, env 가 파일을 이긴다");
}

// ── ⑤ ★ 무회귀 — 옛 box-spawn 과 **같은 env** 를 낸다 ──────────────────────
//  이 변경은 리팩터링이다. 값이 하나라도 달라지면 그건 리팩터링이 아니라 동작 변경이다.
{
  const old = execFileSync("git", ["show", `HEAD:deploy/linux/box-spawn`], { cwd: path.join(here, ".."), encoding: "utf8" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-boxcmp-"));
  const oldPath = path.join(dir, "old"); fs.writeFileSync(oldPath, old); fs.chmodSync(oldPath, 0o755);
  const seed = { PATH: "/inherited/bin:/usr/bin:/bin", HOME, TZ: "Asia/Seoul", LIVELY_SESSION_ID: "box-x" };
  const keys = /^(HOME|USER|LOGNAME|PATH|LANG|LC_ALL|LC_CTYPE|TERM|TZ|LIVELY_SESSION_ID|LIVELY_TOKEN)=/;
  const run = (p) => execFileSync("bash", [p, "--", "/usr/bin/env"], { env: { ...seed, LVLY_SESSION_ENV_LIB: LIB }, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
    .split("\n").filter((l) => keys.test(l)).sort().join("\n");
  const before = run(oldPath);
  const after = run(BOX);
  //  ★ 배선 단언 — 빈 출력을 비교하고 «같다» 고 넘어가는 것이 이 테스트의 유일한 실패 모드다.
  assert.ok(before.split("\n").length >= 8, `옛 판이 env 를 안 냈다(빈 검증): ${JSON.stringify(before).slice(0, 120)}`);
  assert.equal(after, before, "정본 도입으로 env 가 달라졌다 — 리팩터링이 아니다");
  ok("⑤ ★ 무회귀 — 옛 box-spawn 과 완전히 같은 env(빈 검증 방지 단언 포함)");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑥ node 도구 힙 상한 — **세션 대신 명령이 죽게 한다** (#3546) ────────────
//  V8 은 힙 천장을 «머신 메모리»에서 파생하는데, 컨테이너에선 그 값이 **세션 캡 전체**다. 그런데 그
//   캡 안엔 claude·MCP 가 이미 ~1.0GB 상주한다 — 안 묶으면 node 도구 하나가 cgroup OOM 을 불러
//   **세션 컨테이너를 통째로** 데려간다(2026-09-04 실측: 캡 1536MB 세션의 node 기본
//   heap_size_limit=792MB, `npx tsc --noEmit` 도중 세션 사망 · 트랜스크립트가 그 호출에서 끊겼다).
//  메모리 출처는 LVLY_MEMINFO seam 으로 갈아낀다 — 시험이 CI 머신 크기에 좌우되면 안 된다.
{
  const mem = (mb) => {
    const f = path.join(HOME, `meminfo-${mb}`);
    fs.writeFileSync(f, `MemTotal:       ${mb * 1024} kB\n`);
    return f;
  };
  const heapOf = (mb, extra = {}) =>
    envAfter({ home: HOME, seed: { LVLY_MEMINFO: mem(mb), ...extra } }).NODE_OPTIONS;

  assert.equal(heapOf(1536), "--max-old-space-size=537", "캡 1536MB → 35% = 537MB");
  assert.equal(heapOf(2560), "--max-old-space-size=896",
    "캡 2560MB → 896MB — 실측 콜드 tsc 요구량(560<x≤660)을 넘어야 한다");
  assert.equal(heapOf(512), "--max-old-space-size=256", "작은 캡에서도 하한 256MB 아래로 안 내린다");
  //  ★ 무회귀 — 메모리가 넉넉한 표면엔 **아예 안 건다.** 여기가 깨지면 셀프호스트 박스의 빌드가
  //   있지도 않은 문제 때문에 힙 상한을 얻는다.
  assert.equal(heapOf(8192), undefined, "> 4GB 표면엔 걸지 않는다(무회귀)");
  //  기본값은 «미설정일 때만» — 사람이 정한 값을 덮으면 큰 빌드를 하려던 사람을 조용히 막는다.
  assert.equal(heapOf(1536, { NODE_OPTIONS: "--max-old-space-size=9999" }),
    "--max-old-space-size=9999", "명시한 NODE_OPTIONS 를 덮으면 안 된다");
  ok("⑥ node 도구 힙 상한 — 캡 비례 · 하한 256 · >4GB 미적용 · 명시값 우선");
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed`);
