#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 제거 — install.sh 의 역연산(대칭·비파괴 — knowledge: delivery-install-invariants).
#
#   기본: 게이트웨이 서비스 중지·제거 + store 컨테이너 down + 중앙박스 키트(호스트 claude 의 lively) surgical 제거.
#         데이터 볼륨(items-db-data)·.env·앱 디렉토리·claude 로그인은 **보존**(안전).
#   --purge : + 데이터 볼륨 + .env + 앱 디렉토리까지 삭제(완전 초기화 — 되돌릴 수 없음).
#   --yes   : 확인 프롬프트 생략(스크립트/CI).
#
# 사용:  bash deploy/uninstall.sh [--purge] [--yes]
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
OS="$(detect_os)"

PURGE=0; YES=0
for a in "$@"; do case "$a" in
  --purge) PURGE=1 ;;
  --yes|-y) YES=1 ;;
  *) die "알 수 없는 옵션: $a (사용: --purge --yes)" ;;
esac; done

if [ "$YES" != "1" ]; then
  warn "게이트웨이 서비스 · store 컨테이너 · 중앙박스 키트(호스트 claude 의 lively)를 제거합니다."
  [ "$PURGE" = "1" ] && warn "⚠ --purge: 데이터 볼륨(items-db-data) · .env · 앱 디렉토리도 영구 삭제(되돌릴 수 없음)."
  printf "계속? [y/N] "; read -r ans; case "$ans" in y|Y) ;; *) die "취소됨." ;; esac
fi

# 1) 게이트웨이 서비스 중지·제거
phase "게이트웨이 서비스 제거"
if [ "$OS" = "linux" ]; then
  sudo systemctl disable --now context-ontology-gateway 2>/dev/null || true
  sudo rm -f /etc/systemd/system/context-ontology-gateway.service
  sudo systemctl daemon-reload 2>/dev/null || true
else
  launchctl bootout "gui/$(id -u)/io.lvly.context-ontology" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist"
fi
ok "서비스 제거"

# 2) 중앙박스 키트 제거(호스트 claude 의 lively 만 surgical) — 앱 코드(kit/) 필요하므로 디렉토리 삭제 '전'.
#    claude 로그인(~/.claude/.credentials)은 건드리지 않는다 — lively 훅·MCP·~/.lively 만.
phase "중앙박스 키트 제거(호스트 claude)"
if [ -f "$DIR/../kit/setup/uninstall.mjs" ] && command -v node >/dev/null 2>&1; then
  node "$DIR/../kit/setup/uninstall.mjs" $([ "$PURGE" = "1" ] && echo --purge) 2>/dev/null || warn "키트 제거기 경고(수동 확인)"
else
  command -v claude >/dev/null 2>&1 && claude mcp remove lively 2>/dev/null || true
  [ "$PURGE" = "1" ] && rm -rf "$HOME/.lively"
fi
ok "키트 제거(claude 로그인은 보존)"

# 3) store 컨테이너 제거 (--purge 면 볼륨까지)
phase "store(pgvector) 컨테이너 제거"
if [ -f "$APP_DIR/docker-compose.yml" ]; then
  ( cd "$APP_DIR" && dc compose --profile embeddings --profile gateway down --remove-orphans \
      $([ "$PURGE" = "1" ] && echo --volumes) 2>/dev/null ) || warn "compose down 경고"
fi
ok "컨테이너 제거$([ "$PURGE" = "1" ] && echo ' + 데이터 볼륨 삭제')"

# 4) --purge: .env + 앱 디렉토리 완전 삭제
if [ "$PURGE" = "1" ]; then
  phase "완전 초기화(.env + 앱 디렉토리)"
  rm -f "$APP_DIR"/.env "$APP_DIR"/.env.* 2>/dev/null || true
  appdir="$APP_DIR"; cd /
  rm -rf "$appdir" && ok "삭제: $appdir"
fi

ok "제거 완료."
[ "$PURGE" != "1" ] && log "데이터·.env 는 보존됨 — 완전 초기화는 --purge."
