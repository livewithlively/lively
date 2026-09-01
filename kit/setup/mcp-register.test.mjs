// MCP 등록의 계약 (#2476, 2026-08-31) — **바이너리 없이 파일로 쓴다**.
//
//  왜 이 검사가 있나: 종전엔 `claude mcp add …` 를 셸에서 불렀고, 매니지드 키트 시딩은 멤버 exec 중계를 타는데
//  그 중계는 테넌트의 «항상 떠 있는» 컨테이너(tmux)로 나간다. 그 자리는 tmux 용으로 고른 것일 뿐 «하네스가
//  있는 자리» 가 아니다. 이미지가 분리돼 claude 가 빠지자 `set -euo pipefail` 이 그 줄에서 끊겨
//  **훅·settings.json·lib 까지 전부** 안 심겼고, 로그는 «비치명» 한 줄이라 아무도 몰랐다(2026-08-31 프로덕션).
//
//  그래서 잠그는 것은 둘이다 — ① 셸이 하네스 바이너리를 부르지 않는다 ② 파일에 쓰는 모양이 실측과 같다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv, sandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME 만으론 윈도우 격리가 안 된다(#1510)
import { mergeMcpServers, planServers } from "./mcp-register.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

//  ⚠ **캐노니컬을 본다.** kit/setup/register-clients.sh 는 발행마다 여기서 re-vendor 되는 **사본**이라
//   사본만 검사하면 캐노니컬이 어긋나도 초록불이다(실제로 처음에 사본을 고쳤다가 잡았다).
const CANON = path.join(HERE, "..", "..", "scripts", "register-clients.sh");
const VENDORED = path.join(HERE, "register-clients.sh");
const canonSh = () => fs.readFileSync(CANON, "utf8");

t("배선 · 캐노니컬 스크립트와 모듈을 실제로 읽었다(vacuous 방지)", () => {
  assert.ok(canonSh().length > 500);
  assert.equal(typeof planServers, "function");
});

t("★ vendored 사본이 캐노니컬과 같다 — 어긋나면 발행 때 조용히 되돌아간다", () => {
  assert.equal(fs.readFileSync(VENDORED, "utf8"), canonSh(), "kit/setup 사본이 낡았다(캐노니컬에서 다시 복사하라)");
});

t("★ 셸이 하네스 바이너리를 부르지 않는다 — 그 자리에 있으리라는 보장이 없다", () => {
  const sh = canonSh().split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  for (const bin of ["claude", "codex", "agy", "grok"]) {
    assert.ok(!new RegExp(`(^|[;&|(]\\s*)${bin}\\s`, "m").test(sh), `${bin} 를 부르고 있다`);
  }
  //  요구하는 건 node 하나 — 없으면 «건너뛴다»(죽지 않는다). 훅·설정까지 같이 잃는 게 이 사고의 본질이었다.
  assert.match(sh, /command -v node/);
  assert.match(sh, /mcp-register\.mjs/);
});

t("★ 실측 스키마대로 쓴다 — stdio 는 command·args, http 는 url·headers, 키는 type", () => {
  //  claude 2.1.x `--scope user` 실측(2026-08-31): 최상위 mcpServers, 키는 transport 가 아니라 type.
  const stdio = planServers({ shim: "/h/.lively/bin/lively", shimUsable: true, storeUrl: "http://x/mcp", token: "T", env: {} });
  assert.deepEqual(stdio[0], { name: "lively", type: "stdio", command: "/h/.lively/bin/lively", args: ["mcp"], env: {} });

  const http = planServers({ shim: "/h/x", shimUsable: false, storeUrl: "http://x/mcp", token: "T", env: {} });
  assert.equal(http[0].type, "http");
  assert.equal(http[0].url, "http://x/mcp");
  assert.equal(http[0].headers.Authorization, "Bearer T");
});

t("★ 헤더의 ${…} 는 리터럴로 남는다 — 여기서 확장하면 세션 밖에서 빈 값이 굳는다", () => {
  const [lively] = planServers({ shim: "/h/x", shimUsable: false, storeUrl: "http://x/mcp", token: "T", env: { LIVELY_SESSION_ID: "지금세션" } });
  assert.equal(lively.headers["x-lively-session"], "${LIVELY_SESSION_ID:-}");
  assert.ok(!JSON.stringify(lively).includes("지금세션"), "env 를 확장해 구워 버렸다");
});

t("★ 프록시가 있으면 stdio 가 원칙 — http 직결은 세션 내내 failed 로 굳는 경로다(#1079)", () => {
  const over = planServers({ shim: "/h/s", shimUsable: true, transportOverride: "http", storeUrl: "http://x/mcp", token: "T", env: {} });
  assert.equal(over[0].type, "http", "롤백 스위치(mcp-transport=http)는 존중한다");
});

t("★ 조직 서버 — auth_env 는 간접참조다(토큰 리터럴이 설정에 안 박힌다)", () => {
  const s = planServers({
    shim: "/h/s", shimUsable: true, storeUrl: "http://x/mcp", token: "T",
    env: { SOME_TOKEN: "비밀값" },
    orgServers: [
      { name: "a", transport: "http", url: "https://a/mcp", auth_env: "SOME_TOKEN" },
      { name: "b", transport: "http", url: "https://b/mcp", auth_env: "없는변수" },
      { name: "c", transport: "stdio", command: "/bin/tool --flag" },
      { name: "off", transport: "http", url: "https://off/mcp", enabled: false },
      { name: "lively", transport: "http", url: "https://dup/mcp" },
    ],
  });
  const by = Object.fromEntries(s.map((x) => [x.name, x]));
  assert.equal(by.a.headers.Authorization, "Bearer 비밀값");
  assert.equal(by.b.headers, undefined, "값이 없으면 헤더를 안 붙인다(무인증)");
  assert.deepEqual([by.c.command, by.c.args], ["/bin/tool", ["--flag"]]);
  assert.equal(by.off, undefined, "enabled:false 는 등록하지 않는다");
  assert.equal(by.lively.type, "stdio", "이름이 lively 인 조직 항목이 본체를 덮지 않는다");
});

t("★ 사람이 직접 넣은 항목은 보존하고, 우리가 넣었다가 뺀 것만 회수한다", () => {
  const cur = { mine: { type: "stdio", command: "/x" }, retired: { type: "http", url: "u" }, lively: { type: "http", url: "old" } };
  const next = mergeMcpServers(cur, [{ name: "lively", type: "stdio", command: "/s", args: ["mcp"], env: {} }], ["lively", "retired"]);
  assert.ok(next.mine, "남의 항목을 지웠다");
  assert.equal(next.retired, undefined, "우리가 넣었던 은퇴 항목을 안 지웠다");
  assert.equal(next.lively.type, "stdio", "본체를 갱신하지 않았다");
  assert.equal(next.lively.url, undefined, "옛 키가 남았다 — 항목은 통째로 갈아야 한다");
});

t("★ 실제로 파일에 쓴다 — 임시 홈에서 끝까지 돌려 결과를 읽는다", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcpreg-"));
  fs.mkdirSync(path.join(home, ".lively", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".lively", "lib"), { recursive: true });
  fs.writeFileSync(path.join(home, ".lively", "bin", "lively"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(home, ".lively", "lib", "lively-mcp-gateway.mjs"), "");
  //  설치 전부터 쓰던 남의 항목 — 덮이기 전에 백업돼야 한다.
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { lively: { type: "http", url: "예전것" } }, theme: "dark" }));

  execFileSync(process.execPath, [path.join(HERE, "mcp-register.mjs")], {
    //  ⚠ HOME 만 바꾸면 윈도우에서 격리가 안 되고 **실제 홈**에 쓴다(#1510). 샌드박스 조각은 spread 뒤에.
    env: { ...process.env, ...offlineLivelyEnv(), ...sandboxEnv({ home }), LIVELY_TOKEN: "T", STORE_URL: "http://x/mcp", MCP_SERVERS_FILE: "" },
    stdio: "pipe",
  });

  const d = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.equal(d.theme, "dark", "관계없는 키를 잃었다");
  assert.equal(d.mcpServers.lively.type, "stdio");
  const backup = JSON.parse(fs.readFileSync(path.join(home, ".lively", "mcp-user-backup.json"), "utf8"));
  assert.deepEqual(backup.lively, { type: "http", url: "예전것" }, "원본을 안 찍었다 — 제거 때 못 되돌린다");
  const managed = JSON.parse(fs.readFileSync(path.join(home, ".lively", "managed-mcp-servers.json"), "utf8"));
  assert.deepEqual(managed, ["lively"]);
  fs.rmSync(home, { recursive: true, force: true });
});

t("★ 토큰이 없으면 조용히 건너뛴다 — 등록 실패가 키트 설치 전체를 죽이지 않는다", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcpreg2-"));
  const out = execFileSync(process.execPath, [path.join(HERE, "mcp-register.mjs")], {
    env: { ...process.env, ...offlineLivelyEnv(), ...sandboxEnv({ home }), LIVELY_TOKEN: "" }, stdio: "pipe",
  });
  assert.equal(String(out).includes("✓"), false);
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false, "빈 설정을 만들어 놓았다");
  fs.rmSync(home, { recursive: true, force: true });
});

console.log(`mcp-register: ${pass} passed`);
