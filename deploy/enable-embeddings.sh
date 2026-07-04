#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 기존 박스에 임베딩(벡터검색 #172)을 '뒤늦게' 켠다 — install.sh 를 다시 돌리지 않고(멱등·비파괴):
#   ① 임베딩 사이드카 기동(로컬 Ollama) 또는 외부 엔드포인트 확인
#   ② .env 에 EMBEDDINGS_PROVIDER=http (+ base_url/model/dim/auth) 기록
#   ③ 게이트웨이 재시작(.env 반영 — 이후 신규·수정 지식은 자동 임베딩)
#   ④ 기존 지식 백필(벡터화) — 이미 저장된 지식은 ③만으론 안 채워지므로 반드시 필요
# .env·데이터·세션은 보존한다.
#
# 사용:
#   bash deploy/enable-embeddings.sh                         # 로컬 Ollama 사이드카(bge-m3) — t4g.large(8GB)+ 권장
#   EMBEDDINGS_MODEL=bge-m3 bash deploy/enable-embeddings.sh # 모델 지정(한국어 강화=KURE-v1 등)
#   외부 엔드포인트(사이드카 없이 · 4GB 박스/데이터 외부전송 허용 시):
#     EMBEDDINGS_BASE_URL=https://api.openai.com EMBEDDINGS_MODEL=text-embedding-3-small \
#       EMBEDDINGS_AUTH_ENV=OPENAI_API_KEY bash deploy/enable-embeddings.sh --external
#   FORCE=1 : 로컬 사이드카 RAM 가드(4GB 경고) 무시하고 강행.
#
# 되돌리기: deploy/disable-embeddings.sh (provider=off + 사이드카 down). 데이터(벡터 컬럼)는 보존.
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
OS="$(detect_os)"
cd "$APP_DIR"

[ -f "$APP_DIR/.env" ] || die ".env 없음 — 먼저 install.sh 로 설치된 박스에서 실행하세요."
require_cmd node

EXTERNAL=0; [ "${1:-}" = "--external" ] && EXTERNAL=1

MODEL="${EMBEDDINGS_MODEL:-bge-m3}"
DIM="${EMBEDDINGS_DIMENSIONS:-1024}"
# healthz 포트는 .env 기준(커스텀 PORT 존중).
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- || true)"; export PORT="${PORT:-8080}"

if [ "$EXTERNAL" = "1" ]; then
  BASE="${EMBEDDINGS_BASE_URL:?외부 모드: EMBEDDINGS_BASE_URL 을 지정하세요(OpenAI-compatible /v1/embeddings host)}"
  log "외부 임베딩 엔드포인트 사용: $BASE (model=$MODEL) — 사이드카 미기동"
else
  BASE="${EMBEDDINGS_BASE_URL:-http://localhost:11434}"
  # ── G3 RAM 가드 — 로컬 사이드카(Ollama bge-m3)는 t4g.large(8GB)+ 권장. 4GB 는 Postgres+게이트웨이와 동거 시 OOM 위험. ──
  if [ "$OS" = linux ] && [ "${FORCE:-0}" != "1" ]; then
    mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    if [ "${mem_kb:-0}" -gt 0 ] && [ "$mem_kb" -lt 7000000 ]; then
      die "RAM $((mem_kb/1024))MB 감지 — 로컬 사이드카(bge-m3)는 8GB+ 권장(4GB OOM 위험).
   → 박스를 업사이즈(t4g.large+)하거나, 외부 엔드포인트(--external 모드), 또는 FORCE=1 로 강행하세요."
    fi
  fi
  phase "임베딩 사이드카 기동(Ollama · 모델 $MODEL pull)"
  EMBEDDINGS_MODEL="$MODEL" dc compose --profile embeddings up -d || die "사이드카 기동 실패 — 로그: dc compose logs embeddings"
  ok "사이드카 up — 모델 pull 은 백그라운드(embeddings-init). 아래 백필이 가용성(모델 준비)까지 확인."
fi

phase ".env 반영 — EMBEDDINGS_* (provider=http)"
set_env "$APP_DIR/.env" EMBEDDINGS_PROVIDER http
set_env "$APP_DIR/.env" EMBEDDINGS_BASE_URL "$BASE"
set_env "$APP_DIR/.env" EMBEDDINGS_MODEL "$MODEL"
set_env "$APP_DIR/.env" EMBEDDINGS_DIMENSIONS "$DIM"
[ -n "${EMBEDDINGS_AUTH_ENV:-}" ] && set_env "$APP_DIR/.env" EMBEDDINGS_AUTH_ENV "$EMBEDDINGS_AUTH_ENV"
ok ".env: EMBEDDINGS_PROVIDER=http · BASE_URL=$BASE · MODEL=$MODEL · DIM=$DIM"

phase "게이트웨이 재시작(.env 반영)"
restart_gateway
wait_healthz
ok "게이트웨이 재시작 — 임베딩 on. 이제 신규·수정 지식은 자동 임베딩됩니다."

phase "기존 지식 백필(벡터화) — 이미 저장된 지식은 이 단계로만 채워집니다"
if node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/backfill-embeddings.mjs"; then
  ok "백필 완료 — 기존 지식 임베딩됨"
else
  warn "백필 미완료 — 로컬 사이드카면 모델 pull(bge-m3) 이 끝났는지 확인(dc compose logs embeddings-init) 후 재시도:
   node --env-file=.env scripts/backfill-embeddings.mjs"
fi

echo ""
ok "임베딩 활성화 완료."
log "확인: 웹UI 지식탭 '의미검색'(관련도순) · 관리탭 '임베딩(벡터검색)'에서 상태·백로그 · knowledge_search(벡터+grep RRF)."
