#!/usr/bin/env bash
# 분산 노드 에이전트 설치(#869) — 비파괴(delivery-install-invariants).
#  이 레포 체크아웃 안에서 실행한다(도그푸드 v1 — 릴리스 번들 패키징은 후속):
#    bash deploy/node/install.sh --url https://<게이트웨이> --token lvk_... --id <노드id>
#  하는 일: ① 의존 설치+빌드(이미 있으면 재사용) ② ~/.lively/node-agent.env(0600)에 접속정보 저장
#           ③ 데몬 등록(macOS=LaunchAgent · Linux=systemd --user) + 즉시 기동. 로그: ~/.lively/logs/node-agent.log
#  제거: bash deploy/node/uninstall.sh
set -euo pipefail

URL="" TOKEN="" NODE_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --id) NODE_ID="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "사용법: bash deploy/node/install.sh --url <게이트웨이URL> --token <노드토큰> [--id <노드id>]" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT="$REPO_ROOT/dist/node/agent.js"
LIVELY_DIR="$HOME/.lively"
ENV_FILE="$LIVELY_DIR/node-agent.env"
LOG_DIR="$LIVELY_DIR/logs"
mkdir -p "$LIVELY_DIR" "$LOG_DIR"

command -v node >/dev/null 2>&1 || { echo "node 가 필요합니다(v20+)" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || echo "⚠ tmux 가 없습니다 — 세션 생성이 실패합니다(brew install tmux / apt install tmux)" >&2

# 빌드(멱등) — dist 가 없거나 소스가 더 새로우면.
if [ ! -f "$AGENT" ] || [ "$REPO_ROOT/src/node/agent.ts" -nt "$AGENT" ]; then
  echo "· 빌드 중(npm ci + tsc)…"
  (cd "$REPO_ROOT" && npm ci --silent && npm run build >/dev/null)
fi
[ -f "$AGENT" ] || { echo "빌드 실패: $AGENT 없음" >&2; exit 1; }

# 접속정보 — 토큰은 유닛/plist 가 아니라 0600 env 파일에만 둔다.
#  TMUX_BIN 도 여기 기록한다: 코드 기본값이 macOS homebrew 경로(/opt/homebrew/bin/tmux)라
#  Linux/WSL2 노드는 미설정 시 tmux 호출이 전부 실패한다(게이트웨이 .env 의 TMUX_BIN 과 동일 관례).
TMUX_PATH="$(command -v tmux || true)"
umask 177
cat > "$ENV_FILE" <<EOF
LIVELY_GATEWAY_URL=$URL
LIVELY_NODE_TOKEN=$TOKEN
LIVELY_NODE_ID=${NODE_ID:-$(hostname -s | tr '[:upper:]' '[:lower:]')}
${TMUX_PATH:+TMUX_BIN=$TMUX_PATH}
EOF
umask 022
echo "· 접속정보 저장: $ENV_FILE (0600)${TMUX_PATH:+ · tmux=$TMUX_PATH}"

NODE_BIN="$(command -v node)"
RUN_CMD="set -a; . '$ENV_FILE'; exec '$NODE_BIN' '$AGENT'"

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/io.lvly.node-agent.plist"
    /bin/launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.lvly.node-agent</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string><string>$RUN_CMD</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/node-agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/node-agent.log</string>
</dict></plist>
PL
    /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "✅ LaunchAgent 등록·기동: $PLIST"
    echo "   상태: launchctl print gui/$(id -u)/io.lvly.node-agent | head"
    ;;
  Linux)
    # WSL2 등 systemd 미활성 환경 — 유닛 등록 불가 → 즉시 기동(nohup) + 활성화 안내(§8-7 ⑸ Windows=WSL2 전제).
    if [ ! -d /run/systemd/system ]; then
      pkill -f "dist/node/agent.js" 2>/dev/null || true
      nohup bash -c "$RUN_CMD" >> "$LOG_DIR/node-agent.log" 2>&1 &
      echo "⚠ systemd 미활성(WSL2?) — 데몬 등록 대신 즉시 기동했습니다(재부팅 시 재실행 필요)."
      echo "   상시화: /etc/wsl.conf 에 [boot] systemd=true 추가 후 'wsl --shutdown' → 이 스크립트 재실행."
      echo "· 로그: tail -f $LOG_DIR/node-agent.log"
      exit 0
    fi
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/lively-node-agent.service" <<UN
[Unit]
Description=Lively node agent (#869)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $AGENT
Restart=always
RestartSec=3
StandardOutput=append:$LOG_DIR/node-agent.log
StandardError=append:$LOG_DIR/node-agent.log

[Install]
WantedBy=default.target
UN
    systemctl --user daemon-reload
    systemctl --user enable --now lively-node-agent.service
    echo "✅ systemd(user) 등록·기동: lively-node-agent.service"
    echo "   상태: systemctl --user status lively-node-agent  ·  (부팅 유지: loginctl enable-linger $USER)"
    ;;
  *) echo "미지원 OS: $(uname -s) — Windows 는 WSL2 안에서 실행하세요(§8-7 ⑸)" >&2; exit 1 ;;
esac

echo "· 로그: tail -f $LOG_DIR/node-agent.log"
