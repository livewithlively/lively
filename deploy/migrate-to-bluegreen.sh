#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 구 단일설치 → blue-green 레이아웃 **1회성 흡수(migrate)**. Linux/systemd 전용.
#
#   왜 별도 스크립트인가: 흡수는 심볼릭 aliasing·mv 자기참조·mkdir 순서 같은 **데이터파괴 클래스**를 안고 있어
#     평상 배포(deploy-release.sh)와 섞으면 매 배포가 그 위험을 진다. 흡수를 1회성으로 분리하면 배포 스크립트는
#     순수 정상상태(idle 기동→flip→drain)만 남아 R1부터 clean 하다.
#
#   무엇을 하나(순서 = 안전 우선):
#     0) 전제검사 — 구 단일유닛(lively-gateway | context-ontology-gateway) 존재 & active-color 부재(이미 흡수면 die).
#     1) 백업 먼저(가장 중요) — 어떤 이동보다 앞서 old_app/{.env,data} 를 backups/pre-bluegreen-<ts>.tar.gz 로.
#        백업 실패면 die(이동 안 함).
#     2) 레이아웃 생성 — releases·shared·logs·color-env·backups.
#     3) 데이터 이동(cross-FS 안전) — old_app/{.env,data} → shared/. 같은 FS 면 mv(원자), 다르면 copy→검증→삭제.
#        이동 후 old_app 쪽에 shared 로의 심볼릭(구 유닛이 계속 8080 서빙).
#     4) 권한 — shared 서비스유저 traverse, .env 640(운영자:서비스유저), data 소유.
#     5) blue seed — active-color=blue, blue→old_app, color-env/blue.env(PORT), 템플릿 유닛 렌더, legacy-blue-unit marker.
#
#   ⚠ flip 안 함·구 유닛 정지 안 함 — 흡수 후 상태 = 구 유닛(=blue, 8080)이 계속 서빙 + 레이아웃 준비 완료.
#     이어지는 `deploy-release.sh --release <new>` 가 green(8082)에 새 릴리스를 올려 flip 하고, 그 최초 flip 의
#     old(blue) drain 에서 구 유닛을 정지·제거한다(legacy-blue-unit marker 로 인계 — 그 정리 로직만 deploy-release 에).
#
#   레거시↔템플릿 전환(선택 이유): 구 유닛은 blue-green 템플릿과 다른 이름(lively-gateway / context-ontology-gateway)
#     으로 이미 8080 을 물고 있고, migrate 는 그것을 멈추지 않으므로(무중단) '구 유닛을 템플릿 인스턴스로 재라벨'
#     할 수 없다(실행 중 프로세스의 유닛명은 못 바꾼다). 그래서 (a) 템플릿 유닛(@.service)만 렌더해 두고(기동 X)
#     — SERVICE_USER·다음 배포가 읽을 수 있게, (b) 구 유닛명을 legacy-blue-unit 파일에 적어 다음 deploy-release 가
#     '최초 flip 때만' 그 구 유닛을 정리하도록 인계한다. 레거시명 하드코딩은 이 스크립트에만 있고(1회성),
#     deploy-release 는 marker 파일 한 줄만 읽는다 — 배포 스크립트에서 레거시 지식·데이터파괴 클래스가 사라진다.
#
# 사용:  bash deploy/migrate-to-bluegreen.sh [--confirm] [--lively-root <dir>] [--timestamp <ts>]
#   --confirm            (필수) 없으면 dry-run 계획만 출력(부작용 0).
#   --lively-root <dir>  배포 루트(기본 $LIVELY_ROOT 또는 /opt/lively).
#   --timestamp <ts>     백업 파일 타임스탬프(기본 date +%Y%m%d-%H%M%S).
#   환경변수: BLUE_PORT(8081) GREEN_PORT(8082) LIVELY_SERVICE_USER(구 유닛 User 가 비어있을 때만 사용)
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
# shellcheck source=lib/bluegreen.sh
source "$DIR/lib/bluegreen.sh"

CONFIRM=0
TS=""
LIVELY_ROOT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm)     CONFIRM=1; shift ;;
    --lively-root) LIVELY_ROOT_ARG="${2:?--lively-root 값 필요}"; shift 2 ;;
    --timestamp)   TS="${2:?--timestamp 값 필요}"; shift 2 ;;
    *) printf 'migrate-to-bluegreen: 알 수 없는 인자: %s\n' "$1" >&2; exit 2 ;;
  esac
done
LIVELY_ROOT="${LIVELY_ROOT_ARG:-${LIVELY_ROOT:-/opt/lively}}"
export LIVELY_ROOT
root="$LIVELY_ROOT"
TS="${TS:-$(date +%Y%m%d-%H%M%S)}"

# ── 구 단일유닛 탐지 — .service 파일 존재로만 판정(순수, systemd 상태 무관). 없으면 빈 문자열. ──
detect_legacy_unit() {
  local u
  for u in lively-gateway context-ontology-gateway; do
    if [ -f "/etc/systemd/system/${u}.service" ]; then printf '%s\n' "$u"; return 0; fi
  done
  printf '\n'; return 0
}

# ── stat 포맷 이식 래퍼 — GNU(coreutils, `-c`)와 BSD(macOS, `-f`) 문법이 다르다. ──
#  이 스크립트 본체는 Linux 전용이지만 순수 함수(same_filesystem·verify_copy)는 **개발자 맥에서 npm test 로 돈다**
#  (deploy/**/*.test.mjs 는 러너가 자동 수집). GNU 문법만 쓰면 맥에서 stat 이 통째로 실패해 '판정불가'로 떨어지고
#  bluegreen-logic.test.mjs 의 mv/copy 분기 단언이 깨진다(실측). 그래서 여기서 한 번만 흡수한다.
#   %d = 디바이스 번호(GNU) = %d(BSD 도 동일 키), %s = 바이트 크기(GNU) = %z(BSD). 실패 시 rc!=0(호출부가 안전측 판단).
stat_fmt() {
  local key="$1" target="$2"
  case "$key" in
    dev)  stat -c %d "$target" 2>/dev/null || stat -f %d "$target" 2>/dev/null ;;
    size) stat -c %s "$target" 2>/dev/null || stat -f %z "$target" 2>/dev/null ;;
    *)    printf 'stat_fmt: 알 수 없는 키: %s\n' "$key" >&2; return 2 ;;
  esac
}

# ── 같은 파일시스템인가(cross-FS 판정) — stat 디바이스 번호 대조. stat 실패면 '다름'(안전측=copy). ──
same_filesystem() {
  local a b
  a="$(stat_fmt dev "$1" || echo x)"
  b="$(stat_fmt dev "$2" || echo y)"
  [ "$a" != x ] && [ "$b" != y ] && [ "$a" = "$b" ]
}

# ── 구 단일유닛이 실제로 서빙 중인 포트 — 다음 deploy-release 의 최초 flip 이 **이 포트를 deregister** 해야 한다. ──
#  구 유닛은 `node --env-file-if-exists=.env dist/index.js` 를 WorkingDirectory=old_app 에서 돌리므로 포트의 SoT 는
#  old_app/.env 의 PORT 한 곳뿐이다(유닛 템플릿에 PORT Environment/EnvironmentFile 없음 — deploy/linux/lively-gateway.service).
#  ⚠ 8080 을 하드코딩하면 안 된다: PORT 를 바꿔 설치한 박스에서 최초 flip 이 **엉뚱한 포트를 deregister** 해
#   구 포트가 TG 에 등록된 채 남고, 곧이어 구 유닛이 정지되면서 죽은 타깃이 트래픽을 받는다(무증상 5xx — 이 스킴이
#   assert_tg_hc_traffic_port 로 막으려는 것과 같은 silent-outage 클래스). 그래서 흡수 시점에 실측값을 marker 로 남긴다.
#  순수(부작용 없음, stdout 만). .env 부재·PORT 미지정이면 앱 기본값과 같은 8080.
detect_legacy_port() {
  local envf="$1/.env" content="" p=""
  # 읽을 수 있으면 그대로(운영자가 .env 소유자 — 640 operator:svc_user 불변식), 아니면 sudo 로 한 번 더.
  #  sudo 를 조건 없이 쓰면 tty 없는 호출(테스트·CI)에서 통째로 실패해 조용히 기본값으로 떨어진다.
  if [ -r "$envf" ]; then content="$(cat "$envf" 2>/dev/null || true)"
  elif [ -f "$envf" ]; then content="$(sudo cat "$envf" 2>/dev/null || true)"; fi
  # 마지막 정의가 이긴다(dotenv 관례). `PORT` 로 **끝나는** 다른 키(ITEMS_DB_PORT 등)에 낚이지 않게 줄머리 앵커.
  p="$(printf '%s\n' "$content" \
       | grep -E '^[[:space:]]*PORT[[:space:]]*=' \
       | tail -1 \
       | sed -E 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' || true)"
  printf '%s\n' "$p" | grep -qE '^[0-9]+$' || p=8080     # 부재·빈값·비정수 → 앱 기본값
  printf '%s\n' "$p"
}

# ── 이동 전략 — 같은 FS 면 mv(원자적 rename), 아니면(또는 판정불가) copy(→검증→삭제, 안전측). ──
#  순수(부작용 없음, stdout 만) — 테스트가 bash 로 직접 실행해 분기 결정을 락한다.
migrate_move_strategy() {
  if same_filesystem "$1" "$2"; then printf 'mv\n'; else printf 'copy\n'; fi
}

# ── cross-FS 복사 검증 — 디렉토리는 파일 개수, 파일은 바이트 크기 대조(백업이 있으니 이 정도로 충분). ──
verify_copy() {
  local src="$1" dst="$2"
  if [ -d "$src" ]; then
    local cs cd
    cs="$(sudo find "$src" -type f 2>/dev/null | wc -l)"
    cd="$(sudo find "$dst" -type f 2>/dev/null | wc -l)"
    [ "$cs" = "$cd" ]
  else
    local ss sd
    ss="$(sudo stat -c %s "$src" 2>/dev/null || sudo stat -f %z "$src" 2>/dev/null || echo a)"
    sd="$(sudo stat -c %s "$dst" 2>/dev/null || sudo stat -f %z "$dst" 2>/dev/null || echo b)"
    [ "$ss" = "$sd" ]
  fi
}

# ── 항목 하나(.env|data) 이동 — cross-FS 안전 + 자기참조 안전 + old_app 심볼릭 재배선. 멱등. ──
migrate_one() {
  local old_app="$1" shared="$2" name="$3"
  local src="$old_app/$name" dst="$shared/$name"
  # 이미 shared 에 있음(멱등/재실행) — 자기참조면 손대지 않고, 아니면 old_app 심볼릭만 보장.
  if [ -e "$dst" ]; then
    local rsrc rdst; rsrc="$(readlink -f "$src" 2>/dev/null || true)"; rdst="$(readlink -f "$dst" 2>/dev/null || true)"
    if [ -n "$rsrc" ] && [ "$rsrc" = "$rdst" ]; then
      warn "$src 가 이미 shared 원본($rdst)과 동일 실체 — 재배선 생략(자기참조 안전)"; return 0
    fi
    warn "shared 에 이미 $name 존재 — 이동 생략, old_app 심볼릭만 보장: $dst"
    # ⚠ src 가 실체(비심볼릭)인데 dst 도 존재 = cross-FS cp -a 가 중간에 죽고(디스크풀·중단·재부팅) 재실행된
    #  케이스일 수 있다. dst 는 검증 안 된 '부분복사본'일 수 있으므로, 원본(src)을 지우기 전에 verify_copy 로
    #  dst 완전성을 먼저 대조한다 — 일치할 때만 rm+재배선, 불일치면 die(부분복사본을 믿고 원본을 파괴하지 않는다).
    #  src 가 심볼릭(정상 완료 후 재실행)이면 실체가 아니므로 이 대조를 건너뛴다(포인터라 rm/재링크가 안전).
    if [ ! -L "$src" ] && [ -e "$src" ]; then
      verify_copy "$src" "$dst" \
        || die "재실행 감지 — shared/$name($dst) 가 원본($src)과 불일치합니다. cross-FS 복사가 중간에 실패한 '부분복사본'일 수 있어 원본을 지우지 않았습니다. backups/pre-bluegreen-*.tar.gz 에서 복원하거나, $dst 와 $src 를 수동 대사한 뒤 재실행하세요."
      sudo rm -rf "$src"
    fi
    sudo ln -sfn "$dst" "$src"; return 0
  fi
  # old_app 항목이 이미 심볼릭(예외) — 그 타깃 실체를 shared 로 복사 후 재배선(mv 아님).
  if [ -L "$src" ]; then
    local tgt; tgt="$(readlink -f "$src" 2>/dev/null || true)"
    [ -n "$tgt" ] && [ -e "$tgt" ] || die "old_app/$name 이 깨진 심볼릭입니다($src) — 수동 확인 필요."
    sudo cp -a "$tgt" "$dst"
    sudo ln -sfn "$dst" "$src"; return 0
  fi
  [ -e "$src" ] || { warn "old_app 에 $name 없음 — 건너뜀"; return 0; }
  # 실 이동 — 같은 FS 면 mv(원자, 권한·소유 보존), 다르면 cp -a(보존)→검증→원본 삭제(백업이 있으니 안전).
  if same_filesystem "$old_app" "$shared"; then
    sudo mv "$src" "$dst"
  else
    sudo cp -a "$src" "$dst"
    verify_copy "$src" "$dst" || die "cross-FS 복사 검증 실패: $src → $dst (원본 유지 — 백업에서 복원 가능)."
    sudo rm -rf "$src"
  fi
  sudo ln -sfn "$dst" "$src"   # 구 유닛이 old_app 경로(WorkingDirectory)에서 계속 .env·data 를 본다(8080 서빙 지속).
}

main() {
  [ "$(detect_os)" = linux ] || die "migrate-to-bluegreen 은 Linux/systemd 전용입니다(mac 은 단일 launchd)."
  require_cmd systemctl; require_cmd tar; require_cmd stat

  # ── 0) 전제검사 ──────────────────────────────────────────────────────────
  local legacy; legacy="$(detect_legacy_unit)"
  [ -n "$legacy" ] || die "구 단일유닛(lively-gateway / context-ontology-gateway)을 찾지 못했습니다 — 흡수할 단일설치가 없습니다(신규 박스면 이 스크립트 대상이 아닙니다)."
  [ ! -e "$root/active-color" ] || die "이미 blue-green 레이아웃이 존재합니다($root/active-color) — 재흡수를 거부합니다(흡수는 1회성·멱등). 잘못된 상태면 수동 확인 후 진행하세요."

  local old_app; old_app="$(systemctl show -p WorkingDirectory --value "$legacy" 2>/dev/null || true)"
  [ -n "$old_app" ] && [ -d "$old_app" ] || die "구 유닛 $legacy 의 WorkingDirectory 를 못 읽었습니다(old_app='$old_app') — 수동 확인 필요."

  # SERVICE_USER = 구 유닛 User. 비어있으면(root 실행) LIVELY_SERVICE_USER env, 그것도 없으면 die(silent root 흡수 거부).
  local svc_user; svc_user="$(systemctl show -p User --value "$legacy" 2>/dev/null || true)"
  [ -n "$svc_user" ] || svc_user="${LIVELY_SERVICE_USER:-}"
  [ -n "$svc_user" ] || die "구 유닛 $legacy 의 User 가 비어 있습니다(root 실행?) — LIVELY_SERVICE_USER 로 서비스 유저를 명시하세요(silent root 흡수 거부)."

  local backup="$root/backups/pre-bluegreen-${TS}.tar.gz"
  local blue_port; blue_port="$(bg_port blue)"
  local green_port; green_port="$(bg_port green)"
  local legacy_port; legacy_port="$(detect_legacy_port "$old_app")"
  # 구 포트가 flip pool(blue|green)과 겹치면 흡수해선 안 된다 — 첫 배포가 idle(green)을 그 포트에 띄우려다
  #  구 유닛과 충돌하고(EADDRINUSE / 선점 검사 die), 최악은 idle==active 포트로 flip 이 무효가 되는 것이다.
  #  deploy-release 도 이 클래스를 잡지만 그땐 '흡수는 이미 끝난 뒤'라 되돌리기가 번거롭다 → 여기서 먼저 끊는다.
  if [ "$legacy_port" = "$blue_port" ] || [ "$legacy_port" = "$green_port" ]; then
    die "구 유닛의 포트(:$legacy_port)가 blue-green flip pool(blue :$blue_port · green :$green_port)과 겹칩니다 — 흡수를 중단합니다. BLUE_PORT/GREEN_PORT 로 겹치지 않는 포트를 지정해 재실행하거나, 구 설치의 PORT 를 먼저 옮기세요."
  fi

  # ── 계획 출력(dry-run·confirm 공통) ───────────────────────────────────────
  phase "흡수 계획 (migrate-to-bluegreen)"
  log "구 단일유닛      : $legacy"
  log "WorkingDirectory : $old_app"
  log "서비스 유저      : $svc_user"
  log "LIVELY_ROOT      : $root"
  log "백업 파일        : $backup   (← old_app/{.env,data}, 어떤 이동보다 먼저)"
  log "이동             : $old_app/{.env,data} → $root/shared/   (같은 FS=mv, 다르면 copy→검증→삭제)"
  log "blue seed        : active-color=blue · blue→$old_app · color-env/blue.env(PORT=$blue_port) · 템플릿 유닛 렌더"
  log "레거시 marker    : $root/legacy-blue-unit=$legacy · $root/legacy-blue-port=$legacy_port  (다음 deploy-release 최초 flip 때 정리)"
  log "구 유닛          : 정지·flip 안 함(계속 :$legacy_port 서빙)."
  # 실측 포트가 기본이 아니면 눈에 띄게 알린다 — 최초 flip 의 deregister 대상이 이 값이라 오탐이면 곧 사망 타깃이 된다.
  [ "$legacy_port" = 8080 ] || warn "구 유닛 포트가 기본(8080)이 아닙니다: :$legacy_port (old_app/.env 의 PORT). 최초 flip 은 이 포트를 ALB 에서 deregister 합니다 — 실제 서빙 포트와 다르면 지금 중단하고 확인하세요: ss -ltnp | grep -w $legacy_port"

  if [ "$CONFIRM" != 1 ]; then
    warn "DRY-RUN — 실제 변경 없음. 실행하려면 --confirm 을 붙이세요."
    return 0
  fi

  # ── 1) 백업 먼저(가장 중요) — 어떤 이동보다 앞서. 실패면 die(이동 안 함). ──
  phase "1/5 백업(이동 전 최우선)"
  sudo mkdir -p "$root/backups"
  local bk_items=()
  [ -e "$old_app/.env" ] && bk_items+=(".env")
  [ -e "$old_app/data" ] && bk_items+=("data")
  [ ${#bk_items[@]} -gt 0 ] || die "백업 대상(.env·data)이 old_app 에 없습니다($old_app) — 흡수 전제 위반, 중단."
  sudo tar -czf "$backup" -C "$old_app" "${bk_items[@]}" || die "백업 생성 실패: $backup (이동 안 함)."
  sudo tar -tzf "$backup" >/dev/null 2>&1 || die "백업 검증 실패(tar -tzf): $backup (이동 안 함)."
  ok "백업 완료 — 이 파일로 언제든 복원 가능:"
  printf '  백업: %s\n' "$backup"

  # ── 2) 레이아웃 생성 ──────────────────────────────────────────────────────
  phase "2/5 레이아웃 생성"
  sudo mkdir -p "$root/releases" "$root/shared" "$root/logs" "$root/color-env" "$root/backups"

  # ── 3) 데이터 이동(cross-FS 안전) ─────────────────────────────────────────
  phase "3/5 공유 상태 이동(.env·data → shared)"
  local p
  for p in .env data; do
    migrate_one "$old_app" "$root/shared" "$p"
  done

  # ── 4) 권한·소유 — hardened umask 대비 명시 chmod/chown. ──────────────────
  phase "4/5 권한·소유"
  sudo chmod 755 "$root/shared" 2>/dev/null || true   # 서비스 유저 traverse
  [ -e "$root/shared/data" ] && sudo chown -R "$svc_user" "$root/shared/data" 2>/dev/null || true
  # .env 소유권 불변식(운영자:서비스유저 640 — 게이트웨이가 group-read 로 DB 접속정보 로드). common.sh ensure_service_user 와 동일.
  if [ -e "$root/shared/.env" ]; then sudo chown "$(id -un)":"$svc_user" "$root/shared/.env" && sudo chmod 640 "$root/shared/.env"; fi

  # ── 5) blue seed + 템플릿 유닛 렌더 + 레거시 marker ───────────────────────
  phase "5/5 blue seed + 템플릿 유닛"
  sudo ln -sfn "$old_app" "$root/blue"                             # blue = 구 릴리스(구 유닛이 서빙 중). old_app 은 dist/index.js 보유(단일 유닛 ExecStart).
  printf 'PORT=%s\n' "$blue_port" | sudo tee "$root/color-env/blue.env" >/dev/null
  export SERVICE_USER="$svc_user"                                  # render_bluegreen_unit 이 읽는다(User=svc_user).
  render_bluegreen_unit                                            # 템플릿 유닛(@.service) 렌더 — 기동은 안 함(구 유닛이 자기 포트를 물고 있음).
  printf '%s\n' "$legacy" | sudo tee "$root/legacy-blue-unit" >/dev/null   # 최초 flip 때 정리할 구 유닛명 인계.
  printf '%s\n' "$legacy_port" | sudo tee "$root/legacy-blue-port" >/dev/null  # 최초 flip 이 ALB 에서 뺄 구 포트 인계(8080 하드코딩 금지).
  printf 'blue' | sudo tee "$root/active-color" >/dev/null         # active seed=blue → 다음 배포 idle=green(8082, 구 포트 충돌 회피).
  ok "blue seed 완료 — active=blue · blue→$old_app · 구 유닛 $legacy 계속 :$legacy_port 서빙"

  # loopback forwarder(:8080)는 여기서 설치하지 않는다 — 흡수 직후엔 구 단일유닛이 아직 그 포트를 서빙 중이라
  #  socket bind 가 충돌하고, 세션 핀(localhost:8080)은 그 구 유닛이 그대로 받는다. 첫 deploy-release flip 의
  #  phase3(render_loopback_forwarder)이 구 포트 정리와 함께 forwarder 를 세워 인계한다.

  # ── 런북 ──────────────────────────────────────────────────────────────────
  phase "완료 — 다음 단계(런북)"
  ok "흡수 완료. 구 유닛($legacy)은 계속 :$legacy_port 서빙 중, 레이아웃 준비됨."
  log "① 새 릴리스 준비 후 무중단 flip(ALB 타깃 포트 스왑):"
  log "     bash deploy/deploy-release.sh --release <새 릴리스 dir> --tg-arn <ALB 타깃그룹 ARN>"
  log "     → green($(bg_port green))에 올려 ALB register→healthy→구 포트(:$legacy_port) deregister flip, 그 최초 flip 이"
  log "       구 유닛 $legacy 를 정지·제거(marker 로 인계). 전제: ALB TG 가 이미 이 인스턴스 :$legacy_port 를 서빙 중."
  log "② 롤백(흡수 되돌리기 — 아직 deploy-release 전이라면):"
  log "     - 백업 복원:   sudo tar -xzf $backup -C $old_app"
  log "     - 심볼릭 제거:  sudo rm -f $old_app/.env $old_app/data  (그 뒤 백업에서 푼 실체가 남음)"
  log "     - 레이아웃 제거: sudo rm -rf $root/shared $root/blue $root/active-color $root/legacy-blue-unit $root/legacy-blue-port $root/color-env/blue.env"
  log "     - 구 유닛은 정지된 적 없으므로 그대로 :$legacy_port 서빙 지속(추가 복구 불요)."
  log "   백업 파일: $backup"
}

# 소스될 때(테스트)는 main 을 돌리지 않는다 — 순수 함수(same_filesystem·migrate_move_strategy 등)만 검증 가능하게.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
