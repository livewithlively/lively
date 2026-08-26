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
#   GATEWAY_USER 기본 = lively-gateway 유닛의 User= (없으면 SUDO_USER).
# ─────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || { echo "✗ root 필요: sudo bash $0"; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 게이트웨이 유저(sudoers 주체) 결정: env > 유닛 User= > SUDO_USER
GW="${GATEWAY_USER:-}"
[ -n "$GW" ] || GW="$(systemctl show -p User --value lively-gateway 2>/dev/null || true)"
[ -n "$GW" ] || GW="${SUDO_USER:-}"
[ -n "$GW" ] || { echo "✗ 게이트웨이 유저 결정 실패 — GATEWAY_USER=<user> 로 지정"; exit 1; }
id "$GW" >/dev/null 2>&1 || { echo "✗ 게이트웨이 유저 '$GW' 없음"; exit 1; }
echo "게이트웨이 유저(sudoers 주체) = $GW"

# ① 그룹
getent group box_members   >/dev/null || { groupadd box_members;   echo "groupadd box_members"; }
getent group lively-shared >/dev/null || { groupadd lively-shared; echo "groupadd lively-shared"; }
# ①-b 브로커(#746 T4): broker_members(sudoers runas 제한) + lively-broker(브로커 소켓 접근 그룹 — 게이트웨이만, 멤버 제외)
getent group broker_members >/dev/null || { groupadd broker_members; echo "groupadd broker_members"; }
getent group lively-broker  >/dev/null || { groupadd lively-broker;  echo "groupadd lively-broker"; }
# ④ 게이트웨이 → lively-shared (공유 워크스페이스) + lively-broker (브로커 소켓 연결)
id -nG "$GW" | tr ' ' '\n' | grep -qx lively-shared || { usermod -aG lively-shared "$GW"; echo "usermod -aG lively-shared $GW (재로그인/서비스 재시작 후 반영)"; }
id -nG "$GW" | tr ' ' '\n' | grep -qx lively-broker || { usermod -aG lively-broker "$GW"; echo "usermod -aG lively-broker $GW (브로커 소켓 접근 — 서비스 재시작 후 반영)"; }

# ⑤-b 브로커 소켓 디렉토리(#746 T4) — root:lively-broker 2770(setgid) → 소켓이 lively-broker 그룹 상속(게이트웨이만 접근).
#   /run 은 tmpfs(재부팅 소멸) → systemd-tmpfiles 로 부팅 시 재생성. broker_<slug>(lively-broker)만 여기 소켓 생성.
BROKER_RUN_DIR="/run/lively-broker"
install -d -m 2770 -o root -g lively-broker "$BROKER_RUN_DIR"; chmod g+s "$BROKER_RUN_DIR"
if [ -d /etc/tmpfiles.d ]; then
  echo "d $BROKER_RUN_DIR 2770 root lively-broker -" > /etc/tmpfiles.d/lively-broker.conf
  echo "tmpfiles → /etc/tmpfiles.d/lively-broker.conf (부팅 시 $BROKER_RUN_DIR 재생성)"
fi
echo "브로커 소켓 디렉토리 → $BROKER_RUN_DIR (root:lively-broker 2770 setgid)"

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
# ②-cg box-cgspawn wrapper(#1059 D — per-session cgroup 메모리 격리, root:root 0755) — 코드(terminal-isolation.ts
#     BOX_CGSPAWN)·sudoers Cmnd 와 경로 일치. 게이트웨이가 root 로 이것만 호출해 systemd-run --scope 로 세션을
#     MemoryHigh/Max scope 에 가둔다(비-root 는 polkit 때문에 cgroup 불가). systemd-run/cgroup2 부재 박스에선
#     wrapper 내부가 runuser 폴백(무회귀). 파일은 어디에나 깔아도 무해 — 실제 사용은 게이트웨이 코드가 게이트.
install -m 0755 -o root -g root "$DIR/box-cgspawn" /opt/lively/libexec/box-cgspawn
echo "box-cgspawn → /opt/lively/libexec/box-cgspawn (root:root 0755, #1059 D per-session cgroup)"
# ②-b provision-member(웹 프로비저닝용 root 스크립트) — deploy/provision-member.sh 의 root 소유본(게이트웨이 비쓰기).
#     웹 관리탭 [OS 격리 유저 만들기] 가 게이트웨이→잠긴 sudo→이 스크립트로 useradd. 코드(PROVISION_BIN)와 경로 일치.
install -m 0755 -o root -g root "$DIR/../provision-member.sh" /opt/lively/libexec/provision-member
echo "provision-member → /opt/lively/libexec/provision-member (root:root 0755)"
# ②-c install-claude-user(멤버 네이티브 claude 설치 헬퍼 #1023) — provision-member 가 새 멤버 홈에
#     self-update claude(~/.local/bin) 를 깔 때 호출(root 전역 스테일 claude no_permissions 근절).
install -m 0755 -o root -g root "$DIR/../install-claude-user.sh" /opt/lively/libexec/install-claude-user
echo "install-claude-user → /opt/lively/libexec/install-claude-user (root:root 0755)"
# ②-d install-codex-user(멤버 홈 codex + npm prefix 헬퍼) — claude 와 같은 이유의 codex 판.
#     codex 는 시작 시 `npm install -g @openai/codex` 로 자기를 올리는데, root 전역 설치면 멤버가 못 써서
#     EACCES 로 **즉시 종료**된다(끄는 플래그 없음). prefix 를 멤버 홈으로 돌려 자기 홈에 쓰게 한다.
install -m 0755 -o root -g root "$DIR/../install-codex-user.sh" /opt/lively/libexec/install-codex-user
echo "install-codex-user → /opt/lively/libexec/install-codex-user (root:root 0755)"

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
