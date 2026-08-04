# shellcheck shell=bash
# Blue-green 무중단 배포의 **순수 결정 로직** — deploy-release.sh 가 source 한다.
#  여기 함수는 부작용이 없다(파일·systemd·caddy 를 만지지 않고, 결과를 stdout 으로만 낸다). 그래야
#  deploy-release 의 실제 배포 절차를 실행하지 않고도 `bash -c 'source bluegreen.sh; bg_...'` 로 단위 검증이 된다
#  (deploy/bluegreen-*.test.mjs 가 이 계약을 락한다). 실제 기동·flip·drain 은 deploy-release.sh 본체가 담당.

# active color 상태를 읽는다(인자 = 상태 파일 경로). blue|green 만 유효 — 없거나 손상되면 빈 문자열(=fresh 취급).
#  ⚠ 손상값을 그대로 흘리면 idle 계산이 오작동하므로, 화이트리스트에 없으면 조용히 fresh 로 강등한다.
bg_read_active() {
  local f="${1:?bg_read_active: 상태 파일 경로 필요}"
  [ -f "$f" ] || { printf '\n'; return 0; }
  local v; v="$(tr -d '[:space:]' < "$f" 2>/dev/null || true)"
  case "$v" in blue|green) printf '%s\n' "$v" ;; *) printf '\n' ;; esac
}

# idle(= 이번 배포가 기동할) color. active 의 반대. active 가 비면(최초 설치) blue 로 — 첫 릴리스는 blue 에 얹는다.
#  이 규칙이 flip 방향의 SoT 다: 새 코드는 **항상 idle 에 먼저 뜨고**, healthz 통과 후에만 active 로 승격된다.
bg_idle_color() {
  case "${1:-}" in
    blue)  printf 'green\n' ;;
    green) printf 'blue\n' ;;
    *)     printf 'blue\n' ;;   # active 없음(fresh) → 첫 릴리스는 blue
  esac
}

# color → 리슨 포트. BLUE_PORT/GREEN_PORT env 로 오버라이드(기본 8081/8082 — 8080 은 loopback alias 전용, flip pool 에서
#  제외) — 하드코딩 금지, CD 가 주입 가능. systemd per-color EnvironmentFile 의 PORT 로도 쓰인다. 알 수 없는 color 는
#  실패(rc 2)로 조기 차단.
bg_port() {
  local c="${1:?bg_port: color 필요}"
  case "$c" in
    blue)  printf '%s\n' "${BLUE_PORT:-8081}" ;;
    green) printf '%s\n' "${GREEN_PORT:-8082}" ;;
    *)     printf 'bg_port: 알 수 없는 color: %s\n' "$c" >&2; return 2 ;;
  esac
}

# color 유효성(blue|green). 인자 파싱·상태 검증에서 방어적으로 쓴다.
bg_valid_color() { case "${1:-}" in blue|green) return 0 ;; *) return 1 ;; esac; }

# color 를 실제로 돌리는 systemd 유닛 이름. 기본은 템플릿 인스턴스 lively-gateway@<color>.
#  ⚠ LEGACY_BLUE_UNIT 이 설정돼 있으면(= 구 단일설치에서 흡수하는 최초 배포) blue 만 그 구 유닛명으로 매핑한다.
#   구 단일설치는 blue-green 템플릿과 다른 이름(lively-gateway / context-ontology-gateway)으로 8080 을 이미 물고
#   있으므로, 그 최초 flip 의 'old active(blue) 정지' 대상은 템플릿 인스턴스가 아니라 이 구 유닛이어야 한다.
bg_unit_for() {
  local c="${1:?bg_unit_for: color 필요}"
  if [ "$c" = blue ] && [ -n "${LEGACY_BLUE_UNIT:-}" ]; then printf '%s\n' "$LEGACY_BLUE_UNIT"; return 0; fi
  printf 'lively-gateway@%s\n' "$c"
}

# flip 결정 — 헬스체크 종료코드(0=성공)만 보고 flip/abort 를 정한다. 롤백 안전 불변식의 핵심:
#  idle 헬스체크가 실패하면 **flip 하지 않는다** → old active 가 그대로 트래픽을 받고, 호출자는 idle 을 정리 후 die.
#  ⚠ 반환값은 'abort'(=no-flip)다 — 이 함수 자체는 아무것도 롤백하지 않는다(old 는 애초에 안 건드렸으니 되돌릴 게 없다).
#   flip 을 안 하는 것이 곧 자동 롤백이라 종전 'rollback' 은 오해를 불렀다(실제 롤백 동작이 있는 것처럼).
bg_flip_decision() {
  if [ "${1:-1}" -eq 0 ] 2>/dev/null; then printf 'flip\n'; else printf 'abort\n'; fi
}

# 인자 파싱 — 순수(파일·systemd·aws 무접촉). 정규화 결과를 KEY=VAL(%q 인용)로 stdout 에 내면 본체가 eval 로 받는다.
#  실패 시 rc!=0 + stderr. 여기 있어야 side-effect 없는 단위 테스트가 된다(deploy-release.sh 는 source 시 main 실행).
# 로컬 healthz 게이트 health-path 기본값은 **readiness(/readyz)** 다 — liveness(/healthz)가 아니라.
#  /healthz 는 '프로세스가 떴나'(얕음, DB 무관)라 설치/기동 확인용이고(common.sh wait_healthz),
#  게이트는 'ALB 에 넣어도 되나'를 물어야 하므로 readiness 가 맞다(src/index.ts:73 — DB 도달·디스크 여유).
#  liveness 로 통과시키면 DB 불가·디스크풀 상태의 릴리스를 ALB 에 등록할 수 있다(#813 T2 회귀). --health-path 로 오버라이드.
# ── ALB flip 파라미터 ── (flip primitive = ALB 타깃 포트 스왑. instance-id 는 순수 파싱이라 여기선 값만 받고,
#  비면 본체가 IMDSv2 로 해석한다. tg-arn 은 env LIVELY_TG_ARN 폴백 — 둘 다 없으면 flip 대상 불명이라 거부.)
bg_parse_args() {
  local release="" lively_root="${LIVELY_ROOT:-/opt/lively}" health_path="/readyz" health_retries=60 drain=5 keep_old=0
  local tg_arn="${LIVELY_TG_ARN:-}" instance_id="" alb_health_timeout=180
  while [ $# -gt 0 ]; do
    case "$1" in
      --release)            release="${2:?--release 값 필요}"; shift 2 ;;
      --lively-root)        lively_root="${2:?--lively-root 값 필요}"; shift 2 ;;
      --health-path)        health_path="${2:?--health-path 값 필요}"; shift 2 ;;
      --health-retries)     health_retries="${2:?--health-retries 값 필요}"; shift 2 ;;
      --drain-seconds)      drain="${2:?--drain-seconds 값 필요}"; shift 2 ;;
      --keep-old)           keep_old=1; shift ;;
      --tg-arn)             tg_arn="${2:?--tg-arn 값 필요}"; shift 2 ;;
      --instance-id)        instance_id="${2:?--instance-id 값 필요}"; shift 2 ;;
      --alb-health-timeout) alb_health_timeout="${2:?--alb-health-timeout 값 필요}"; shift 2 ;;
      *) printf 'bg_parse_args: 알 수 없는 인자: %s\n' "$1" >&2; return 2 ;;
    esac
  done
  [ -n "$release" ] || { printf 'bg_parse_args: --release 는 필수입니다\n' >&2; return 2; }
  # flip 대상 TG 는 필수 — ALB 타깃 포트 스왑이 flip primitive 이므로 arn 없이는 전환할 수 없다. env 폴백 허용.
  [ -n "$tg_arn" ] || { printf 'bg_parse_args: --tg-arn 은 필수입니다(또는 env LIVELY_TG_ARN) — ALB 타깃그룹 flip 대상\n' >&2; return 2; }
  printf '%s\n' "$health_retries" | grep -qE '^[0-9]+$' || { printf 'bg_parse_args: --health-retries 는 정수여야 합니다: %s\n' "$health_retries" >&2; return 2; }
  printf '%s\n' "$drain" | grep -qE '^[0-9]+$' || { printf 'bg_parse_args: --drain-seconds 는 정수여야 합니다: %s\n' "$drain" >&2; return 2; }
  printf '%s\n' "$alb_health_timeout" | grep -qE '^[0-9]+$' || { printf 'bg_parse_args: --alb-health-timeout 은 정수여야 합니다: %s\n' "$alb_health_timeout" >&2; return 2; }
  printf 'RELEASE_DIR=%q\n' "$release"
  printf 'LIVELY_ROOT=%q\n' "$lively_root"
  printf 'HEALTH_PATH=%q\n' "$health_path"
  printf 'HEALTH_RETRIES=%q\n' "$health_retries"
  printf 'DRAIN_SECONDS=%q\n' "$drain"
  printf 'KEEP_OLD=%q\n' "$keep_old"
  printf 'TG_ARN=%q\n' "$tg_arn"
  printf 'INSTANCE_ID=%q\n' "$instance_id"
  printf 'ALB_HEALTH_TIMEOUT=%q\n' "$alb_health_timeout"
}
