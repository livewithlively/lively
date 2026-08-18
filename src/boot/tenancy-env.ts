// 부팅 최초 env 재배선(#1750 S1) — **index.ts 의 첫 import 여야 한다.**
//
// 셀프호스트 다중 워크스페이스가 활성화돼 있으면(stateDir 의 tenancy/runtime.json), 이 프로세스의
//  DB 접속을 **앱 role(lvly_app)** 로 바꾼다. RLS 정책은 앱 role 에만 걸리므로(FORCE + TO lvly_app),
//  이 재배선이 없으면 게이트웨이가 소유자 role 로 붙어 **정책이 전혀 적용되지 않는다** — 가장 조용한 유출.
//
// 왜 여기(부수효과 모듈)인가: db/client.ts 는 leaf 라 모듈 로드 시점에 env 를 읽어 풀을 만든다.
//  그보다 먼저 env 를 바꿔야 하는데, ESM 은 import 순서대로 실행하므로 **index.ts 첫 줄 import** 가
//  정확히 그 자리다. (bootstrap-admin 등 별도 프로세스는 이 모듈을 import 하지 않아 소유자 접속을
//  유지한다 — 스키마·부트스트랩은 소유자의 일이다.)
//
// 원 소유자 DSN 은 LIVELY_OWNER_DATABASE_URL 로 보존한다 — 스키마 초기화 자식 프로세스(housekeeping
//  'schemas' 단계)가 이 값으로 소유자 접속을 되찾는다.
//
// 경로·파싱 규약은 org/tenancy/state.ts 가 단일 출처다 — 여기서는 그 모듈의 동기 읽기를 그대로 쓴다
//  (state.ts → ops/state-dir → log 까지 전부 DB 무관 leaf 라 이 시점 import 가 안전하다).
import { readTenancyRuntimeSync } from "../org/tenancy/state.js";

(() => {
  const rt = readTenancyRuntimeSync();
  if (!rt) return; // 상태파일 없음/파손 = 단일 워크스페이스(종전) — 아무것도 안 바꾼다
  if (!process.env.LIVELY_OWNER_DATABASE_URL) process.env.LIVELY_OWNER_DATABASE_URL = process.env.ITEMS_DATABASE_URL || "";
  process.env.ITEMS_DATABASE_URL = rt.app_dsn;
  // 바인딩은 요청별(rls)이되 고정 테넌트가 아니다 — LIVELY_TENANT_ID 는 두지 않는다(리졸버는 부팅이 주입).
  process.env.LIVELY_TENANT_BINDING = "rls";
  process.env.LIVELY_TENANCY_MODE = "registry";
})();
