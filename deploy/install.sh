#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# Lively 셀프호스트 설치 — 크로스플랫폼(Linux/Mac) 단일 진입점.
#
#   토폴로지 = Option 2: store(pgvector)=도커 / gateway=호스트 네이티브(systemd|launchd).
#   (배포 설계 결정: 중앙박스 세션이 호스트 docker 를 그대로 써 DinD 함정을 피한다.)
#
# 사용:  bash deploy/install.sh
#   환경변수(선택):
#     LIVELY_DOMAIN=gw.org.com               설정 시 Caddy 자동 HTTPS(Let's Encrypt) + PUBLIC_URL 기본 https
#     PUBLIC_URL=http://<host>:8080         외부 접속 URL(LIVELY_DOMAIN 설정 시 https://도메인 자동)
#     BOOTSTRAP_ADMIN_EMAIL=you@org.com      첫 관리자(웹 로그인) 이메일
#     ORG_DOMAIN=org.com                     에이전트 토큰 이메일 도메인
#     WITH_EMBEDDINGS=1                      임베딩 사이드카 동반(t4g.large+ 권장)
#     FORCE=1                                기존 게이트웨이 감지해도 강행
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

OS="$(detect_os)"
log "OS=$OS  APP_DIR=$APP_DIR"
# shellcheck source=/dev/null
source "$DIR/$OS/provision.sh"    # os_install_deps() + os_install_service() 제공

# 기존 설치 보호(비파괴) — 이미 :PORT 에 게이트웨이가 떠 있으면 중단(개발 박스 등).
PORT="${PORT:-8080}"
# OFFLINE=1 (에어갭): 네트워크 의존 단계(node/claude 설치·npm ci)를 생략하고 번들 동봉 자산(node_modules·dist)을 쓴다.
#  코드 획득은 bootstrap.sh 가 LIVELY_BUNDLE 로 처리 → 여기선 '설치'만 오프라인 모드로 분기. 기본 0(온라인).
export OFFLINE="${OFFLINE:-0}"
if [ "${FORCE:-0}" != "1" ] && curl -fsS --max-time 2 "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
  die "이미 :${PORT} 에 게이트웨이가 떠 있습니다 — 기존 설치 보호. 새 호스트에서 실행하거나 FORCE=1 로 강행하세요."
fi

require_cmd curl; require_cmd openssl

main() {
  phase "1/7 의존성 설치 (docker · node22 · tmux · claude)"
  os_install_deps

  phase "2/7 .env 생성(비파괴) + 시크릿"
  ensure_env
  ensure_env_secret CONNECTOR_SECRET_KEY   # 기존 .env 보존 설치도 secret-box 마스터키 백필(#540 git 자격·#541 커넥터) — 신규는 ensure_env 가 이미 넣음

  phase "3/7 store(pgvector) 기동"
  store_up

  phase "4/7 의존성 + 빌드"
  cd "$APP_DIR"
  if [ "$OFFLINE" = "1" ]; then
    # 오프라인 번들 — node_modules·dist 동봉 전제(네트워크 0).
    [ -d node_modules ] || die "OFFLINE: node_modules 가 없습니다 — 오프라인 번들에 동봉돼야 합니다."
    [ -d dist ] || die "OFFLINE: dist 가 없습니다 — 오프라인 번들에 동봉돼야 합니다."
    ok "OFFLINE — npm/빌드 생략(번들 자산 사용)"
  elif [ -d dist ] && [ ! -d src ]; then
    # prebuilt 릴리스 번들(dist 동봉·소스 없음) → tsc 불요, 런타임 deps(node-pty 포함)만.
    ok "prebuilt 릴리스 — 빌드 생략, npm ci --omit=dev"
    npm ci --omit=dev
  else
    # 소스 배포(git clone/rsync) → 전체 deps + 빌드.
    npm ci
    npm run build
  fi

  # ⚠ 순서: 스키마는 게이트웨이가 '기동 시 listen 성공 후' 자가 마이그레이션한다 → 부트스트랩(테이블 필요)은
  #   반드시 서비스 기동·헬스체크 '뒤'에. (먼저 돌리면 org_member 테이블이 아직 없어 실패.)
  phase "5/7 게이트웨이 서비스 설치·기동 + 헬스체크(스키마 자가 마이그레이션) + TLS 프록시"
  ensure_host_memory_safety   # #1059 OOM 재발방지 — swap 완충 + earlyoom(sshd 보호·폭주 kill). 서비스 기동 전. 비치명.
  os_install_service
  wait_healthz
  proxy_up   # LIVELY_DOMAIN 설정 시 Caddy 자동 HTTPS(미설정 시 no-op)

  phase "6/7 부트스트랩 — 첫 관리자 + 익명 baseline(페르소나·규칙)"
  # P4(#524): 게이트웨이 유저(lively)로 실행 — 키트가 그 유저 홈(~/.claude)에 써야 하고, 부트스트랩도 같은 유저로 통일.
  #  (.env 는 운영자 소유·그룹 lively·640 이라 lively/운영자 둘 다 읽음. SERVICE_USER=설치유저면 run_as_service 는 그냥 실행.)
  local admin_out=""
  if admin_out="$(run_as_service node --env-file="$APP_DIR/.env" "$DIR/bootstrap-admin.mjs" 2>&1)"; then
    ok "관리자 시드 완료"
  else
    warn "관리자 부트스트랩 경고(나중에 재시도): $admin_out"
  fi
  # 익명 조직 baseline(org-defaults 페르소나·규칙) — 빈 경우에만(편집 보존). 신규 조직이 맥락 블라인드를 안 넘게.
  if run_as_service node --env-file="$APP_DIR/.env" "$DIR/bootstrap-baseline.mjs" 2>&1; then
    ok "baseline 시드 처리(빈 org-defaults 만)"
  else
    warn "baseline 시드 경고(나중에 재시도: node --env-file=.env deploy/bootstrap-baseline.mjs)"
  fi
  # 기본 커넥터 카탈로그(#746) — DCR 지원 호스팅 OAuth MCP(Notion·Linear 등) '없으면 등록'(멱등, 기존 보존).
  if run_as_service node --env-file="$APP_DIR/.env" "$DIR/bootstrap-connectors.mjs" 2>&1; then
    ok "기본 커넥터 시드 처리(없는 것만)"
  else
    warn "커넥터 시드 경고(나중에 재시도: node --env-file=.env deploy/bootstrap-connectors.mjs)"
  fi

  # 중앙박스 키트 — 이 호스트의 claude 에 lively(MCP+훅+컨텍스트) 설치 → 웹터미널 세션이 맥락 CRUD 가능.
  phase "7/7 중앙박스 키트 설치(게이트웨이 유저의 claude 를 lively-aware 로)"
  if run_as_service bash "$DIR/install-kit.sh"; then
    ok "중앙박스 키트 설치 완료"
  else
    warn "키트 설치 경고(나중에 재시도: bash deploy/install-kit.sh)"
  fi

  # 임베딩 백필 — WITH_EMBEDDINGS 로 사이드카+provider(http)를 켠 경우, 시드/기존 지식을 벡터화(best-effort).
  #  사이드카 모델(bge-m3) pull 이 아직이면 백필이 '불가용'으로 건너뛴다 → 경고 + 재시도 안내(설치는 실패 아님).
  if [ "${WITH_EMBEDDINGS:-0}" = "1" ]; then
    phase "임베딩 백필(기존 지식 벡터화)"
    if run_as_service node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/backfill-embeddings.mjs"; then
      ok "임베딩 백필 완료"
    else
      warn "임베딩 백필 건너뜀/미완료 — 사이드카 모델 pull 이 끝난 뒤 재시도: node --env-file=.env scripts/backfill-embeddings.mjs"
    fi
  fi

  # ── 요약 ──
  phase "완료"
  ok "게이트웨이: ${PUBLIC_URL:-http://localhost:$PORT}"
  ok "헬스: ${PUBLIC_URL:-http://localhost:$PORT}/healthz   ·   웹UI: ${PUBLIC_URL:-http://localhost:$PORT}/ui/"
  [ -n "$admin_out" ] && ok "첫 관리자: $admin_out"
  [ -n "${AGENT_TOKEN:-}" ] && ok "에이전트 토큰(.env AUTH_TOKENS_JSON): $AGENT_TOKEN"
  ok "중앙박스: 호스트 claude 에 lively 키트 설치됨 — 웹터미널 세션이 맥락 CRUD 가능 (claude mcp list 로 확인)"
  echo ""
  log "다음: 이 호스트에서 'claude' 로그인(중앙박스 세션이 쓸 계정) → 웹UI 로그인 → 고객 DB(읽기전용)·구성원 등록."
  [ "$OS" = linux ] && log "서비스 로그: journalctl -u lively-gateway -f   또는   tail -f $APP_DIR/logs/gateway.log"
}
main "$@"
