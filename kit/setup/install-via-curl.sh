#!/usr/bin/env bash
# curl 설치 부트스트랩 — git clone 없이 토큰게이트 /install 에서 발행 묶음을 받아 설치한다.
# 게이트웨이(context-ontology)가 DB→materialize→generator 로 발행 아티팩트를 tar.gz 로 동적 생성·스트림하고,
# 이 스크립트가 압축을 풀어 기존 setup-mac.sh 에 위임한다 — git clone 모델과 동일한 user-level end-state.
#
# 사용:
#   LIVELY_TOKEN=<발급토큰> LIVELY_GATEWAY=http://<host>:8080 bash install-via-curl.sh
# 또는 관리 UI '구성원' 탭에서 토큰을 발급하면 위 한 줄이 그대로 출력된다.
set -euo pipefail

: "${LIVELY_TOKEN:?LIVELY_TOKEN env 필요 — 관리자가 발급한 본인 토큰}"
: "${LIVELY_GATEWAY:?LIVELY_GATEWAY env 필요 — 예: http://<host>:8080}"

GW="${LIVELY_GATEWAY%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] 발행 묶음 다운로드 ← ${GW}/install"
curl -fsSL -H "Authorization: Bearer ${LIVELY_TOKEN}" "${GW}/install" -o "$TMP/bundle.tgz"

echo "[2/3] 압축 해제"
tar -xzf "$TMP/bundle.tgz" -C "$TMP"
[ -f "$TMP/setup/setup-mac.sh" ] || { echo "✗ 묶음에 setup/setup-mac.sh 가 없습니다(발행 손상)"; exit 1; }

echo "[3/3] 설치(setup-mac.sh — git clone 모델과 동일 end-state)"
# setup-mac.sh 는 LIVELY_GATEWAY(=.../mcp) 를 요구한다. GW 에 /mcp 가 없으면 붙여 전달.
case "$GW" in */mcp) GW_MCP="$GW";; *) GW_MCP="$GW/mcp";; esac
LIVELY_TOKEN="$LIVELY_TOKEN" LIVELY_GATEWAY="$GW_MCP" bash "$TMP/setup/setup-mac.sh"

echo "✓ 설치 완료 — 어느 폴더에서 켜든 컨텍스트+리플렉스가 적용됩니다."
echo "  제거: bash <(curl -fsSL ${GW}/install ...) 가 아니라, ~/.lively 가 자기완결 uninstall 을 동봉합니다(setup/uninstall-mac.sh)."
