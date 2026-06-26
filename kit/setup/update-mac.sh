#!/usr/bin/env bash
# 업데이트 — 설치된 토큰으로 최신 발행 묶음을 받아 멱등 재설치(install 의 대칭, self-contained).
# 콘텐츠(강제규칙·회사맥락·메모리)는 매 세션 자동 갱신되므로, 이건 훅/제품(설정) 변경을 받을 때 쓴다.
#   bash update-mac.sh        # ~/.lively/token + gateway-url 을 읽음 — 토큰 재입력 불필요
# 페일: 설치 안 됨/게이트웨이 주소 없음이면 명확히 실패. setup-mac.sh 가 멱등이라 몇 번 돌려도 안전.
set -euo pipefail

LIVELY_HOME="${LIVELY_HOME:-$HOME/.lively}"
[ -r "$LIVELY_HOME/token" ] || { echo "✗ 설치되어 있지 않음(~/.lively/token 없음) — 먼저 설치하세요."; exit 1; }
TOKEN="$(cat "$LIVELY_HOME/token")"
GW="$([ -r "$LIVELY_HOME/gateway-url" ] && cat "$LIVELY_HOME/gateway-url" || echo "${LIVELY_GATEWAY_URL:-}")"
GW="${GW%/}"; GW="${GW%/mcp}"
[ -n "$GW" ] || { echo "✗ 게이트웨이 주소 없음(~/.lively/gateway-url)."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] 최신 묶음 다운로드 ← ${GW}/install"
curl -fsSL -H "Authorization: Bearer ${TOKEN}" "${GW}/install" -o "$TMP/bundle.tgz"

echo "[2/3] 압축 해제"
tar -xzf "$TMP/bundle.tgz" -C "$TMP"
[ -f "$TMP/setup/setup-mac.sh" ] || { echo "✗ 묶음 손상(setup-mac.sh 없음)"; exit 1; }

echo "[3/3] 멱등 재설치(업데이트)"
# setup-mac.sh 는 LIVELY_GATEWAY(=.../mcp)를 요구한다. GW 는 위에서 /mcp 가 벗겨졌으므로 다시 붙여 전달.
case "$GW" in */mcp) GW_MCP="$GW";; *) GW_MCP="$GW/mcp";; esac
LIVELY_TOKEN="$TOKEN" LIVELY_GATEWAY="$GW_MCP" bash "$TMP/setup/setup-mac.sh"

echo "✓ 업데이트 완료 — 다음 세션부터 최신 훅/설정 적용. (콘텐츠는 매 세션 자동 갱신.)"
