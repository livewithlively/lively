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
# #1079 — lively 본체는 **로컬 stdio 프록시**(`lively mcp`)로 등록한다. http 직결이면 세션이 뜨는 순간
#  게이트웨이에 못 닿을 때(사내 게이트웨이 + VPN 미접속) Claude Code 가 그 서버를 failed 로 마킹하고
#  **그 세션 내내 복구하지 않는다** — 사람이 `/mcp reconnect lively` 를 직접 쳐야 했다.
#  stdio 는 로컬 프로세스라 항상 connected 이고, 상류가 살아나면 tools/list_changed 로 되살아난다.
#  종전 헤더(Authorization·x-lively-session#852·x-lively-mode#1007+)는 사라진 게 아니라 **프록시가
#  ~/.lively/token 과 세션 env 에서 읽어 상류 호출에 붙인다**(kit/cli/lively-mcp-gateway.mjs).
#  ⚠ kit/cli/lively.mjs registerLivelyMcp 와 **같은 transport 를 유지할 것**(lively.test.mjs ④ 가 두 트윈을 함께 못박는다).
LIVELY_SHIM="${LIVELY_SHIM:-$HOME/.lively/bin/lively}"
if [ -x "$LIVELY_SHIM" ] && [ -f "$HOME/.lively/lib/lively-mcp-gateway.mjs" ] \
   && [ "$(cat "$HOME/.lively/mcp-transport" 2>/dev/null || true)" != "http" ]; then
  claude mcp add --transport stdio --scope user "$MCP_LABEL" "$LIVELY_SHIM" mcp
  echo "  ✓ ${MCP_LABEL} (stdio 프록시 → ${STORE_URL})"
else
  # 폴백 — 프록시 미설치(CLI 설치 전·구버전 번들)이거나 롤백 스위치(~/.lively/mcp-transport=http)면 종전 http 직결.
  #  작은따옴표 = 셸 확장 금지(설정엔 리터럴, Claude Code 가 연결 시 제 env 로 확장).
  #  `:-` 기본값이 필수 — 없으면 세션 밖(랩탑)에서 "Missing environment variables" 경고가 뜬다(실측 2.1.209).
  claude mcp add --transport http --scope user "$MCP_LABEL" "$STORE_URL" \
    --header "Authorization: Bearer ${LIVELY_TOKEN}" \
    --header 'x-lively-session: ${LIVELY_SESSION_ID:-}' \
    --header 'x-lively-mode: ${LIVELY_MODE:-}'
  echo "  ✓ ${MCP_LABEL} (http 직결 — 프록시 미설치/롤백)"
fi

# ── 추가 MCP 서버(org_mcp_server) — mcp-servers.json 순회 등록(claude). lively 는 위에서 등록됨. ──
#  소스 우선순위: MCP_SERVERS_FILE env > 번들 ../.lively/mcp-servers.json > ~/.lively/mcp-servers.json.
#  파싱은 node(부재 시 스킵 — jq 의존 회피). 인증은 auth_env(환경변수 '이름') 간접참조 — 토큰 리터럴 없음.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_FILE="${MCP_SERVERS_FILE:-}"
[ -z "$MCP_FILE" ] && [ -f "$SCRIPT_DIR/../.lively/mcp-servers.json" ] && MCP_FILE="$SCRIPT_DIR/../.lively/mcp-servers.json"
[ -z "$MCP_FILE" ] && [ -f "$HOME/.lively/mcp-servers.json" ] && MCP_FILE="$HOME/.lively/mcp-servers.json"
if [ -n "$MCP_FILE" ] && [ -f "$MCP_FILE" ] && command -v node >/dev/null 2>&1; then
  echo "  추가 MCP 서버 ← ${MCP_FILE}"
  node -e 'const fs=require("fs");let d={};try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}for(const s of (d.servers||[])){if(s.enabled===false)continue;if((s.name||"")==="lively")continue;process.stdout.write([s.name||"",s.transport||"http",s.url||"",s.command||"",s.auth_env||""].join("\t")+"\n")}' "$MCP_FILE" \
  | while IFS="$(printf '\t')" read -r name transport url command auth_env; do
      [ -z "$name" ] && continue
      # 비파괴 라운드트립 — 유저가 설치 전부터 쓰던 항목을 덮어쓰기 전 최초 1회 스냅샷(uninstall 원복용). lively.mjs backupUserMcp 와 동형.
      node -e 'const fs=require("fs"),p=require("path");const[n,cj,bk]=process.argv.slice(1);let b={};try{b=JSON.parse(fs.readFileSync(bk,"utf8"))||{}}catch{}if(Object.prototype.hasOwnProperty.call(b,n))process.exit(0);let e=null;try{e=JSON.parse(fs.readFileSync(cj,"utf8"))?.mcpServers?.[n]??null}catch{}b[n]=e;try{fs.mkdirSync(p.dirname(bk),{recursive:true})}catch{}try{fs.writeFileSync(bk,JSON.stringify(b,null,2)+"\n",{mode:0o600})}catch{}' "$name" "$HOME/.claude.json" "$HOME/.lively/mcp-user-backup.json" 2>/dev/null || true
      claude mcp remove "$name" 2>/dev/null || true
      if [ "$transport" = "stdio" ]; then
        # $command 는 의도적 word-split(claude stdio 는 command+args 를 분리 인자로 받음). glob 확장만 차단(set -f).
        #  한계: 단일 인자에 공백이 있는 경로/값은 미지원(현재 command 는 공백구분 토큰만).
        [ -n "$command" ] && { set -f; claude mcp add --transport stdio --scope user "$name" $command && echo "  ✓ $name (stdio)" || echo "  ⚠️ $name 등록 실패"; set +f; }
      else
        tok=""; [ -n "$auth_env" ] && eval "tok=\${$auth_env:-}"
        if [ -n "$tok" ]; then
          claude mcp add --transport http --scope user "$name" "$url" --header "Authorization: Bearer ${tok}" && echo "  ✓ $name (http)" || echo "  ⚠️ $name 등록 실패"
        else
          claude mcp add --transport http --scope user "$name" "$url" && echo "  ✓ $name (http, 무인증 — auth_env 미설정/미존재)" || echo "  ⚠️ $name 등록 실패"
        fi
      fi
    done
fi

echo
echo "▶ Codex — 이 스크립트는 codex 를 건드리지 않습니다."
echo "   codex 배선(MCP + 훅 + AGENTS.md)은 setup/user-install.mjs --harness codex 가 통째로 담당합니다:"
echo "     node setup/user-install.mjs --harness codex"
echo "   (claude 와 같은 stdio 프록시로 등록되므로 x-lively-session·x-lively-mode 도 함께 실립니다."
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
        "x-lively-mode": "\${LIVELY_MODE:-}"
      }
    }
  }
}
EOF

echo
echo "▶ pi — native MCP 미지원. pi-mcp-adapter 확장에 동일 URL/토큰 등록."
