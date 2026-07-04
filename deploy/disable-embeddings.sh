#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 임베딩(벡터검색 #172)을 끈다 — enable-embeddings.sh 의 역연산(멱등·비파괴):
#   ① DB(org_runtime_config.embedding_config) + .env 를 provider=off 로 (UI/env 어느 경로로 켰든 확실히 off)
#   ② 게이트웨이 재시작 → 검색은 grep 폴백으로 무중단 전환
#   ③ 임베딩 사이드카 down (ollama-models 볼륨은 보존)
# ⚠ 벡터 컬럼·이미 채운 임베딩은 '보존'한다 — 다시 켜면 재사용(재백필 불요). 데이터 삭제 아님.
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
cd "$APP_DIR"
[ -f "$APP_DIR/.env" ] || die ".env 없음."
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- || true)"; export PORT="${PORT:-8080}"
PGUSER="$(grep -E '^PGUSER=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- || true)"
PGDATABASE="$(grep -E '^PGDATABASE=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- || true)"

phase "provider=off (DB + .env — 어느 경로로 켰든 확실히)"
# DB config(관리탭 UI 로 켠 경우) 우선순위가 env 보다 높으므로 DB 도 반드시 off. best-effort.
dc compose exec -T items-db psql -U "${PGUSER:-lively}" -d "${PGDATABASE:-items}" \
  -c "UPDATE org_runtime_config SET embedding_config='{\"provider\":\"off\"}'::jsonb WHERE id=1;" >/dev/null 2>&1 \
  && ok "DB embedding_config → off" || warn "DB off 스킵(store 미기동/미설정 — env 경로면 불필요)"
set_env "$APP_DIR/.env" EMBEDDINGS_PROVIDER off
ok ".env EMBEDDINGS_PROVIDER=off (벡터 컬럼·임베딩 데이터는 보존)"

phase "게이트웨이 재시작(검색 grep 폴백)"
restart_gateway
wait_healthz

phase "임베딩 사이드카 down"
dc compose --profile embeddings down --remove-orphans >/dev/null 2>&1 || true
ok "사이드카 정지(ollama-models 볼륨 보존)"

ok "임베딩 비활성화 완료 — 검색은 grep 폴백. 다시 켜기: deploy/enable-embeddings.sh"
