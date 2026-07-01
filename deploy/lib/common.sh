# shellcheck shell=bash
# 배포 공통 헬퍼 — Linux/Mac 공유. install.sh 가 source 한다.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/lib
DEPLOY_DIR="$(dirname "$LIB_DIR")"                         # deploy
APP_DIR="$(dirname "$DEPLOY_DIR")"                         # repo 루트
export LIB_DIR DEPLOY_DIR APP_DIR

# ── 로그 ──
_c() { printf '\033[%sm' "$1"; }
log()    { printf '%s▸%s %s\n'  "$(_c '1;36')" "$(_c 0)" "$*"; }
phase()  { printf '\n%s══ %s ══%s\n' "$(_c '1;35')" "$*" "$(_c 0)"; }
ok()     { printf '%s✓%s %s\n'  "$(_c '1;32')" "$(_c 0)" "$*"; }
warn()   { printf '%s⚠%s %s\n'  "$(_c '1;33')" "$(_c 0)" "$*" >&2; }
die()    { printf '%s✗%s %s\n'  "$(_c '1;31')" "$(_c 0)" "$*" >&2; exit 1; }

# ── OS 감지 ──
detect_os() {
  case "$(uname -s)" in
    Linux)  echo linux ;;
    Darwin) echo mac ;;
    *) die "지원하지 않는 OS: $(uname -s) (linux/mac 만)" ;;
  esac
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "필요한 명령 없음: $1"; }

# 시크릿 생성(hex — URL/compose/.env 어디서도 이스케이프 불필요).
gen_hex() { openssl rand -hex "${1:-32}"; }

# docker 래퍼 — 소켓 접근 권한 없으면 sudo 로(리눅스 fresh: usermod 반영 전 현재 셸). 볼륨은 데몬(root) 소유라 무해.
dc() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

# ── .env 생성 (비파괴: 이미 있으면 보존) ──
#  caller 가 export 로 넘길 수 있는 값: PUBLIC_URL, TMUX_BIN, TERMINAL_ROOT_SHARED, TERMINAL_ROOT_PERSONAL,
#    ORG_DOMAIN(에이전트 토큰 이메일 도메인), PORT, ITEMS_DB_PORT, WITH_EMBEDDINGS
ensure_env() {
  local envf="$APP_DIR/.env"
  if [ -f "$envf" ]; then
    ok ".env 이미 존재 — 보존(비파괴). 시크릿 재생성 안 함."
    return 0
  fi
  local pgpw token webhook
  pgpw="$(gen_hex 16)"; token="$(gen_hex 32)"; webhook="$(gen_hex 32)"
  local port="${PORT:-8080}" idbport="${ITEMS_DB_PORT:-5432}"
  local domain="${LIVELY_DOMAIN:-}"
  # LIVELY_DOMAIN 설정 시 front door = Caddy TLS → PUBLIC_URL 기본을 https://도메인 으로(쿠키 Secure 판정 근거).
  local pub="${PUBLIC_URL:-$([ -n "$domain" ] && echo "https://$domain" || echo "http://localhost:$port")}"
  local tmux_bin="${TMUX_BIN:-$(command -v tmux || echo /usr/bin/tmux)}"
  local rshared="${TERMINAL_ROOT_SHARED:-$HOME/workspace}"
  local rpersonal="${TERMINAL_ROOT_PERSONAL:-$HOME/box}"
  local orgdom="${ORG_DOMAIN:-example.com}"
  mkdir -p "$rshared" "$rpersonal" 2>/dev/null || true   # 중앙박스 세션 루트(없으면 세션 생성 실패)

  umask 077   # .env 600
  cat > "$envf" <<EOF
# context-ontology — 배포 .env (deploy/install.sh 자동 생성). 시크릿 포함 → 절대 커밋 금지(.gitignore 등재).
PORT=$port
LOG_LEVEL=info
PUBLIC_URL=$pub

# ── TLS 프론트도어(Caddy, profile=proxy) — LIVELY_DOMAIN 설정 시 자동 HTTPS(Let's Encrypt). ──
#  비우면 프록시 없음(8080 직접/SSH 터널). 설정 시 A레코드가 이 호스트를 향해야 인증서 발급됨.
#  값 바꾼 뒤 재적용: deploy/update.sh (proxy_up 재기동). PUBLIC_URL=https://도메인 이라야 쿠키 Secure.
LIVELY_DOMAIN=$domain
LIVELY_UPSTREAM=localhost:$port

# ── store(pgvector, docker compose) ──
PGUSER=lively
PGPASSWORD=$pgpw
PGDATABASE=items
ITEMS_DB_PORT=$idbport
ITEMS_DATABASE_URL=postgres://lively:$pgpw@localhost:$idbport/items
DOMAINMAP_DATABASE_URL=postgres://lively:$pgpw@localhost:$idbport/domainmap
# db_query 용 고객 제품 DB 는 웹UI(org_db_source)로 등록(읽기전용 리플리카). DATABASE_URL env 자동등록은 폐기됨.

# ── 에이전트/MCP bearer 토큰(정적) ──
#  scope=context/items/db 만 — admin/runtime 은 DANGEROUS_SCOPES 라 거부(kill-switch). 사람관리=세션 로그인.
#  운영 시 회수가능 DB 토큰(lvk_)으로 발급 권장.
AUTH_TOKENS_JSON='{"$token":{"userId":"agent","email":"agent@$orgdom","scopes":["context","items","db"],"projects":["*"]}}'
WEBHOOK_SECRET=$webhook

# ── 로케일(불변식: tmux 세션 파싱) ──
LANG=C.UTF-8
LC_ALL=C.UTF-8
LC_CTYPE=C.UTF-8

# ── 중앙박스(웹터미널) ──
TMUX_BIN=$tmux_bin
TERMINAL_ROOT_SHARED=$rshared
TERMINAL_ROOT_PERSONAL=$rpersonal

# ── 임베딩 / 벡터검색(#172) — 기본 off(knowledge_search=grep 폴백). 4GB 박스는 off 유지 권장. ──
EMBEDDINGS_PROVIDER=off
EMBEDDINGS_BASE_URL=http://localhost:11434
EMBEDDINGS_MODEL=bge-m3
EMBEDDINGS_DIMENSIONS=1024

# ── db_query 안전장치 ──
DB_STATEMENT_TIMEOUT_MS=5000
DB_MAX_ROWS=1000
EOF
  umask 022
  chmod 600 "$envf"
  ok ".env 생성(시크릿 자동) → $envf"
  AGENT_TOKEN="$token"   # summary 출력용
  export AGENT_TOKEN
}

# store(pgvector) 기동 + healthy 대기.
store_up() {
  cd "$APP_DIR"
  dc compose up -d --wait items-db || die "items-db 기동 실패 (docker compose 로그 확인)"
  ok "store(pgvector) healthy"
  if [ "${WITH_EMBEDDINGS:-0}" = "1" ]; then
    dc compose --profile embeddings up -d && ok "임베딩 사이드카 기동(모델 pull 백그라운드)"
  fi
}

# 게이트웨이 /healthz 200 대기.
wait_healthz() {
  local port="${PORT:-8080}" url
  url="http://localhost:${port}/healthz"
  log "헬스체크: $url"
  if curl -fsS --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused -o /dev/null "$url"; then
    ok "게이트웨이 응답 OK ($url)"
  else
    die "게이트웨이가 $url 에 응답 없음 — 로그: $APP_DIR/logs/gateway.log"
  fi
}

# TLS 리버스 프록시(Caddy) 기동 — .env 의 LIVELY_DOMAIN 이 있을 때만(자동 HTTPS). 멱등.
#  판정은 .env 기준(caller env 아님) — install/update 어느 경로로도 일관. 도메인 없으면 no-op.
proxy_up() {
  cd "$APP_DIR"
  local domain
  domain="$(grep -E '^LIVELY_DOMAIN=' .env 2>/dev/null | head -n1 | cut -d= -f2-)"
  if [ -z "$domain" ]; then
    log "LIVELY_DOMAIN 미설정 — TLS 프록시 건너뜀(8080 직접/SSH 터널). 활성화: .env 에 LIVELY_DOMAIN=도메인 후 update.sh"
    return 0
  fi
  log "Caddy 리버스 프록시 기동(자동 HTTPS: $domain)"
  dc compose --profile proxy up -d caddy || die "Caddy 기동 실패 (docker compose 로그: dc compose logs caddy)"
  ok "Caddy 프록시 up — https://$domain (Let's Encrypt 자동 발급·갱신, 최초 발급 수십초)"
}
