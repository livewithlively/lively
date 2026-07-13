#!/usr/bin/env bash
# per-member 브로커 격리 E2E(#746 T4) — 박스에서 sudo 로 실행(실 uid·소켓 권한 검증). 세션 샌드박스 불가.
#  증명: 전용 uid(broker_t) 브로커의 unix 소켓(group=lively, 0660)을
#   (b) 게이트웨이 대역 gw_t(lively 그룹)는 exec 호출 가능,
#   (c) 멤버 대역 box_t(lively 그룹 아님)는 소켓 연결 불가(EACCES),
#   (d) box_t 는 브로커 프로세스 env(자격)도 못 읽음(/proc/<pid>/environ, 다른 uid).
#  실행(박스): CO=/home/ubuntu/co-t4 bash $CO/scripts/integration/broker-isolation.sh
set -uo pipefail
CO="${CO:-/home/ubuntu/co-t4}"
T=/tmp/brokertest
LOG=/tmp/broker-t.log   # $T 는 root 소유라 실행 셸(ubuntu)이 못 씀 → 로그는 별도 ubuntu-쓰기가능 경로
BROKER_U=broker_t; GW_U=gw_t; MEMBER_U=box_t; GRP=lively
FAKE_SECRET="super-secret-token-DO-NOT-LEAK"
fail=0; note(){ echo "  $*"; }
pass(){ echo "ok  $*"; }
bad(){ echo "FAIL $*"; fail=1; }

cleanup(){
  [ -n "${BPID:-}" ] && sudo kill "$BPID" 2>/dev/null
  sudo pkill -u "$BROKER_U" 2>/dev/null
  sudo rm -rf "$T" "$LOG"
  for u in "$BROKER_U" "$GW_U" "$MEMBER_U"; do sudo userdel "$u" 2>/dev/null; done
}
trap cleanup EXIT

echo "=== 준비: 그룹/유저/디렉토리 ==="
getent group "$GRP" >/dev/null || sudo groupadd "$GRP"
sudo useradd -M -s /usr/sbin/nologin "$BROKER_U" 2>/dev/null || true       # 브로커 전용 uid
sudo useradd -M -s /usr/sbin/nologin -G "$GRP" "$GW_U" 2>/dev/null || true  # 게이트웨이 대역(lively 그룹)
sudo useradd -M -s /bin/bash "$MEMBER_U" 2>/dev/null || true               # 멤버 대역(lively 그룹 아님)

sudo rm -rf "$T"; sudo mkdir -p "$T/broker" "$T/sock" "$T/work"
sudo cp "$CO"/dist/broker/*.js "$T/broker/"
echo '{"type":"module"}' | sudo tee "$T/package.json" >/dev/null
# 게이트웨이 대역이 client 로 호출하는 최소 caller
sudo tee "$T/call.mjs" >/dev/null <<'EOF'
import { brokerCall } from "./broker/client.js";
const [,, sock, req] = process.argv;
try { console.log(JSON.stringify(await brokerCall(sock, JSON.parse(req || "{}"), 8000))); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message, conn: true })); process.exitCode = 3; }
EOF
sudo chmod -R 755 "$T"
# 소켓 디렉토리: owner=broker_t, group=lively, setgid(2770) → 안에 만들어지는 소켓이 group lively 상속
sudo chown "$BROKER_U:$GRP" "$T/sock"; sudo chmod 2770 "$T/sock"
sudo chown "$BROKER_U:$GRP" "$T/work"; sudo chmod 2775 "$T/work"
SOCK="$T/sock/t.sock"

echo "=== 브로커 기동(uid=$BROKER_U, 자격 env 주입) ==="
sudo -u "$BROKER_U" env \
  LIVELY_BROKER_SOCKET="$SOCK" LIVELY_BROKER_MEMBER=t LIVELY_BROKER_WORKROOT="$T/work" \
  LIVELY_BROKER_ALLOWED_TOOLS=echo,true,git "SECRET_TOKEN=$FAKE_SECRET" \
  node "$T/broker/index.js" >"$LOG" 2>&1 &
# 소켓 디렉토리가 2770(제한)이라 ubuntu 는 stat 불가 → 준비체크·권한확인은 sudo(root)로.
for i in $(seq 1 40); do sudo test -S "$SOCK" && break; sleep 0.2; done
if ! sudo test -S "$SOCK"; then bad "브로커 소켓 미생성"; cat "$LOG" 2>/dev/null; exit 1; fi
BPID=$(pgrep -u "$BROKER_U" -f "broker/index.js" | head -1)
note "소켓 권한: $(sudo stat -c '%U:%G %a' "$SOCK")  브로커 pid: $BPID"

echo "=== (a) 소켓이 group=lively·0660 인가 ==="
perm=$(sudo stat -c '%G %a' "$SOCK")
[ "$perm" = "$GRP 660" ] && pass "(a) 소켓 group=$GRP mode=660" || bad "(a) 소켓 권한 예상밖: $perm"

echo "=== (b) 게이트웨이 대역(lively 그룹)은 exec 가능 ==="
R=$(cd "$T" && sudo -u "$GW_U" node "$T/call.mjs" "$SOCK" '{"op":"exec","tool":"echo","args":["ISOLATION-OK"]}' 2>&1)
note "gw 응답: $R"
echo "$R" | grep -q 'ISOLATION-OK' && pass "(b) 게이트웨이(lively 그룹) → exec 성공" || bad "(b) 게이트웨이가 exec 못함"

echo "=== (c) 멤버 대역(lively 그룹 아님)은 소켓 연결 불가 ==="
R=$(cd "$T" && sudo -u "$MEMBER_U" node "$T/call.mjs" "$SOCK" '{"op":"exec","tool":"echo","args":["SHOULD-NOT-RUN"]}' 2>&1)
note "member 응답: $R"
if echo "$R" | grep -qi 'EACCES\|permission denied\|conn'; then pass "(c) 멤버 → 소켓 연결 거부(EACCES)"; else bad "(c) 멤버가 소켓에 접근됨(격리 실패!): $R"; fi

echo "=== (d) 멤버는 브로커 자격(env)도 못 읽음 ==="
R=$(sudo -u "$MEMBER_U" cat "/proc/$BPID/environ" 2>&1 | tr '\0' '\n' | grep -c "$FAKE_SECRET")
if [ "$R" = "0" ]; then pass "(d) 멤버 → 브로커 env 자격 열람 불가"; else bad "(d) 멤버가 브로커 자격을 읽음(격리 실패!)"; fi

echo
[ "$fail" = "0" ] && echo "BROKER-ISOLATION(T4) ALL GREEN" || echo "BROKER-ISOLATION(T4) 실패 있음"
exit $fail
