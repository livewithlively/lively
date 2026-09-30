#!/usr/bin/env bash
# #1291 e2e — 재기동 + 시드 + 실행을 한 번에. 각 단계 종료코드를 찍어 어디서 죽었는지 보이게 한다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=port.sh
. "$HERE/port.sh"
CT="${VIS_E2E_DB_CONTAINER:-lively-items-db-1}"   # boot.sh 와 같은 기본값
WORK="${VIS_E2E_WORK:-$HOME/vis-e2e}"
cd "$WORK" || exit 1

# 공유 워크스페이스는 운영 유저(lively) 소유라 ubuntu 가 못 쓴다 — e2e 전용 경로로 돌린다(코드 문제 아님).
mkdir -p "$WORK/shared"
grep -vE '^(TERMINAL_ROOT_SHARED|LIVELY_SHARED_DIR)=' .env > .env.tmp && mv .env.tmp .env
{ echo "TERMINAL_ROOT_SHARED=$WORK/shared"; echo "LIVELY_SHARED_DIR=$WORK/shared"; } >> .env
chmod 600 .env

# 포트 소유자를 직접 찾아 죽이고, 놓였는지 확인한 뒤에만 띄운다(이름 패턴 금지 — port.sh 머리말).
stop_port_owner 8099 || exit 1
nohup node --env-file="$WORK/.env" dist/index.js > gw.log 2>&1 &
GW=$!
for i in $(seq 1 45); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8099/healthz)" = "200" ] && break
  sleep 1
done
echo "게이트웨이 pid=$GW · healthz=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8099/healthz)"
# 지금 응답하는 프로세스가 방금 띄운 그 프로세스인지 확인한다(옛 프로세스가 계속 서빙하는 착각 방지).
SERVING=$(port_owner 8099)
[ "$SERVING" = "$GW" ] && echo "서빙 프로세스 = 방금 띄운 것($GW)" || { echo "⚠ 서빙=$SERVING, 기동=$GW — 옛 프로세스가 응답 중"; exit 1; }
echo "배포된 게이트 수=$(grep -c assertTaskVisible dist/capabilities/task-detail-v6.js)"

sudo docker exec "$CT" psql -U lively -d vis_e2e \
  -c "TRUNCATE project, project_list, project_folder, project_list_member, project_folder_member, org_member, auth_token CASCADE" >/dev/null 2>&1
# 레포의 시드·실행 스크립트를 작업 디렉터리로 복사해 돌린다 — `import pg` 가 WORK 의 node_modules 에서 풀려야 한다.
#  (종전엔 박스에만 있는 사본 vis-e2e-seed.mjs·vis-e2e-run.mjs 와 ~/.vis_e2e_url 을 불러, 레포 수정이 반영되지 않았다.)
cp "$HERE"/seed.mjs "$HERE"/run*.mjs "$WORK/"
DB_URL="$(grep -m1 -E '^ITEMS_DATABASE_URL=' .env | cut -d= -f2-)"
SEED="$(ITEMS_DATABASE_URL="$DB_URL" node seed.mjs 2>&1 | tail -1)"
echo "seed=$?"
for r in ${VIS_E2E_RUNS:-run.mjs}; do   # 예: VIS_E2E_RUNS="run.mjs run-v2.mjs run-ui-wire.mjs"
  SEED="$SEED" node "$r"
  echo "$r exit=$?"
done
