// registry 모드 스키마 초기화 자식(#1750 S1) — **소유자 자격 전용 엔트리.** 절대 import 하지 마라(top-level 실행).
//
// 부모(게이트웨이, 앱 role)는 DDL 권한이 없다 — 스키마는 소유자의 일이다. 부모의 housekeeping
//  'schemas' 스텝이 이 파일을 소유자 DSN(ITEMS_DATABASE_URL 로 치환) + 바인딩 env 제거 상태로 spawn 한다.
//  여기서 하는 일 셋, 순서 고정:
//   ① initAllSchemas — 종전 부팅과 같은 직렬 체인(item→org→…→ensureTenantColumn).
//   ② ensureSelfRls — self 소스 행 단위 공개범위(비치명, 종전과 동일 시맨틱).
//   ③ ensureTenantPolicies — ①이 만든 **신규 테이블**에 격리 정책을 보장한다. 이게 이 자식의 존재
//      이유 절반이다: 새 코어 릴리스가 테이블을 추가하면, 정책 없는 그 테이블은 전 워크스페이스에
//      보인다. 매 부팅 여기서 잡히므로 정책 없는 테이블은 한 요청도 서비스되기 전에 사라진다.
//      (③이 던지면 exit 1 → 부모 부팅 체인이 실패로 기록한다 — fail-closed.)
import { initAllSchemas } from "./schemas.js";
import { ensureSelfRls } from "../db/self-rls.js";
import { ensureTenantPolicies } from "../org/tenancy/activate.js";
import { itemsPool } from "../db/client.js";

try {
  await initAllSchemas();
  await ensureSelfRls().catch((err) => console.warn("[schema-child] self-rls 실패(비치명):", err instanceof Error ? err.message : err));
  const pol = await ensureTenantPolicies();
  console.log(`[schema-child] 격리 정책 보장 — 콘텐츠 테이블 ${pol.tables}개 · 신규 적용 ${pol.touched}개`);
  await itemsPool.end().catch(() => {});
  process.exit(0);
} catch (err) {
  console.error("[schema-child] 실패:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
