#!/usr/bin/env bash
# per-member 브로커 격리 + 라우팅 E2E(#746 T4) — 박스에서 sudo 로 실행(실 uid·소켓 권한). 세션 샌드박스 불가.
#  증명: 전용 uid(broker_t) 브로커의 unix 소켓(group=lively, 0660)을
#   (a) group=lively·0660,
#   (b) 게이트웨이 대역 gw_t(lively 그룹)는 raw client 로 exec 가능,
#   (b2) routeToBroker(①)로도 exec 라우팅 가능,
#   (c) 멤버 대역 box_t(lively 그룹 아님)는 소켓 연결 불가(EACCES),
#   (d) box_t 는 브로커 프로세스 env(자격)도 못 읽음(/proc/<pid>/environ, 다른 uid).
#  브로커는 world-readable APP 복사본(/opt)에서 실행 — 프로덕션(/opt/context-ontology) 미러(node_modules 해결 + 멤버 uid 가독).
#  실행(박스): CO=/home/ubuntu/co-t4 bash $CO/scripts/integration/broker-isolation.sh
set -uo pipefail
CO="${CO:-/home/ubuntu/co-t4}"
APP=/opt/co-t4-test                # world-readable 앱 복사본(브로커·callers 실행 위치)
T=/tmp/brokertest                  # 제한 소켓 디렉토리(2770) + 임시
LOG=/tmp/broker-t.log
BROKER_U=broker_t; GW_U=gw_t; MEMBER_U=box_t; GRP=lively
FAKE_SECRET="super-secret-token-DO-NOT-LEAK"
fail=0; note(){ echo "  $*"; }; pass(){ echo "ok  $*"; }; bad(){ echo "FAIL $*"; fail=1; }

cleanup(){
  [ -n "${BPID:-}" ] && sudo kill "$BPID" 2>/dev/null
  sudo pkill -u "$BROKER_U" 2>/dev/null
  sudo rm -rf "$T" "$LOG" "$APP"
  for u in "$BROKER_U" "$GW_U" "$MEMBER_U"; do sudo userdel "$u" 2>/dev/null; done
}
trap cleanup EXIT

echo "=== 준비: 그룹/유저/앱복사본/소켓디렉토리 ==="
getent group "$GRP" >/dev/null || sudo groupadd "$GRP"
sudo useradd -M -s /usr/sbin/nologin "$BROKER_U" 2>/dev/null || true       # 브로커 전용 uid
sudo useradd -M -s /usr/sbin/nologin -G "$GRP" "$GW_U" 2>/dev/null || true  # 게이트웨이 대역(lively 그룹)
sudo useradd -M -s /bin/bash "$MEMBER_U" 2>/dev/null || true               # 멤버 대역(lively 그룹 아님)

# world-readable 앱 복사본(prod /opt/context-ontology 미러) — 브로커 uid·gw_t·box_t 모두 읽기 가능
sudo rm -rf "$APP"; sudo mkdir -p "$APP"
sudo cp -a "$CO/dist" "$CO/node_modules" "$CO/package.json" "$APP/"
sudo chmod -R a+rX "$APP"
# 게이트웨이-측 caller(raw client / routeToBroker) — $APP 의 dist 를 절대경로 import
sudo rm -rf "$T"; sudo mkdir -p "$T/sock"; echo '{"type":"module"}' | sudo tee "$T/package.json" >/dev/null
sudo tee "$T/call.mjs" >/dev/null <<EOF
import { brokerCall } from "$APP/dist/broker/client.js";
const [,, sock, req] = process.argv;
try { console.log(JSON.stringify(await brokerCall(sock, JSON.parse(req || "{}"), 8000))); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message, conn: true })); process.exitCode = 3; }
EOF
sudo tee "$T/route-call.mjs" >/dev/null <<EOF
import { routeToBroker } from "$APP/dist/broker/route.js";
const [,, slug, req] = process.argv;
try { console.log(JSON.stringify(await routeToBroker(slug, JSON.parse(req || "{}"), () => {}))); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 3; }
EOF
sudo chmod -R 755 "$T"/*.mjs "$T/package.json"
# 소켓 디렉토리: owner=broker_t, group=lively, setgid(2770) → 소켓이 group lively 상속
sudo chown "$BROKER_U:$GRP" "$T/sock"; sudo chmod 2770 "$T/sock"
sudo mkdir -p "$T/work"; sudo chown "$BROKER_U:$GRP" "$T/work"; sudo chmod 2775 "$T/work"
SOCK="$T/sock/t.sock"

echo "=== 브로커 기동(uid=$BROKER_U, 자격 env 주입, APP=$APP) ==="
sudo -u "$BROKER_U" env \
  LIVELY_BROKER_SOCKET="$SOCK" LIVELY_BROKER_MEMBER=t LIVELY_BROKER_WORKROOT="$T/work" \
  LIVELY_BROKER_ALLOWED_TOOLS=echo,true,git "SECRET_TOKEN=$FAKE_SECRET" \
  node "$APP/dist/broker/index.js" >"$LOG" 2>&1 &
for i in $(seq 1 40); do sudo test -S "$SOCK" && break; sleep 0.2; done
if ! sudo test -S "$SOCK"; then bad "브로커 소켓 미생성"; cat "$LOG" 2>/dev/null; exit 1; fi
BPID=$(pgrep -u "$BROKER_U" -f "broker/index.js" | head -1)
note "소켓 권한: $(sudo stat -c '%U:%G %a' "$SOCK")  브로커 pid: $BPID"

echo "=== (a) 소켓 group=lively·0660 ==="
perm=$(sudo stat -c '%G %a' "$SOCK")
[ "$perm" = "$GRP 660" ] && pass "(a) 소켓 group=$GRP mode=660" || bad "(a) 소켓 권한 예상밖: $perm"

echo "=== (b) 게이트웨이 대역(lively 그룹) raw client → exec ==="
R=$(sudo -u "$GW_U" node "$T/call.mjs" "$SOCK" '{"op":"exec","tool":"echo","args":["ISOLATION-OK"]}' 2>&1)
note "gw 응답: $R"; echo "$R" | grep -q 'ISOLATION-OK' && pass "(b) 게이트웨이 raw exec 성공" || bad "(b) 실패: $R"

echo "=== (b2) 게이트웨이 라우팅(routeToBroker ①) → 멤버 브로커 exec ==="
R=$(sudo -u "$GW_U" env LIVELY_BROKER_SOCK_DIR="$T/sock" node "$T/route-call.mjs" t '{"op":"exec","tool":"echo","args":["ROUTED-OK"]}' 2>&1)
note "route 응답: $R"; echo "$R" | grep -q 'ROUTED-OK' && pass "(b2) routeToBroker → 브로커 exec 라우팅 성공" || bad "(b2) 실패: $R"

echo "=== (c) 멤버 대역(lively 그룹 아님) → 소켓 연결 불가 ==="
R=$(sudo -u "$MEMBER_U" node "$T/call.mjs" "$SOCK" '{"op":"exec","tool":"echo","args":["NO"]}' 2>&1)
note "member 응답: $R"
echo "$R" | grep -qi 'EACCES\|permission denied\|conn' && pass "(c) 멤버 → 소켓 EACCES 거부" || bad "(c) 멤버 접근됨(격리 실패!): $R"

echo "=== (d) 멤버 → 브로커 자격(env) 열람 불가 ==="
N=$(sudo -u "$MEMBER_U" cat "/proc/$BPID/environ" 2>&1 | tr '\0' '\n' | grep -c "$FAKE_SECRET")
[ "$N" = "0" ] && pass "(d) 멤버 → 브로커 자격 열람 불가" || bad "(d) 멤버가 자격 읽음(격리 실패!)"

echo
[ "$fail" = "0" ] && echo "BROKER-ISOLATION+ROUTE(T4) ALL GREEN" || echo "BROKER-ISOLATION+ROUTE(T4) 실패 있음"
exit $fail
