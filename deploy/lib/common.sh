# shellcheck shell=bash
# 배포 공통 헬퍼 — Linux/Mac 공유. install.sh 가 source 한다.

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/lib
DEPLOY_DIR="$(dirname "$LIB_DIR")"                         # deploy
APP_DIR="$(dirname "$DEPLOY_DIR")"                         # repo 루트
export LIB_DIR DEPLOY_DIR APP_DIR

# ── 로그 ──
_c() { printf '\033[%sm' "$1"; }
# ⚠ 진단/진행 로그는 전부 stderr 로(warn·die 와 동일). stdout 은 '데이터 반환' 전용 — ensure_service_user 처럼
#   VAR="$(func)" 로 캡처되는 함수가 log 를 stdout 에 흘리면 반환값이 오염돼(→ getet passwd 실패, set -e exit 2) 배포가 깨진다.
log()    { printf '%s▸%s %s\n'  "$(_c '1;36')" "$(_c 0)" "$*" >&2; }
phase()  { printf '\n%s══ %s ══%s\n' "$(_c '1;35')" "$*" "$(_c 0)" >&2; }
ok()     { printf '%s✓%s %s\n'  "$(_c '1;32')" "$(_c 0)" "$*" >&2; }
warn()   { printf '%s⚠%s %s\n'  "$(_c '1;33')" "$(_c 0)" "$*" >&2; }
die()    { printf '%s✗%s %s\n'  "$(_c '1;31')" "$(_c 0)" "$*" >&2; exit 1; }

# ── OS 감지 ──
detect_os() {
  case "$(uname -s)" in
    Linux)  echo linux ;;
    Darwin) echo mac ;;
    *) die "지원하지 않는 OS: $(uname -s) (linux/mac 만)" ;;
  esac
}

# ── P4(#524): 전용 비-root 게이트웨이 서비스 유저 ──
#  게이트웨이·프로젝트 공동세션이 admin(ssm-user)로 안 뜨게 — non-root·무sudo·무docker 의 lively 로.
#  멱등. echo 로 실제 서비스 유저명 반환. mac(launchd)·미Linux 는 현 유저(대상 아님).
#  ⚠ 격리 spawn 은 별도 잠긴 sudoers(install-isolation, GATEWAY_USER=이 유저)로만 부여 — 여기선 유저·소유권만.
LIVELY_SERVICE_HOME="${LIVELY_SERVICE_HOME:-/var/lib/lively}"
# .env(KEY=VAL 파일) 키 멱등 설정 — 있으면 교체, 없으면 추가. 값은 경로(특수문자 없음)라 sed # 구분자 안전.
set_env() { local f="$1" k="$2" v="$3"
  if sudo grep -qE "^$k=" "$f" 2>/dev/null; then sudo sed -i "s#^$k=.*#$k=$v#" "$f"; else echo "$k=$v" | sudo tee -a "$f" >/dev/null; fi
}
ensure_service_user() {
  local user="${1:-lively}"
  if [ "$(detect_os)" != linux ]; then echo "$(id -un)"; return 0; fi
  if ! id "$user" >/dev/null 2>&1; then
    sudo useradd --system --create-home --home-dir "$LIVELY_SERVICE_HOME" --shell /bin/bash "$user" \
      || die "게이트웨이 서비스 유저 생성 실패: $user"
    log "게이트웨이 서비스 유저 생성: $user (system·shell=bash·무암호·무SSH키·무sudo·무docker)"
  fi
  # ⚠ 셸 = /bin/bash (nologin 아님). 게이트웨이가 '비격리' 세션(프로젝트 공동세션·managed)을 이 유저로 spawn 하는데
  #   tmux new-session 이 '명령 없이'면 유저의 로그인 셸을 띄운다 → nologin 이면 즉시 죽어 세션 생성이 500.
  #   로그인은 무암호·무authorized_keys 로 이미 차단(셸 있어도 로그인 불가) → bash 부여가 보안 저하 아님. 기존 유저도 멱등 교정.
  case "$(getent passwd "$user" | cut -d: -f7)" in */bash) : ;; *) sudo usermod -s /bin/bash "$user"; log "서비스 유저 셸 → /bin/bash (비격리 세션 spawn 용)" ;; esac
  getent group lively-shared >/dev/null || sudo groupadd lively-shared
  id -nG "$user" | tr ' ' '\n' | grep -qx lively-shared || sudo usermod -aG lively-shared "$user"
  # ⚠ APP_DIR 소유는 '운영자(배포 실행 유저)' 그대로 둔다 — update 가 npm ci/build 로 여기에 '쓰기' 때문(lively 소유면
  #   다음 update 의 npm ci 가 EACCES). 게이트웨이(lively)는 dist/node_modules 를 '읽기'만 하면 되고, 그건 /opt 아래
  #   (world traverse) + npm/git 기본 umask(022 → world/group read)로 충족 → chown -R 안 한다. logs 만 lively 가 append
  #   (systemd StandardOutput=append) → render_service_unit 이 chown -R 로 넘긴다.
  # .env 소유권 불변식(운영자:서비스유저 640 — 게이트웨이가 group-read)은 이 함수 '맨 끝'에서 적용한다 —
  #  아래 세션루트 repoint 의 set_env(sudo sed -i)가 .env 를 재작성하며 그룹을 도로 깰 수 있어, 모든 .env 편집 뒤가 유일하게 안전.
  case "$APP_DIR" in
    /opt/*|/srv/*) : ;;
    *) warn "앱 경로 $APP_DIR — lively 접근엔 /opt 권장(홈 아래면 상위 traverse 권한 필요)"; sudo chmod o+x "$(dirname "$APP_DIR")" 2>/dev/null || true ;;
  esac
  # ── 세션 루트(비격리 shared·personal)를 게이트웨이 유저 접근가능 경로로 ──
  #  프로젝트 공동세션(비격리)은 이 유저로 mkdir/spawn 한다. .env 의 TERMINAL_ROOT_* 가 옛 게이트웨이 유저 홈
  #  ($HOME/workspace)을 가리키면 lively 가 못 써서 세션 생성이 500. 현재 값을 이 유저가 쓸 수 있으면 보존(관리자
  #  커스텀 존중), 아니면 shared=격리공유dir(/srv/lively/shared, lively-shared 그룹 rw)·personal=서비스홈/box 로 repoint.
  local shared_dir="${LIVELY_SHARED_DIR:-/srv/lively/shared}"
  getent group lively-shared >/dev/null 2>&1 && sudo install -d -g lively-shared -m 2775 "$shared_dir" 2>/dev/null || sudo mkdir -p "$shared_dir"
  sudo install -d -o "$user" -g "$user" -m 700 "$LIVELY_SERVICE_HOME/box" 2>/dev/null || true
  if [ -f "$APP_DIR/.env" ]; then
    local cur
    cur="$(sudo grep -E '^TERMINAL_ROOT_SHARED=' "$APP_DIR/.env" | cut -d= -f2-)"
    sudo -u "$user" test -w "$cur" 2>/dev/null || { set_env "$APP_DIR/.env" TERMINAL_ROOT_SHARED "$shared_dir"; log "세션 shared 루트 → $shared_dir ($user 접근가능)"; }
    cur="$(sudo grep -E '^TERMINAL_ROOT_PERSONAL=' "$APP_DIR/.env" | cut -d= -f2-)"
    sudo -u "$user" test -w "$cur" 2>/dev/null || { set_env "$APP_DIR/.env" TERMINAL_ROOT_PERSONAL "$LIVELY_SERVICE_HOME/box"; log "세션 personal 루트 → $LIVELY_SERVICE_HOME/box"; }
  fi
  # ⭐ .env 소유권 불변식 최종 적용 — 위 모든 .env 편집(set_env 세션루트 repoint 등) '뒤' 마지막에 강제.
  #  게이트웨이(서비스유저 그룹)가 .env 를 group-read 해야 DB 접속정보를 로드한다(못 읽으면 password=undefined→SASL 다운:
  #  2026-07-03 고객사 A 실장애). sed -i 계열이 중간에 그룹을 깨도 여기가 최종적으로 '운영자:서비스유저 640' 을 보장.
  if [ -f "$APP_DIR/.env" ]; then sudo chown "$(id -un)":"$user" "$APP_DIR/.env" && sudo chmod 640 "$APP_DIR/.env"; fi
  echo "$user"
}

# 명령을 게이트웨이 서비스 유저(SERVICE_USER)로 실행 — P4 에서 .env·홈이 lively 소유라 부트스트랩·키트를 그 유저로.
#  SERVICE_USER 가 현재 유저(비-P4)면 그냥 실행. 설치에 필요한 env 만 화이트리스트로 전달(secure_path·홈 세팅).
run_as_service() {
  local svc="${SERVICE_USER:-$(id -un)}"
  if [ "$svc" = "$(id -un)" ] || [ "$(detect_os)" != linux ]; then "$@"; return; fi
  local h; h="$(getent passwd "$svc" | cut -d: -f6)"
  sudo -u "$svc" env HOME="$h" PATH="$PATH" \
    BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-}" ORG_DOMAIN="${ORG_DOMAIN:-}" \
    PUBLIC_URL="${PUBLIC_URL:-}" PORT="${PORT:-}" \
    LIVELY_GATEWAY="${LIVELY_GATEWAY:-}" LIVELY_TOKEN="${LIVELY_TOKEN:-}" KIT_HARNESS="${KIT_HARNESS:-}" \
    "$@"
}

# ── 서비스 유닛(systemd/launchd) 렌더·설치 — install(provision.os_install_service)·update 공유(단일 소스). ──
#  유닛 템플릿(deploy/<os>/…) 변경(예: KillMode=process)이 update.sh 로도 기존 박스에 전파되게 한다. 멱등.
#  '파일 렌더'만(+linux daemon-reload) — enable/start/restart 는 호출자가(provision=enable·start, update=restart).
#  게이트웨이 유저 = ${SERVICE_USER:-현재유저}. 호출자(provision=lively, update=현재보존)가 SERVICE_USER 로 지정.
render_service_unit() {
  local svc_user="${SERVICE_USER:-$(id -un)}"
  # ⚠ `|| true` 필수(#246) — getent 는 macOS 에 없어(127) pipefail+set -e 가 설치를 여기서 무언 중단시킨다.
  #  값은 linux 분기(@PATH@ 치환)만 쓰므로 폴백($HOME)으로 충분하다.
  local svc_home; svc_home="$(getent passwd "$svc_user" 2>/dev/null | cut -d: -f6 || true)"; svc_home="${svc_home:-$HOME}"
  require_cmd node   # set -e 에서 `$(command -v node)` 는 미설치 시 무언 exit(빈 ExecStart 유닛). 명시적 die 로 조기 차단.
  local node_bin node_dir; node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"
  # 게이트웨이(비-운영자 lively)가 런타임에 '쓰는' 디렉토리는 서비스유저 소유여야 한다 — logs(systemd append) +
  #  data(노션 자산 등 fs 쓰기: 게이트웨이 cwd=APP_DIR 이라 asset_dir 기본값 = $APP_DIR/data/notion-assets). APP_DIR 본체를
  #  운영자 소유로 두는 불변식(update 의 npm ci)과 무충돌 — logs·data 는 빌드 산출이 아니라 '런타임 쓰기'다(/usr vs /var 처럼
  #  코드=운영자·가변데이터=서비스유저 분리). items-db 는 docker named volume(items-db-data:/var/lib/postgresql)이라
  #  $APP_DIR/data 아래에 없음 → data 를 chown 해도 DB 볼륨 무영향. 매 update 재적용(멱등)이라 신규/이관 자산도 계속 소유.
  mkdir -p "$APP_DIR/logs" "$APP_DIR/data"
  [ "$(detect_os)" = linux ] && sudo chown -R "$svc_user" "$APP_DIR/logs" "$APP_DIR/data" 2>/dev/null || true
  case "$(detect_os)" in
    linux)
      local unit="/etc/systemd/system/lively-gateway.service"
      # #1059 B — 게이트웨이 서비스 cgroup 소프트 상한. GATEWAY_MEMORY_HIGH_MB(양의 정수) 설정 시에만 MemoryHigh 줄을 채운다.
      #  비었거나 0/비정수면 빈 줄 = 무제한 = **무회귀**(대다수 박스는 안 걸어도 됨 — D per-session 캡이 근본, 이건 보조).
      local mem_high_line=""
      if [ -n "${GATEWAY_MEMORY_HIGH_MB:-}" ] && printf '%s' "${GATEWAY_MEMORY_HIGH_MB}" | grep -qE '^[0-9]+$' && [ "${GATEWAY_MEMORY_HIGH_MB}" -gt 0 ]; then
        mem_high_line="MemoryHigh=${GATEWAY_MEMORY_HIGH_MB}M"
      fi
      sed -e "s#@APP_DIR@#$APP_DIR#g" \
          -e "s#@APP_USER@#$svc_user#g" \
          -e "s#@NODE_BIN@#$node_bin#g" \
          -e "s#@MEMORY_HIGH_LINE@#$mem_high_line#g" \
          -e "s#@PATH@#$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$svc_home/.npm-global/bin#g" \
          "$DEPLOY_DIR/linux/lively-gateway.service" | sudo tee "$unit" >/dev/null
      sudo systemctl daemon-reload
      ok "systemd 유닛 렌더: $unit (User=$svc_user${mem_high_line:+, $mem_high_line})"
      # #1240 — 여기가 유일하게 옳은 자리다: svc_user 가 확정돼 있고(이 함수가 그 값으로 유닛을 쓴다),
      #  아직 서비스를 (재)기동하기 전이라 새 그룹이 다음 exec 에 그대로 적용된다. 근거는 함수 주석 참조.
      ensure_journal_read_access "$svc_user"
      ;;
    mac)
      local plist="$HOME/Library/LaunchAgents/io.lvly.lively.plist"
      mkdir -p "$(dirname "$plist")"
      if [ -f "$plist" ]; then cp "$plist" "$plist.bak-$(date +%Y%m%d-%H%M%S)"; warn "기존 plist 백업 후 갱신"; fi
      sed -e "s#@APP_DIR@#$APP_DIR#g" \
          -e "s#@NODE_BIN@#$node_bin#g" \
          -e "s#@PATH@#$node_dir:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin#g" \
          "$DEPLOY_DIR/mac/io.lvly.lively.plist" > "$plist"
      ok "launchd plist 렌더: $plist"
      ;;
  esac
}

# ── blue-green 템플릿 유닛(lively-gateway@.service) 렌더·설치 — deploy-release.sh 가 부른다(Linux/systemd 전용). ──
#  render_service_unit(단일 유닛)의 blue-green 판. 인스턴스(%i=color)·WorkingDirectory·per-color EnvironmentFile 로
#  두 color 가 각자의 릴리스·포트를 물게 한다. '파일 렌더 + daemon-reload'만 — enable/start/stop 은 호출자(deploy-release).
#  멱등: 매 배포 재렌더(템플릿·PATH·node 경로 변경 전파). LIVELY_ROOT 는 caller env(기본 /opt/lively).
render_bluegreen_unit() {
  [ "$(detect_os)" = linux ] || die "blue-green 유닛은 Linux/systemd 전용입니다"
  local root="${LIVELY_ROOT:-/opt/lively}"
  # ⚠ SERVICE_USER 폴백(id -un) 금지 — silent 실행자 드리프트가 게이트웨이 유저를 운영자/root 로 바꿔 ~/.claude 인증·
  #  소유권을 무너뜨린 이력(#4). 현재 호출자(deploy-release·migrate)는 모두 export 하지만, 미래 호출자가 안 하면
  #  조용히 실행자 유닛이 렌더되므로 함수 자체가 불변식을 강제한다(알 수 없으면 폴백 말고 die).
  [ -n "${SERVICE_USER:-}" ] || die "render_bluegreen_unit: SERVICE_USER 미설정 — 호출자가 서비스 유저를 export 해야 합니다(silent 실행자 드리프트 금지)."
  local svc_user="$SERVICE_USER"
  local svc_home; svc_home="$(getent passwd "$svc_user" 2>/dev/null | cut -d: -f6 || true)"; svc_home="${svc_home:-$HOME}"  # || true: #246 과 동일(pipefail)
  require_cmd node   # set -e 에서 `$(command -v node)` 는 미설치 시 무언 exit(빈 ExecStart 유닛). 명시적 die 로 조기 차단.
  local node_bin node_dir; node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"
  # 게이트웨이가 런타임에 '쓰는' 공유 디렉토리는 서비스유저 소유 — render_service_unit 과 동일 원칙·동일 멱등성.
  #  logs: 유닛이 append: 로 쓴다.  shared/data: 릴리스 안 data 심볼릭의 실체(노션 자산 등 fs 쓰기).
  #  ⚠ data 도 매 배포 재적용해야 한다 — migrate 가 흡수 시 한 번 chown 하지만, 그 뒤 운영자가 root 로 파일을
  #   떨구면(복원·수기 이관) 게이트웨이가 그 하위에 못 써서 조용히 실패한다. 단일 유닛 쪽 불변식과 같은 이유.
  sudo mkdir -p "$root/logs" "$root/shared/data"
  sudo chown -R "$svc_user" "$root/logs" "$root/shared/data" 2>/dev/null || true
  # MemoryHigh 소프트 상한(#1059 B) — 단일 유닛과 동일 규칙(GATEWAY_MEMORY_HIGH_MB 양의 정수일 때만, 비면 무제한).
  local mem_high_line=""
  if [ -n "${GATEWAY_MEMORY_HIGH_MB:-}" ] && printf '%s' "${GATEWAY_MEMORY_HIGH_MB}" | grep -qE '^[0-9]+$' && [ "${GATEWAY_MEMORY_HIGH_MB}" -gt 0 ]; then
    mem_high_line="MemoryHigh=${GATEWAY_MEMORY_HIGH_MB}M"
  fi
  local unit="/etc/systemd/system/lively-gateway@.service"
  sed -e "s#@LIVELY_ROOT@#$root#g" \
      -e "s#@APP_USER@#$svc_user#g" \
      -e "s#@NODE_BIN@#$node_bin#g" \
      -e "s#@MEMORY_HIGH_LINE@#$mem_high_line#g" \
      -e "s#@PATH@#$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$svc_home/.npm-global/bin#g" \
      "$DEPLOY_DIR/linux/lively-gateway@.service" | sudo tee "$unit" >/dev/null
  sudo systemctl daemon-reload
  ok "systemd 템플릿 유닛 렌더: $unit (User=$svc_user${mem_high_line:+, $mem_high_line})"
  ensure_journal_read_access "$svc_user"   # earlyoom kill 관측(단일 유닛과 동일) — svc_user 확정 + 재기동 전, 여기가 옳은 자리.
}

# ── loopback alias forwarder(:8080 → active color) 렌더 — deploy-release 가 flip 마다 부른다(Linux/systemd 전용). ──
#  migrate 는 의도적으로 안 부른다(흡수 직후엔 구 단일유닛이 아직 :8080 을 물어 socket bind 충돌 — migrate 주석 참조).
#  8080 은 blue-green flip pool 에서 빠져(blue:8081|green:8082) 세션 클라 핀(~/.lively/gateway-url=http://localhost:8080)
#  전용 안정 진입점이 됐다(2026-08-03 flip 이 세션 핀을 죽여 전 세션 재연결 실패). socket 은
#  상시 listen(sockets.target), service(systemd-socket-proxyd L4 프록시)만 flip 마다 새 active 포트로 재렌더·restart.
#  render_bluegreen_unit 과 동일 규약: '파일 렌더 + daemon-reload'만 — enable/start/restart 는 호출자가(순단 최소).
render_loopback_forwarder() {
  [ "$(detect_os)" = linux ] || die "loopback forwarder 는 Linux/systemd 전용입니다"
  local active_port="${1:?render_loopback_forwarder: active_port 인자 필요}"
  printf '%s' "$active_port" | grep -qE '^[0-9]+$' || die "render_loopback_forwarder: active_port 는 정수여야 합니다: $active_port"
  # systemd-socket-proxyd 바이너리 탐지 — 배포판별 위치(/lib vs /usr/lib). 둘 다 없으면 die(systemd 내장이라 통상 존재).
  local proxyd_bin=""
  if [ -x /lib/systemd/systemd-socket-proxyd ]; then proxyd_bin=/lib/systemd/systemd-socket-proxyd
  elif [ -x /usr/lib/systemd/systemd-socket-proxyd ]; then proxyd_bin=/usr/lib/systemd/systemd-socket-proxyd
  else die "systemd-socket-proxyd 미설치 — loopback forwarder 를 렌더할 수 없습니다(/lib·/usr/lib/systemd 둘 다 없음)."; fi
  # socket 유닛은 무치환 그대로 복사(ListenStream 고정 :8080), service 유닛만 sed 로 @ACTIVE_PORT@·@PROXYD_BIN@ 치환.
  sudo tee /etc/systemd/system/lively-loopback.socket < "$DEPLOY_DIR/linux/lively-loopback.socket" >/dev/null
  sed -e "s#@ACTIVE_PORT@#$active_port#g" \
      -e "s#@PROXYD_BIN@#$proxyd_bin#g" \
      "$DEPLOY_DIR/linux/lively-loopback.service" | sudo tee /etc/systemd/system/lively-loopback.service >/dev/null
  sudo systemctl daemon-reload
  ok "loopback forwarder 렌더: :8080 → active :$active_port"
}

# ── 호스트 메모리 안전장치 (#1059 OOM 재발방지) — install·update 공유(단일 소스, render_service_unit 패턴). ──
#  2026-07-21 고객사 A 다운: claude 세션 baseline(~8GB) + Ollama 임베딩 3.3GB 스파이크가 스왑0 물리 초과 →
#   스래싱 라이브락(쉘·게이트웨이 무응답 → 강제재부팅, global_oom 이 엉뚱하게 llama-server 만 반복 kill). swap 완충 +
#   earlyoom(sshd 보호하며 폭주 프로세스 선제 kill)로 방어. Linux 전용(mac no-op — launchd 박스는 대상 아님).
#  멱등·비파괴(delivery-install-invariants): 기존 swap/sysctl/earlyoom 설정을 덮지 않고 존중. sudo 필요(install·update 는 이미 sudo 사용).
#  조정: LIVELY_SWAP_SIZE(기본 8G, 0=swap 생략) · LIVELY_MEM_SAFETY=off(전체 생략).
ensure_host_memory_safety() {
  [ "$(detect_os)" = linux ] || return 0
  [ "${LIVELY_MEM_SAFETY:-on}" != off ] || { log "메모리 안전장치 — LIVELY_MEM_SAFETY=off, 생략"; return 0; }

  # ① swap — 활성 swap 이 하나도 없을 때만 생성(기존 구성 존중). fallocate 실패(구 FS)면 dd 폴백.
  local swap_size="${LIVELY_SWAP_SIZE:-8G}" swapfile="/swapfile"
  if [ "$swap_size" = 0 ]; then
    log "메모리: swap 생성 생략(LIVELY_SWAP_SIZE=0)"
  elif [ -n "$(swapon --show=NAME --noheadings 2>/dev/null)" ]; then
    ok "메모리: swap 이미 활성 — 존중(비파괴)"
  else
    log "메모리: swap 없음 → $swapfile ($swap_size) 생성"
    if ! sudo fallocate -l "$swap_size" "$swapfile" 2>/dev/null; then
      local mib; mib="$(numfmt --from=iec "$swap_size" 2>/dev/null || echo 8589934592)"; mib=$(( mib / 1048576 ))
      sudo dd if=/dev/zero of="$swapfile" bs=1M count="$mib" status=none 2>/dev/null || true
    fi
    if sudo chmod 600 "$swapfile" 2>/dev/null && sudo mkswap "$swapfile" >/dev/null 2>&1 && sudo swapon "$swapfile" 2>/dev/null; then
      grep -qE "^[[:space:]]*$swapfile[[:space:]]" /etc/fstab 2>/dev/null || echo "$swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
      ok "메모리: swap 활성화 $swapfile ($swap_size, /etc/fstab 등재)"
    else
      warn "메모리: swap 설정 실패(비치명) — 수동 확인: swapon --show"
    fi
  fi

  # ② swappiness — lively 관리 sysctl 파일이 없을 때만 생성(고객 기존 튜닝 존중). 스왑 완충이 너무 늦지 않게 10.
  local sysctl_f="/etc/sysctl.d/99-lively-mem.conf"
  if [ -f "$sysctl_f" ]; then
    log "메모리: $sysctl_f 이미 존재 — 존중(비파괴)"
  else
    printf '# lively(#1059) — 스왑 완충이 너무 늦지 않게. 조정/제거 자유.\nvm.swappiness=10\n' | sudo tee "$sysctl_f" >/dev/null \
      && sudo sysctl -q -p "$sysctl_f" 2>/dev/null || true
    ok "메모리: vm.swappiness=10 ($sysctl_f — lively 관리)"
  fi

  # ③ earlyoom — 물리 임계 도달 시 생명줄을 보호하며 **가장 큰** 프로세스를 선제 kill. 커널 global_oom 보다 이르고 정밀.
  #
  #  ⚠ #1220 재설계(2026-07-28) — 종전 `-s 6` + `--prefer claude` 두 인자가 방어를 정반대로 만들고 있었다. 실측 근거:
  #   고객사 A에서 하루에 claude 4개(서로 다른 멤버)를 SIGTERM 했는데 죽은 게 VmRSS 177~328MB 짜리였고, 죽여도
  #   압박이 안 풀려(03:03:09 kill → 5초 뒤 여전히 5.37%) 연쇄 학살이 됐다.
  #
  #   ㉠ `--prefer (^|/)claude$` **제거**. prefer 는 oom_score 에 +300 을 얹는다(earlyoom kill.c OOM_SCORE_PREFER).
  #     그런데 커널이 노출하는 oom_score 는 `(1000 + (RSS+swap+pgtables)*1000/(RAM+swap)) * 2/3`(fs/proc/base.c
  #     proc_oom_score) 라 **하한이 666**이고, 24GB(RAM16+swap8) 분모에선 300MB 차이가 5점 남짓이다 — 즉 claude 끼리는
  #     애초에 사실상 동점인데 거기에 +300 을 주니 **크기와 무관하게 모든 claude 가 1순위**가 됐다(실측 badness 976~978).
  #     게다가 분자에 **swap 이 포함**돼(mm/oom_kill.c oom_badness) 오래 idle 이라 swap 으로 밀려난 세션일수록 점수가
  #     높은데, 그런 프로세스를 죽여도 **RAM 은 RSS 만큼만 풀린다**(실측 badness 978 을 역산하면 총 417MB 중 240MB 가
  #     이미 swap) → 죽여도 압박이 안 풀리고 다음 tick 에 또 죽인다. prefer 를 빼면 크기 순으로 돌아가 3.3GB
  #     llama-server(≈758점)가 claude(≈678점)보다 먼저 죽어 **3.3GB 가 실제로 풀리고**, 재로드 가능한 캐시라 사용자 피해도 없다.
  #     세션 총합(baseline)은 earlyoom 이 하나씩 죽여서 줄일 수 있는 게 아니다 — 그건 F(idle 회수)와 압박 회수의 몫이다.
  #   ㉡ `-s 6` → `-s 100,100`. earlyoom 발동 조건은 `MemAvailable% <= -m` **AND** `SwapFree% <= -s` 다(main.c:414).
  #     즉 #1059 A 로 swap 8G 를 깐 뒤로는 **swap 이 거의 다 찰 때까지 earlyoom 이 아예 발동하지 않아** 그동안 스래싱만
  #     진행됐다(#1059 로그: `swap free: 0 of 8191 MiB (0.00%)` 가 되어서야 kill). `-s 100` 은 earlyoom 이 문서화한
  #     'swap 무시' 관용구(msg.c: "Using -s 100 is a valid way to ignore swap usage"). term 만 100 이면 SIGKILL
  #     에스컬레이션 조건(kill=term/2=50%)이 남으므로 **term,kill 둘 다 100**으로 준다.
  #   ㉢ `-m 6` 은 그대로. 임계까지 같이 건드리면 무엇이 효과를 냈는지 못 가른다(변경은 방향만, 세기는 종전).
  #     earlyoom 앞단은 게이트웨이 압박 회수(session-reaper)가 맡는다 — 그쪽이 예고·복원 가능한 정상 경로다.
  #
  #  --avoid: 생명줄(sshd·systemd·dbus·tmux=세션컨테이너·docker=store·node=게이트웨이). node 는 게이트웨이를 노린
  #   과잉보호(멤버가 띄운 빌드 node 까지 보호)지만 **유지한다** — comm 으로는 둘을 구분할 수 없고, 유닛
  #   `OOMScoreAdjust=` 로 게이트웨이만 정밀 보호하면 그 값을 **자식(tmux 서버 → 세션 claude)이 상속**해 세션까지
  #   보호돼 최후 방어가 통째로 무력화된다. 세션 안에서 도는 빌드 폭주는 D(per-session cgroup 캡)의 일이다.
  #
  #  ⚠ **avoid 는 생명줄 보호일 뿐 아니라 `oom_score_adj` 왜곡을 막는 장치이기도 하다**(#1220 EC2 실증에서 발견).
  #   커널 oom_score 에는 `oom_score_adj` 가 **그대로 더해진다**(mm/oom_kill.c: `adj *= totalpages/1000; points += adj`).
  #   그래서 systemd 계열의 adj=100~200 짜리 프로세스는 **수 MB 밖에 안 쓰는데도 점수가 700~800** 이 되어,
  #   3.3GB llama-server(689)나 claude(673)를 제치고 1순위가 된다. 그걸 죽이면 **몇 MB 만 풀리고 압박은 그대로**라
  #   #1220 이 고치려던 연쇄 학살이 그대로 재현된다. 기존 avoid 항목(systemd·dbus.*·node)이 −300 으로 그 왜곡을
  #   상쇄하고 있었는데, **`(sd-pam)` 만 괄호로 시작해 어떤 항목에도 안 걸려 뚫려 있었다**(pilot-box 실측:
  #   adj=100 · RSS 3.3MB · score 733 → prefer 를 뺀 순간 실제로 1순위로 뽑혔다). 그래서 명시적으로 넣는다.
  #   ⚠ 괄호는 **문자클래스 `[(]`·`[)]` 로 쓴다** — 백슬래시 이스케이프는 EnvironmentFile 파싱에서 어떻게 살아남는지
  #    배포판마다 달라 위험하고, 문자클래스는 POSIX ERE 에서 같은 뜻이면서 백슬래시가 없다.
  #   ⚠ earlyoom 의 `-i`(oom_score_adj 무시)로 근본 해결하려 했으나 **v1.7 에서 제거됐다**("Option -i is ignored
  #    since earlyoom v1.7") — 그래서 정규식으로 막는 수밖에 없다. 박스별로 새 왜곡 프로세스가 있을 수 있으니,
  #    압박 대응의 1선은 어차피 게이트웨이 압박 회수(RSS 기준이라 이 왜곡이 없다)여야 한다.
  #  EARLYOOM_ARGS 만 우리 값으로(파일 내 다른 설정 보존).
  if ! command -v earlyoom >/dev/null 2>&1; then
    log "메모리: earlyoom 설치(apt)…"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y earlyoom >/dev/null 2>&1 \
      || warn "메모리: earlyoom 설치 실패(비치명 — swap 만으로도 완충). 수동: sudo apt-get install earlyoom"
  fi
  if command -v earlyoom >/dev/null 2>&1; then
    local eo="/etc/default/earlyoom"
    # ⚠ 정규식에 작은따옴표를 감싸지 않는다 — /etc/default/earlyoom 은 systemd EnvironmentFile 로 읽혀
    #  $EARLYOOM_ARGS 가 word-split 되는데, 작은따옴표는 벗겨지지 않고 리터럴로 earlyoom 에 전달돼 정규식이 깨진다.
    #  우리 패턴엔 공백이 없어 따옴표 없이 안전(공백 있는 패턴이면 이 방식 불가).
    local args="-m 6 -s 100,100 -r 3600 --avoid (^|/)(sshd|systemd|systemd-.*|[(]sd-pam[)]|dbus.*|tmux.*|dockerd|containerd|node)$"
    sudo touch "$eo" 2>/dev/null || true
    if sudo grep -qE '^EARLYOOM_ARGS=' "$eo" 2>/dev/null; then
      sudo sed -i "s#^EARLYOOM_ARGS=.*#EARLYOOM_ARGS=\"$args\"#" "$eo"
    else
      echo "EARLYOOM_ARGS=\"$args\"" | sudo tee -a "$eo" >/dev/null
    fi
    sudo systemctl enable --now earlyoom >/dev/null 2>&1 || true
    sudo systemctl try-restart earlyoom >/dev/null 2>&1 || true
    ok "메모리: earlyoom 활성(생명줄 보호 · 크기순 kill · swap 조건 무시)"
  fi
}

# ── 게이트웨이가 earlyoom 로그를 **읽을 수 있게**(#1240) ─────────────────────────────────────
#  왜: earlyoom 의 SIGTERM 은 `exec claude` 구조상 세션까지 없애는데 게이트웨이는 그 사실을 전혀 몰랐다.
#   그래서 "세션이 주기적으로 회수된다"는 신고(2026-07-28)에 **운영자 journalctl 로그를 받아서야** 범인을 짚었다.
#  ⚠ 실측(pilot-box): 이 그룹이 없으면 서비스 유저는 `No journal files were opened due to insufficient
#   permissions` 로 아무것도 못 본다. 넣으면 즉시 읽힌다. **읽기 전용**이다(저널 쓰기·삭제 권한이 아니다).
#
#  ⚠⚠ **호출 위치가 이 함수의 정확성 그 자체다** — `render_service_unit` 안에서만 부른다. 이유 둘:
#   ① **서비스 유저가 그때 확정된다.** `SERVICE_USER` 는 `os_install_service`(→ provision.sh) 안에서 비로소
#     할당되므로, 그 **앞**에서 부르면(예: install.sh 의 ensure_host_memory_safety 자리) 신규 설치 때
#     그 값이 비어 있다 — 기본 경로는 대상 유저가 아직 없고, opt-in 경로도 유저 생성 전이라 **양쪽 다 조용히
#     no-op** 이 된다. 첫 update 전까지 기능이 안 켜지는데 경고조차 안 뜬다(2026-07-29 리뷰에서 잡힌 실제 버그).
#   ② **exec 시점에 굳는다.** supplementary 그룹은 이미 떠 있는 프로세스에 소급되지 않는다. render_service_unit 은
#     '파일 렌더만' 하고 enable/start·restart 는 호출자가 하므로, 여기서 넣으면 **뒤이은 (재)기동이 곧 적용**이다.
#  없어도 비치명 — 관측만 조용히 꺼진다(src/ops/earlyoom-log.ts 가 readable:false 로 정직하게 보고한다).
ensure_journal_read_access() {
  local svc_user="${1:?ensure_journal_read_access: 서비스 유저 인자 필요}"
  [ "$(detect_os)" = linux ] || return 0
  getent group systemd-journal >/dev/null 2>&1 || return 0
  id "$svc_user" >/dev/null 2>&1 || { warn "저널 읽기 권한: 유저 없음($svc_user) — 건너뜀"; return 0; }
  if id -nG "$svc_user" 2>/dev/null | tr ' ' '\n' | grep -qx systemd-journal; then
    log "저널 읽기: $svc_user 는 이미 systemd-journal 그룹 — 존중(비파괴)"
  elif sudo usermod -aG systemd-journal "$svc_user" 2>/dev/null; then
    ok "저널 읽기: $svc_user → systemd-journal 그룹(earlyoom kill 관측, 읽기 전용)"
  else
    warn "저널 읽기: systemd-journal 그룹 추가 실패(비치명 — earlyoom kill 이 관리탭·경보에 안 보일 뿐)"
  fi
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "필요한 명령 없음: $1"; }

# 시크릿 생성(hex — URL/compose/.env 어디서도 이스케이프 불필요).
gen_hex() { openssl rand -hex "${1:-32}"; }

# docker 래퍼 — 소켓 접근 권한 없으면 sudo 로(리눅스 fresh: usermod 반영 전 현재 셸). 볼륨은 데몬(root) 소유라 무해.
dc() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

# ── .env 생성 (비파괴: 이미 있으면 보존) ──
#  caller 가 export 로 넘길 수 있는 값: PUBLIC_URL, TMUX_BIN, TERMINAL_ROOT_SHARED, TERMINAL_ROOT_PERSONAL,
#    ORG_DOMAIN(에이전트 토큰 이메일 도메인), PORT, ITEMS_DB_PORT, WITH_EMBEDDINGS
ensure_env() {
  local envf="$APP_DIR/.env"
  if [ -f "$envf" ]; then
    ok ".env 이미 존재 — 보존(비파괴). 시크릿 재생성 안 함."
    return 0
  fi
  local pgpw token webhook conn_key
  pgpw="$(gen_hex 16)"; token="$(gen_hex 32)"; webhook="$(gen_hex 32)"; conn_key="$(gen_hex 32)"
  local port="${PORT:-8080}" idbport="${ITEMS_DB_PORT:-5432}"
  local domain="${LIVELY_DOMAIN:-}"
  # LIVELY_DOMAIN 설정 시 front door = Caddy TLS → PUBLIC_URL 기본을 https://도메인 으로(쿠키 Secure 판정 근거).
  local pub="${PUBLIC_URL:-$([ -n "$domain" ] && echo "https://$domain" || echo "http://localhost:$port")}"
  local tmux_bin="${TMUX_BIN:-$(command -v tmux || echo /usr/bin/tmux)}"
  local rshared="${TERMINAL_ROOT_SHARED:-$HOME/workspace}"
  local rpersonal="${TERMINAL_ROOT_PERSONAL:-$HOME/box}"
  local orgdom="${ORG_DOMAIN:-example.com}"
  mkdir -p "$rshared" "$rpersonal" 2>/dev/null || true   # 중앙박스 세션 루트(없으면 세션 생성 실패)
  # 임베딩(#172) — WITH_EMBEDDINGS=1(또는 EMBEDDINGS_PROVIDER=http)면 provider 를 켜서 기록(사이드카는 store_up 이 기동,
  #  기존 지식 백필은 install.sh 말미). 아니면 off(grep 폴백). base_url/model/dim/auth 는 caller env 로 오버라이드 가능.
  local emb_provider="off"
  if [ "${WITH_EMBEDDINGS:-0}" = "1" ] || [ "${EMBEDDINGS_PROVIDER:-}" = "http" ]; then emb_provider="http"; fi
  local emb_base="${EMBEDDINGS_BASE_URL:-http://localhost:11434}"
  local emb_model="${EMBEDDINGS_MODEL:-bge-m3}"
  local emb_dim="${EMBEDDINGS_DIMENSIONS:-1024}"
  local emb_auth_line="# EMBEDDINGS_AUTH_ENV=OPENAI_API_KEY   # 외부 API 인증 시: 키를 담은 환경변수 '이름'(값 아님)"
  [ -n "${EMBEDDINGS_AUTH_ENV:-}" ] && emb_auth_line="EMBEDDINGS_AUTH_ENV=${EMBEDDINGS_AUTH_ENV}"

  umask 077   # .env 600
  cat > "$envf" <<EOF
# Lively — 배포 .env (deploy/install.sh 자동 생성). 시크릿 포함 → 절대 커밋 금지(.gitignore 등재).
PORT=$port
LOG_LEVEL=info
PUBLIC_URL=$pub

# ── TLS 프론트도어(Caddy, profile=proxy) — LIVELY_DOMAIN 설정 시 자동 HTTPS(Let's Encrypt). ──
#  비우면 프록시 없음(8080 직접/SSH 터널). 설정 시 A레코드가 이 호스트를 향해야 인증서 발급됨.
#  값 바꾼 뒤 재적용: deploy/update.sh (proxy_up 재기동). PUBLIC_URL=https://도메인 이라야 쿠키 Secure.
LIVELY_DOMAIN=$domain
LIVELY_UPSTREAM=localhost:$port

# ── store(pgvector, docker compose) ──
PGUSER=lively
PGPASSWORD=$pgpw
PGDATABASE=items
ITEMS_DB_PORT=$idbport
ITEMS_DATABASE_URL=postgres://lively:$pgpw@localhost:$idbport/items
DOMAINMAP_DATABASE_URL=postgres://lively:$pgpw@localhost:$idbport/domainmap
# db_query 용 고객 제품 DB 는 웹UI(org_db_source)로 등록(읽기전용 리플리카). DATABASE_URL env 자동등록은 폐기됨.

# ── 에이전트/MCP bearer 토큰(정적) ──
#  scope=context/items/db/memory — admin/runtime 은 DANGEROUS_SCOPES 라 거부(kill-switch). 사람관리=세션 로그인.
#  memory 는 knowledge_* 게이트(#248) — 없으면 호스트 세션의 지식 조회·저장이 전부 Forbidden(조용히 실패).
#  운영 시 회수가능 DB 토큰(lvk_)으로 발급 권장.
AUTH_TOKENS_JSON='{"$token":{"userId":"agent","email":"agent@$orgdom","scopes":["context","items","db","memory"],"projects":["*"]}}'
WEBHOOK_SECRET=$webhook

# ── at-rest 암호화 키 — git 자격(#540)·커넥터 토큰(#541)을 DB에 봉투 암호화(secret-box)하는 공용 마스터키. ──
#  자동 생성(사람 개입 불요). ⚠ 바꾸면 기존 암호문(git 자격·커넥터 토큰) 복호 불가 → update 는 보존한다.
CONNECTOR_SECRET_KEY=$conn_key

# ── 로케일(불변식: tmux 세션 파싱) ──
LANG=C.UTF-8
LC_ALL=C.UTF-8
LC_CTYPE=C.UTF-8

# ── 중앙박스(웹터미널) ──
TMUX_BIN=$tmux_bin
TERMINAL_ROOT_SHARED=$rshared
TERMINAL_ROOT_PERSONAL=$rpersonal

# ── 임베딩 / 벡터검색(#172) — off=knowledge_search grep 폴백. http=OpenAI-compatible /v1/embeddings. ──
#  뒤늦게 켜기: deploy/enable-embeddings.sh (사이드카→provider=http→재시작→기존 지식 백필). 또는 관리탭 '임베딩(벡터검색)'.
#  4GB 박스는 로컬 사이드카(bge-m3) 비권장(t4g.large+) — 외부 엔드포인트로 base_url 지정 가능.
EMBEDDINGS_PROVIDER=$emb_provider
EMBEDDINGS_BASE_URL=$emb_base
EMBEDDINGS_MODEL=$emb_model
EMBEDDINGS_DIMENSIONS=$emb_dim
$emb_auth_line

# ── db_query 안전장치 ──
DB_STATEMENT_TIMEOUT_MS=5000
DB_MAX_ROWS=1000
EOF
  umask 022
  chmod 600 "$envf"
  ok ".env 생성(시크릿 자동) → $envf"
  AGENT_TOKEN="$token"   # summary 출력용
  export AGENT_TOKEN
}

# 기존 .env 에 필수 시크릿이 없으면 자동 생성해 추가(멱등·비파괴 — 비어있지 않은 값은 보존).
#  신규 도입 변수를 기존 박스에 백필하는 용도(예: CONNECTOR_SECRET_KEY — ensure_env 로 새로 깐 박스는 이미 있고,
#  그 전에 설치된 박스는 update.sh 가 이걸로 채워 넣는다).
#  ⚠ .env 의 owner:group:mode 를 절대 안 바꾼다 — 불변식 '.env = 운영자:lively 640'(게이트웨이 lively 가 group-read).
#   sed -i 는 새 inode 로 rename 하며 **group 을 실행유저 기본그룹으로 리셋** → lively 가 .env 못 읽어 SASL 다운
#   (2026-07-03 고객사 A 실박스 실장애). 그래서 append(>>) + 빈 라인 제거는 inode-보존 되쓰기(>)만 쓴다(둘 다 perms 무변).
ensure_env_secret() {
  local name="$1" bytes="${2:-32}" envf="$APP_DIR/.env"
  [ -f "$envf" ] || return 0
  if grep -qE "^${name}=.+" "$envf"; then return 0; fi        # 비어있지 않은 값 존재 → 보존
  if grep -qE "^${name}=" "$envf"; then                       # 빈 "${name}=" 라인만 제거(inode 보존 → group 유지)
    local tmp="$envf.tmp.$$"
    grep -vE "^${name}=" "$envf" > "$tmp" && cat "$tmp" > "$envf"   # > 되쓰기 = 같은 inode(owner/group/mode 무변)
    rm -f "$tmp"
  fi
  printf '\n# %s — deploy 자동생성(#540 git 자격·#541 커넥터 토큰 at-rest 암호화). 분실 시 복호 불가 → 재등록.\n%s=%s\n' \
    "$name" "$name" "$(gen_hex "$bytes")" >> "$envf"          # append = owner/group/mode 무변
  ok ".env 에 $name 자동 생성(백필·소유/모드 보존)"
}

# store(pgvector) 기동 + healthy 대기.
store_up() {
  cd "$APP_DIR"
  dc compose up -d --wait items-db || die "items-db 기동 실패 (docker compose 로그 확인)"
  ok "store(pgvector) healthy"
  if [ "${WITH_EMBEDDINGS:-0}" = "1" ]; then
    dc compose --profile embeddings up -d && ok "임베딩 사이드카 기동(모델 pull 백그라운드)"
  fi
}

# 게이트웨이 /healthz 200 대기.
wait_healthz() {
  local port="${PORT:-8080}" url
  url="http://localhost:${port}/healthz"
  log "헬스체크: $url"
  if curl -fsS --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused -o /dev/null "$url"; then
    ok "게이트웨이 응답 OK ($url)"
  else
    die "게이트웨이가 $url 에 응답 없음 — 로그: $APP_DIR/logs/gateway.log"
  fi
}

# TLS 리버스 프록시(Caddy) 기동 — .env 의 LIVELY_DOMAIN 이 있을 때만(자동 HTTPS). 멱등.
#  판정은 .env 기준(caller env 아님) — install/update 어느 경로로도 일관. 도메인 없으면 no-op.
proxy_up() {
  cd "$APP_DIR"
  local domain
  domain="$(grep -E '^LIVELY_DOMAIN=' .env 2>/dev/null | head -n1 | cut -d= -f2-)"
  if [ -z "$domain" ]; then
    log "LIVELY_DOMAIN 미설정 — TLS 프록시 건너뜀(8080 직접/SSH 터널). 활성화: .env 에 LIVELY_DOMAIN=도메인 후 update.sh"
    return 0
  fi
  log "Caddy 리버스 프록시 기동(자동 HTTPS: $domain)"
  dc compose --profile proxy up -d caddy || die "Caddy 기동 실패 (docker compose 로그: dc compose logs caddy)"
  ok "Caddy 프록시 up — https://$domain (Let's Encrypt 자동 발급·갱신, 최초 발급 수십초)"
}

# 게이트웨이 재시작 — .env 변경(예: EMBEDDINGS_*) 반영. 유닛은 --env-file-if-exists=.env 라 재시작만으로 픽업.
#  KillMode=process(systemd)라 중앙박스 tmux 세션은 생존(재부착). mac 은 plist 변경까지 반영하려 bootout+bootstrap.
#  update.sh 는 유저 마이그레이션까지 하지만, 여기선 '단순 재시작'만 필요(유닛/유저 불변).
restart_gateway() {
  case "$(detect_os)" in
    linux) sudo systemctl restart lively-gateway ;;
    mac)
      launchctl bootout "gui/$(id -u)/io.lvly.lively" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.lvly.lively.plist" ;;
  esac
}
