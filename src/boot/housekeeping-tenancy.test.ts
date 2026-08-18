import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";

// ★★ 요청별 테넌시(공유 게이트웨이)에서 부팅 하우스키핑을 돌리면 **매 tick 실패한다.**
//  이 스텝들은 "이 프로세스의 워크스페이스" 하나를 전제로 DB 를 만지는데, 요청 밖이라 컨텍스트가 없다.
//  실측: 시딩·로그 재니터·prune·위탁 스케줄러가 전부 42704 로 죽었다.
//  억지로 한 테넌트를 골라 돌리면 "누구의 것인지 모르는 정리 작업" 이 되므로, 아예 안 돌린다.

const src = readFileSync("src/boot/housekeeping.ts", "utf8");

test("★★ 요청별 테넌시면 DB 부팅 체인을 건너뛴다", () => {
  assert.match(src, /if \(requestScopedTenancy\(\)\) \{/, "차단 분기가 없다");
  const guard = src.indexOf("if (requestScopedTenancy()) {");
  const loop = src.indexOf("for (const step of DB_BOOT_STEPS)");
  assert.ok(guard > 0 && guard < loop, `차단이 체인보다 앞이어야 한다: ${guard} < ${loop}`);
});

test("★ 스케줄러 스텝도 같은 이유로 막힌다", () => {
  assert.match(src, /!schedulerEnabled\(\) \|\| requestScopedTenancy\(\)/);
});

// ★ 판정은 "rls 인데 고정 테넌트가 없다" — 고정 바인딩(테넌트당 게이트웨이)은 종전대로 돌아야 한다.
test("★ 고정 바인딩은 요청별이 아니다(종전 배포 무회귀)", () => {
  assert.match(src, /LIVELY_TENANT_BINDING[\s\S]{0,120}LIVELY_TENANT_ID/,
    "두 값을 함께 봐야 고정/요청별을 가른다");
});
