#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 중앙 박스 구성원 격리(#524) — 박스 1회 설치(root). privsep 배선만.
#   ① box_members·lively-shared 그룹  ② box-spawn wrapper(/opt/lively/libexec, root:root 0755)
#   ③ 잠긴 sudoers(/etc/sudoers.d/lively) — 게이트웨이 유저가 box_members 로 wrapper 만 실행
#   ④ 게이트웨이 유저를 lively-shared 에(공유 워크스페이스 접근)
#  ⚠ P4(전용 lively 서비스 유저 전환·게이트웨이 docker 그룹 제거·ssm-user NOPASSWD 회수)는
#     별도 하드닝 런북 — 이 스크립트는 uid-격리 메커니즘만 깐다(무회귀: 게이트웨이 env 로 켜기 전엔 무효).
#
# 사용: sudo [GATEWAY_USER=<user>] bash deploy/linux/install-isolation.sh
#   GATEWAY_USER 기본 = context-ontology-gateway 유닛의 User= (없으면 SUDO_USER).
# ─────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { echo "✗ root 필요: sudo bash $0"; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 게이트웨이 유저(sudoers 주체) 결정: env > 유닛 User= > SUDO_USER
GW="${GATEWAY_USER:-}"
[ -n "$GW" ] || GW="$(systemctl show -p User --value context-ontology-gateway 2>/dev/null || true)"
[ -n "$GW" ] || GW="${SUDO_USER:-}"
[ -n "$GW" ] || { echo "✗ 게이트웨이 유저 결정 실패 — GATEWAY_USER=<user> 로 지정"; exit 1; }
id "$GW" >/dev/null 2>&1 || { echo "✗ 게이트웨이 유저 '$GW' 없음"; exit 1; }
echo "게이트웨이 유저(sudoers 주체) = $GW"

# ① 그룹
getent group box_members   >/dev/null || { groupadd box_members;   echo "groupadd box_members"; }
getent group lively-shared >/dev/null || { groupadd lively-shared; echo "groupadd lively-shared"; }
# ④ 게이트웨이 → lively-shared (공유 워크스페이스 read/write)
id -nG "$GW" | tr ' ' '\n' | grep -qx lively-shared || { usermod -aG lively-shared "$GW"; echo "usermod -aG lively-shared $GW (재로그인/서비스 재시작 후 반영)"; }

# ⑤ 공유 워크스페이스 dir(#524 ROOTS-under-isolation) — resolveRootPath 의 shared 루트. setgid 2775 로
#    새 파일이 lively-shared 그룹 상속 → 게이트웨이·멤버 공동 접근(개인 크레덴셜은 멤버 홈 700 에 별도 격리).
SHARED_DIR="${LIVELY_SHARED_DIR:-/srv/lively/shared}"
install -d -m 2775 -o root -g lively-shared "$SHARED_DIR"
chmod g+s "$SHARED_DIR"   # install -m 2775 로도 setgid 이지만 재실행 멱등 보강
echo "공유 워크스페이스 → $SHARED_DIR (root:lively-shared 2775 setgid)"

# ② box-spawn wrapper (root:root 0755) — 코드(terminal-isolation.ts BOX_SPAWN)와 경로 일치
install -d -m 0755 /opt/lively/libexec
install -m 0755 -o root -g root "$DIR/box-spawn" /opt/lively/libexec/box-spawn
echo "box-spawn → /opt/lively/libexec/box-spawn (root:root 0755)"
# ②-b provision-member(웹 프로비저닝용 root 스크립트) — deploy/provision-member.sh 의 root 소유본(게이트웨이 비쓰기).
#     웹 관리탭 [OS 격리 유저 만들기] 가 게이트웨이→잠긴 sudo→이 스크립트로 useradd. 코드(PROVISION_BIN)와 경로 일치.
install -m 0755 -o root -g root "$DIR/../provision-member.sh" /opt/lively/libexec/provision-member
echo "provision-member → /opt/lively/libexec/provision-member (root:root 0755)"

# ③ 잠긴 sudoers — 템플릿의 'lively' 주체를 실제 게이트웨이 유저로 치환, visudo 검증 후 설치
TMPS="$(mktemp)"
sed -E "s/^lively( +ALL=)/${GW}\\1/" "$DIR/sudoers-lively" > "$TMPS"
if visudo -cf "$TMPS" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "$TMPS" /etc/sudoers.d/lively
  echo "sudoers → /etc/sudoers.d/lively (주체=$GW, box_members 로 wrapper 만, NOPASSWD)"
else
  echo "✗ sudoers visudo 검증 실패 — 미설치(sudo 안전)"; rm -f "$TMPS"; exit 1
fi
rm -f "$TMPS"

echo "✓ 격리 인프라 설치 완료."
echo "  멤버 provision: 웹 관리탭 ▸ 중앙박스 계정 ▸ [🔒 OS 격리 유저 만들기]  또는  sudo LIVELY_TOKEN=<t> bash deploy/provision-member.sh <member-id>"
echo "  격리는 secure-by-default — provision 되면 그 멤버 '새 세션'부터 자동 격리(별도 켜기 불요). 끄려면 게이트웨이 env LIVELY_MEMBER_ISOLATION=off."
