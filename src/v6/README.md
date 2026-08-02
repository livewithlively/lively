# src/v6/ — 캐노니컬 스토어 계층 (#1313 R49 명문화)

이 디렉터리의 관례를 여기 한 곳에 적는다. 새 파일을 만들기 전에 읽어라.

## 1. 'v6' 가 무슨 뜻인가

**현행 캐노니컬 데이터 접근 계층**이다. 버전 히스토리가 아니다 —
**`src/v5/` 는 존재한 적이 없고, v4 이하도 없다.** 스키마 세대명(v6 = 현행 `knowledge`/`project`/`task` 스키마)이
그대로 디렉터리 이름이 됐을 뿐이다. "언젠가 v7 으로 갈아탄다"는 계획도 없다 — 여기가 유일한 스토어 계층이다.

같은 이유로 **`-v6` 접미사는 새 파일에 붙이지 않는다.** `src/capabilities/*-v6.ts`(projects-v6·lists-v6·
task-detail-v6 …)와 MCP op 이름의 `_v6`(`project_get_v6` 등)는 **이미 외부에 노출된 표면**이라 그대로 유지하지만,
새로 만드는 capability·store 파일명에는 붙이지 마라. 접미사가 아무것도 구별해 주지 않는다(전부 v6 다).

## 2. 파일 구성

- **엔티티당 1파일.** `<엔티티>-store.ts` 가 그 엔티티의 DB 접근을 전부 소유한다
  (`knowledge-store.ts`·`project-store.ts`·`task-field-store.ts`·`team-store.ts` …).
- **테스트는 병치.** `x.ts` 의 테스트는 같은 디렉터리의 `x.test.ts` 다. 러너가 소스 글롭으로 자동 발견하므로
  **파일 생성만** 하면 된다(등록 불요 — `scripts/README.md` 테스트 계층 참조).
- **온톨로지 무관 store 는 도메인 접두 파일명을 쓴다.** 이 디렉터리에는 지식 온톨로지와 무관한 store 도 산다
  (대시보드 환경설정·사이드바 환경설정·즐겨찾기 …). 이름만으로 소관이 드러나야 한다:
  `dash-pref-store.ts` · `side-pref-store.ts` · `knowledge-view-config-store.ts`.
  일반명(`view-config-store.ts`)은 옆 파일과 충돌한다 — 실제로 `view-store.ts`(프로젝트 저장 뷰)와
  헷갈려 R49 에서 개명했다. **가능하면 REST 경로/테이블명과 같은 어휘를 파일명에 써라.**

## 3. 계층 규칙 (기계 검증됨 — `scripts/check-imports.mjs`)

v6 는 **가장 아래 계층**이다. 위로 올라가는 import 는 금지다:

| 금지 | 이유 |
|---|---|
| `src/v6/** → src/capabilities/**` | 스토어가 MCP/REST 표면을 알면 안 된다(R9). `rest-util.ts` 도 capabilities 소속이라 여기 포함 |
| `src/v6/** → src/http/**` | express 층 금지(R9). HTTP 에러가 필요하면 leaf 인 `src/http-error.ts` 를 쓴다 |
| `src/v6/schema/** → src/org/store**` | 스키마 init 은 org 설정을 읽지 않는다 — 직접 SELECT(R19c) |
| `src/db/**(self/ 제외) → src/v6/**` | 반대 방향도 금지. 범용 db_query 스택은 온톨로지를 몰라야 한다(R48) |

허용되는 아래 방향: `src/db/client.ts`(pool·`q`·`one`) · `src/v6/` 내부 · `src/http-error.ts` · 순수 유틸.

## 4. 쓰기 감사

콘텐츠 쓰기는 `content-audit.ts` 의 `auditOrgContent(...)` 로 `org_content_audit` 에 남긴다
(엔티티만 호출자가 지정 — 스토어마다 복붙하지 마라). 데이터 **접근**(db_query) 감사는 이 계층이 아니라
`src/db/access-log.ts` 소관이다.
