# scripts/ — 운영·빌드 스크립트와 테스트 계층 안내

## 테스트 6계층 (#1313 R6 — 무엇이 어디서 도는가)

| 계층 | 무엇 | 실행 | 전제 |
|---|---|---|---|
| ① 유닛 체인 | `src/**/*.test.ts`(→dist) + `kit\|scripts\|deploy/**/*.test.mjs` — [run-tests.mjs](./run-tests.mjs) 가 **소스 글롭으로 자동 발견**(등록 불요) | `npm test` (빌드 포함 · **병렬·실패해도 끝까지** → [실행 정책](#러너-실행-정책-1431--끝까지--병렬)) · 부분 실행 `node scripts/run-tests.mjs <부분문자열>` | 없음 (DB 불요) |
| ② itest | `scripts/*.itest.mjs` — 실 DB 필요한 통합(스키마 init·세션로그 CAS 등) | `npm run test:itest` · 개별 `node --env-file-if-exists=.env scripts/<x>.itest.mjs` | `ITEMS_DATABASE_URL` (.env) |
| ③ integration/ | [scripts/integration/](./integration/) — 실 PG·실 게이트웨이 대상 수동 e2e(각 파일 머리에 실행법 주석) | 파일별 수동 | 파일별 상이(PG·실행 중 게이트웨이·시크릿 키) |
| ④ vis-e2e/ | [scripts/vis-e2e/](./vis-e2e/) — 가시성 축·UI 배선 e2e(전용 README 있음) | `vis-e2e/README.md` 참조 | 실행 중 게이트웨이 |
| ⑤ pg-test | `src/**/*.pg-test.mjs` (현재 org/auth/device-auth.pg-test.mjs) — **CI 전용** 실 Postgres 통합 | CI(test.yml)가 pgvector 서비스로 실행 · 로컬은 `ITEMS_DATABASE_URL=… node src/org/auth/device-auth.pg-test.mjs` | 실 PG |
| ⑥ 훅 bash | [kit/hooks/test-hooks.sh](../kit/hooks/test-hooks.sh) — 훅 셸 경로 러너 | `kit/hooks/test-hooks.sh` | 없음 |

- ①이 기본 안전망이다 — 테스트 추가는 **파일 생성만**(package.json 등록 금지, 러너가 자동 발견).
- `*.itest.mjs`·`*.pg-test.mjs` 는 러너 기본 수집에서 제외된다(러너 헤더 주석 참조).

### 러너 실행 정책 (#1431 — 끝까지 · 병렬)
종전 러너는 **직렬 + 첫 실패에서 즉시 중단**이라, 실패 1건이 뒤쪽 100여 건을 가리고 10코어에서 1코어만 썼다. 이제:

- **끝까지 실행이 기본** — 실패해도 남은 파일을 계속 돌리고 끝에 실패 목록을 한 번에 모아 보고한다. 종료코드는 종전처럼 **첫 실패의 exit code** 를 전파.
- **병렬이 기본** — 기본 `-j min(코어수, 8)`. 이 계층이 병렬 안전한 근거: 파일 하나 = 프로세스 하나 · 실 DB 무사용 · temp 는 전부 `mkdtemp` · 포트는 `listen(0)` · HOME 은 샌드박스(가드: `src/ops/state-dir.test.ts`, `kit/cli/bootstrap-node-gate.test.mjs`).
- **빌드도 러너가 돈다** — `npm test` = `node scripts/run-tests.mjs --build`. 종전 `npm run build && …` 는 `&&` 라서 웹 tsc 타입오류 하나가 노드 테스트 160건을 통째로 가렸다. 이제 빌드 실패를 기억해두고 돌 수 있는 테스트는 돌린 뒤 둘 다 보고한다(종료코드엔 반영).
- 빌드 산출물 누락도 같은 원칙 — 누락분만 실패로 기록하고 나머지는 돌린다(조용히 건너뛰지 않는다).

| 옵션 | 뜻 |
|---|---|
| `<부분문자열>…` | 경로 부분일치만(여러 개면 OR). **0건 매치는 실패**(exit 1) — 오타가 거짓 green 이 되지 않게 |
| `-j N` / `--jobs=N` | 동시 실행수. `-j 1` 은 자식 출력을 그대로 흘린다(한 건 디버깅) |
| `--fail-fast` | 첫 실패에서 중단(종전 기본 동작) |
| `--verbose` | 통과한 파일의 출력도 전부 표시(병렬 모드는 기본이 한 줄 요약) |
| `--slowest[=N]` | 끝에 느린 파일 N건(기본 10) — 병렬 wall 의 하한은 **최장 1건**이라 이걸로 범인을 찾는다 |
| `--list` / `--itest` / `--build` | 발견 목록만 / ②계층(실 DB — 직렬 고정) / 빌드까지 러너가 실행 |
| `--scope=kit,desktop` | 지정 면의 `*.test.mjs` 만 수집(src→dist 매핑 생략). **윈도우 CI 가 이걸로 공통 러너를 쓴다** — 그 잡은 `npm ci`·빌드를 안 하므로 dist 를 수집하면 전부 '산출물 없음'이 된다 |
| `--budget=N` | 유닛 파일당 상한(초). 넘으면 **통과해도 실패**. 기본은 끔 — CI 리눅스 잡이 `--budget=45` 로 켠다 |

### 파일당 시간 예산 (#2457 — 2026-08-31)

유닛 파일 하나가 상한을 넘으면 통과해도 실패다. **넘는다는 건 그 파일이 유닛이 아니거나(→ `*.itest.mjs` 로 옮겨라) 무언가를 기다린다는 뜻**이고, 후자가 실제 사고였다:

> DB 주소(`ITEMS_DATABASE_URL`)가 없으면 pg 는 **libpq 기본값 localhost:5432** 로 붙는다. CI 유닛 잡에는 그 env 가 없는데 `services.postgres` 가 5432 에 살아 있어, DB 를 쓰지 않는 유닛 6건이 **파일당 60초씩** 대기했다(유닛 CPU 604초의 60%). 맥에는 DB 가 없어 즉시 ECONNREFUSED → 같은 6건이 1.8초. **실행 시간이 그 기계 포트 상태의 함수**였던 것이다.
> 넉 달간 아무도 몰랐던 이유는 단순하다 — **아무도 재고 있지 않았다.** 지금은 `src/db/client.ts` 가 주소 없으면 접속을 시도하지 않고(`src/db/no-db-socket.test.ts` 가 고정), 이 예산이 재발을 당일 잡는다.

**실측(2026-08-03, 10코어 · 160건):** 직렬 121s → `-j 8` 42s. 그때 wall 을 잡고 있던 건 `kit/cli/project-status.test.mjs` 한 건(36.5s = 전체 30%)이었고, 원인은 `lively status` 의 harness 프로브가 **실제 `claude mcp list`** 를 부르던 것(스텁 bin 으로 가려 1.6s). 유닛 테스트가 사람의 로컬 MCP 설정에 시간을 의존하면 안 된다 — CLI 를 띄우는 테스트는 `kit/cli/lively.test.mjs` 의 `newHome` 처럼 **스텁 bin 을 PATH 앞에** 둘 것.

## 주요 스크립트
- `run-tests.mjs` — 유닛 체인 러너(위 ①·②). 병렬·끝까지 실행 + `--build` — 옵션은 위 [실행 정책](#러너-실행-정책-1431--끝까지--병렬)
- `build-node-agent.mjs` — 워커 노드 에이전트 esbuild 번들
- `restart-gateway.sh` — 라이브 박스 게이트웨이 빌드·재기동(빌드 성공 시에만 재시작)
- `restage.sh` — `stage` 브랜치 재조립(main 을 새 바닥으로 깔고 얹혀 있던 브랜치 재머지). **손으로 `reset --hard` 하지 말 것** — PR 없는 브랜치·stage 직접 커밋이 조용히 사라진다. 이 스크립트는 그걸 검사해 막고, 백업 태그를 남긴다
- `check-css-drops.mjs` — CSS 셀렉터 유실 가드(#317)
- `register-*.mjs|sh` — 클라이언트/훅 등록 일회 도구
- `seed-notion-fixture.mjs` — 커넥터 픽스처 시드
- `archive/` — 완료된 일회성 백필·마이그레이션(이슈번호 접두) 보관. **새 일회성 스크립트는 완료 후 여기로.**
