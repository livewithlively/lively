#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 격리 멤버(#524) 훅 러너 리프레시 — 게이트웨이 업데이트(update.sh) 후 각 box_<slug> 멤버의
#  ~/.lively 훅 런타임을 **현재 번들**로 갱신한다(root). 토큰·세션·settings·MCP 무영향
#  = 파일만 소유권 유지 복사(멱등·안전).
#
#  왜 필요한가(갭): 멤버 kit 은 첫 프로비저닝에만 설치되고(terminal-sessions.ts ensureMemberOsUser 빠른경로 —
#   이미 있으면 provision 스킵), 이후 세션에 재설치 안 됨. 그래서 게이트웨이 업데이트로 러너(예: #637 Stage2
#   run-custom 의 PostToolUse 전파)가 바뀌어도 이미 프로비저닝된 멤버 홈엔 안 갔다. update.sh 가 격리 인프라
#   (install-isolation.sh)만 리프레시하고 멤버 kit 은 안 하던 갭 → 이 스크립트가 메운다.
#   토큰·게이트웨이·settings·MCP 는 그대로(멤버 신원·세션 무영향) — 훅 런타임 파일만 교체.
#
#  ⚠ 무엇을 복사할지 **여기서 정하지 않는다**(2026-08-27 회귀). 종전엔 `kit/hooks/*.mjs` 글롭이었는데,
#   그 글롭이 최초 설치기(user-install.mjs)와 조용히 어긋나 세 가지를 동시에 틀렸다:
#     · hooks/ 밖의 공유 모듈(lib/host-effects.mjs)을 못 날라 **설치 멤버 전원의 훅이 전멸**
#     · opencode-plugin.js 를 놓침(확장자가 .js 라 *.mjs 에 미매치)
#     · 반대로 .test.mjs 25개를 멤버 홈에 뿌림
#   목록은 kit/setup/kit-manifest.mjs 단일 출처가 갖고, 이 스크립트는 그걸 **읽어 갈 뿐**이다.
#   그리고 **스테이지에 먼저 깔아 verify-kit-install.mjs 로 검증한 뒤에만** 살아 있는 트리로 옮긴다.
#   훅은 non-blocking 이라 깨져도 세션이 떠서, 이 확인이 없으면 다음 사고도 사용자 제보로만 발견된다.
#
#  ⭐ 불변식: **검증에 실패한 훅 런타임은 멤버에게 닿지 않는다.**
#   왜 «덮어쓰고 검증» 으로는 부족한가 — 훅이 깨지면 self-update 를 띄우는 유일한 주체(session-preload)가
#   함께 죽는다(session-preload.mjs:468 이 유일 호출부). 즉 한 번 나쁜 kit 이 실리면 멤버는 **스스로
#   복구할 수 없고** 관리자가 홈마다 손대야 한다(2026-08-27 실측). 그래서 «닿기 전에» 걸러야 한다.
#
# 사용: sudo bash deploy/refresh-member-kits.sh   (update.sh 가 격리 박스에서 자동 호출)
# ─────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { echo "✗ root 필요: sudo bash $0"; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$DIR/.." && pwd)/kit"
MANIFEST="$KIT/setup/kit-manifest.mjs"
VERIFY="$KIT/setup/verify-kit-install.mjs"
[ -d "$KIT/hooks" ] || { echo "번들 kit/hooks 없음($KIT/hooks) — 스킵"; exit 0; }

# 설치 목록은 매니페스트에서만 온다 — node 가 없으면 목록을 알 수 없으므로 **추측해서 복사하지 않는다**
#  (글롭 폴백을 두면 이 회귀가 그대로 되살아난다). 게이트웨이 박스엔 node 가 항상 있다(deploy/lib/common.sh).
command -v node >/dev/null 2>&1 || { echo "✗ node 없음 — 설치 목록을 읽을 수 없어 리프레시 중단"; exit 1; }
[ -f "$MANIFEST" ] || { echo "✗ 설치 매니페스트 없음($MANIFEST) — 리프레시 중단"; exit 1; }
PLAN="$(node "$MANIFEST" --install-plan --kit-root "$KIT")" || { echo "✗ 설치 목록 조회 실패($MANIFEST)"; exit 1; }
[ -n "$PLAN" ] || { echo "✗ 설치 목록이 비어 있음 — 리프레시 중단"; exit 1; }

# 격리 멤버 = box_members 그룹의 보조멤버(provision-member.sh: useradd -G box_members). 없으면 no-op.
members="$(getent group box_members 2>/dev/null | awk -F: '{print $4}' | tr ',' ' ')"
[ -n "${members// /}" ] || { echo "격리 멤버 없음(box_members 비어있음) — 스킵"; exit 0; }

n=0
failed=0
# 번들에 없는 파일(매니페스트와 불일치) 총계 — **경고로 끝내지 않는다**.
#  2026-08-27 사고가 정확히 이 모양이었다: 공유 모듈 하나가 번들에서 빠져 전 멤버의 훅이 죽었는데,
#  리프레시는 «성공»으로 끝나 배포 로그에 아무 신호가 없었다. 부르는 쪽(update.sh)은 `|| warn` 이라
#  **종료코드가 유일한 신호**다 — 누락이 하나라도 있으면 1로 알린다.
missing_total=0
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

  # ── ① 스테이징에 먼저 깔고 검증한다 — 살아 있는 트리는 아직 건드리지 않는다 ─────────────
  #  ⚠ 이 순서가 핵심이다(2026-08-27 사고의 근본 처방). 종전엔 «덮어쓰고 → 검증» 이라, 나쁜 번들이 실리면
  #   검증이 실패를 알려줄 때는 **이미 멤버가 깨진 뒤**였다. 그리고 그 상태에서 자가치유가 불가능하다:
  #   self-update 를 띄우는 곳은 session-preload 하나뿐인데(session-preload.mjs:468) 그 session-preload
  #   자신이 방금 덮어쓴 트리 안에 산다 — 트리가 깨지면 **복구를 실행할 주체가 함께 죽는다**. 그래서
  #   그날 관리자가 홈마다 파일을 손으로 복사해야 했다.
  #   스테이지에서 먼저 검증하면 나쁜 번들은 **아무에게도 닿지 않는다** — 멤버는 돌던 kit 을 그대로 쓴다.
  stage="$h/.lively/.refresh-stage"
  rm -rf "$stage"
  install -d -o "$u" -g "$u" -m 0755 "$stage"
  cnt=0
  gone=0
  while IFS=$'\t' read -r src dest; do
    [ -n "$src" ] || continue
    if [ ! -f "$src" ]; then
      gone=$((gone + 1)); echo "    ⚠ 번들에 없음(매니페스트와 불일치): $src"; continue
    fi
    # 대상 디렉터리는 **멤버 소유**로 만든다 — root 소유로 만들면 이후 멤버 권한으로 도는 자동 업데이트
    #  (user-install)이 그 안에 못 써서 다음 업데이트가 조용히 실패한다.
    d="$stage/$(dirname "$dest")"
    [ -d "$d" ] || install -d -o "$u" -g "$u" -m 0755 "$d"
    # 소유권=멤버, 파일만 교체(원자적 install). 러너는 node 가 읽어 실행(실행비트 불요) → 0644.
    if install -o "$u" -g "$u" -m 0644 "$src" "$stage/$dest"; then cnt=$((cnt + 1)); fi
  done <<EOF
$PLAN
EOF

  # 스테이지가 실제로 import 를 푸는가 — 개수가 아니라 **실행 가능성**을 본다.
  if ! vout="$(node "$VERIFY" "$stage" 2>&1)"; then
    failed=$((failed + 1))
    echo "  ✗ $u — 새 훅 런타임이 검증에 실패해 **적용하지 않았다**(기존 트리 유지 — 이 멤버는 계속 동작한다):"
    printf '%s\n' "$vout" | sed 's/^/      /'
    if [ "$gone" -ne 0 ]; then
      echo "      ⚠ 번들 누락 ${gone}건(위 목록)"
      missing_total=$((missing_total + gone))
    fi
    rm -rf "$stage"
    n=$((n + 1))
    continue
  fi

  # ── ② 검증을 통과한 것만 살아 있는 트리로 옮긴다 ───────────────────────────────────
  while IFS=$'\t' read -r src dest; do
    [ -n "$src" ] || continue
    [ -f "$stage/$dest" ] || continue
    d="$h/.lively/$(dirname "$dest")"
    [ -d "$d" ] || install -d -o "$u" -g "$u" -m 0755 "$d"
    install -o "$u" -g "$u" -m 0644 "$stage/$dest" "$h/.lively/$dest"
  done <<EOF
$PLAN
EOF
  rm -rf "$stage"

  # 옮긴 뒤 실제 트리도 한 번 더 본다 — 스테이지엔 없던 잔존물이 폐포를 깨는 경우까지 잡는다.
  if vout="$(node "$VERIFY" "$h/.lively" 2>&1)"; then
    echo "  ✓ $u — 훅 런타임 ${cnt}개 리프레시 · 설치 검증 통과"
  else
    failed=$((failed + 1))
    echo "  ✗ $u — 적용 후 검증 실패(이 멤버의 훅은 동작하지 않는다):"
    printf '%s\n' "$vout" | sed 's/^/      /'
  fi
  if [ "$gone" -ne 0 ]; then
    echo "    ⚠ $u — 번들 누락 ${gone}건(위 목록)"
    missing_total=$((missing_total + gone))
  fi
  n=$((n + 1))
done
echo "✓ 격리 멤버 훅 러너 리프레시 완료(${n}명, 소스=$KIT)"
if [ "$failed" -gt 0 ]; then
  echo "✗ 그중 ${failed}명은 설치 검증 실패 — 훅이 죽은 채로 세션이 뜬다(위 진단 참조)"
  exit 1
fi
# ⚠ 검증을 통과했더라도 **번들↔매니페스트 불일치**는 그 자체로 실패다. verify 는 «심어진 트리가 import 를
#  푸는가»를 보므로, 빠진 파일을 아무 훅도 아직 import 하지 않으면 조용히 통과한다 — 그 상태로 배포가
#  «성공»하면 다음 훅이 그걸 import 하는 순간 전 멤버가 죽는다(2026-08-27). 여기서 끊는다.
if [ "$missing_total" -gt 0 ]; then
  echo "✗ 번들에 없는 설치 대상 ${missing_total}건 — 발행 번들과 kit-manifest 가 어긋났다(위 ⚠ 목록)"
  exit 1
fi
