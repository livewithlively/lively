#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# Blue-green 무중단 배포 — 단일 박스, **정상상태(steady-state) 전용**.
#   토폴로지: ALB:443 → node(blue:8081 | green:8082). ALB 가 인스턴스 타깃에 **직결**한다(caddy 우회).
#     (:8080 은 flip pool 에서 빠져 세션 클라 핀 전용 loopback alias 가 됐다 — 근거는 lib/common.sh 의
#      render_loopback_forwarder 주석과 deploy/README.md 의 blue-green 절.)
#     flip primitive = **ALB 타깃 그룹의 타깃 포트 스왑**이다. 박스의 docker-compose caddy 는 front-door 가
#     아니라 vestigial 이라 flip 경로에서 제거했다(구버전은 caddy reload 로 flip 했으나 ALB 가 active color 포트 직결이라 불일치).
#
#   절차: idle color 에 새 릴리스 기동 → **로컬** readiness(/readyz) 200 대기(ALB 넣기 전 자가 게이트)
#         → ALB register-targets(idle 포트) → describe-target-health 폴링으로 idle 포트가 **State=healthy**
#         → healthy 면 ALB deregister-targets(구 포트, ALB 가 dereg delay 300s 동안 connection draining)
#         → active-color=idle 커밋 → old color 유닛 stop.
#         로컬 readiness 실패 시 ALB 미변경·idle 정지·die(자동 롤백). ALB 미healthy 시 idle 등록취소·idle 정지·die(무중단).
#
#   ⭐ 롤백 안전 불변식: ALB register(+healthy 확인)가 deregister(구 포트)보다 **먼저**. active-color 커밋은
#     deregister 성공 **뒤**. old 유닛 stop 은 맨 마지막. register/deregister 실패는 die — old 유닛이 계속 서빙한다.
#
#   전제: (1) 배포할 릴리스가 이미 준비돼 있다(dist + node_modules). 코드 획득(tgz/rsync/git)은 deploy/bootstrap.sh 계약.
#         (2) blue-green 레이아웃이 이미 존재한다($LIVELY_ROOT/releases·shared + active-color 상태파일).
#            ⚠ 최초 레이아웃 생성·구 단일설치 흡수는 이 스크립트가 하지 않는다 — 별도 1회성 `deploy/migrate-to-bluegreen.sh`
#              가 담당한다(흡수 경로의 데이터파괴 클래스를 배포 스크립트에서 통째로 분리). active-color 가 없으면 die.
#         (3) ALB 타깃 그룹(--tg-arn) **전부**가 이 인스턴스의 **현재 active color 포트**를 이미 등록하고 서빙 중이다
#            (최초 컷오버 = ALB 타깃을 이 인스턴스로 지정하는 것 — deploy/migrate-to-bluegreen.sh 런북 참조).
#            이 스크립트는 TG 를 만들지도, 리스너를 붙이지도 않는다 — ALB·TG·리스너 프로비저닝은 이 리포 밖 인프라 책임.
#         (4) 박스 instance role 에 elbv2 권한(해당 TG 한정): RegisterTargets · DeregisterTargets ·
#            DescribeTargetHealth · **DescribeTargetGroups**. 마지막 것을 빠뜨리면 flip 직전 HC preflight
#            (assert_tg_hc_traffic_port)가 query-failed 로 die 해 **모든 배포가 막힌다**(fail-safe 설계).
#         ⚠ store(items-db, docker named volume) 가 떠 있어야 한다 — 게이트 기본값 /readyz 가 DB 도달을
#           요구하므로(src/index.ts), store 미기동이면 readiness 가 200 을 못 내 flip 이 성립하지 않는다(자동 롤백).
#
#   레이아웃(${LIVELY_ROOT:-/opt/lively}):
#     releases/<id>/            릴리스별 코드(dist·node_modules). .env·data·logs 는 공유 루트로의 심볼릭(배포마다 보존).
#     shared/.env  shared/data  공유 상태(시크릿·노션 자산). items-db 는 docker named volume 이라 애초에 이 밖.
#     logs/gateway-<color>.log  공유 로그.  color-env/<color>.env  per-color PORT.
#     <color> → releases/<id>   color→릴리스 심볼릭.  active-color  상태파일(blue|green).
#     current → 활성 color 릴리스,  previous → 직전 릴리스(즉시 롤백용).
#     legacy-blue-unit          (흡수 직후에만) migrate 가 남긴 구 단일유닛명 — 최초 flip 때 정리 후 제거.
#     legacy-blue-port          (흡수 직후에만) 구 단일유닛의 실서빙 포트(old .env 의 PORT 실측) — 최초 flip 의
#                               ALB deregister 대상. 8080 을 가정하지 않는다. unit marker 와 같이 제거된다.
#
#   롤백: 이전 릴리스로 재실행하면 된다 — `deploy-release.sh --release "$LIVELY_ROOT/previous" --tg-arn <arn>`
#         (previous 심볼릭·old color 유닛이 보존되므로 재빌드 없이 수초 내 flip).
#
# 사용:  bash deploy/deploy-release.sh --release <dir> --tg-arn <arn> [옵션]
#   --release <dir>          (필수) 배포할 준비된 릴리스 디렉토리(dist/index.js 포함).
#   --tg-arn <arn>           (필수, env LIVELY_TG_ARN 폴백) flip 할 ALB 타깃 그룹 ARN. **반복 지정·콤마 구분으로
#                            여러 개**를 줄 수 있다 — ALB TG 는 로드밸런서 1대에만 붙는 하드 리밋이 있어(TG 공유 불가)
#                            ALB 가 여럿이면 TG 도 여럿이고, flip 은 그 전부에 반영돼야 한다. register 는 전부 성공해야
#                            진행하고(부분 등록은 되돌린다), healthy 는 전부 충족해야 하며, 구 포트 제거도 전부에 적용된다.
#   --instance-id <id>       ALB 에 등록할 인스턴스 ID(기본: IMDSv2 로 자동 해석).
#   --alb-health-timeout <n> ALB 타깃 healthy 폴링 타임아웃 초(기본 180 — HC interval 30s·threshold 2 이면 ≈60s).
#   --lively-root <dir>      배포 루트(기본 $LIVELY_ROOT 또는 /opt/lively).
#   --health-path <path>     로컬 게이트 헬스체크 경로(기본 /readyz = readiness). liveness 로 바꾸려면 /healthz.
#   --health-retries <n>     로컬 헬스체크 재시도 횟수(기본 60, 1초 간격).
#   --drain-seconds <n>      구 포트 ALB 등록해제 후 old 유닛 정지까지 로컬 유예(기본 5). ⚠ ALB dereg delay 는 300s —
#                            이 유예가 그보다 짧으면 ALB 가 draining 중인 in-flight 커넥션을 끊을 수 있다(트레이드오프).
#                            긴 커넥션(웹터미널)을 온전히 흘리려면 --keep-old 로 old 를 남기고 나중에 수동 정지.
#   --keep-old               old color 유닛을 stop 하지 않고 남긴다(빠른 롤백 대기 / ALB 300s drain 완주용).
#   자격: aws CLI 가 ambient credential chain(prod=박스 instance role)으로 elbv2 를 호출한다. region 은 AWS_REGION
#         env 또는 IMDS 로 해석. 환경변수: BLUE_PORT(8081) GREEN_PORT(8082) LIVELY_SERVICE_USER GATEWAY_MEMORY_HIGH_MB
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
# shellcheck source=lib/bluegreen.sh
source "$DIR/lib/bluegreen.sh"

# ── 릴리스 안에 공유 상태 심볼릭 배선 — 코드는 릴리스별, .env·data·logs 는 공유(배포마다 보존). ──
#  릴리스 디렉토리는 '갓 준비된 코드'라 그 안의 .env/data/logs 를 심볼릭으로 갈아끼워도 상태 손실이 없다(공유가 SoT).
link_shared_state() {
  local rel="$1" root="$2"
  # ⚠ 파괴 가드 — 아래 `sudo rm -rf "$rel/..."` 는 rel 이 빈값/루트/비-릴리스면 재앙(rm -rf "/.env" 등).
  #  rel 이 실제 준비된 릴리스 디렉토리(dist/index.js 보유)일 때만 진행한다. 빈 var·오타 경로를 조기 차단.
  [ -n "$rel" ] && [ -d "$rel" ] && [ -f "$rel/dist/index.js" ] \
    || die "link_shared_state: 릴리스 디렉토리가 아닙니다(파괴 방지) — rel='${rel:-<빈값>}'"
  # ⚠ 자기참조 rm 가드(방어심층) — rel/.env·rel/data 가 shared 원본과 **같은 실체**를 가리키면 아래 rm 이
  #  그 원본을 파괴한다(예: previous 롤백에서 previous 안 항목이 shared 로의 심볼릭인 경우). 레이아웃은 이미
  #  migrate 가 shared 를 원본 소유로 만들어 이 클래스를 없앴지만, 외부/잔여 배선을 대비해 실경로를 대조하고
  #  같으면 rm/재링크를 통째로 skip 한다(이미 올바른 배선이라 손댈 게 없다). 다르면 정상 rm + 재링크.
  local p relp shp
  for p in .env data; do
    relp="$(readlink -f "$rel/$p" 2>/dev/null || true)"
    shp="$(readlink -f "$root/shared/$p" 2>/dev/null || true)"
    if [ -n "$relp" ] && [ "$relp" = "$shp" ]; then
      warn "link_shared_state: $rel/$p 가 shared 원본과 동일 실체($shp) — 자기참조 rm 방지 위해 제거·재링크 생략"
      continue
    fi
    sudo rm -rf "$rel/$p"
    sudo ln -sfn "$root/shared/$p" "$rel/$p"
  done
  sudo rm -rf "$rel/logs"
  sudo ln -sfn "$root/logs" "$rel/logs"
}

# ── IMDSv2 메타데이터 1건 조회 — 토큰 발급(PUT) 후 GET. 실패 시 빈 문자열(호출부가 판단). ──
#  박스는 항상 EC2 → instance-id·region 을 여기서 얻는다(--instance-id·AWS_REGION 미지정 시).
imds_get() {
  local path="$1" tok
  tok="$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)"
  curl -fsS -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/$path" 2>/dev/null || true
}

# ── TG 리스트 분해 — --tg-arn 은 콤마 구분 다중 지정을 허용한다(ALB TG 는 로드밸런서 1대 전용이라, ALB 가
#  여럿이면 TG 도 여럿이고 flip 은 그 전부에 반영돼야 한다). glob 확장을 끄고 나눈다(arn 에 메타문자는 없지만
#  IFS 분해에 딸려오는 pathname expansion 을 원천 차단).
tg_split() {
  local IFS=, item; set -f
  for item in $1; do [ -n "$item" ] && printf '%s\n' "$item"; done
  set +f
}

# ── ALB 타깃 healthy 폴링 — describe-target-health 로 (instance,port) 타깃이 **모든 TG 에서** State=healthy 될 때까지. ──
#  ALB HC=traffic-port(각 타깃 자기 포트로 HC)·interval 30s·healthy threshold 2 → 최초 healthy 까지 ≈60s.
#  5s 간격 폴링. healthy 면 rc 0, 타임아웃까지 미달이면 rc 1(호출부가 등록 취소·롤백). aws 실패는 query-failed 로 계속 대기.
#  ⚠ TG 별로 순차 대기하지 않고 **라운드로빈**으로 아직 미달인 TG 만 다시 본다 — 순차면 타임아웃이 TG 수만큼
#   곱해져(2개면 최대 360s) 배포 창이 늘어난다. HC 는 TG 마다 독립이므로 동시에 익어간다.
alb_wait_healthy() {
  local csv="$1" iid="$2" port="$3" timeout="$4" waited=0 state="" tg
  local -a pending=() still=()
  while IFS= read -r tg; do pending+=("$tg"); done <<EOF
$(tg_split "$csv")
EOF
  while [ "$waited" -lt "$timeout" ]; do
    still=()
    for tg in "${pending[@]}"; do
      state="$(aws elbv2 describe-target-health --target-group-arn "$tg" \
        --targets Id="$iid",Port="$port" \
        --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2>/dev/null || echo query-failed)"
      log "  ALB target :$port state=$state (${waited}s/${timeout}s) TG=${tg##*/}"
      [ "$state" = healthy ] || still+=("$tg")
    done
    [ "${#still[@]}" -eq 0 ] && return 0
    pending=("${still[@]}")
    sleep 5; waited=$((waited+5))
  done
  return 1
}

# ── ALB register — 모든 TG 에 idle 포트를 등록한다. 하나라도 실패하면 **이 실행에서 등록한 것들을 되돌리고** rc 1.
#  되돌리는 이유: 등록만으론 트래픽이 가지 않지만(새 타깃은 initial 상태로, HC 통과 전엔 라우팅되지 않는다 —
#  전 타깃 unhealthy 시 fail-open 예외만) **남겨두면 나중에 healthy 가 된 뒤** die 경로가 그 유닛을 끄므로
#  죽은 등록 타깃이 된다. 불변식 "healthy 확인 전에는 아무 ALB 도 idle 로 보내지 않는다" 를 그래서 지킨다.
alb_register_targets() {
  local csv="$1" iid="$2" port="$3" tg d
  local -a done_tgs=()
  while IFS= read -r tg; do
    log "ALB register-targets: TG=${tg##*/} Id=$iid Port=$port"
    if aws elbv2 register-targets --target-group-arn "$tg" --targets Id="$iid",Port="$port"; then
      done_tgs+=("$tg")
    else
      warn "register-targets 실패(TG=${tg##*/}) — 이 실행에서 등록한 ${#done_tgs[@]}건을 되돌린다(healthy 미확인 타깃에 트래픽 금지)"
      for d in ${done_tgs[@]+"${done_tgs[@]}"}; do
        aws elbv2 deregister-targets --target-group-arn "$d" --targets Id="$iid",Port="$port" \
          || warn "롤백 등록해제 실패(TG=${d##*/} :$port) — 수동 확인: aws elbv2 describe-target-health --target-group-arn $d"
      done
      return 1
    fi
  done <<EOF
$(tg_split "$csv")
EOF
  return 0
}

# ── ALB deregister — 모든 TG 에서 해당 포트를 뺀다. 하나라도 실패하면 rc 1(호출부가 판단: 구 포트 제거 실패는
#  둘 다 등록된 무중단 상태이므로 die, idle 롤백 실패는 warn).
alb_deregister_targets() {
  local csv="$1" iid="$2" port="$3" tg rc=0
  while IFS= read -r tg; do
    aws elbv2 deregister-targets --target-group-arn "$tg" --targets Id="$iid",Port="$port" \
      || { warn "deregister-targets 실패(TG=${tg##*/} :$port)"; rc=1; }
  done <<EOF
$(tg_split "$csv")
EOF
  return "$rc"
}

# ── TG 헬스체크 포트 preflight(flip 진입 전 — 이 스킴의 유일한 silent-outage 모드 차단) ──────────
#  ALB HC 는 **traffic-port**(각 타깃을 자기 등록 포트로 HC)여야 blue-green 이 성립한다. HC 가 고정 포트
#  (예: 8081)로 드리프트되면, idle(:8082)을 register 해도 ALB 가 그 타깃을 **구 포트 8081** 으로 HC 해
#  healthy 오판 → flip 후 구 포트 stop 시 모든 타깃이 죽은 포트로 판정받아 **전면 outage**(무증상, 롤백만이 유일 신호).
#  register 전에 HC 포트가 traffic-port 임을 단언해 포트별 판정이 성립함을 보장한다. describe 실패도 die(fail-safe).
assert_tg_hc_traffic_port() {
  local csv="$1" tg hc_port
  while IFS= read -r tg; do
    hc_port="$(aws elbv2 describe-target-groups --target-group-arn "$tg" \
      --query 'TargetGroups[0].HealthCheckPort' --output text 2>/dev/null || echo query-failed)"
    [ "$hc_port" = traffic-port ] \
      || die "TG HC 가 traffic-port 아님(TG=${tg##*/} HealthCheckPort=$hc_port) — blue-green 포트별 판정 불가(idle 을 구 포트로 HC 해 healthy 오판 → flip 후 전면 outage). traffic-port 로 되돌린 뒤 재실행: aws elbv2 modify-target-group --target-group-arn $tg --health-check-port traffic-port"
  done <<EOF
$(tg_split "$csv")
EOF
}

# ── idle 포트 선점 검사(방어심층) ────────────────────────────────────────────
#  idle 유닛이 아직 안 떠 있는데 idle_port 가 이미 LISTEN 중이면 = 외부/구 유닛(흡수 잔재)이 선점한 것.
#  그대로 기동하면 EADDRINUSE 로 새 릴리스가 못 뜨는데, 선점 프로세스가 healthz/readyz 200 을 응답해
#  false-positive 로 flip → 구코드로 전환된다. 그래서 기동/flip 전에 die 로 끊는다.
assert_idle_port_free() {
  local port="$1" idle_unit="$2"
  # idle 유닛이 이미 active 면 그 포트는 우리 것 → systemctl restart 가 정상 처리(선점 아님).
  systemctl is-active --quiet "$idle_unit" 2>/dev/null && return 0
  local holder=""
  if command -v ss >/dev/null 2>&1; then
    holder="$(ss -ltnH "sport = :$port" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    holder="$(sudo lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  else
    warn "포트 점유 검사 도구(ss/lsof) 없음 — idle 포트 :$port 선점 검사 생략"
    return 0
  fi
  [ -z "$holder" ] || die "idle 포트 :$port 를 다른 프로세스가 선점 중입니다($idle_unit 미기동) — 흡수 잔재(구 단일유닛) 또는 idle 유닛 자신의 restart-loop 가능성(is-active 는 activating 을 active 로 안 봐 자기 유닛도 선점처럼 보일 수 있음). healthz false-positive flip(구코드 전환) 방지 위해 중단. 확인: systemctl status $idle_unit; ss -ltnp 'sport = :$port'"
}

main() {
  [ "$(detect_os)" = linux ] || die "blue-green 배포는 Linux/systemd 전용입니다(mac 은 단일 launchd)."
  require_cmd curl; require_cmd systemctl; require_cmd aws

  # ⚠ 캡처 후 eval — `eval "$(cmd)" || die` 는 cmd 실패를 못 잡는다($()의 rc 가 eval 라인 rc 가 아님).
  #   할당의 rc 는 $()의 rc 라, 파싱 실패(--release 누락 등)가 여기서 정확히 die 로 이어진다.
  local parsed; parsed="$(bg_parse_args "$@")" || die "인자 파싱 실패(사용법은 스크립트 머리 주석)."
  eval "$parsed"
  export LIVELY_ROOT
  local root="$LIVELY_ROOT"
  [ -f "$RELEASE_DIR/dist/index.js" ] || die "릴리스가 준비되지 않았습니다(dist/index.js 없음): $RELEASE_DIR"
  # ⚠ pwd -P (logical 아님) — 심볼릭까지 실경로로 정규화. 롤백은 `--release "$root/previous"`(previous 는
  #  심볼릭)로 재실행하는데, logical pwd 면 RELEASE_DIR 이 previous 심볼릭 경로 그대로 남아 idle 심볼릭이
  #  blue→previous→(다음 배포 때 옮겨갈 수 있는)불량릴리스 체인이 된다 → 재기동 시 불량 릴리스 부활. 실경로로 끊는다.
  RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd -P)"

  # ── 전제: blue-green 레이아웃이 이미 존재해야 한다(흡수/최초 레이아웃 생성은 이 스크립트 책임 아님). ──
  #  active-color 가 없거나 손상이면 레이아웃이 없는 박스다 → 데이터파괴 위험이 있던 흡수는 별도 1회성
  #  migrate-to-bluegreen.sh 로 분리했으므로, 여기서 조용히 레이아웃을 만들지 않고 명확히 중단한다.
  local active
  active="$(bg_read_active "$root/active-color")"
  # bg_read_active 는 부재와 손상(화이트리스트 밖 값) 둘 다 빈값으로 강등하지만, 조치는 다르다 —
  #  부재(미흡수)면 migrate 로 레이아웃을 만들어야 하고, 손상(값 이상)이면 migrate 는 active-color 존재를 보고
  #  재흡수를 거부하므로(핑퐁) 파일을 수기로 blue|green 복구해야 한다. 파일 존재 여부로 갈라 정확히 안내한다.
  if [ -z "$active" ]; then
    if [ ! -e "$root/active-color" ]; then
      die "blue-green 레이아웃이 없습니다(active-color 부재: $root/active-color) — 먼저 'bash deploy/migrate-to-bluegreen.sh --confirm' 로 레이아웃을 만드세요."
    else
      die "active-color 파일이 손상됐습니다($root/active-color — 내용이 blue|green 이 아님). 파일 내용을 확인해 활성 color(blue 또는 green)로 수기 복구한 뒤 재실행하세요(migrate 는 active-color 가 있으면 재흡수를 거부하므로 여기서 자동 복구하지 않습니다)."
    fi
  fi

  phase "0/4 전제 확인 + 서비스 유저 + ALB 대상 확정"
  # 이 스크립트가 만드는 것은 '릴리스별' 산출물뿐 — 공유상태(shared)·백업은 migrate 가 만든 전제(여기선 안 만든다).
  sudo mkdir -p "$root/releases" "$root/logs" "$root/color-env"
  # ── SERVICE_USER — 활성 템플릿유닛의 User 를 SoT 로 읽는다. 없으면 LIVELY_SERVICE_USER env, 그것도 없으면 die. ──
  #  ⚠ 실행자(id -un)로 폴백하지 않는다(silent 드리프트 금지) — 그 조용한 드리프트가 게이트웨이 유저를 운영자/root
  #    로 바꿔 ~/.claude 인증·소유권을 무너뜨린 이력(#4). 알 수 없으면 차라리 멈춘다. 흡수 직후 첫 배포도 active=blue
  #    템플릿유닛(lively-gateway@blue)의 User 를 migrate 가 렌더해 두므로 여기서 정확히 읽힌다.
  SERVICE_USER="$(systemctl show -p User --value "lively-gateway@$active" 2>/dev/null || true)"
  [ -n "$SERVICE_USER" ] || SERVICE_USER="${LIVELY_SERVICE_USER:-}"
  [ -n "$SERVICE_USER" ] || die "SERVICE_USER 를 확정할 수 없습니다(활성 템플릿유닛 lively-gateway@$active 의 User 가 비어 있고 LIVELY_SERVICE_USER 도 없음). 레이아웃이 migrate 로 올바로 만들어졌는지 확인하세요(silent id -un 드리프트 금지)."
  export SERVICE_USER

  # ── 흡수 완료 인계(최소) — migrate 가 구 단일유닛을 흡수하면 그 유닛명을 marker 파일로 남긴다. ──
  #  레거시 유닛명(lively-gateway/context-ontology-gateway) 하드코딩 스캔·seed·mv 는 전부 migrate 로 옮겼고,
  #  여기 남는 것은 marker 를 읽어(단순 파일 read) '최초 flip 때 그 구 유닛을 정리' 하는 것뿐이다.
  #  marker 가 있으면 active=blue 는 아직 구 유닛이 자기 포트를 물고 있는 상태 → 이번 flip 의 old(blue) 정지 대상이
  #  템플릿 인스턴스가 아니라 그 구 유닛이다(bg_unit_for 가 LEGACY_BLUE_UNIT 으로 blue 를 매핑). phase 4 에서
  #  정지·disable·.service 제거 + marker 삭제 → 이후 배포는 순수 템플릿 유닛만.
  LEGACY_BLUE_UNIT="$(cat "$root/legacy-blue-unit" 2>/dev/null || true)"
  # ⚠ marker 내용 검증 — 이 값은 아래에서 `systemctl stop/disable` 대상이자 `rm -f /etc/systemd/system/<값>.service`
  #  의 경로 조각이 된다. 정상 경로에선 migrate 가 쓴 유닛명이지만, 손상·수기편집된 marker(슬래시·공백·`..`)를
  #  그대로 흘리면 엉뚱한 유닛 정지나 systemd 디렉터리 밖 삭제로 번진다. 유닛명 문법으로 좁히고, 어긋나면 die.
  if [ -n "$LEGACY_BLUE_UNIT" ]; then
    bg_valid_unit_name "$LEGACY_BLUE_UNIT" \
      || die "legacy-blue-unit marker 가 유닛명 문법이 아닙니다('$LEGACY_BLUE_UNIT' — $root/legacy-blue-unit). 이 값으로 systemctl stop/disable 과 /etc/systemd/system 삭제를 하므로 진행하지 않습니다. 파일을 구 유닛명으로 고치거나(흡수 이미 끝났으면) 삭제하세요."
  fi
  export LEGACY_BLUE_UNIT
  # 최초 flip 이 ALB 에서 뺄 구 포트 — migrate 가 old_app/.env 의 PORT 를 실측해 남긴다(8080 하드코딩 금지).
  #  구 marker(포트 파일 없이 유닛명만 남긴 흡수)와의 호환을 위해 부재·비정수면 8080 으로 폴백한다.
  LEGACY_BLUE_PORT="$(cat "$root/legacy-blue-port" 2>/dev/null || true)"
  printf '%s' "$LEGACY_BLUE_PORT" | grep -qE '^[0-9]+$' || LEGACY_BLUE_PORT=8080

  # ── ALB flip 전제 — INSTANCE_ID(미지정 시 IMDSv2) + region(aws CLI 는 AWS_REGION env 또는 IMDS 로 해석). ──
  #  일찍 확정해 flip 직전이 아니라 여기서 실패하게 한다(idle 을 띄우기 전에 끊음).
  if [ -z "${INSTANCE_ID:-}" ]; then
    INSTANCE_ID="$(imds_get meta-data/instance-id)"
    [ -n "$INSTANCE_ID" ] || die "INSTANCE_ID 확정 불가 — IMDSv2 에서 instance-id 를 못 읽었습니다(--instance-id 로 명시하세요)."
  fi
  export INSTANCE_ID
  # SSM RunShellScript 는 최소 env 라 region 이 unset 일 수 있음 → 비어있으면 IMDS placement/region 으로 채운다(박스는 EC2).
  if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
    local imds_region; imds_region="$(imds_get meta-data/placement/region)"
    [ -n "$imds_region" ] && { export AWS_REGION="$imds_region" AWS_DEFAULT_REGION="$imds_region"; log "region ← IMDS: $imds_region"; }
  fi
  log "ALB flip 대상: TG=$TG_ARN  instance=$INSTANCE_ID  alb-health-timeout=${ALB_HEALTH_TIMEOUT}s"

  local idle idle_port
  idle="$(bg_idle_color "$active")"
  idle_port="$(bg_port "$idle")"
  log "active=$active  idle=$idle  idle_port=$idle_port  release=$RELEASE_DIR"

  phase "1/4 idle($idle) 릴리스 배선 + 유닛 렌더"
  # color → 릴리스 심볼릭 + 릴리스 내부 공유상태 배선.
  local dst="$root/releases/$(basename "$RELEASE_DIR")"
  if [ "$RELEASE_DIR" != "$dst" ]; then sudo ln -sfn "$RELEASE_DIR" "$dst" 2>/dev/null || true; fi
  link_shared_state "$RELEASE_DIR" "$root"
  sudo ln -sfn "$RELEASE_DIR" "$root/$idle"
  # per-color PORT env(실제 env → .env PORT 를 이긴다). LANG 은 유닛 Environment 로도 박혀 있으나 명시.
  printf 'PORT=%s\n' "$idle_port" | sudo tee "$root/color-env/$idle.env" >/dev/null
  render_bluegreen_unit                         # 템플릿 유닛 렌더(멱등) — common.sh

  phase "2/4 idle($idle) 기동 + 로컬 ${HEALTH_PATH} 대기(ALB 넣기 전 자가 게이트)"
  assert_idle_port_free "$idle_port" "lively-gateway@$idle"   # 선점(구유닛 잔재) 검사 — false-positive flip 차단
  sudo systemctl enable "lively-gateway@$idle" >/dev/null 2>&1 || true
  sudo systemctl restart "lively-gateway@$idle"
  local health_url="http://localhost:${idle_port}${HEALTH_PATH}" rc=0
  log "로컬 헬스체크: $health_url (최대 ${HEALTH_RETRIES}s)"
  curl -fsS --retry "$HEALTH_RETRIES" --retry-delay 1 --retry-all-errors --retry-connrefused -o /dev/null "$health_url" || rc=$?

  # ⭐ 로컬 게이트가 ALB register 보다 앞이다 — 실패면 ALB 를 아예 만지지 않고 idle 정리 후 die(old 계속 서빙).
  if [ "$(bg_flip_decision "$rc")" != flip ]; then
    warn "idle($idle) 로컬 ${HEALTH_PATH} 실패(rc=$rc) — ALB 미변경. old($active) 그대로 서빙(자동 롤백)."
    sudo systemctl stop "lively-gateway@$idle" 2>/dev/null || true   # 실패한 idle 정리(ALB 에 넣은 적 없음)
    sudo systemctl disable "lively-gateway@$idle" 2>/dev/null || true # phase 2 enable 원복 — 재부팅 시 양 color 동시기동(OOM) 방지
    die "배포 중단 — 새 릴리스가 로컬 ${HEALTH_PATH} 를 통과하지 못했습니다. 로그: $root/logs/gateway-$idle.log"
  fi
  ok "idle($idle) 로컬 ${HEALTH_PATH} 200 — ALB flip 진행"

  phase "3/4 ALB flip — idle 등록 → health poll → 구 포트 등록해제 → 상태 커밋"
  local active_port; active_port="$(bg_port "$active")"
  # legacy 흡수 최초 flip: 구 단일유닛은 템플릿 포트(bg_port blue=8081)가 아니라 **자기 .env 의 PORT** 를 서빙하므로
  #  deregister 대상은 그 실서빙 포트여야 한다 — migrate 가 실측해 legacy-blue-port marker 로 넘겨준 값을 쓴다.
  #  ⚠ 8080 하드코딩 금지: PORT 를 바꿔 설치한 박스에선 엉뚱한 포트를 빼 구 포트가 TG 에 남고, 곧 구 유닛이 정지되면서
  #   죽은 타깃이 트래픽을 받는다(무증상 5xx — assert_tg_hc_traffic_port 가 막는 것과 같은 silent-outage 클래스).
  #  ⚠ active=blue guard 필수: marker 는 잔존 가능하다(--keep-old 로 marker 삭제 skip, 또는 phase3 die 로 커밋 후 미삭제).
  #   marker 의미론상 legacy=blue 이므로, active=green 인데 marker 가 남았으면 실서빙은 green 포트라 구 포트 강제는
  #   오폭(green 을 deregister 못 해 사망 타깃 잔존). active=blue 일 때만 marker 포트가 실서빙과 일치한다.
  [ -n "${LEGACY_BLUE_UNIT:-}" ] && [ "$active" = blue ] && active_port="$LEGACY_BLUE_PORT"
  # ⭐ flip 진입 전 가드 2종(register 로 되돌릴 수 없는 부작용을 내기 전에 끊는다).
  #  (1) idle==active 포트 가드: BLUE_PORT==GREEN_PORT 오설정이면 idle 을 register 한 직후 같은 (instance,port)
  #     타깃을 deregister(구 포트)가 도로 빼 flip 이 무효가 된다(트래픽 유실). 두 포트가 다를 때만 진행한다.
  [ "$idle_port" != "$active_port" ] || die "idle/active 포트 동일(:$idle_port) — BLUE_PORT==GREEN_PORT 오설정. deregister(구 포트)가 방금 register 한 타깃을 도로 뺌 → flip 무효. 포트 분리 후 재실행."
  #  (2) HC=traffic-port preflight: HC 가 고정 포트면 포트별 healthy 판정이 성립 안 해 flip 후 전면 outage(위 함수 주석).
  assert_tg_hc_traffic_port "$TG_ARN"
  # 불변식: register(+healthy 확인) → deregister(구 포트) → active-color 커밋 → old 유닛 stop(맨 끝). ALB 가 스위치다.
  #  idle 포트를 TG 에 넣고 ALB HC(traffic-port ≈60s)로 healthy 확인된 뒤에만 구 포트를 뺀다 → 두 포트가 겹치는
  #  구간이 있어 무중단(구 포트는 dereg delay 300s 동안 connection draining).
  if ! alb_register_targets "$TG_ARN" "$INSTANCE_ID" "$idle_port"; then
    sudo systemctl stop "lively-gateway@$idle" 2>/dev/null || true
    sudo systemctl disable "lively-gateway@$idle" 2>/dev/null || true # phase 2 enable 원복 — 재부팅 시 양 color 동시기동(OOM) 방지
    die "ALB register-targets 실패(idle :$idle_port) — idle 정리. old($active:$active_port) 그대로 서빙(무중단). ALB 는 원복됨(부분 등록이 있었다면 위 warn 참조 — 원복까지 실패했으면 수동 확인)."
  fi
  log "ALB health poll — idle :$idle_port 가 healthy 될 때까지(최대 ${ALB_HEALTH_TIMEOUT}s)"
  if ! alb_wait_healthy "$TG_ARN" "$INSTANCE_ID" "$idle_port" "$ALB_HEALTH_TIMEOUT"; then
    # idle 이 ALB 에서 timeout 까지 healthy 안 됨 → 등록 취소(원복)·idle 정지·구 유닛 유지·die(무중단).
    warn "idle :$idle_port 가 ${ALB_HEALTH_TIMEOUT}s 내 ALB healthy 미달 — 등록 취소·롤백(old 계속 서빙)."
    alb_deregister_targets "$TG_ARN" "$INSTANCE_ID" "$idle_port" \
      || warn "idle 등록 취소 실패 — 수동 확인: aws elbv2 describe-target-health --target-group-arn <TG> (TG=$TG_ARN)"
    # ⚠ 다중 TG 고유 edge: TG 가 여럿이면 **먼저 healthy 가 된 ALB** 는 타임아웃까지 idle 로 신규 트래픽을
    #  보내고 있었을 수 있다(단일 TG 시절엔 '라우팅 중인 idle 을 끄는' 경로가 아예 없었다). 방금 등록을
    #  취소했으니 유닛을 끄기 전에 phase 4 의 old stop 과 같은 drain 유예를 준다 — 없으면 그 ALB 의
    #  in-flight 커넥션이 유예 없이 절단된다.
    sleep "$DRAIN_SECONDS"
    sudo systemctl stop "lively-gateway@$idle" 2>/dev/null || true
    sudo systemctl disable "lively-gateway@$idle" 2>/dev/null || true # phase 2 enable 원복 — 재부팅 시 양 color 동시기동(OOM) 방지
    die "배포 중단 — idle($idle) 이 ALB 에서 healthy 되지 못했습니다(HC=traffic-port :$idle_port). old($active) 그대로 서빙(자동 롤백). 로그: $root/logs/gateway-$idle.log"
  fi
  ok "ALB idle($idle:$idle_port) healthy — 구 포트($active:$active_port) 등록 해제"
  if ! alb_deregister_targets "$TG_ARN" "$INSTANCE_ID" "$active_port"; then
    # deregister 실패: idle 은 healthy·등록됨(트래픽 받는 중), 구 포트도 아직 등록됨 → 둘 다 서빙(무중단).
    #  active-color 미커밋 → 재실행하면 register(멱등)·healthy·deregister 재시도로 flip 완결 가능. idle 은 안 끈다(서빙 중).
    die "ALB deregister-targets(구 포트 :$active_port) 실패 — 무중단(dereg 성공한 TG 는 idle 만, 실패한 TG 는 둘 다 등록). active-color 미커밋. ⚠ TG 가 여럿이면 **수동 등록해제 후 재개**가 더 안전하다 — 재실행은 phase 2 가 이미 서빙 중인 idle 을 restart 해, old 가 빠진 TG 에서 유일 타깃이 수 초 내려간다."
  fi
  # current/previous 편의 심볼릭 + active 상태 커밋 — deregister 성공 **뒤**에만(불변식).
  [ -n "$active" ] && sudo ln -sfn "$(readlink -f "$root/$active" 2>/dev/null || true)" "$root/previous" 2>/dev/null || true
  sudo ln -sfn "$RELEASE_DIR" "$root/current"
  printf '%s' "$idle" | sudo tee "$root/active-color" >/dev/null
  ok "flip 완료 — active=$idle (:$idle_port). 구 포트 :$active_port 는 ALB 가 ~300s connection draining."

  # 8080 loopback forwarder 를 새 active(idle_port)로 재지정 — 세션 클라 핀(localhost:8080)이 항상 현재 active 를
  #  가리키게 한다. socket 은 상시 listen(순단 최소), service 만 새 포트로 restart.
  #  ⚠ legacy 흡수 최초 flip: 이 재지정(phase3)은 구 단일유닛(:8080) stop(phase4)보다 앞서므로, 그 최초 flip 에선
  #   loopback.socket 의 :8080 bind 가 아직 살아있는 구 유닛과 충돌해 여기 restart 는 실패한다(warn). 그 인계는
  #   phase4 legacy 분기가 구 유닛을 내린 **뒤** forwarder 를 재시도해 같은 실행 안에서 마무리한다(암전 방지).
  #   steady-state(흡수 완료 박스)에선 :8080 을 forwarder 말고 아무도 안 물어 여기서 바로 clean 하게 붙는다.
  render_loopback_forwarder "$idle_port"
  sudo systemctl enable lively-loopback.socket >/dev/null 2>&1 || true
  # restart 성공만으로 ok 를 찍지 않는다 — 이번 사고(세션 핀 죽음)가 재발해도 로그가 성공으로 보이면 무의미하다.
  #  restart 후 실제 :8080 → active 경로를 end-to-end 로 찔러 통과할 때만 ok(render·restart·bind 실패를 한 번에 잡음).
  #  실패는 warn(비치명 — flip 은 이미 커밋됐고, legacy 흡수 최초 flip 은 위 주석대로 bind 충돌이 정상 경로다).
  if sudo systemctl restart lively-loopback.service \
     && curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:8080${HEALTH_PATH}"; then
    ok "loopback :8080 → active :$idle_port 재지정(end-to-end 확인)"
  else
    warn "loopback :8080 forwarder 재지정 검증 실패 — 세션 핀(localhost:8080)이 active(:$idle_port)를 못 볼 수 있음(비치명, flip 은 커밋됨). 확인: systemctl status lively-loopback.service; ss -ltnp 'sport = :8080'"
  fi

  phase "4/4 old($active) drain·stop"
  local old_unit; old_unit="$(bg_unit_for "$active")"
  if [ "$KEEP_OLD" = 1 ]; then
    # old 를 안 끄면 drain sleep 은 무의미하다(sleep 은 stop 직전 in-flight 를 흘리는 유예) → keep-old 는 즉시 반환.
    #  긴 커넥션 완주는 ALB dereg delay 300s 가 이미 담당(구 포트는 draining 중). old 는 수동 정지 대기.
    log "--keep-old — $old_unit 를 남깁니다(빠른 롤백 대기, drain sleep 생략)."
  else
    log "drain ${DRAIN_SECONDS}s 후 정지: $old_unit"
    sleep "$DRAIN_SECONDS"
    sudo systemctl stop "$old_unit" 2>/dev/null || warn "$old_unit 정지 경고(이미 정지?)"
    if [ -n "${LEGACY_BLUE_UNIT:-}" ] && [ "$old_unit" = "$LEGACY_BLUE_UNIT" ]; then
      # 구 단일유닛을 흡수한 최초 flip: disable + .service 제거 + marker 삭제 → 재부팅 부활 방지 +
      #  다음 배포의 legacy 재감지 차단(흡수는 여기서 종결 — 이후 배포는 템플릿 유닛만).
      sudo systemctl disable "$old_unit" 2>/dev/null || true
      sudo rm -f "/etc/systemd/system/${old_unit}.service" && sudo systemctl daemon-reload
      sudo rm -f "$root/legacy-blue-unit" "$root/legacy-blue-port"
      log "구 단일유닛 $old_unit 정지·제거 + marker 삭제(흡수 완료 — 이후 배포는 템플릿 유닛만)"
      # 구 단일유닛이 그 포트를 놓은 뒤에야 forwarder 가 :8080 을 잡을 수 있다(구 유닛이 8080 을 물었던 경우 —
      #  phase3 시도는 bind 충돌로 실패했다). 구 포트가 8080 이 아니었다면 phase3 에서 이미 붙었고 여기선 멱등 재확인이다.
      sudo systemctl restart lively-loopback.socket lively-loopback.service 2>/dev/null || true
      if curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:8080${HEALTH_PATH}"; then
        ok "loopback :8080 → active :$idle_port (legacy 흡수 후 인계 완료)"
      else
        warn "loopback :8080 재기동 실패 — 세션 핀(localhost:8080) 미복구. 수동 확인: systemctl status lively-loopback.service"
      fi
    else
      # 템플릿 인스턴스도 stop 시 disable — 안 그러면 이전 배포에서 enable 된 채 남아 재부팅 시 old color 도
      #  기동돼 양 color 동시 실행(메모리 2배 — OOM 이력 박스엔 치명). idle enable 은 phase 2 에서만 한다.
      sudo systemctl disable "$old_unit" 2>/dev/null || true
    fi
    ok "old($active) 정지 — drain 완료"
  fi

  phase "완료"
  ok "active=$idle  릴리스=$RELEASE_DIR"
  ok "확인: http://localhost:${idle_port}${HEALTH_PATH}  ·  프론트: ALB → instance:$idle_port (TG=$TG_ARN)"
  ok "세션 핀: http://localhost:8080 (loopback alias → :$idle_port)"
  log "롤백(즉시): bash deploy/deploy-release.sh --release \"$root/previous\" --tg-arn \"$TG_ARN\""
}
main "$@"
