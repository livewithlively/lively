#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 업데이트 — 기존 호스트에 '새 코드'를 반영(빌드 + 재시작). 최초 설치는 install.sh.
#
#   전제: 새 코드가 이미 이 호스트에 와 있다(operator 가 rsync 또는 git pull 로 가져옴).
#   보존: .env · 데이터(items-db 볼륨) · 서비스 유닛 · claude 인증 · 부트스트랩(멱등) — 안 건드린다.
#   스키마: 게이트웨이 부팅(재시작) 시 자가 마이그레이션 — 별도 명령 없음.
#   빌드 실패 시: 재시작 전에 중단 → 기존 게이트웨이 계속 가동(다운 없음).
#
# 사용:  bash deploy/update.sh [--kit]
#   --kit : kit/ 가 바뀌었으면 중앙박스 키트(호스트 claude 훅/MCP/컨텍스트)도 갱신.
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
OS="$(detect_os)"
cd "$APP_DIR"

[ -f "$APP_DIR/.env" ] || die ".env 없음 — 최초 설치가 안 된 호스트입니다. install.sh 를 쓰세요."

phase "1/3 의존성 + 빌드"
if [ -d dist ] && [ ! -d src ]; then
  # prebuilt 릴리스 번들(dist 동봉·소스 없음) → tsc 불요. 새 번들이 이미 dist 를 담아 옴. 런타임 deps 만 멱등 반영.
  ok "prebuilt 릴리스 번들 — 빌드 생략, npm ci --omit=dev"
  npm ci --omit=dev
else
  npm ci
  npm run build   # 실패하면 set -e 로 여기서 중단 → 기존 게이트웨이 그대로 가동(다운 없음)
fi

phase "2/3 store 반영(멱등) + 게이트웨이 재시작"
dc compose up -d --wait items-db    # compose/이미지 변경 멱등 반영(없으면 no-op)
if [ "$OS" = linux ]; then
  sudo systemctl restart context-ontology-gateway
else
  launchctl kickstart -k "gui/$(id -u)/io.lvly.context-ontology"
fi
wait_healthz
proxy_up   # LIVELY_DOMAIN(.env) 설정 시 Caddy 재적용/기동(미설정 시 no-op) — 도메인 추가/변경도 여기서 반영

if [ "${1:-}" = "--kit" ]; then
  phase "3/3 중앙박스 키트 갱신(호스트 claude 훅/MCP/컨텍스트)"
  bash "$DIR/install-kit.sh" || warn "키트 갱신 경고 — 나중에: bash deploy/install-kit.sh"
else
  log "3/3 키트 갱신 건너뜀 — kit/ 가 바뀌었으면 --kit 로 실행"
fi

ok "업데이트 완료 — ${PUBLIC_URL:-http://localhost:${PORT:-8080}}"
log "확인: /healthz · 웹UI /ui/ · 온보딩 /ui/#/onboarding"
