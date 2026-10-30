// register-clients.sh 두 사본이 갈라지지 않는다 (#4501).
//  정본은 scripts/register-clients.sh, 발행 번들에 실리는 것은 kit/setup/register-clients.sh(vendored) 다.
//  생성기(kit/generator/build-context.mjs)의 «정본을 사본 위에 복사» 는 kit 이 게이트웨이 옆 별 레포이던 시절의
//  탐색이라, 지금 배치(kit 이 lively 레포 안)에서는 GATEWAY_DIR 을 주지 않는 한 돌지 않는다 — 번들은 늘 사본을 싣는다.
//  그래서 둘을 손으로 함께 고치는 관례를 이 테스트가 강제한다(한쪽만 고치면 번들에는 옛 등록기가 나간다).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const canonical = path.join(ROOT, "scripts", "register-clients.sh");
const vendored = path.join(ROOT, "kit", "setup", "register-clients.sh");

assert.ok(fs.existsSync(canonical) && fs.existsSync(vendored), "두 사본 중 하나가 없다(테스트가 대상을 잃음)");
assert.ok(fs.readFileSync(canonical).equals(fs.readFileSync(vendored)),
  "scripts/register-clients.sh 와 kit/setup/register-clients.sh 가 다르다 — 발행 번들은 kit 사본을 싣는다. 두 파일을 같게 맞추세요");
console.log("ok  register-clients.sh 정본·사본 바이트 동일");
