#!/usr/bin/env bash
# #1291 가시성 e2e — 격리 DB 위에 이 브랜치 게이트웨이를 띄운다.
#  라이브(:8080)와 라이브 DB 는 건드리지 않는다: 별도 DB 1개(vis_e2e) + 별도 포트 + 스케줄러/커넥터 off.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=port.sh
. "$HERE/port.sh"
# 호스트마다 다른 값은 env 로 덮는다(기본값 = deploy/install.sh 로 /opt/lively 에 깐 표준 설치 —
#  compose 프로젝트명이 앱 디렉터리 이름이라 컨테이너는 lively-items-db-1).
CT="${VIS_E2E_DB_CONTAINER:-lively-items-db-1}"   # items-db 컨테이너 이름
APP="${VIS_E2E_APP_DIR:-/opt/lively}"             # 운영 .env 가 있는 게이트웨이 앱 디렉터리
WORK="${VIS_E2E_WORK:-$HOME/vis-e2e}"                       # 이 브랜치 빌드(dist·node_modules)가 있는 작업 디렉터리
PORT=8099

sudo docker exec "$CT" psql -U lively -d postgres -c "DROP DATABASE IF EXISTS vis_e2e" >/dev/null 2>&1 || true
sudo docker exec "$CT" psql -U lively -d postgres -c "CREATE DATABASE vis_e2e" >/dev/null
echo "격리 DB 준비: vis_e2e"

# 운영 .env 를 그대로 쓰되 DB·포트만 덮는다 — 비밀값을 내가 보지 않고도 필요한 설정을 다 얻는다.
sudo cat "$APP/.env" > "$WORK/.env.base"
sudo chown "$USER" "$WORK/.env.base"; chmod 600 "$WORK/.env.base"
PW="$(grep -m1 -E '^PGPASSWORD=' "$WORK/.env.base" | cut -d= -f2- | tr -d '\r')"

grep -vE '^(ITEMS_DATABASE_URL|DOMAINMAP_DATABASE_URL|PORT|AUTH_TOKENS_JSON|LIVELY_NO_SCHEDULER)=' "$WORK/.env.base" > "$WORK/.env"   # DOMAINMAP_ 은 옛 .env 에 남은 것 — 게이트웨이는 더 안 읽는다
{
  echo "ITEMS_DATABASE_URL=postgres://lively:${PW}@localhost:5432/vis_e2e"
  echo "PORT=${PORT}"
  echo "LIVELY_NO_SCHEDULER=1"
  # e2e 용 정적 토큰 2개 — 대상(vis_in) / 비대상(vis_out). 둘 다 일반 멤버 스코프.
  echo 'AUTH_TOKENS_JSON=[{"token":"e2e-in-token","userId":"vis_in","email":"vis_in@example.invalid","scopes":["items","context","memory"],"projects":["*"]},{"token":"e2e-out-token","userId":"vis_out","email":"vis_out@example.invalid","scopes":["items","context","memory"],"projects":["*"]},{"token":"e2e-admin-token","userId":"vis_admin","email":"vis_admin@example.invalid","scopes":["items","context","memory","admin"],"projects":["*"]}]'
} >> "$WORK/.env"
chmod 600 "$WORK/.env"
rm -f "$WORK/.env.base"
echo ".env 준비(운영 값 상속 + DB·포트·토큰 오버라이드)"

stop_port_owner "$PORT"   # 이름 패턴이 아니라 포트로(port.sh 머리말)
cd "$WORK"
nohup node --env-file="$WORK/.env" dist/index.js > "$WORK/gw.log" 2>&1 &
echo "게이트웨이 기동(pid=$!) — 포트 $PORT"

for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/healthz" || true)
  [ "$code" = "200" ] && { echo "healthz 200 ($i초)"; exit 0; }
  sleep 1
done
echo "기동 실패 — 로그 꼬리:"; tail -20 "$WORK/gw.log"; exit 1
