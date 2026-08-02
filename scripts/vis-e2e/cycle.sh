#!/usr/bin/env bash
# #1291 e2e — 재기동 + 시드 + 실행을 한 번에. 각 단계 종료코드를 찍어 어디서 죽었는지 보이게 한다.
set -uo pipefail
cd "$HOME/vis-e2e"

# 공유 워크스페이스는 운영 유저(lively) 소유라 ubuntu 가 못 쓴다 — e2e 전용 경로로 돌린다(코드 문제 아님).
mkdir -p "$HOME/vis-e2e/shared"
grep -vE '^(TERMINAL_ROOT_SHARED|LIVELY_SHARED_DIR)=' .env > .env.tmp && mv .env.tmp .env
{ echo "TERMINAL_ROOT_SHARED=$HOME/vis-e2e/shared"; echo "LIVELY_SHARED_DIR=$HOME/vis-e2e/shared"; } >> .env
chmod 600 .env

# ⚠ 이름 패턴(pkill -f)으로 죽이면 실제 커맨드라인과 안 맞아 조용히 실패한다 —
#  그러면 옛 프로세스가 포트를 계속 물고 새 프로세스는 EADDRINUSE 로 죽어, **옛 코드로 테스트하게 된다**(실제로 그랬다).
#  포트 소유자를 직접 찾아 죽이고, 놓였는지 확인한 뒤에만 띄운다.
OLD=$(sudo ss -ltnp 2>/dev/null | awk '/:8099 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)
if [ -n "${OLD:-}" ]; then kill "$OLD" 2>/dev/null; for i in $(seq 1 15); do sudo ss -ltn 2>/dev/null | grep -q ":8099 " || break; sleep 1; done; fi
if sudo ss -ltn 2>/dev/null | grep -q ":8099 "; then echo "포트 8099 가 안 놓임 — 중단"; exit 1; fi
nohup node --env-file="$HOME/vis-e2e/.env" dist/index.js > gw.log 2>&1 &
GW=$!
for i in $(seq 1 45); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8099/healthz)" = "200" ] && break
  sleep 1
done
echo "게이트웨이 pid=$GW · healthz=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8099/healthz)"
# 지금 응답하는 프로세스가 방금 띄운 그 프로세스인지 확인한다(옛 프로세스가 계속 서빙하는 착각 방지).
SERVING=$(sudo ss -ltnp 2>/dev/null | awk '/:8099 /{match($0,/pid=([0-9]+)/,m); print m[1]}' | head -1)
[ "$SERVING" = "$GW" ] && echo "서빙 프로세스 = 방금 띄운 것($GW)" || { echo "⚠ 서빙=$SERVING, 기동=$GW — 옛 프로세스가 응답 중"; exit 1; }
echo "배포된 게이트 수=$(grep -c assertTaskVisible dist/capabilities/task-detail-v6.js)"

sudo docker exec context-ontology-items-db-1 psql -U lively -d vis_e2e \
  -c "TRUNCATE project, project_list, project_folder, project_list_member, project_folder_member, org_member, auth_token CASCADE" >/dev/null 2>&1
SEED="$(ITEMS_DATABASE_URL="$(cat "$HOME/.vis_e2e_url")" node vis-e2e-seed.mjs 2>&1 | tail -1)"
echo "seed=$?"
SEED="$SEED" node vis-e2e-run.mjs
echo "e2e exit=$?"
