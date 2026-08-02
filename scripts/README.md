# scripts/ — 운영·빌드 스크립트와 테스트 계층 안내

## 테스트 6계층 (#1313 R6 — 무엇이 어디서 도는가)

| 계층 | 무엇 | 실행 | 전제 |
|---|---|---|---|
| ① 유닛 체인 | `src/**/*.test.ts`(→dist) + `kit\|scripts\|deploy/**/*.test.mjs` — [run-tests.mjs](./run-tests.mjs) 가 **소스 글롭으로 자동 발견**(등록 불요) | `npm test` (빌드 포함) · 부분 실행 `node scripts/run-tests.mjs <부분문자열>` | 없음 (DB 불요) |
| ② itest | `scripts/*.itest.mjs` — 실 DB 필요한 통합(스키마 init·세션로그 CAS 등) | `npm run test:itest` · 개별 `node --env-file-if-exists=.env scripts/<x>.itest.mjs` | `ITEMS_DATABASE_URL` (.env) |
| ③ integration/ | [scripts/integration/](./integration/) — 실 PG·실 게이트웨이 대상 수동 e2e(각 파일 머리에 실행법 주석) | 파일별 수동 | 파일별 상이(PG·실행 중 게이트웨이·시크릿 키) |
| ④ vis-e2e/ | [scripts/vis-e2e/](./vis-e2e/) — 가시성 축·UI 배선 e2e(전용 README 있음) | `vis-e2e/README.md` 참조 | 실행 중 게이트웨이 |
| ⑤ pg-test | `src/**/*.pg-test.mjs` (현재 org/auth/device-auth.pg-test.mjs) — **CI 전용** 실 Postgres 통합 | CI(test.yml)가 pgvector 서비스로 실행 · 로컬은 `ITEMS_DATABASE_URL=… node src/org/auth/device-auth.pg-test.mjs` | 실 PG |
| ⑥ 훅 bash | [kit/hooks/test-hooks.sh](../kit/hooks/test-hooks.sh) — 훅 셸 경로 러너 | `kit/hooks/test-hooks.sh` | 없음 |

- ①이 기본 안전망이다 — 테스트 추가는 **파일 생성만**(package.json 등록 금지, 러너가 자동 발견).
- `*.itest.mjs`·`*.pg-test.mjs` 는 러너 기본 수집에서 제외된다(러너 헤더 주석 참조).

## 주요 스크립트
- `run-tests.mjs` — 유닛 체인 러너(위 ①·②)
- `build-node-agent.mjs` — 워커 노드 에이전트 esbuild 번들
- `restart-gateway.sh` — 라이브 박스 게이트웨이 빌드·재기동(빌드 성공 시에만 재시작)
- `check-css-drops.mjs` — CSS 셀렉터 유실 가드(#317)
- `register-*.mjs|sh` — 클라이언트/훅 등록 일회 도구
- `seed-notion-fixture.mjs` — 커넥터 픽스처 시드
- `archive/` — 완료된 일회성 백필·마이그레이션(이슈번호 접두) 보관. **새 일회성 스크립트는 완료 후 여기로.**
