# shellcheck shell=bash
# Linux(Ubuntu/Debian) provisioning — systemd 네이티브 게이트웨이. install.sh 가 source 한다.

os_install_deps() {
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
  local unit="/etc/systemd/system/context-ontology-gateway.service"
  local node_bin node_dir user
  node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"; user="$(id -un)"
  mkdir -p "$APP_DIR/logs"
  log "systemd 유닛 작성: $unit"
  sed -e "s#@APP_DIR@#$APP_DIR#g" \
      -e "s#@APP_USER@#$user#g" \
      -e "s#@NODE_BIN@#$node_bin#g" \
      -e "s#@PATH@#$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.npm-global/bin#g" \
      "$DEPLOY_DIR/linux/context-ontology-gateway.service" | sudo tee "$unit" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now context-ontology-gateway.service
  ok "systemd 서비스 enable+start (context-ontology-gateway)"
}
