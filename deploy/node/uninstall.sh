#!/usr/bin/env bash
# 분산 노드 에이전트 제거(#869) — 데몬 해제 + 접속정보 삭제(레포·빌드는 남긴다, 비파괴).
set -euo pipefail
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/io.lvly.node-agent.plist"
    /bin/launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ LaunchAgent 해제"
    ;;
  Linux)
    systemctl --user disable --now lively-node-agent.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/lively-node-agent.service"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "✅ systemd(user) 해제"
    ;;
esac
rm -f "$HOME/.lively/node-agent.env"
echo "· 접속정보 삭제됨 — 게이트웨이 쪽 접속 해제는 웹/REST(POST /api/ui/nodes/<id>/rotate 또는 DELETE)로."
