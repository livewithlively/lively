// launchd KeepAlive 회귀락 (2026-08-26 dev.lvly.io 9분 502, 프로젝트 #2049) — "죽으면 자동 재시작"이 조용히 반쪽이 된다.
//  KeepAlive{SuccessfulExit:false} 는 **비정상 종료에만** 재기동한다. 게이트웨이는 SIGTERM 을 우아하게 받아 exit 0 으로
//  끝나므로(src/index.ts), 남의 `pkill -f dist/index.js`·`kill <pid>`·`launchctl stop` 한 방에 영구 다운됐다 — 크래시는
//  살아나는데 정상 TERM 은 안 살아나는 구멍은 실제로 죽을 때까지 안 보인다(실측: 구설정 probe 는 TERM 뒤 not running,
//  KeepAlive=true 는 새 PID 로 2초 만에 부활). 코드도 exit 0 = "슈퍼바이저가 다시 띄운다"를 전제한다
//  (src/boot/housekeeping.ts workspace-registry 의 의도된 재기동). 그래서 값이 아니라 **결정**을 락한다:
//   E1 mac plist 의 KeepAlive 는 무조건 true(딕셔너리 조건 금지 — SuccessfulExit/NetworkState 로 되돌리면 재현)
//   E2 Linux 유닛(단일·blue-green)도 같은 계약 — Restart=always(on-failure 로 내리면 같은 구멍)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, "io.lvly.lively.plist"), "utf8");
// 주석은 설정이 아니다 — 주석에 적힌 "SuccessfulExit(종전)" 설명이 단언에 걸리지 않게 걷어낸다.
const plist = raw.replace(/<!--[\s\S]*?-->/g, "");

// 배선 단언 — 엉뚱한 파일을 읽고 조용히 통과하지 않게(vacuous 방지).
assert.ok(/<string>io\.lvly\.lively<\/string>/.test(plist), "게이트웨이 plist 템플릿이 아니다(테스트가 대상을 잃음)");

// E1 — KeepAlive 는 <true/> 하나. 바로 다음 요소가 true 여야 하고, 조건 키는 파일 어디에도 없어야 한다.
const ka = /<key>KeepAlive<\/key>\s*(<[^>]+>)/.exec(plist);
assert.ok(ka, "KeepAlive 키가 없다 — 상시구동의 핵심이다");
assert.equal(ka[1], "<true/>", `KeepAlive 는 <true/> 여야 한다(exit 0 에도 재기동). 지금: ${ka[1]}`);
assert.ok(!/SuccessfulExit/.test(plist), "SuccessfulExit 조건은 금지 — 정상 TERM(exit 0)에 안 살아나는 2026-08-26 구멍이 재현된다");
assert.ok(!/NetworkState/.test(plist), "NetworkState 조건은 쓰지 않는다(launchd 에서 폐기된 키 — 조건부 KeepAlive 로 오해를 남긴다)");

// E2 — Linux 유닛 패리티: 같은 게이트웨이, 같은 계약.
for (const unit of ["lively-gateway.service", "lively-gateway@.service"]) {
  const u = fs.readFileSync(path.join(here, "..", "linux", unit), "utf8");
  assert.ok(/\[Service\]/.test(u), `${unit}: systemd 유닛이 아니다(테스트가 대상을 잃음)`);
  const r = /^Restart=(\S+)/m.exec(u);
  assert.ok(r, `${unit}: Restart= 가 없다`);
  assert.equal(r[1], "always", `${unit}: Restart=always 여야 한다(exit 0 에도 재기동). 지금: ${r[1]}`);
}
console.log("keepalive-always: OK (mac KeepAlive=true · linux Restart=always)");
