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
    # 네이티브 설치(설치 유저 홈 ~/.local/bin — self-update). 과거 `sudo npm i -g` 는 root 전역(/usr/lib)이라
    #  비-root 세션이 자동 업뎃을 못 해 no_permissions 로 스테일됐다(#1023). 네이티브는 사용자 소유라 스스로 최신화.
    #  격리 박스는 멤버별로도 각자 네이티브 설치(provision-member/install-claude-user) — 여긴 호스트/비격리(단일유저) 세션용.
    log "Claude Code 네이티브 설치(사용자 소유 self-update — #1023)…"
    curl -fsSL --max-time 120 https://claude.ai/install.sh | bash \
      || warn "claude 네이티브 설치 실패 — 나중에 수동: curl -fsSL https://claude.ai/install.sh | bash"
    # 이번 실행의 이후 command -v claude 가 찾도록 PATH 보강(네이티브 설치기는 셸 rc 에도 등록).
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH";; esac
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
  sudo systemctl enable --now lively-gateway.service
  ok "systemd 서비스 enable+start (lively-gateway, User=${SERVICE_USER:-$(id -un)})"
}
