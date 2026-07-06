# shellcheck shell=bash
# 배포 공통 헬퍼 — Linux/Mac 공유. install.sh 가 source 한다.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/lib
DEPLOY_DIR="$(dirname "$LIB_DIR")"                         # deploy
APP_DIR="$(dirname "$DEPLOY_DIR")"                         # repo 루트
export LIB_DIR DEPLOY_DIR APP_DIR

# ── 로그 ──
_c() { printf '\033[%sm' "$1"; }
# ⚠ 진단/진행 로그는 전부 stderr 로(warn·die 와 동일). stdout 은 '데이터 반환' 전용 — ensure_service_user 처럼
#   VAR="$(func)" 로 캡처되는 함수가 log 를 stdout 에 흘리면 반환값이 오염돼(→ getet passwd 실패, set -e exit 2) 배포가 깨진다.
log()    { printf '%s▸%s %s\n'  "$(_c '1;36')" "$(_c 0)" "$*" >&2; }
phase()  { printf '\n%s══ %s ══%s\n' "$(_c '1;35')" "$*" "$(_c 0)" >&2; }
ok()     { printf '%s✓%s %s\n'  "$(_c '1;32')" "$(_c 0)" "$*" >&2; }
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

# ── P4(#524): 전용 비-root 게이트웨이 서비스 유저 ──
#  게이트웨이·프로젝트 공동세션이 admin(ssm-user)로 안 뜨게 — non-root·무sudo·무docker 의 lively 로.
#  멱등. echo 로 실제 서비스 유저명 반환. mac(launchd)·미Linux 는 현 유저(대상 아님).
#  ⚠ 격리 spawn 은 별도 잠긴 sudoers(install-isolation, GATEWAY_USER=이 유저)로만 부여 — 여기선 유저·소유권만.
LIVELY_SERVICE_HOME="${LIVELY_SERVICE_HOME:-/var/lib/lively}"
# .env(KEY=VAL 파일) 키 멱등 설정 — 있으면 교체, 없으면 추가. 값은 경로(특수문자 없음)라 sed # 구분자 안전.
set_env() { local f="$1" k="$2" v="$3"
  if sudo grep -qE "^$k=" "$f" 2>/dev/null; then sudo sed -i "s#^$k=.*#$k=$v#" "$f"; else echo "$k=$v" | sudo tee -a "$f" >/dev/null; fi
}
ensure_service_user() {
  local user="${1:-lively}"
  if [ "$(detect_os)" != linux ]; then echo "$(id -un)"; return 0; fi
  if ! id "$user" >/dev/null 2>&1; then
    sudo useradd --system --create-home --home-dir "$LIVELY_SERVICE_HOME" --shell /bin/bash "$user" \
      || die "게이트웨이 서비스 유저 생성 실패: $user"
    log "게이트웨이 서비스 유저 생성: $user (system·shell=bash·무암호·무SSH키·무sudo·무docker)"
  fi
  # ⚠ 셸 = /bin/bash (nologin 아님). 게이트웨이가 '비격리' 세션(프로젝트 공동세션·managed)을 이 유저로 spawn 하는데
  #   tmux new-session 이 '명령 없이'면 유저의 로그인 셸을 띄운다 → nologin 이면 즉시 죽어 세션 생성이 500.
  #   로그인은 무암호·무authorized_keys 로 이미 차단(셸 있어도 로그인 불가) → bash 부여가 보안 저하 아님. 기존 유저도 멱등 교정.
  case "$(getent passwd "$user" | cut -d: -f7)" in */bash) : ;; *) sudo usermod -s /bin/bash "$user"; log "서비스 유저 셸 → /bin/bash (비격리 세션 spawn 용)" ;; esac
  getent group lively-shared >/dev/null || sudo groupadd lively-shared
  id -nG "$user" | tr ' ' '\n' | grep -qx lively-shared || sudo usermod -aG lively-shared "$user"
  # ⚠ APP_DIR 소유는 '운영자(배포 실행 유저)' 그대로 둔다 — update 가 npm ci/build 로 여기에 '쓰기' 때문(lively 소유면
  #   다음 update 의 npm ci 가 EACCES). 게이트웨이(lively)는 dist/node_modules 를 '읽기'만 하면 되고, 그건 /opt 아래
  #   (world traverse) + npm/git 기본 umask(022 → world/group read)로 충족 → chown -R 안 한다. logs 만 lively 가 append
  #   (systemd StandardOutput=append) → render_service_unit 이 chown -R 로 넘긴다.
  # .env 소유권 불변식(운영자:서비스유저 640 — 게이트웨이가 group-read)은 이 함수 '맨 끝'에서 적용한다 —
  #  아래 세션루트 repoint 의 set_env(sudo sed -i)가 .env 를 재작성하며 그룹을 도로 깰 수 있어, 모든 .env 편집 뒤가 유일하게 안전.
  case "$APP_DIR" in
    /opt/*|/srv/*) : ;;
    *) warn "앱 경로 $APP_DIR — lively 접근엔 /opt 권장(홈 아래면 상위 traverse 권한 필요)"; sudo chmod o+x "$(dirname "$APP_DIR")" 2>/dev/null || true ;;
  esac
  # ── 세션 루트(비격리 shared·personal)를 게이트웨이 유저 접근가능 경로로 ──
  #  프로젝트 공동세션(비격리)은 이 유저로 mkdir/spawn 한다. .env 의 TERMINAL_ROOT_* 가 옛 게이트웨이 유저 홈
  #  ($HOME/workspace)을 가리키면 lively 가 못 써서 세션 생성이 500. 현재 값을 이 유저가 쓸 수 있으면 보존(관리자
  #  커스텀 존중), 아니면 shared=격리공유dir(/srv/lively/shared, lively-shared 그룹 rw)·personal=서비스홈/box 로 repoint.
  local shared_dir="${LIVELY_SHARED_DIR:-/srv/lively/shared}"
  getent group lively-shared >/dev/null 2>&1 && sudo install -d -g lively-shared -m 2775 "$shared_dir" 2>/dev/null || sudo mkdir -p "$shared_dir"
  sudo install -d -o "$user" -g "$user" -m 700 "$LIVELY_SERVICE_HOME/box" 2>/dev/null || true
  if [ -f "$APP_DIR/.env" ]; then
    local cur
    cur="$(sudo grep -E '^TERMINAL_ROOT_SHARED=' "$APP_DIR/.env" | cut -d= -f2-)"
    sudo -u "$user" test -w "$cur" 2>/dev/null || { set_env "$APP_DIR/.env" TERMINAL_ROOT_SHARED "$shared_dir"; log "세션 shared 루트 → $shared_dir ($user 접근가능)"; }
    cur="$(sudo grep -E '^TERMINAL_ROOT_PERSONAL=' "$APP_DIR/.env" | cut -d= -f2-)"
    sudo -u "$user" test -w "$cur" 2>/dev/null || { set_env "$APP_DIR/.env" TERMINAL_ROOT_PERSONAL "$LIVELY_SERVICE_HOME/box"; log "세션 personal 루트 → $LIVELY_SERVICE_HOME/box"; }
  fi
  # ⭐ .env 소유권 불변식 최종 적용 — 위 모든 .env 편집(set_env 세션루트 repoint 등) '뒤' 마지막에 강제.
  #  게이트웨이(서비스유저 그룹)가 .env 를 group-read 해야 DB 접속정보를 로드한다(못 읽으면 password=undefined→SASL 다운:
  #  2026-07-03 어니스트 실장애). sed -i 계열이 중간에 그룹을 깨도 여기가 최종적으로 '운영자:서비스유저 640' 을 보장.
  if [ -f "$APP_DIR/.env" ]; then sudo chown "$(id -un)":"$user" "$APP_DIR/.env" && sudo chmod 640 "$APP_DIR/.env"; fi
  echo "$user"
}

# 명령을 게이트웨이 서비스 유저(SERVICE_USER)로 실행 — P4 에서 .env·홈이 lively 소유라 부트스트랩·키트를 그 유저로.
#  SERVICE_USER 가 현재 유저(비-P4)면 그냥 실행. 설치에 필요한 env 만 화이트리스트로 전달(secure_path·홈 세팅).
run_as_service() {
  local svc="${SERVICE_USER:-$(id -un)}"
  if [ "$svc" = "$(id -un)" ] || [ "$(detect_os)" != linux ]; then "$@"; return; fi
  local h; h="$(getent passwd "$svc" | cut -d: -f6)"
  sudo -u "$svc" env HOME="$h" PATH="$PATH" \
    BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-}" ORG_DOMAIN="${ORG_DOMAIN:-}" \
    PUBLIC_URL="${PUBLIC_URL:-}" PORT="${PORT:-}" \
    LIVELY_GATEWAY="${LIVELY_GATEWAY:-}" LIVELY_TOKEN="${LIVELY_TOKEN:-}" KIT_HARNESS="${KIT_HARNESS:-}" \
    "$@"
}

# ── 서비스 유닛(systemd/launchd) 렌더·설치 — install(provision.os_install_service)·update 공유(단일 소스). ──
#  유닛 템플릿(deploy/<os>/…) 변경(예: KillMode=process)이 update.sh 로도 기존 박스에 전파되게 한다. 멱등.
#  '파일 렌더'만(+linux daemon-reload) — enable/start/restart 는 호출자가(provision=enable·start, update=restart).
#  게이트웨이 유저 = ${SERVICE_USER:-현재유저}. 호출자(provision=lively, update=현재보존)가 SERVICE_USER 로 지정.
render_service_unit() {
  local svc_user="${SERVICE_USER:-$(id -un)}"
  local svc_home; svc_home="$(getent passwd "$svc_user" 2>/dev/null | cut -d: -f6)"; svc_home="${svc_home:-$HOME}"
  local node_bin node_dir; node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"
  # 게이트웨이(비-운영자 lively)가 런타임에 '쓰는' 디렉토리는 서비스유저 소유여야 한다 — logs(systemd append) +
  #  data(노션 자산 등 fs 쓰기: 게이트웨이 cwd=APP_DIR 이라 asset_dir 기본값 = $APP_DIR/data/notion-assets). APP_DIR 본체를
  #  운영자 소유로 두는 불변식(update 의 npm ci)과 무충돌 — logs·data 는 빌드 산출이 아니라 '런타임 쓰기'다(/usr vs /var 처럼
  #  코드=운영자·가변데이터=서비스유저 분리). items-db 는 docker named volume(items-db-data:/var/lib/postgresql)이라
  #  $APP_DIR/data 아래에 없음 → data 를 chown 해도 DB 볼륨 무영향. 매 update 재적용(멱등)이라 신규/이관 자산도 계속 소유.
  mkdir -p "$APP_DIR/logs" "$APP_DIR/data"
  [ "$(detect_os)" = linux ] && sudo chown -R "$svc_user" "$APP_DIR/logs" "$APP_DIR/data" 2>/dev/null || true
  case "$(detect_os)" in
    linux)
      local unit="/etc/systemd/system/context-ontology-gateway.service"
      sed -e "s#@APP_DIR@#$APP_DIR#g" \
          -e "s#@APP_USER@#$svc_user#g" \
          -e "s#@NODE_BIN@#$node_bin#g" \
          -e "s#@PATH@#$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$svc_home/.npm-global/bin#g" \
          "$DEPLOY_DIR/linux/context-ontology-gateway.service" | sudo tee "$unit" >/dev/null
      sudo systemctl daemon-reload
      ok "systemd 유닛 렌더: $unit (User=$svc_user)"
      ;;
    mac)
      local plist="$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist"
      mkdir -p "$(dirname "$plist")"
      if [ -f "$plist" ]; then cp "$plist" "$plist.bak-$(date +%Y%m%d-%H%M%S)"; warn "기존 plist 백업 후 갱신"; fi
      sed -e "s#@APP_DIR@#$APP_DIR#g" \
          -e "s#@NODE_BIN@#$node_bin#g" \
          -e "s#@PATH@#$node_dir:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin#g" \
          "$DEPLOY_DIR/mac/io.lvly.context-ontology.plist" > "$plist"
      ok "launchd plist 렌더: $plist"
      ;;
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
  local pgpw token webhook conn_key
  pgpw="$(gen_hex 16)"; token="$(gen_hex 32)"; webhook="$(gen_hex 32)"; conn_key="$(gen_hex 32)"
  local port="${PORT:-8080}" idbport="${ITEMS_DB_PORT:-5432}"
  local domain="${LIVELY_DOMAIN:-}"
  # LIVELY_DOMAIN 설정 시 front door = Caddy TLS → PUBLIC_URL 기본을 https://도메인 으로(쿠키 Secure 판정 근거).
  local pub="${PUBLIC_URL:-$([ -n "$domain" ] && echo "https://$domain" || echo "http://localhost:$port")}"
  local tmux_bin="${TMUX_BIN:-$(command -v tmux || echo /usr/bin/tmux)}"
  local rshared="${TERMINAL_ROOT_SHARED:-$HOME/workspace}"
  local rpersonal="${TERMINAL_ROOT_PERSONAL:-$HOME/box}"
  local orgdom="${ORG_DOMAIN:-example.com}"
  mkdir -p "$rshared" "$rpersonal" 2>/dev/null || true   # 중앙박스 세션 루트(없으면 세션 생성 실패)
  # 임베딩(#172) — WITH_EMBEDDINGS=1(또는 EMBEDDINGS_PROVIDER=http)면 provider 를 켜서 기록(사이드카는 store_up 이 기동,
  #  기존 지식 백필은 install.sh 말미). 아니면 off(grep 폴백). base_url/model/dim/auth 는 caller env 로 오버라이드 가능.
  local emb_provider="off"
  if [ "${WITH_EMBEDDINGS:-0}" = "1" ] || [ "${EMBEDDINGS_PROVIDER:-}" = "http" ]; then emb_provider="http"; fi
  local emb_base="${EMBEDDINGS_BASE_URL:-http://localhost:11434}"
  local emb_model="${EMBEDDINGS_MODEL:-bge-m3}"
  local emb_dim="${EMBEDDINGS_DIMENSIONS:-1024}"
  local emb_auth_line="# EMBEDDINGS_AUTH_ENV=OPENAI_API_KEY   # 외부 API 인증 시: 키를 담은 환경변수 '이름'(값 아님)"
  [ -n "${EMBEDDINGS_AUTH_ENV:-}" ] && emb_auth_line="EMBEDDINGS_AUTH_ENV=${EMBEDDINGS_AUTH_ENV}"

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

# ── at-rest 암호화 키 — git 자격(#540)·커넥터 토큰(#541)을 DB에 봉투 암호화(secret-box)하는 공용 마스터키. ──
#  자동 생성(사람 개입 불요). ⚠ 바꾸면 기존 암호문(git 자격·커넥터 토큰) 복호 불가 → update 는 보존한다.
CONNECTOR_SECRET_KEY=$conn_key

# ── 로케일(불변식: tmux 세션 파싱) ──
LANG=C.UTF-8
LC_ALL=C.UTF-8
LC_CTYPE=C.UTF-8

# ── 중앙박스(웹터미널) ──
TMUX_BIN=$tmux_bin
TERMINAL_ROOT_SHARED=$rshared
TERMINAL_ROOT_PERSONAL=$rpersonal

# ── 임베딩 / 벡터검색(#172) — off=knowledge_search grep 폴백. http=OpenAI-compatible /v1/embeddings. ──
#  뒤늦게 켜기: deploy/enable-embeddings.sh (사이드카→provider=http→재시작→기존 지식 백필). 또는 관리탭 '임베딩(벡터검색)'.
#  4GB 박스는 로컬 사이드카(bge-m3) 비권장(t4g.large+) — 외부 엔드포인트로 base_url 지정 가능.
EMBEDDINGS_PROVIDER=$emb_provider
EMBEDDINGS_BASE_URL=$emb_base
EMBEDDINGS_MODEL=$emb_model
EMBEDDINGS_DIMENSIONS=$emb_dim
$emb_auth_line

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

# 기존 .env 에 필수 시크릿이 없으면 자동 생성해 추가(멱등·비파괴 — 비어있지 않은 값은 보존).
#  신규 도입 변수를 기존 박스에 백필하는 용도(예: CONNECTOR_SECRET_KEY — ensure_env 로 새로 깐 박스는 이미 있고,
#  그 전에 설치된 박스는 update.sh 가 이걸로 채워 넣는다).
#  ⚠ .env 의 owner:group:mode 를 절대 안 바꾼다 — 불변식 '.env = 운영자:lively 640'(게이트웨이 lively 가 group-read).
#   sed -i 는 새 inode 로 rename 하며 **group 을 실행유저 기본그룹으로 리셋** → lively 가 .env 못 읽어 SASL 다운
#   (2026-07-03 어니스트 실박스 실장애). 그래서 append(>>) + 빈 라인 제거는 inode-보존 되쓰기(>)만 쓴다(둘 다 perms 무변).
ensure_env_secret() {
  local name="$1" bytes="${2:-32}" envf="$APP_DIR/.env"
  [ -f "$envf" ] || return 0
  if grep -qE "^${name}=.+" "$envf"; then return 0; fi        # 비어있지 않은 값 존재 → 보존
  if grep -qE "^${name}=" "$envf"; then                       # 빈 "${name}=" 라인만 제거(inode 보존 → group 유지)
    local tmp="$envf.tmp.$$"
    grep -vE "^${name}=" "$envf" > "$tmp" && cat "$tmp" > "$envf"   # > 되쓰기 = 같은 inode(owner/group/mode 무변)
    rm -f "$tmp"
  fi
  printf '\n# %s — deploy 자동생성(#540 git 자격·#541 커넥터 토큰 at-rest 암호화). 분실 시 복호 불가 → 재등록.\n%s=%s\n' \
    "$name" "$name" "$(gen_hex "$bytes")" >> "$envf"          # append = owner/group/mode 무변
  ok ".env 에 $name 자동 생성(백필·소유/모드 보존)"
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

# 게이트웨이 재시작 — .env 변경(예: EMBEDDINGS_*) 반영. 유닛은 --env-file-if-exists=.env 라 재시작만으로 픽업.
#  KillMode=process(systemd)라 중앙박스 tmux 세션은 생존(재부착). mac 은 plist 변경까지 반영하려 bootout+bootstrap.
#  update.sh 는 유저 마이그레이션까지 하지만, 여기선 '단순 재시작'만 필요(유닛/유저 불변).
restart_gateway() {
  case "$(detect_os)" in
    linux) sudo systemctl restart context-ontology-gateway ;;
    mac)
      launchctl bootout "gui/$(id -u)/io.lvly.context-ontology" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist" ;;
  esac
}
