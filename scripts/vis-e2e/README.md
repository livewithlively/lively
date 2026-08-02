# 맥락 가시성(#1291) 실 e2e — REST·MCP 이중 표면

가시성의 요구는 하나다: **사람과 그 사람의 AI 에 동시에 적용된다.** 웹 화면은 REST 를, AI 는 MCP 를 쓰므로
**같은 신원으로 두 표면을 나란히 때려 같은 답이 나오는지**를 봐야 그 요구가 검증된다.
유닛(`src/v6/visibility.test.ts`)과 SQL 통합(`src/v6/visibility.pg-test.mjs`)은 술어만 본다 —
실제로 잠긴 태스크가 응답에 실려 나가던 누수는 **이 e2e 만이** 잡았다.

## 어디서 도나
`pilot-box` EC2(우리 테스트 박스). dev 맥미니를 경유해 접속한다:

```sh
# dev 맥미니의 AWS 는 [default] 가 SSO 라 비대화식에서 못 쓴다 → 정적 키를 env 로 올려 덮는다.
ssh lively@localhost
. ~/.lively-awsenv.sh                      # AWS_ACCESS_KEY_ID/SECRET 를 ~/.aws/credentials 에서 읽어 export
aws ec2 describe-instances --filters Name=tag:Name,Values=pilot-box \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text
ssh -i ~/.ssh/pilot-box ubuntu@<그 IP>
```

## 절차
1. `boot.sh` — 격리 DB 2개(`vis_e2e`, `vis_e2e_dm`)를 만들고, 운영 `.env` 를 상속하되 **DB·포트(8099)·공유경로만 덮어** 이 브랜치 게이트웨이를 띄운다. 라이브(:8080)와 라이브 DB 는 건드리지 않는다.
2. `cycle.sh` — 재기동 + 시드 + 실행. 반복 검증은 이것만 쓰면 된다.
3. 기준선: `run.mjs` 34 · `run-v2.mjs` 30 · `run-ui-wire.mjs` 8 · `src/v6/visibility.pg-test.mjs` 30, 전부 0 failed.

## 세 스크립트가 각각 보는 것
- `run.mjs` — v1: **비대상은 못 본다**(목록·상세·검색·태스크·파일·세션·타임라인을 REST·MCP 양쪽에서).
- `run-v2.mjs` — v2: **admin 도 내용은 못 본다**, 대신 메타데이터는 보이고 사유를 적은 긴급 열람이 한시적으로 연다. 끝에 **휴지통**(지우면 열리지 않는가 · 복원이 잠금을 풀지 않는가)이 붙는다 — 시드 상태를 바꾸므로 항상 마지막이다.
- `run-ui-wire.mjs` — 화면이 부르는 경로가 **실제로 서빙되는지**. 코드에 라우트를 등록한 것과 그 프로세스가 그 경로에 응답하는 것은 다른 일이라, 브라우저 없이 확인할 수 있는 가장 실질적인 화면 검증이다. (공유폴더 공개범위 모달의 배지/모달 두 모드, 프로젝트 폴더의 `settable=false`, 팀 지정, 긴급열람 이력.)

## 함정 (여기서 실제로 겪은 것)
- **`pkill -f` 로 게이트웨이를 죽이지 마라.** 실제 커맨드라인과 패턴이 어긋나면 조용히 실패하고, 옛 프로세스가 포트를 계속 물어 새 프로세스는 EADDRINUSE 로 죽는다 → **옛 코드로 테스트하면서 통과했다고 믿게 된다.** `cycle.sh` 는 포트 소유자를 찾아 죽이고, 응답하는 pid 가 방금 띄운 pid 인지 확인한다.
- **배선 단언을 먼저 넣어라.** 토큰이 401 이면 "차단됨" 단언이 전부 통과한다(공허한 테스트). `run.mjs` 는 `/api/ui/me` 로 세 토큰이 살아있는지, 비대상도 공개 프로젝트를 실제로 받는지부터 확인한다.
- **정적 토큰(`AUTH_TOKENS_JSON`)으로 admin 을 못 만든다** — 로드 시 admin/runtime 이 의도적으로 제거된다(회수 불가라서). 그래서 `seed.mjs` 가 `auth_token` 에 DB 토큰을 직접 발급한다(실효 권한 = 토큰 ∩ 멤버라 멤버 scope 도 함께 넣는다).
- 릴리스 번들에는 `mysql2` 가 없다. 이 검증은 mysql 소스를 안 쓰므로 "쓰이면 즉시 실패"하는 스텁으로 대체한다(조용히 넘어가는 것보다 낫다).
- 공유 워크스페이스는 운영 유저 소유라 `ubuntu` 가 못 쓴다 → e2e 전용 경로로 돌린다(코드 문제 아님).

## 정리
```sh
kill $(sudo ss -ltnp | awk '/:8099 /{match($0,/pid=([0-9]+)/,m); print m[1]}')
sudo docker exec context-ontology-items-db-1 psql -U lively -d postgres \
  -c 'DROP DATABASE IF EXISTS vis_e2e' -c 'DROP DATABASE IF EXISTS vis_e2e_dm'
rm -rf ~/vis-e2e
```

## 새 게이트를 넣었으면 red 를 한 번 봐라
휴지통 게이트는 **스토어가 돌려주지도 않는 필드로 판정**해 완전한 no-op 이었는데, 유닛·격리 리뷰 1라운드·e2e 3종을 전부 통과했다. 아무도 그 경로를 때려보지 않았기 때문이다. 통과하는 테스트는 그 자체로는 아무것도 증명하지 않는다 — 컴파일된 게이트를 잠시 무력화해 **빨간불을 눈으로 본 뒤** 원복한다:

```sh
node -e 'const fs=require("fs"),p="dist/capabilities/trash.js";let s=fs.readFileSync(p,"utf8");
  s=s.replace("async function filterVisibleDeleted(entries, viewer) {", "$&\n    return entries;");
  fs.writeFileSync(p,s)'
# 재기동 → run-v2.mjs → 해당 단언이 FAIL 나는지 확인 → dist 원복 후 재기동
```
