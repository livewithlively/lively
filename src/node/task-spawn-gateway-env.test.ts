// 위탁 스폰이 «어디에 붙나» 를 **실제로** 싣는가 (#4012 T5 배선) — 사양 엣지 표 W1~W3.
//
//  task-gateway-env.test 는 순수 함수(taskGatewayEnvArgs)를 잰다. 그것만으로는 **스폰이 그 함수를 부르는지**
//   모른다 — 함수가 맞아도 호출 한 줄이 빠지면 판은 여전히 `~/.lively/gateway-url` 로 흘러 남의 워크스페이스에
//   붙는다(2026-09-16 olddev 사고의 모양 그대로). 그래서 스텁 tmux 로 spawnTaskSession 을 **진짜로** 돌리고,
//   tmux 가 받은 `new-session` 인자에 두 env 가 실렸는지를 **부작용(argv 로그)으로** 본다.
//
//  ⚠ TMUX_BIN 은 모듈 로드 시점에 읽힌다 → env 를 먼저 심고 **동적 import** 한다(정적 import 는 호이스팅된다).
//  ⚠ POSIX 전용 — 스텁이 sh 스크립트다(윈도우 러너는 건너뛴다).
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") {
  console.log("↷ task-spawn-gateway-env — win32 건너뜀(스텁 tmux 가 sh 스크립트)");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t5-spawn-"));
  const log = path.join(root, "tmux.log");
  const stub = path.join(root, "tmux");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });

  //  진짜 자원을 안 건드리게 전부 임시 자리로 — 홈·공유 루트·tmux·DB.
  process.env.TMUX_BIN = stub;
  process.env.TERMINAL_ROOT_SHARED = path.join(root, "shared");
  process.env.HOME = path.join(root, "home");
  process.env.LIVELY_MULTIPROFILE = "0";
  delete process.env.ITEMS_DATABASE_URL;
  delete process.env.LIVELY_GATEWAY_URL;   // 테스트 러너 env 가 새어 들어와 «실렸다» 로 오인하지 않게

  const { spawnTaskSession } = await import("./tasks.js");

  //  마지막 new-session 호출의 `-e K=V` 만 뽑는다.
  const lastNewSessionEnv = (): Record<string, string> => {
    const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("new-session "));
    assert.ok(lines.length > 0, "스텁 tmux 가 new-session 을 한 번도 못 받았다 — 관측 장치가 죽어 있다");
    const toks = lines[lines.length - 1].split(" ");
    const out: Record<string, string> = {};
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i] !== "-e") continue;
      const kv = toks[i + 1]; const at = kv.indexOf("=");
      if (at > 0) out[kv.slice(0, at)] = kv.slice(at + 1);
    }
    return out;
  };
  const base = { user: { userId: "t5-probe" }, rootKey: "shared", subpath: "", prompt: "ping", harness: "claude" };
  let n = 900001;
  const spawn = (extra: Record<string, unknown>) =>
    spawnTaskSession({ ...base, taskId: n++, ...extra } as unknown as Parameters<typeof spawnTaskSession>[0]);

  try {
    // ★ W1 보낸 쪽이 준 게이트웨이·워크스페이스가 판에 실린다.
    await spawn({ gatewayUrl: "https://lively-46e3.app.lvly.io", tenantSlug: "lively-46e3" });
    const e1 = lastNewSessionEnv();
    assert.equal(e1.LIVELY_GATEWAY_URL, "https://lively-46e3.app.lvly.io", "W1 주소가 판에 실린다");
    assert.equal(e1.LVLY_TENANT_SLUG, "lively-46e3", "W1 워크스페이스가 판에 실린다");
    assert.ok(e1.LIVELY_SESSION_ID?.startsWith("box-"), "W1 배선 확인 — 세션 id 도 같은 인자열에 있다");

    // W2 안 주면 안 싣는다 — 구 게이트웨이·단일 테넌트 무회귀.
    await spawn({});
    const e2 = lastNewSessionEnv();
    assert.equal(e2.LIVELY_GATEWAY_URL, undefined, "W2 주소 없음");
    assert.equal(e2.LVLY_TENANT_SLUG, undefined, "W2 슬러그 없음");

    // W3 모양이 아닌 주소는 명령줄까지 가지 않는다(종단).
    await spawn({ gatewayUrl: "https://x; rm -rf /", tenantSlug: "../evil" });
    const e3 = lastNewSessionEnv();
    assert.equal(e3.LIVELY_GATEWAY_URL, undefined, "W3 위험한 주소는 싣지 않는다");
    assert.equal(e3.LVLY_TENANT_SLUG, undefined, "W3 위험한 슬러그는 싣지 않는다");

    console.log("✓ task-spawn-gateway-env — 스폰이 게이트웨이·워크스페이스를 판에 싣는다 (W1~W3)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
