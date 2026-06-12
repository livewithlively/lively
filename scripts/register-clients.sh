#!/usr/bin/env bash
set -euo pipefail
# context-ontology 게이트웨이를 각 로컬 CLI 에 등록한다. (캐노니컬 멀티하네스 등록 스크립트 — 라벨/URL 변경은 여기 먼저)
#   STORE_URL    : 게이트웨이 주소 (기본 localhost — 조직 기본값은 콜사이트 setup 스크립트가 주입)
#   LIVELY_TOKEN : 본인 퍼유저 bearer 토큰 (.env 의 AUTH_TOKENS_JSON 키)
MCP_LABEL="lively"
STORE_URL="${STORE_URL:-http://localhost:8080/mcp}"
: "${LIVELY_TOKEN:?LIVELY_TOKEN 환경변수에 본인 토큰을 넣으세요}"

echo "▶ Claude Code"
claude mcp remove "$MCP_LABEL" 2>/dev/null || true
claude mcp add --transport http --scope user "$MCP_LABEL" "$STORE_URL" \
  --header "Authorization: Bearer ${LIVELY_TOKEN}"

echo
echo "▶ Codex — ~/.codex/config.toml 에 아래 추가 (토큰은 LIVELY_TOKEN 환경변수로):"
cat <<EOF
[mcp_servers.${MCP_LABEL}]
url = "${STORE_URL}"
bearer_token_env_var = "LIVELY_TOKEN"
EOF

echo
echo "▶ openclaw — openclaw.json 의 mcpServers 에 추가 (\${LIVELY_TOKEN} 은 환경변수 참조 — 토큰 값을 직접 적지 말 것):"
cat <<EOF
{
  "mcpServers": {
    "${MCP_LABEL}": {
      "type": "http",
      "url": "${STORE_URL}",
      "headers": { "Authorization": "Bearer \${LIVELY_TOKEN}" }
    }
  }
}
EOF

echo
echo "▶ pi — native MCP 미지원. pi-mcp-adapter 확장에 동일 URL/토큰 등록."
