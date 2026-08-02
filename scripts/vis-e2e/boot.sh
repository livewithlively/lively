#!/usr/bin/env bash
# #1291 가시성 e2e — 격리 DB 위에 이 브랜치 게이트웨이를 띄운다.
#  라이브(:8080)와 라이브 DB 는 건드리지 않는다: 별도 DB 2개 + 별도 포트 + 스케줄러/커넥터 off.
set -euo pipefail
CT=context-ontology-items-db-1
PORT=8099
APP=/opt/context-ontology
WORK="$HOME/vis-e2e"

for db in vis_e2e vis_e2e_dm; do
  sudo docker exec "$CT" psql -U lively -d postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1 || true
  sudo docker exec "$CT" psql -U lively -d postgres -c "CREATE DATABASE $db" >/dev/null
done
echo "격리 DB 준비: vis_e2e, vis_e2e_dm"

# 운영 .env 를 그대로 쓰되 DB·포트만 덮는다 — 비밀값을 내가 보지 않고도 필요한 설정을 다 얻는다.
sudo cat "$APP/.env" > "$WORK/.env.base"
sudo chown "$USER" "$WORK/.env.base"; chmod 600 "$WORK/.env.base"
PW="$(grep -m1 -E '^PGPASSWORD=' "$WORK/.env.base" | cut -d= -f2- | tr -d '\r')"

grep -vE '^(ITEMS_DATABASE_URL|DOMAINMAP_DATABASE_URL|PORT|AUTH_TOKENS_JSON|LIVELY_NO_SCHEDULER)=' "$WORK/.env.base" > "$WORK/.env"
{
  echo "ITEMS_DATABASE_URL=postgres://lively:${PW}@localhost:5432/vis_e2e"
  echo "DOMAINMAP_DATABASE_URL=postgres://lively:${PW}@localhost:5432/vis_e2e_dm"
  echo "PORT=${PORT}"
  echo "LIVELY_NO_SCHEDULER=1"
  # e2e 용 정적 토큰 2개 — 대상(vis_in) / 비대상(vis_out). 둘 다 일반 멤버 스코프.
  echo 'AUTH_TOKENS_JSON=[{"token":"e2e-in-token","userId":"vis_in","email":"vis_in@example.invalid","scopes":["items","context","memory"],"projects":["*"]},{"token":"e2e-out-token","userId":"vis_out","email":"vis_out@example.invalid","scopes":["items","context","memory"],"projects":["*"]},{"token":"e2e-admin-token","userId":"vis_admin","email":"vis_admin@example.invalid","scopes":["items","context","memory","admin"],"projects":["*"]}]'
} >> "$WORK/.env"
chmod 600 "$WORK/.env"
rm -f "$WORK/.env.base"
echo ".env 준비(운영 값 상속 + DB·포트·토큰 오버라이드)"

pkill -f "vis-e2e/dist/index.js" 2>/dev/null || true
cd "$WORK"
nohup node --env-file="$WORK/.env" dist/index.js > "$WORK/gw.log" 2>&1 &
echo "게이트웨이 기동(pid=$!) — 포트 $PORT"

for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/healthz" || true)
  [ "$code" = "200" ] && { echo "healthz 200 ($i초)"; exit 0; }
  sleep 1
done
echo "기동 실패 — 로그 꼬리:"; tail -20 "$WORK/gw.log"; exit 1
