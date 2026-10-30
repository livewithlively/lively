// 커넥터 서브프로세스(run-sync·run-push·run-wiki-push)에게 넘길 환경 — 순수 조립부.
//
//  왜 분리하나: 이 규칙을 **아웃바운드 CLI 두 개가 안 쓰고 있었다**(2026-09-21 실측). 인바운드는
//   run-tracker 의 childEnv 로 테넌트 바인딩을 명시해 자식을 띄우는데, 아웃바운드(connector_push·wiki_push)는
//   `execFile(...)` 로 부모 환경을 그대로 상속시켜 띄운다. 바인딩이 켜진 배포에서는 자식의 모든 쿼리가
//   `app.tenant_id` 없이 나가 정책에서 실패한다 — 실측 증상:
//     · run-wiki-push: `unrecognized configuration parameter "app.tenant_id"` (42704)
//     · run-push(clickup): 같은 DB 실패를 config 해소가 삼켜 **「CLICKUP_API_TOKEN 미설정」으로 오도**됨
//       → 두 달 넘게 "토큰 문제"로 보였다.
//  조립 규칙을 한 곳에 두고 세 CLI 가 같이 쓰면 이 비대칭이 다시 생기지 않는다.
import type { TenantBinding } from "./child-env-types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 자식 환경을 조립한다. 부모 환경 객체는 **변형하지 않는다**(호출부가 process.env 를 그대로 넘긴다).
 *
 * - 바인딩 비활성(자가호스팅 단일 워크스페이스) → 부모 환경 그대로. 새 변수를 더하지 않는다(종전 동작 보존).
 * - 바인딩 활성 + 유효한 테넌트 id → `LIVELY_SKIP_SCHEMA_INIT`(스키마 소유 아님) +
 *   `LIVELY_TENANT_BINDING=rls` + `LIVELY_TENANT_ID` 를 실어 **부모와 같은 워크스페이스**에 못 박는다.
 * - 바인딩 활성인데 id 가 없거나 형식이 틀리면 → 바인딩 변수를 싣지 않고 `warn` 을 돌려준다.
 *   🔴 임의의 테넌트를 고르지 않는다 — 남의 워크스페이스에 쓰는 것보다 자식이 정책에서 실패하는 편이 낫다.
 *   (`LIVELY_SKIP_SCHEMA_INIT` 은 그래도 싣는다: 앱 role 로는 DDL 권한이 없어 부팅 스키마 초기화가 죽는다.)
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  binding: TenantBinding,
): { env: NodeJS.ProcessEnv; warn?: string } {
  // 복사해서 돌려준다 — 부모 객체(process.env)를 그대로 넘기면 호출부가 그걸 mutate 하는 순간
  //  게이트웨이 자신의 환경이 오염된다. 종전 동작과 의미는 같고(추가 변수 0), env 크기상 비용은 무시 가능하다.
  if (!binding.active) return { env: { ...parentEnv } };
  const env: NodeJS.ProcessEnv = { ...parentEnv, LIVELY_SKIP_SCHEMA_INIT: "1" };
  const id = binding.tenantId ?? "";
  if (!UUID_RE.test(id)) {
    // 🔴 부모 환경에 남아 있던 바인딩 변수를 **지운다.** 안 지우면 spread 로 그대로 새어, 자식이 옛 값으로
    //  자가 설치(db/client.ts 의 고정 모드)해 **부모가 지금 걸 값과 다른 워크스페이스**에 쓸 수 있다.
    //  경고가 "넘기지 못했다"고 말하는데 실제로는 넘어가는 모순도 함께 없앤다.
    delete env.LIVELY_TENANT_BINDING;
    delete env.LIVELY_TENANT_ID;
    // 원인을 뭉개지 않는다 — 컨텍스트가 없는 것과 값이 깨진 것은 다른 사고다.
    const why = id === ""
      ? "컨텍스트 밖에서 실행이 시작됐습니다(테넌트 id 없음)"
      : "부모의 테넌트 id 형식이 올바르지 않습니다";
    return { env, warn: `자식에 테넌트 바인딩을 넘기지 못했습니다 — ${why}` };
  }
  env.LIVELY_TENANT_BINDING = "rls";
  env.LIVELY_TENANT_ID = id;
  return { env };
}
