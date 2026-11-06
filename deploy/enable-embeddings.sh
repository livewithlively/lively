#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 기존 박스에 임베딩(벡터검색 #172)을 '뒤늦게' 켠다 — install.sh 를 다시 돌리지 않고(멱등·비파괴):
#   ① 임베딩 사이드카 기동 + 모델 pull 완료 대기(로컬 Ollama) 또는 외부 엔드포인트 확인
#   ② .env 에 EMBEDDINGS_PROVIDER=http (+ base_url/model/dim/auth) 기록
#   ③ 게이트웨이 재시작(.env 반영 — 이후 신규·수정 지식은 자동 임베딩)
#   ④ 기존 지식 백필(벡터화) — 약 5분(진행 중인 배치까지). 남은 것은 게이트웨이의 자동 백필이 이어서 채운다
# .env·데이터·세션은 보존한다. 백필이 실패하면 exit 1 로 끝난다(임베딩 설정은 켜진 채로 남는다).
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
  EMBEDDINGS_MODEL="$MODEL" dc compose --profile embeddings up -d embeddings || die "사이드카 기동 실패 — 로그: dc compose logs embeddings"
  # 모델 pull 을 여기서 끝낸다 — 백그라운드에 두면 아래 백필이 모델 없는 서버를 만나 처음 켜는 박스가 늘 실패로 끝난다.
  #  실패하면 .env 를 쓰기 전에 멈춘다(모델 없는 서버로 게이트웨이를 켜 두지 않는다).
  log "처음이면 모델을 내려받느라 몇 분 걸립니다. 오래 멈춰 있으면 Ctrl-C 로 끊고 사이드카 로그(docker compose logs embeddings)를 보세요 — 다시 실행해도 안전합니다."
  EMBEDDINGS_MODEL="$MODEL" dc compose --profile embeddings run --rm embeddings-init || die "모델 $MODEL pull 실패 — 네트워크를 확인한 뒤 다시 실행하세요."
  ok "사이드카 up · 모델 $MODEL 준비됨"
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

phase "기존 지식 백필(벡터화) — 약 5분(진행 중인 배치까지), 남은 것은 게이트웨이가 이어서 채웁니다"
# 게이트웨이도 같은 대상을 자동 백필한다(부팅 30초 뒤·10분 주기). 여기서 끝까지 붙들면 CPU 박스는 문서 수천 건에 하루가 걸리고, 두 쪽이 같은 행을 집어 일이 겹친다.
#  그래서 이 단계는 실제로 벡터가 써지는지 확인하고 작은 박스를 바로 끝내는 몫까지만 한다.
backfill_rc=0
node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/backfill-embeddings.mjs" --max-seconds=300 || backfill_rc=$?

# #688 우선순위 안내 — 관리탭에서 '명시적으로 끈'(DB explicit off) 박스는 .env 시드보다 관리탭이 우선이라 이 스크립트로도 안 켜진다.
log "참고: 관리탭에서 임베딩을 명시적으로 꺼둔 상태(설정 출처 db-off)면 .env 시드가 무시됩니다 — 그 경우 관리탭 '임베딩(벡터검색)'에서 켜기 저장."
echo ""
if [ "$backfill_rc" -ne 0 ]; then
  warn ".env 는 반영했지만 기존 지식 백필을 끝내지 못했습니다(위 오류 참고). 일시적인 문제면 게이트웨이가 10분마다 다시 시도합니다.
   직접 재시도: node --env-file=.env scripts/backfill-embeddings.mjs"
  exit 1
fi
ok "임베딩 활성화 완료."
log "확인: 웹UI 지식탭 '의미검색'(관련도순) · 관리탭 '임베딩(벡터검색)'에서 상태·백로그 · knowledge_search(벡터+grep RRF)."
