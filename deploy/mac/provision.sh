# shellcheck shell=bash
# macOS provisioning — launchd 네이티브 게이트웨이. install.sh 가 source 한다.
#  ⚠ 라이블리 개발 박스(맥미니)는 이미 launchd+lc-items-db 로 떠 있다 — 이 스크립트는 '새 mac' 용.
#    기존 박스에서 실행하면 install.sh 의 :8080 감지가 막아준다(FORCE=1 로만 강행).

os_install_deps() {
  if [ "${OFFLINE:-0}" = "1" ]; then
    log "OFFLINE — 의존성 설치 생략, 존재 확인만"
    for cmd in docker node tmux; do command -v "$cmd" >/dev/null 2>&1 || die "OFFLINE: '$cmd' 없음 — 사전 설치 필요."; done
    docker info >/dev/null 2>&1 || die "OFFLINE: docker 데몬 미동작."
    command -v claude >/dev/null 2>&1 || warn "OFFLINE: claude 없음(중앙박스 세션용) — 사전 설치 권장."
    ok "의존성 확인(OFFLINE)"
    return
  fi
  command -v brew >/dev/null 2>&1 || die "Homebrew 필요 — https://brew.sh"
  command -v tmux >/dev/null 2>&1 || brew install tmux
  command -v node >/dev/null 2>&1 || brew install node@22
  command -v docker >/dev/null 2>&1 || die "docker 필요 — Docker Desktop 또는: brew install colima docker && colima start"
  docker info >/dev/null 2>&1 || die "docker 데몬 미동작 — Docker Desktop 실행 또는 'colima start'"
  command -v claude >/dev/null 2>&1 || npm i -g @anthropic-ai/claude-code || warn "claude 설치 실패 — 나중에 수동."
  ok "의존성 준비 완료"
}

os_install_service() {
  local plist="$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist"
  local node_bin node_dir; node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"
  mkdir -p "$APP_DIR/logs" "$(dirname "$plist")"
  if [ -f "$plist" ]; then
    cp "$plist" "$plist.bak-$(date +%Y%m%d-%H%M%S)"   # 비파괴: 기존 plist 백업
    warn "기존 plist 백업 후 갱신"
  fi
  sed -e "s#@APP_DIR@#$APP_DIR#g" \
      -e "s#@NODE_BIN@#$node_bin#g" \
      -e "s#@PATH@#$node_dir:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin#g" \
      "$DEPLOY_DIR/mac/io.lvly.context-ontology.plist" > "$plist"
  launchctl bootout "gui/$(id -u)/io.lvly.context-ontology" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  ok "launchd 서비스 로드 (io.lvly.context-ontology)"
}
