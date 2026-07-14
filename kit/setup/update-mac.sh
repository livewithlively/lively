#!/usr/bin/env bash
# 업데이트 — 설치된 토큰으로 최신 발행 묶음을 받아 멱등 재설치(install 의 대칭, self-contained).
#
# ⚠ **이건 이제 최후의 폴백이다. 평소 업데이트는 `lively update` 다(#864).**
#    ① 콘텐츠는 원래도 매 세션 자동  ② 키트(훅 코드·배선)도 session-preload 가 kit_version 을 비교해
#    백그라운드로 자동 재설치(#858, 적용은 다음 세션)  ③ 사람이 직접 맞춰야 할 땐 `lively update`.
#    이 스크립트가 남아 있는 이유는 하나 — **`lively` 자체가 없거나 깨졌을 때**(구세대 설치본, CLI 유실).
#    그런 경우가 아니면 `lively update` 를 써라(같은 일을 하고, MCP 재등록까지 한다).
#   bash update-mac.sh        # ~/.lively/token + gateway-url 을 읽음 — 토큰 재입력 불필요
# 페일: 설치 안 됨/게이트웨이 주소 없음이면 명확히 실패. setup-mac.sh 가 멱등이라 몇 번 돌려도 안전.
set -euo pipefail

# ⚠ LIVELY_HOME 은 키트 전체에서 **HOME 리다이렉트**다(.lively 디렉터리가 아니라) —
#  user-install.mjs·user-uninstall.mjs·self-update.mjs·lively CLI 가 전부 그 계약이다.
#  여기서만 '.lively 경로'로 쓰고 있었다(#864 에서 발견) → LIVELY_HOME 을 준 샌드박스에서 서로 다른 곳을 봤다.
LV_DIR="${LIVELY_HOME:-$HOME}/.lively"
[ -r "$LV_DIR/token" ] || { echo "✗ 설치되어 있지 않음(~/.lively/token 없음) — 먼저 설치하세요."; exit 1; }
TOKEN="$(cat "$LV_DIR/token")"
GW="$([ -r "$LV_DIR/gateway-url" ] && cat "$LV_DIR/gateway-url" || echo "${LIVELY_GATEWAY_URL:-}")"
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

echo "✓ 업데이트 완료 — 다음 세션부터 최신 훅/설정 적용."
echo "  (평소엔 자동입니다 — #858. 직접 맞춰야 할 땐 이제 'lively update' 를 쓰세요 — #864.)"
