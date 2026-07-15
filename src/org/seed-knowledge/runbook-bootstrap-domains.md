---
name: bootstrap-domains
description: 최초 1회 — 임의 스택의 레포에서 비즈니스 도메인 taxonomy 추출 + 코드/데이터 매핑 + 도메인 부채 1패스. 스택 비종속(stack-agnostic). v2(cold-run 검증 반영).
trigger: on-demand (one-time bootstrap)
mode: interactive
requires_tools: [bash, read, grep, glob, ls]
inputs:
  repo_paths: ["<repo root>(들)"]
outputs: "DB via `node dist/domainmap/cli.js ingest` (호스트, context-ontology/ 에서). 감사·스냅샷·복구는 change_log."
guardrails:
  - 스택/경계를 가정하지 말 것 — Step 0 탐지 후 적응. "프레임워크 인식 = 깔끔한 모듈 경계"도 가정 금지(모듈 프리미티브 없는 스택 존재)
  - 순수 스크립트 결정성은 스택 무관 신호(디렉/매니페스트/확장자)에만. 스택별 신호 수집은 에이전트 적응 단계
  - 부채 주장은 구체 파일/모듈/엔티티명 인용 필수
  - 출력은 candidate — 사람 승인 전 확정 금지
  - 탐지 실패 시 디렉·파일명 폴백 + 저신뢰 명시(silent fail 금지)
---

## 원칙
도메인은 **비즈니스 기준**으로 정의하되 ground truth는 코드 + 데이터 모델이다. 특정 프레임워크를 가정하지 않는다(설치 조직의 임의 스택에서 동작해야 함). 외부 채팅/이슈 데이터는 입력이 아니다.
- **in-repo 설계문서 처리:** README·`docs/`·`architecture.md` 등 *코드 인접 문서*는 외부 chat과 다르다. ground truth로 *맹신하지 말되*, **도메인 가설로 채택해 코드로 검증**하라(흔히 최고 신호). 코드와 어긋나면 코드 우선 + 그 괴리를 부채로 기록.

## Step 0 — 스택 탐지 (에이전트, 필수 선행)
가정 없이 조사:
- **매니페스트:** package.json / requirements.txt / pyproject.toml / go.mod / pom.xml·build.gradle / Gemfile / composer.json / Cargo.toml / *.csproj …
- **언어 분포:** 지배적 확장자(find+카운트)
- **레포 형태:** 모노레포(workspaces, nx/turbo/lerna, go work, gradle) vs 폴리레포 vs 단일
- **`services[]` = 내부 독립 배포 단위만** (docker-compose 서비스, 별도 프로세스/데몬, 앱 디렉). **외부 SaaS 통합(S3, LLM API 등)은 `external_integrations[]`로 따로 나열** — services와 섞지 말 것.
- **데이터 모델 위치/형식:** ORM 스키마(Prisma/Django/SQLAlchemy/ActiveRecord/JPA/TypeORM/Ent) / SQL DDL·마이그레이션 / 또는 "없음". ⚠️ 개념이 엔티티 *밖*(타입·직렬화·컬럼·프롬프트 문자열)에만 살 수도 있음 — Step 4에서 추적.
- → detected = { languages, frameworks, repo_shape, services[], external_integrations[], data_model_kind+locations[] }
- **기존 상태 먼저 읽기(reconcile):** `node --env-file-if-exists=.env dist/domainmap/cli.js show <repo>` / `list-domains <repo>` 로 이미 등록된 도메인·매핑·`confirmed` 여부를 읽어 참고 (호스트, `context-ontology/` 디렉에서; 빌드 선행 `npm run build`) — 재실행은 새 제안만 추가하고 사람이 확정/편집한 건 건드리지 않는다.

## Step 1 — 구조 신호 수집 (스택 적응)
- **(a) 구조 단위(structural units)** — 스택의 자연 경계:
  - DI/MVC 서버: Nest `*.module.ts` · Django app · Flask/FastAPI 라우터 · Go 패키지 · Rails `app/{models,controllers}` · Spring 패키지
  - **프론트 메타프레임워크(Next.js App Router / Remix / SvelteKit 등): 모듈 프리미티브 *없음* → `route 폴더` + `components/<feature>/` + `lib/<subsystem>/` 3축을 *교차*로 경계 추정** (한 축만 믿지 말 것)
  - 그 외/불명확: top-level 소스 디렉 + 응집된 파일명 군집 폴백
- **(b) 데이터 모델** — 형식대로 엔티티/테이블명 추출. 없으면 "데이터 앵커 없음".
- **(c) API/엔트리** — 라우트·엔드포인트·CLI 커맨드(가능 시).
- → signals manifest.

## Step 2 — 도메인 taxonomy 제안 (LLM 판단)
신호를 비즈니스 도메인으로 클러스터(각 `id`·이름·1줄). cross-cutting/platform 분리.
- **타이브레이커:** 일반적으로 인프라인 관심사(LLM·검색·스토리지)라도 **이 제품의 핵심 능력이면 도메인**으로 둔다. 부수적 plumbing일 때만 cross-cutting. (예: AI 작곡 앱의 LLM = 도메인 / 로깅용 LLM = 인프라.) 같은 기술이 둘로 갈리면 *feature*와 *infra*를 분리 표기.

## Step 3 — 구조단위/엔티티 → 도메인 매핑
각 단위/엔티티를 1..N 도메인에 매핑. 매핑 표에 **`domains` 컬럼 + multi-domain이면 `⚠debt` 태그**. 미매핑 목록화.

## Step 4 — 도메인 부채 스캔 (근거 인용 필수)
- 흩어진 도메인 / 서비스 간 중복 엔티티 / 공유·모호 엔티티 / **god-unit** / 미매핑·데드
- **god-unit 기준(재현성):** 관계(relation) fan-out 과다 또는 필드가 N개(>3) 도메인에 걸침 → 후보.
- **개념적 부채(엔티티 밖):** 모델 선언만 보지 말고 **개념명으로 코드 전반 검색**(타입·직렬화·컬럼명·프롬프트). 레거시 개념은 엔티티가 아니라 타입/문자열에만 남는 경우가 많음.
- 각 항목 구체 파일·모듈·엔티티명 인용.

## Step 5 — DB에 기록 (문서 출력 아님)
신호+판단을 reconcile payload(JSON)로 구성해 **호스트에서 `context-ontology/` 디렉의 `node --env-file-if-exists=.env dist/domainmap/cli.js ingest < payload.json` 로 세션이 직접 DB에 기록**(별도 loader 없음). 엔진 코어(src/domainmap/core/reconcile.ts)가 비파괴 reconcile(사람 `confirmed` 보존, 불일치는 `drift`) + 모든 변경 `change_log` 스냅샷(복구 가능)을 강제.
- payload: `repo`(name, root_path=`/target`, detected_stack) · `domains`(+cross_cutting) · `code_units` · `data_entities`(name+source; 같은 이름 다른 source는 별 행) · `mappings`(target→domain_key) · `debts`(cited_refs).
- 사람은 이후 웹 UI에서 confirm/편집/merge/split → `change_log`에 actor=human으로 감사.

## 폴백 & 한계
- 프레임워크 미인식/비웹/라이브러리/스크립트성: 디렉+파일명 군집 + **저신뢰 명시.**
- 데이터 모델 부재: 코드 구조만으로 진행 + 표기.
- 구조 신호(이름·디렉·개념 검색) 기반. import 그래프 커플링·런타임은 phase 2.
- 출력은 제안. 자동 확정 금지.

## 검증 방법 (이 런북을 고칠 때)
**cold-run:** 맥락 0인 fresh 에이전트에 *이 런북만* 주고 안 본 레포에 돌려, (1) 작동 여부 + (2) 런북이 모호/overfit한 지점을 보고받는다. 서로 다른 스택 형태(모노레포·단일앱)에 cold-run 해 overfit 을 걸러낸다.