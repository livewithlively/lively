#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 격리 멤버(#524) 훅 러너 리프레시 — 게이트웨이 업데이트(update.sh) 후 각 box_<slug> 멤버의
#  ~/.lively/hooks/*.mjs(run-custom 등)를 **현재 번들**로 갱신한다(root). 토큰·세션·settings·MCP 무영향
#  = 파일만 소유권 유지 복사(멱등·안전).
#
#  왜 필요한가(갭): 멤버 kit 은 첫 프로비저닝에만 설치되고(terminal-sessions.ts ensureMemberOsUser 빠른경로 —
#   이미 있으면 provision 스킵), 이후 세션에 재설치 안 됨. 그래서 게이트웨이 업데이트로 러너(예: #637 Stage2
#   run-custom 의 PostToolUse 전파)가 바뀌어도 이미 프로비저닝된 멤버 700홈엔 안 갔다. update.sh 가 격리 인프라
#   (install-isolation.sh)만 리프레시하고 멤버 kit 은 안 하던 갭 → 이 스크립트가 메운다.
#   러너 소스 = kit 첫 설치와 동일(user-install.mjs HOOK_SCRIPTS = kit/hooks 최상위 *.mjs).
#   토큰·게이트웨이·settings·MCP 는 그대로(멤버 신원·세션 무영향) — 러너 파일만 교체.
#
# 사용: sudo bash deploy/refresh-member-kits.sh   (update.sh 가 격리 박스에서 자동 호출)
# ─────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { echo "✗ root 필요: sudo bash $0"; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/../kit/hooks"
[ -d "$SRC" ] || { echo "번들 kit/hooks 없음($SRC) — 스킵"; exit 0; }

# 격리 멤버 = box_members 그룹의 보조멤버(provision-member.sh: useradd -G box_members). 없으면 no-op.
members="$(getent group box_members 2>/dev/null | awk -F: '{print $4}' | tr ',' ' ')"
[ -n "${members// /}" ] || { echo "격리 멤버 없음(box_members 비어있음) — 스킵"; exit 0; }

n=0
for u in $members; do
  id "$u" >/dev/null 2>&1 || continue
  h="$(getent passwd "$u" | cut -d: -f6)"
  [ -n "$h" ] || continue
  # 멤버 claude 자동 업데이트 백필(#1023) — 이미 프로비저닝된 멤버(첫 세션 게이트로 재프로비저닝 안 됨)의
  #  홈에 **네이티브** self-update claude 를 보장한다. root 전역 스테일 claude(no_permissions) → 멤버 소유
  #  self-update 로 전환(box-spawn PATH 가 ~/.local/bin 우선). 멱등·이미 있으면 스킵·OFFLINE 스킵·best-effort.
  #  훅 러너와 달리 kit 미설치 멤버(hooks 없음)도 대상 — claude 는 세션 필수라 미리 깔아둔다.
  if [ -f "$DIR/install-claude-user.sh" ]; then
    OFFLINE="${OFFLINE:-0}" bash "$DIR/install-claude-user.sh" "$u" || true
  fi
  # 이하 훅 러너 리프레시는 kit 설치 멤버(~/.lively/hooks 존재)만 — 첫 세션 프로비저닝이 설치한다.
  [ -d "$h/.lively/hooks" ] || continue
  cnt=0
  for f in "$SRC"/*.mjs; do
    [ -f "$f" ] || continue
    # 소유권=멤버, 파일만 교체(원자적 install). 러너는 node 가 읽어 실행(실행비트 불요) → 0644.
    install -o "$u" -g "$u" -m 0644 "$f" "$h/.lively/hooks/$(basename "$f")" && cnt=$((cnt + 1))
  done
  echo "  ✓ $u — 훅 러너 ${cnt}개 리프레시"
  n=$((n + 1))
done
echo "✓ 격리 멤버 훅 러너 리프레시 완료(${n}명, 소스=$SRC)"
