#!/usr/bin/env bash
set -euo pipefail
# context-ontology 게이트웨이를 각 로컬 CLI 에 등록한다. (캐노니컬 멀티하네스 등록 스크립트 — 라벨/URL 변경은 여기 먼저)
#   STORE_URL    : 게이트웨이 주소 (기본 localhost — 조직 기본값은 콜사이트 setup 스크립트가 주입)
#   LIVELY_TOKEN : 본인 퍼유저 bearer 토큰 (.env 의 AUTH_TOKENS_JSON 키)
MCP_LABEL="lively"
STORE_URL="${STORE_URL:-http://localhost:8080/mcp}"
: "${LIVELY_TOKEN:?LIVELY_TOKEN 환경변수에 본인 토큰을 넣으세요}"

echo "▶ Claude Code"
# ⚠ **CLI 를 부르지 않는다.** 종전엔 `claude mcp add …` 를 셸에서 불렀는데, 매니지드 키트 시딩은 멤버 exec 중계를
#  타고 그 중계는 테넌트의 «항상 떠 있는» 컨테이너(tmux)로 나간다. 그 자리는 tmux 용으로 고른 것일 뿐 하네스
#  바이너리가 있는 자리라는 보장이 없다 — 이미지 분리로 claude 가 빠지자 `set -euo pipefail` 이 여기서 끊겨
#  **훅·settings.json·lib 까지 통째로** 안 심겼다(실측 2026-08-31 프로덕션, «claude: command not found»).
#  `claude mcp add --scope user` 가 하는 일은 ~/.claude.json 의 mcpServers 에 쓰는 것뿐이라 파일 쓰기로 내렸다.
#  이제 이 스크립트가 요구하는 건 **node 하나**다. 상세·실측 스키마는 setup/mcp-register.mjs 머리말.
#  ⚠ 이 파일이 캐노니컬이다(kit/setup/ 사본은 발행마다 여기서 re-vendor 된다) — 편집은 여기서.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#  번들 안에서는 setup/ 옆에, 레포에서는 kit/setup/ 에 있다.
MCP_REG=""
for c in "$SCRIPT_DIR/mcp-register.mjs" "$SCRIPT_DIR/../kit/setup/mcp-register.mjs"; do
  [ -f "$c" ] && { MCP_REG="$c"; break; }
done
if [ -n "$MCP_REG" ] && command -v node >/dev/null 2>&1; then
  node "$MCP_REG"
else
  echo "  ⚠️ MCP 등록기를 못 찾거나 node 가 없어 건너뜁니다(훅·설정은 그대로 심깁니다)."
fi


echo "▶ Codex — 이 스크립트는 codex 를 건드리지 않습니다."
echo "   codex 배선(MCP + 훅 + AGENTS.md)은 setup/user-install.mjs --harness codex 가 통째로 담당합니다:"
echo "     node setup/user-install.mjs --allow-host-effects --harness codex"
echo "   (#1475 부터 claude 와 같은 stdio 프록시로 등록되므로 x-lively-session·x-lively-mode 도 함께 실립니다 —"
echo "    codex 의 http_headers 는 정적값이라 http 직결로는 그 둘을 보낼 수 없었습니다."
echo "    수동 http 직결이 필요하면 ~/.lively/mcp-transport 에 http 를 적고 재설치하세요.)"

echo
echo "▶ openclaw — openclaw.json 의 mcpServers 에 추가 (\${LIVELY_TOKEN} 은 환경변수 참조 — 토큰 값을 직접 적지 말 것):"
cat <<EOF
{
  "mcpServers": {
    "${MCP_LABEL}": {
      "type": "http",
      "url": "${STORE_URL}",
      "headers": {
        "Authorization": "Bearer \${LIVELY_TOKEN}",
        "x-lively-mode": "\${LIVELY_MODE:-}",
        "x-lively-workspace": "\${LVLY_TENANT_SLUG:-}"
      }
    }
  }
}
EOF

echo
echo "▶ pi — native MCP 미지원. pi-mcp-adapter 확장에 동일 URL/토큰 등록."
