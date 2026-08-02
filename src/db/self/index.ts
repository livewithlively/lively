// ══ db/self/ — 내장 'self' 소스 특화층 (#1313 R48) ══════════════════════════════════════════════
//
//  ⭐ 계약: **db/self/ 는 v6(visibility)를 알아도 된다. 범용 스택(firewall·policy·mask·sources)의
//     v6 무의존이 불변식이다.**
//
//  왜 이 경계를 굳이 디렉터리로 드러내나:
//   · db_query 스택은 **아무 고객 DB에나 붙는 범용 게이트**다 — SQL 파싱·테이블 allow/deny·컬럼 마스킹·
//     소스 레지스트리는 "여기가 우리 items DB 인지"를 몰라야 한다. 그걸 알기 시작하면 방화벽이 온톨로지
//     (프로젝트·리스트·지식의 공개범위)에 결합되고, 공개범위 모델이 바뀔 때마다 방화벽이 흔들린다.
//   · 반대로 self 소스는 **우리 콘텐츠를 우리 스키마로 읽는 창**이라 v6 를 모르면 아예 성립하지 않는다
//     (누가 무엇을 볼 수 있는가 = v6/visibility 술어 SoT). 그 앎을 이 디렉터리 안에 가둔다.
//   · 그래서 방향은 한쪽뿐이다: db/self/ → v6 는 허용, 범용 스택 → v6 는 금지.
//     범용 스택이 self 에서 가져가도 되는 건 **import 0 인 순수 상수 모듈(self-source.ts)** 뿐이다
//     (policy/sources 가 allow-list 를 시드할 때 쓴다 — 이 경로로는 v6 가 딸려오지 않는다).
//
//  ⚠ 기계가 지킨다: scripts/check-imports.mjs 의 금지 엣지 룰
//    "범용 db 스택(firewall·policy·mask·sources)의 v6 import 금지" 가 src/db/ 중 self/ 밖에서
//    src/v6/ 로 가는 정적 import 를 전부 실패시킨다. 주석은 설명이고, 게이트가 계약이다.
//
//  구성:
//   · self-source.ts — 내장 소스 이름·콘텐츠 테이블 allow-list(순수 상수, import 0). 범용 스택도 읽는다.
//   · self-rls.ts    — 행 단위 공개범위(RLS 롤·스코프 테이블·정책). v6 술어 SoT 의 **결과**만 심는다.
//   · self-guard.ts  — 열람 가드(방어선 0-b). RLS 미준비 배포의 v2 폴백(전면 차단 + 긴급 열람).
//
//  ⚠ 소비자 import 는 종전 경로 유지(배럴): src/db/self-source.ts · src/db/self-rls.ts ·
//   src/db/query-exec.ts(requireSelfSourceAllowed 재수출).
export * from "./self-source.js";
export * from "./self-rls.js";
export * from "./self-guard.js";
