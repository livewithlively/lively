#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 중앙 박스 구성원 격리(#524) — 멤버 1인 OS 유저 프로비저닝(root). install-isolation.sh 뒤.
#   useradd box_<slug> + 홈 700 + box_members/lively-shared 그룹 + .lively(훅·컨텍스트 복사 + token 600)
#   + 홈 스켈레톤(.bash_profile 프롬프트·토큰로드, git 신원) + .claude dir(700, 로그인 대기).
#  멱등: 이미 있으면 갱신. claude 로그인(OAuth)은 별도 — 멤버가 자기 세션에서 1회(`claude` → /login),
#   자격증명은 그 멤버 홈 $HOME/.claude/.credentials.json(700 홈)에 떨어져 uid 로 격리된다.
#  ⚠ 디프로비저닝은 pkill -u box_<slug> 후 userdel -r (세션 프로세스 살아있으면 userdel 거부 — #524 교훈).
#
# 사용: sudo LIVELY_TOKEN=<membertoken> [MEMBER_NAME=..] [MEMBER_EMAIL=..] bash deploy/provision-member.sh <member-id-or-email>
#   slug = seam(terminal-sessions userSlug)과 동일 로직(불변식) — 게이트웨이가 세션에서 파생하는 osUser 와 일치.
# ─────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { echo "✗ root 필요: sudo bash $0 <member-id>"; exit 1; }
MEMBER="${1:-}"; [ -n "$MEMBER" ] || { echo "사용: sudo LIVELY_TOKEN=<t> bash $0 <member-id>"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ node 필요(slug 계산)"; exit 1; }

# slug — terminal-sessions.ts 의 slug() 과 **동일**: toLowerCase→[^a-z0-9]→'-'→트림→24 || 'user'
SLUG="$(node -e 'const s=String(process.argv[1]||"");process.stdout.write(s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24)||"user")' "$MEMBER")"
OSUSER="box_$SLUG"
HOME_DIR="/home/$OSUSER"
echo "멤버=$MEMBER  slug=$SLUG  osUser=$OSUSER"

# 그룹 보장(install-isolation.sh 가 이미 했어도 멱등)
getent group box_members   >/dev/null || groupadd box_members
getent group lively-shared >/dev/null || groupadd lively-shared

# 유저(멱등) — 홈·셸·그룹·비번잠금(대화형 로그인 불가; 진입은 게이트웨이 sudo→box-spawn 로만)
if id "$OSUSER" >/dev/null 2>&1; then
  usermod -aG box_members,lively-shared "$OSUSER"; echo "유저 $OSUSER 갱신"
else
  useradd -m -d "$HOME_DIR" -s /bin/bash -G box_members,lively-shared "$OSUSER"
  passwd -l "$OSUSER" >/dev/null 2>&1 || true
  echo "유저 $OSUSER 생성"
fi
chown "$OSUSER:$OSUSER" "$HOME_DIR"; chmod 700 "$HOME_DIR"   # ⭐ 홈 700 = 크레덴셜 격벽

# .lively — 훅·컨텍스트(공유 소스=게이트웨이 홈에서 복사, 멤버 소유) + token(멤버 600)
GW_LIVELY="${LIVELY_SHARED_DIR:-}"
if [ -z "$GW_LIVELY" ]; then
  GW="$(systemctl show -p User --value context-ontology-gateway 2>/dev/null || true)"
  [ -n "$GW" ] && GW_LIVELY="$(getent passwd "$GW" | cut -d: -f6)/.lively"
fi
install -d -m 700 -o "$OSUSER" -g "$OSUSER" "$HOME_DIR/.lively"
if [ -n "$GW_LIVELY" ] && [ -d "$GW_LIVELY" ]; then
  for item in hooks context.md org-name work-roots hooks-config.json mcp-servers.json auto-approve.json runtime gateway-url; do
    [ -e "$GW_LIVELY/$item" ] && cp -a "$GW_LIVELY/$item" "$HOME_DIR/.lively/" 2>/dev/null || true
  done
  echo ".lively 훅·컨텍스트 복사(from $GW_LIVELY)"
else
  echo "⚠ 게이트웨이 .lively 못찾음($GW_LIVELY) — 훅/컨텍스트 미복사(첫 세션 훅이 채우거나 수동)"
fi
# 멤버 토큰(있으면) — 훅/코덱스 MCP 가 이 멤버로 인증(600)
if [ -n "${LIVELY_TOKEN:-}" ]; then
  ( umask 077; printf '%s' "$LIVELY_TOKEN" > "$HOME_DIR/.lively/token" )
  echo ".lively/token 기록(멤버 600)"
fi
chown -R "$OSUSER:$OSUSER" "$HOME_DIR/.lively"

# 홈 스켈레톤 — 프롬프트(멤버 표시)·토큰 로드(비밀 리터럴 없음)
# 멱등 surgical: 기존 관리 블록(있으면)을 떼고 최신 블록을 다시 심는다 — 재프로비저닝(예: 게이트웨이 변경)에도
#   자가치유. 과거 `-z LIVELY_TOKEN` 가드는 옛 셸에 남은 stale 토큰이 파일 토큰을 shadow 해 401 을 유발했다.
BP="$HOME_DIR/.bash_profile"
BP_BEGIN="# >>> lively-managed (#524 구성원 프로필) >>>"
BP_END="# <<< lively-managed <<<"
if [ -f "$BP" ] && grep -qxF "$BP_BEGIN" "$BP"; then
  awk -v b="$BP_BEGIN" -v e="$BP_END" '$0==b{skip=1} skip{if($0==e)skip=0; next} {print}' "$BP" > "$BP.tmp" && mv "$BP.tmp" "$BP"
fi
cat >> "$BP" <<EOF
$BP_BEGIN
[ -r "\$HOME/.bashrc" ] && . "\$HOME/.bashrc"
export PS1='[$SLUG] \w \\\$ '
[ -r "\$HOME/.lively/token" ] && export LIVELY_TOKEN="\$(cat "\$HOME/.lively/token")"
$BP_END
EOF
chown "$OSUSER:$OSUSER" "$BP"; echo ".bash_profile 스켈레톤(프롬프트·토큰 로드 · 멱등 surgical)"

# git 신원(있으면) — 커밋이 멤버로 귀속
if [ -n "${MEMBER_NAME:-}" ]; then runuser -u "$OSUSER" -- git config --global user.name  "$MEMBER_NAME"  2>/dev/null || true; fi
if [ -n "${MEMBER_EMAIL:-}" ]; then runuser -u "$OSUSER" -- git config --global user.email "$MEMBER_EMAIL" 2>/dev/null || true; fi

# claude 설정 dir(멤버 700) — 로그인 대기
install -d -m 700 -o "$OSUSER" -g "$OSUSER" "$HOME_DIR/.claude"
# 개인 폴더(#524 ROOTS-under-isolation) — resolveRootPath 의 personal 루트 = $HOME/box (멤버 소유)
install -d -m 700 -o "$OSUSER" -g "$OSUSER" "$HOME_DIR/box"

# 멤버 claude 키트(훅 + lively MCP) — /install 번들을 멤버 토큰으로 받아 user-install + register-clients 를 **멤버로** 실행.
#  → ~/.claude/settings.json(훅)·~/.claude.json(lively MCP=멤버 토큰). 이게 없으면 격리 멤버 claude 가 lively 미연동(#524 갭).
#  best-effort: 실패해도 프로비저닝은 성공(OS 격리 자체는 됨). 게이트웨이가 떠 있어야(웹 provision 은 항상 그렇다) /install 다운로드 됨.
if [ -n "${LIVELY_TOKEN:-}" ]; then
  GW_URL="$(cat "$HOME_DIR/.lively/gateway-url" 2>/dev/null || echo "http://localhost:${PORT:-8080}")"; GW_URL="${GW_URL%/}"
  KTMP="$(mktemp -d)"
  if curl -fsSL -H "Authorization: Bearer $LIVELY_TOKEN" "$GW_URL/install" -o "$KTMP/b.tgz" 2>/dev/null \
     && tar -xzf "$KTMP/b.tgz" -C "$KTMP" 2>/dev/null && [ -f "$KTMP/setup/user-install.mjs" ]; then
    chown -R "$OSUSER:$OSUSER" "$KTMP"
    runuser -u "$OSUSER" -- env HOME="$HOME_DIR" LIVELY_TOKEN="$LIVELY_TOKEN" \
      node "$KTMP/setup/user-install.mjs" --harness claude >/dev/null 2>&1 || echo "  ⚠ user-install 경고(훅 머지)"
    runuser -u "$OSUSER" -- env HOME="$HOME_DIR" LIVELY_TOKEN="$LIVELY_TOKEN" STORE_URL="${GW_URL}/mcp" \
      bash "$KTMP/setup/register-clients.sh" >/dev/null 2>&1 || echo "  ⚠ MCP 등록 경고"
    echo "멤버 claude 키트 완료(settings.json 훅 + lively MCP=멤버 토큰)"
  else
    echo "  ⚠ kit 번들 다운로드 실패($GW_URL/install) — 훅/MCP 미설정. 세션은 뜨나 lively 미연동(게이트웨이/토큰 확인 후 재프로비저닝)."
  fi
  rm -rf "$KTMP"
fi

echo "✓ $OSUSER 프로비저닝 완료 (홈 700 · 그룹 · .lively · 스켈레톤 · .claude · box · 키트)"
echo "  로그인(멤버 1회, 자기 세션에서): claude → /login   (자격증명은 $HOME_DIR/.claude 에 격리)"
