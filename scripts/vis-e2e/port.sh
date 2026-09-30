# shellcheck shell=bash
# #1291 e2e 공용 — 포트를 문 프로세스를 **포트로** 찾아 멈춘다(boot.sh·cycle.sh 가 source).
#  ⚠ 이름 패턴(pkill -f)으로 죽이면 실제 커맨드라인과 안 맞아 조용히 실패한다 — 게이트웨이는 작업 디렉터리에서
#   `node … dist/index.js`(상대 경로)로 뜨므로 «vis-e2e/dist/index.js» 같은 패턴은 애초에 매치되지 않는다. 그러면 옛
#   프로세스가 포트를 계속 물고 새 프로세스는 EADDRINUSE 로 죽어 **옛 코드로 테스트하게 된다**(실제로 그랬다, #4501 에서 boot.sh 도 고침).
#  pid 뽑기는 grep 으로 — awk 의 match(…, m) 3인자는 GNU awk 전용이라 우분투 기본 mawk 에서 문법 오류가 난다.
port_owner() { sudo ss -ltnp 2>/dev/null | grep -E ":$1 " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }
stop_port_owner() {
  local port="$1" old
  old="$(port_owner "$port")"
  if [ -n "${old:-}" ]; then
    kill "$old" 2>/dev/null || true
    for _ in $(seq 1 15); do sudo ss -ltn 2>/dev/null | grep -q ":$port " || break; sleep 1; done
  fi
  if sudo ss -ltn 2>/dev/null | grep -q ":$port "; then echo "포트 $port 가 안 놓임 — 중단" >&2; return 1; fi
}
