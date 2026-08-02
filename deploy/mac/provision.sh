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
  render_service_unit                                        # 렌더(plist)·백업(공유 — common.sh, update.sh 와 동일 소스)
  local plist="$HOME/Library/LaunchAgents/io.lvly.lively.plist"
  launchctl bootout "gui/$(id -u)/io.lvly.lively" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  ok "launchd 서비스 로드 (io.lvly.lively)"
}
