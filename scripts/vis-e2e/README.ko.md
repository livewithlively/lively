# 맥락 가시성(#1291) 실 e2e — REST·MCP 이중 표면

*[English](README.md)*

가시성의 요구는 하나다: **사람과 그 사람의 AI 에 동시에 적용된다.** 웹 화면은 REST 를, AI 는 MCP 를 쓰므로
**같은 신원으로 두 표면을 나란히 때려 같은 답이 나오는지**를 봐야 그 요구가 검증된다.
유닛(`src/v6/visibility.test.ts`)과 SQL 통합(`src/v6/visibility.pg-test.mjs`)은 술어만 본다 —
실제로 잠긴 태스크가 응답에 실려 나가던 누수는 **이 e2e 만이** 잡았다.

## 무엇이 필요한가
Lively 가 설치돼 도는 리눅스 호스트 하나 — items-db 컨테이너와 게이트웨이 앱 디렉터리의 `.env` 가 있어야 한다(`boot.sh` 가 그 `.env` 를 상속한다).
그리고 검증할 브랜치의 빌드(`dist/` + `npm ci` 한 `node_modules/`)를 둔 작업 디렉터리. `sudo` 로 `docker`·`ss` 를 부를 수 있어야 한다.
호스트마다 다른 값은 env 로 준다(기본값은 `boot.sh` 머리):

| env | 뜻 |
|---|---|
| `VIS_E2E_DB_CONTAINER` | items-db 컨테이너 이름 |
| `VIS_E2E_APP_DIR` | 운영 `.env` 가 있는 게이트웨이 앱 디렉터리 |
| `VIS_E2E_WORK` | 이 브랜치 빌드가 있는 작업 디렉터리 |
| `VIS_E2E_RUNS` | `cycle.sh` 가 돌릴 스크립트(공백 구분, 기본 `run.mjs`) |

## 절차
1. `boot.sh` — 격리 DB(`vis_e2e`)를 만들고, 운영 `.env` 를 상속하되 **DB·포트(8099)·토큰·스케줄러만 덮어**(공유경로는 `cycle.sh` 가 덮는다) 이 브랜치 게이트웨이를 띄운다. 라이브(:8080)와 라이브 DB 는 건드리지 않는다.
2. `cycle.sh` — 재기동 + 시드 + 실행. 반복 검증은 이것만 쓰면 된다. 레포의 `seed.mjs`·`run*.mjs` 를 작업 디렉터리로 복사해 돌린다(`import pg` 가 그 `node_modules` 에서 풀려야 해서).
3. 기준선: `run.mjs` 34 · `run-v2.mjs` 30 · `run-ui-wire.mjs` 8 · `src/v6/visibility.pg-test.mjs` 30, 전부 0 failed.

## 각 스크립트가 보는 것
- `run.mjs` — v1: **비대상은 못 본다**(목록·상세·검색·태스크·파일·세션·타임라인을 REST·MCP 양쪽에서).
- `run-v2.mjs` — v2: **admin 도 내용은 못 본다**, 대신 메타데이터는 보이고 사유를 적은 긴급 열람이 한시적으로 연다. 끝에 **휴지통**(지우면 열리지 않는가 · 복원이 잠금을 풀지 않는가)이 붙는다 — 시드 상태를 바꾸므로 항상 마지막이다.
- `run-ui-wire.mjs` — 화면이 부르는 경로가 **실제로 서빙되는지**. 코드에 라우트를 등록한 것과 그 프로세스가 그 경로에 응답하는 것은 다른 일이라, 브라우저 없이 확인할 수 있는 가장 실질적인 화면 검증이다. (공유폴더 공개범위 모달의 배지/모달 두 모드, 프로젝트 폴더의 `settable=false`, 팀 지정, 긴급열람 이력.)
- `run-v3.mjs` — v3: self 소스가 **행 단위**로 걸리는지(v2 는 잠긴 게 하나라도 있으면 self 를 통째로 닫았다). 잠겨 있어도 self 는 열려 있고, 잠긴 행은 결과에 안 나오며, 비대상과 대상이 같은 SQL 에 다른 답을 받고, 소유자 권한으로 새어 나오지 않는지.
- `run-v4.mjs` — v4: 커넥터별 자료 공개범위 정책과 증류 지식의 상속. 대상 없는 잠금은 거절 · 채널 규칙이 커넥터 규칙을 이긴다 · 백필이 과거분을 실제로 맞춘다 · 증류 지식이 원본 대상을 물려받는다(cites 는 안 물려받는다) · 비-admin 은 정책을 못 만진다.
- `run-axes.mjs` — 축 토글: 유형별 켜기/끄기가 **실제로 강제를 걷는지**(끄면 종전처럼 전원 공개, 켜면 다시 잠긴다)를 실제 응답으로 왕복 확인한다. 조직 단위 상태를 바꾸므로 항상 원상복구하고 끝낸다.

## 함정 (여기서 실제로 겪은 것)
- **`pkill -f` 로 게이트웨이를 죽이지 마라.** 실제 커맨드라인과 패턴이 어긋나면 조용히 실패하고, 옛 프로세스가 포트를 계속 물어 새 프로세스는 EADDRINUSE 로 죽는다 → **옛 코드로 테스트하면서 통과했다고 믿게 된다.** `boot.sh`·`cycle.sh` 는 `port.sh` 로 포트 소유자를 찾아 멈추고, `cycle.sh` 는 응답하는 pid 가 방금 띄운 pid 인지 확인한다.
- **배선 단언을 먼저 넣어라.** 토큰이 401 이면 "차단됨" 단언이 전부 통과한다(공허한 테스트). `run.mjs` 는 `/api/ui/me` 로 세 토큰이 살아있는지, 비대상도 공개 프로젝트를 실제로 받는지부터 확인한다.
- **정적 토큰(`AUTH_TOKENS_JSON`)으로 admin 을 못 만든다** — 로드 시 admin/runtime 이 의도적으로 제거된다(회수 불가라서). 그래서 `seed.mjs` 가 `auth_token` 에 DB 토큰을 직접 발급한다(실효 권한 = 토큰 ∩ 멤버라 멤버 scope 도 함께 넣는다).
- 릴리스 번들에는 `mysql2` 가 없다. 이 검증은 mysql 소스를 안 쓰므로 "쓰이면 즉시 실패"하는 스텁으로 대체한다(조용히 넘어가는 것보다 낫다).
- 공유 워크스페이스는 운영 유저 소유라 e2e 를 돌리는 유저가 못 쓴다 → e2e 전용 경로로 돌린다(코드 문제 아님).

## 정리
```sh
. scripts/vis-e2e/port.sh && stop_port_owner 8099
sudo docker exec "$VIS_E2E_DB_CONTAINER" psql -U lively -d postgres -c 'DROP DATABASE IF EXISTS vis_e2e'
rm -rf "$VIS_E2E_WORK"
```

## 새 게이트를 넣었으면 red 를 한 번 봐라
휴지통 게이트는 **스토어가 돌려주지도 않는 필드로 판정**해 완전한 no-op 이었는데, 유닛·격리 리뷰 1라운드·e2e 3종을 전부 통과했다. 아무도 그 경로를 때려보지 않았기 때문이다. 통과하는 테스트는 그 자체로는 아무것도 증명하지 않는다 — 컴파일된 게이트를 잠시 무력화해 **빨간불을 눈으로 본 뒤** 원복한다:

```sh
node -e 'const fs=require("fs"),p="dist/capabilities/trash.js";let s=fs.readFileSync(p,"utf8");
  s=s.replace("async function filterVisibleDeleted(entries, viewer) {", "$&\n    return entries;");
  fs.writeFileSync(p,s)'
# 재기동 → run-v2.mjs → 해당 단언이 FAIL 나는지 확인 → dist 원복 후 재기동
```
