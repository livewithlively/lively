#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# context-ontology 셀프호스트 설치 — 크로스플랫폼(Linux/Mac) 단일 진입점.
#
#   토폴로지 = Option 2: store(pgvector)=도커 / gateway=호스트 네이티브(systemd|launchd).
#   (배포 설계 결정: 중앙박스 세션이 호스트 docker 를 그대로 써 DinD 함정을 피한다.)
#
# 사용:  bash deploy/install.sh
#   환경변수(선택):
#     PUBLIC_URL=http://<host>:8080         외부 접속 URL
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
if [ "${FORCE:-0}" != "1" ] && curl -fsS --max-time 2 "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
  die "이미 :${PORT} 에 게이트웨이가 떠 있습니다 — 기존 설치 보호. 새 호스트에서 실행하거나 FORCE=1 로 강행하세요."
fi

require_cmd curl; require_cmd openssl

main() {
  phase "1/7 의존성 설치 (docker · node22 · tmux · claude)"
  os_install_deps

  phase "2/7 .env 생성(비파괴) + 시크릿"
  ensure_env

  phase "3/7 store(pgvector) 기동"
  store_up

  phase "4/7 앱 빌드 (npm ci && npm run build)"
  cd "$APP_DIR"
  npm ci
  npm run build

  # ⚠ 순서: 스키마는 게이트웨이가 '기동 시 listen 성공 후' 자가 마이그레이션한다 → 부트스트랩(테이블 필요)은
  #   반드시 서비스 기동·헬스체크 '뒤'에. (먼저 돌리면 org_member 테이블이 아직 없어 실패.)
  phase "5/7 게이트웨이 서비스 설치·기동 + 헬스체크(스키마 자가 마이그레이션)"
  os_install_service
  wait_healthz

  phase "6/7 첫 관리자 부트스트랩(웹 세션 로그인 계정)"
  local admin_out=""
  if admin_out="$(node --env-file="$APP_DIR/.env" "$DIR/bootstrap-admin.mjs" 2>&1)"; then
    ok "관리자 시드 완료"
  else
    warn "관리자 부트스트랩 경고(나중에 재시도): $admin_out"
  fi

  # 중앙박스 키트 — 이 호스트의 claude 에 lively(MCP+훅+컨텍스트) 설치 → 웹터미널 세션이 맥락 CRUD 가능.
  phase "7/7 중앙박스 키트 설치(호스트 claude 를 lively-aware 로)"
  if bash "$DIR/install-kit.sh"; then
    ok "중앙박스 키트 설치 완료"
  else
    warn "키트 설치 경고(나중에 재시도: bash deploy/install-kit.sh)"
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
  [ "$OS" = linux ] && log "서비스 로그: journalctl -u context-ontology-gateway -f   또는   tail -f $APP_DIR/logs/gateway.log"
}
main "$@"
