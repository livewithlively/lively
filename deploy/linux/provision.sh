# shellcheck shell=bash
# Linux(Ubuntu/Debian) provisioning — systemd 네이티브 게이트웨이. install.sh 가 source 한다.

os_install_deps() {
  if [ "${OFFLINE:-0}" = "1" ]; then
    log "OFFLINE — 의존성 설치 생략, 존재 확인만(에어갭 호스트에 docker·node·tmux 사전 설치 가정)"
    for cmd in docker node tmux; do command -v "$cmd" >/dev/null 2>&1 || die "OFFLINE: '$cmd' 가 없습니다 — 에어갭 호스트에 사전 설치 필요."; done
    command -v claude >/dev/null 2>&1 || warn "OFFLINE: claude 없음(중앙박스 세션용) — 사전 설치 권장."
    sudo usermod -aG docker "$(id -un)" 2>/dev/null || true
    ok "의존성 확인(OFFLINE)"
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  log "apt 패키지(git·tmux·build deps·python3)…"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg git tmux build-essential python3 unzip jq

  if ! command -v docker >/dev/null 2>&1; then
    log "docker 설치(get.docker.com)…"
    curl -fsSL https://get.docker.com | sudo sh
  fi
  # 다음 로그인부터 그룹 반영. systemd 서비스는 start 시점의 /etc/group 을 읽어 docker 그룹을 갖는다.
  sudo usermod -aG docker "$(id -un)" || true

  local major=0
  command -v node >/dev/null 2>&1 && major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 20 ]; then
    log "Node 22 설치(NodeSource)…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  if ! command -v claude >/dev/null 2>&1; then
    log "Claude Code 설치(중앙박스 세션용 — 이후 사용자가 직접 인증)…"
    sudo npm i -g @anthropic-ai/claude-code || warn "claude 전역설치 실패 — 나중에 수동 설치(npm i -g @anthropic-ai/claude-code)."
  fi
  ok "의존성 준비 완료"
}

os_install_service() {
  # 게이트웨이 유저(#524 P4): LIVELY_SERVICE_USER=lively 로 **opt-in** 시 전용 비관리자 lively(무sudo·무docker)로,
  #  아니면 현재(설치) 유저(기존 동작·무회귀). fresh-install-as-lively 전체 E2E 검증 후 default 전환 예정.
  if [ -n "${LIVELY_SERVICE_USER:-}" ]; then
    SERVICE_USER="$(ensure_service_user "$LIVELY_SERVICE_USER")"; export SERVICE_USER
  fi
  render_service_unit                                        # 렌더+daemon-reload(공유 — common.sh, update.sh 와 동일 소스). SERVICE_USER 없으면 현재 유저.
  sudo systemctl enable --now context-ontology-gateway.service
  ok "systemd 서비스 enable+start (context-ontology-gateway, User=${SERVICE_USER:-$(id -un)})"
}
