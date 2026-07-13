#!/usr/bin/env bash
# per-member 브로커 '암묵 auto-spawn' E2E(#746 T4 ②) — 박스 sudo. 살아있는 게이트웨이/실 sudoers 무접촉(테스트 전용 sudoers).
#  증명(사용자 Q2 "명시적이지 않은 트리거"): routeToBroker 가 브로커 부재 시 spawner 로 '자동 기동' →
#   게이트웨이 대역 gw_t 가 잠긴 sudo(sudo -n -u broker_t -- box-spawn node broker)로 브로커를 띄우고 exec 라우팅.
#   기존 격리 특권경로(box-spawn + env_keep + runas 그룹제한)를 그대로 재사용 — 새 권한/명시적 액션 없음.
#  실행(박스): CO=/home/ubuntu/co-t4 bash $CO/scripts/integration/broker-autospawn.sh
set -uo pipefail
CO="${CO:-/home/ubuntu/co-t4}"
APP=/opt/co-t4-test
T=/tmp/broker-autospawn
BROKER_U=broker_t; GW_U=gw_t; MEMBER_U=box_t
SUDOERS=/etc/sudoers.d/lively-brokertest
RUNDIR=/run/lively-broker
fail=0; note(){ echo "  $*"; }; pass(){ echo "ok  $*"; }; bad(){ echo "FAIL $*"; fail=1; }

cleanup(){
  sudo pkill -u "$BROKER_U" 2>/dev/null
  sudo rm -f "$SUDOERS"; sudo rm -rf "$T" "$APP" "$RUNDIR"/t.sock
  for u in "$BROKER_U" "$GW_U" "$MEMBER_U"; do sudo userdel -r "$u" 2>/dev/null; done
}
trap cleanup EXIT

echo "=== 준비: 그룹/유저/앱/소켓디렉토리/box-spawn/테스트 sudoers ==="
for g in broker_members lively-broker; do getent group $g >/dev/null || sudo groupadd $g; done
sudo useradd -m -d /home/$BROKER_U -s /usr/sbin/nologin -G broker_members,lively-broker "$BROKER_U" 2>/dev/null || sudo usermod -aG broker_members,lively-broker "$BROKER_U"
sudo useradd -M -s /usr/sbin/nologin -G lively-broker "$GW_U" 2>/dev/null || sudo usermod -aG lively-broker "$GW_U"  # 게이트웨이 대역(sudo 주체·소켓 그룹)
sudo useradd -M -s /usr/sbin/nologin "$MEMBER_U" 2>/dev/null || true                                              # 멤버 대역(lively-broker 아님)
sudo install -d -m 2770 -o "$BROKER_U" -g lively-broker /home/$BROKER_U/work
# world-readable 앱(브로커 entry·node_modules) — prod /opt/context-ontology 미러
sudo rm -rf "$APP"; sudo mkdir -p "$APP"; sudo cp -a "$CO/dist" "$CO/node_modules" "$CO/package.json" "$APP/"; sudo chmod -R a+rX "$APP"
# box-spawn 래퍼 설치(root:root 0755) — 코드 BOX_SPAWN 경로와 일치
sudo install -d -m 0755 /opt/lively/libexec
sudo install -m 0755 -o root -g root "$CO/deploy/linux/box-spawn" /opt/lively/libexec/box-spawn
# 소켓 디렉토리(설치 스크립트와 동일: root:lively-broker 2770 setgid)
sudo install -d -m 2770 -o root -g lively-broker "$RUNDIR"; sudo chmod g+s "$RUNDIR"
# 테스트 sudoers — gw_t 가 broker_members 로 box-spawn 만, LIVELY_BROKER_* env_keep(실 sudoers 파일과 별개 파일)
sudo tee "$SUDOERS" >/dev/null <<EOF
Runas_Alias LIVELY_BROKERS_T = %broker_members
Defaults!/opt/lively/libexec/box-spawn env_keep += "LIVELY_BROKER_SOCKET LIVELY_BROKER_MEMBER LIVELY_BROKER_WORKROOT LIVELY_BROKER_ALLOWED_TOOLS LIVELY_BROKER_INTERNAL_HOSTS LIVELY_BROKER_ENTRY"
$GW_U ALL=(LIVELY_BROKERS_T) NOPASSWD: /opt/lively/libexec/box-spawn
EOF
sudo visudo -cf "$SUDOERS" >/dev/null || { bad "테스트 sudoers 검증 실패"; exit 1; }
# 게이트웨이-측 caller — routeToBroker + defaultBrokerSpawner(실제 sudo/box-spawn spawn)
sudo mkdir -p "$T"
echo '{"type":"module"}' | sudo tee "$T/package.json" >/dev/null
sudo tee "$T/autospawn-call.mjs" >/dev/null <<EOF
import { routeToBroker, defaultBrokerSpawner } from "$APP/dist/broker/route.js";
const [,, slug, req] = process.argv;
const spawner = defaultBrokerSpawner({ entry: "$APP/dist/broker/index.js", allowedTools: ["echo","true","git"] });
try { console.log(JSON.stringify(await routeToBroker(slug, JSON.parse(req || "{}"), spawner))); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 3; }
EOF
sudo chmod -R 755 "$T"

echo "=== 사전확인: 브로커 미기동(소켓 없음) ==="
sudo test -S "$RUNDIR/t.sock" && bad "이미 소켓 존재(사전상태 오염)" || pass "사전: broker_t 소켓 없음(미기동)"

echo "=== (핵심) gw_t 가 routeToBroker 호출 → 브로커 '자동' 기동 + exec 라우팅 ==="
R=$(cd "$T" && sudo -u "$GW_U" node "$T/autospawn-call.mjs" t '{"op":"exec","tool":"echo","args":["AUTOSPAWN-OK"]}' 2>&1)
note "응답: $R"
echo "$R" | grep -q 'AUTOSPAWN-OK' && pass "routeToBroker → 브로커 자동 기동 후 exec 성공(명시적 spawn 액션 없음)" || bad "auto-spawn 라우팅 실패: $R"
BPID=$(pgrep -u "$BROKER_U" -f "broker/index.js" | head -1)
[ -n "$BPID" ] && pass "브로커 프로세스 자동 기동됨(uid=$BROKER_U pid=$BPID)" || bad "브로커 프로세스 미기동"
[ -n "$BPID" ] && note "소켓: $(sudo stat -c '%U:%G %a' "$RUNDIR/t.sock" 2>/dev/null)"

echo "=== 2차 호출은 재기동 없이 기존 브로커 재사용(idempotent) ==="
R2=$(cd "$T" && sudo -u "$GW_U" node "$T/autospawn-call.mjs" t '{"op":"exec","tool":"echo","args":["REUSE-OK"]}' 2>&1)
BPID2=$(pgrep -u "$BROKER_U" -f "broker/index.js" | head -1)
{ echo "$R2" | grep -q 'REUSE-OK' && [ "$BPID" = "$BPID2" ]; } && pass "2차 호출 = 동일 브로커 재사용(pid 불변)" || bad "재사용 실패(R2=$R2 pid $BPID→$BPID2)"

echo "=== 격리 유지: 멤버 대역(lively-broker 아님)은 auto-spawn 된 소켓에도 접근 불가 ==="
R3=$(sudo -u "$MEMBER_U" node -e 'const http=require("http");const r=http.request({socketPath:process.argv[1],path:"/",method:"POST"},()=>console.log("CONNECTED"));r.on("error",e=>console.log(e.code||e.message));r.end("{}")' "$RUNDIR/t.sock" 2>&1)
note "member 접근: $R3"
echo "$R3" | grep -qiE 'EACCES|ENOENT' && pass "멤버 → auto-spawn 소켓 접근 불가(EACCES/ENOENT — 격리 유지)" || bad "멤버가 접근됨(격리 실패!): $R3"

echo
[ "$fail" = "0" ] && echo "BROKER-AUTOSPAWN(T4 ②) ALL GREEN" || echo "BROKER-AUTOSPAWN(T4 ②) 실패 있음"
exit $fail
