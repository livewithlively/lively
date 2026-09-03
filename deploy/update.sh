#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 업데이트 — 기존 호스트에 '새 코드'를 반영(빌드 + 재시작). 최초 설치는 install.sh.
#
#   전제: 새 코드가 이미 이 호스트에 와 있다(operator 가 rsync 또는 git pull 로 가져옴).
#   보존: .env · 데이터(items-db 볼륨) · 서비스 유닛 · claude 인증 · 부트스트랩(멱등) — 안 건드린다.
#   스키마: 게이트웨이 부팅(재시작) 시 자가 마이그레이션 — 별도 명령 없음.
#   빌드 실패 시: 재시작 전에 중단 → 기존 게이트웨이 계속 가동(다운 없음).
#
# 사용:  bash deploy/update.sh [--kit]
#   --kit : kit/ 가 바뀌었으면 중앙박스 키트(호스트 claude 훅/MCP/컨텍스트)도 갱신.
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"
OS="$(detect_os)"
cd "$APP_DIR"

[ -f "$APP_DIR/.env" ] || die ".env 없음 — 최초 설치가 안 된 호스트입니다. install.sh 를 쓰세요."

# ── blue-green 박스에서의 오용 차단 ────────────────────────────────────────────
#  update.sh 는 **단일 유닛(lively-gateway) 모델** 전용이다 — APP_DIR 을 제자리에서 빌드하고 그 유닛을 재시작한다.
#  blue-green 레이아웃(deploy/migrate-to-bluegreen.sh 로 흡수한 박스)에서 이걸 돌리면 두 모델이 충돌한다:
#   ① render_service_unit 이 lively-gateway.service 를 되살려 .env 의 PORT(기본 8080)에 bind 를 시도 → 그 포트는
#      loopback forwarder(lively-loopback.socket) 가 쥐고 있어 EADDRINUSE 크래시루프(Restart=always).
#   ② 정작 트래픽을 받는 건 active color 인스턴스(lively-gateway@blue|green)라 **코드가 안 바뀐다** —
#      운영자는 "업데이트했다"고 믿는데 서빙되는 건 구 릴리스인 silent no-op 가 가장 위험한 결과다.
#  그래서 레이아웃이 보이면 여기서 멈추고 올바른 경로(deploy-release.sh)를 알린다. 판정은 두 신호의 OR —
#  active-color(레이아웃 상태파일)와 템플릿 유닛 파일(LIVELY_ROOT 를 모르는 채 흡수된 박스도 잡힌다).
BG_ROOT="${LIVELY_ROOT:-/opt/lively}"
if [ "${LIVELY_ALLOW_SINGLE_UPDATE:-0}" != "1" ] \
   && { [ -e "$BG_ROOT/active-color" ] || [ -f "/etc/systemd/system/lively-gateway@.service" ]; }; then
  die "blue-green 레이아웃이 감지됐습니다($BG_ROOT/active-color 또는 lively-gateway@.service) — update.sh 는 단일 유닛 전용입니다.
  이 박스는 'bash deploy/deploy-release.sh --release <준비된 릴리스 dir> --tg-arn <ALB 타깃그룹 ARN>' 로 배포하세요(deploy/README.md 의 blue-green 절 참조).
  그대로 강행하면 lively-gateway.service 가 포트를 두고 forwarder 와 충돌하고, 정작 서빙 중인 active color 는 구 릴리스로 남습니다.
  단일 유닛으로 되돌린 박스라 확신하면 LIVELY_ALLOW_SINGLE_UPDATE=1 로 강행할 수 있습니다."
fi

ensure_env_secret CONNECTOR_SECRET_KEY    # secret-box 마스터키 백필(#540 git 자격·#541 커넥터 토큰) — 기존값 보존, 재시작이 반영

phase "1/3 의존성 + 빌드"
if [ -d dist ] && [ ! -d src ]; then
  # prebuilt 릴리스 번들(dist 동봉·소스 없음) → tsc 불요. 새 번들이 이미 dist 를 담아 옴. 런타임 deps 만 멱등 반영.
  ok "prebuilt 릴리스 번들 — 빌드 생략, npm ci --omit=dev"
  npm ci --omit=dev
else
  npm ci
  npm run build   # 실패하면 set -e 로 여기서 중단 → 기존 게이트웨이 그대로 가동(다운 없음)
fi

phase "2/3 store 반영(멱등) + 유닛 갱신 + 게이트웨이 재시작"
dc compose up -d --wait items-db    # compose/이미지 변경 멱등 반영(없으면 no-op)
# 게이트웨이 유저 보존(#524 P4): update 는 기존 유저를 **안 바꾼다**(비격리 박스 강제 마이그레이션 방지). 현재 유닛의
#  User 를 읽어 유지. LIVELY_SERVICE_USER 로 명시했을 때만 그 유저(예: lively)로 마이그레이션(생성·chown·재소유).
if [ "$OS" = linux ]; then
  # 레거시 유닛 승계(레포명 context-ontology → lively) — 전환 전에 설치된 박스는 구 이름으로 돌고 있다.
  #  구 유닛에서 **서비스 유저를 승계**한 뒤 구 유닛을 정리하고, 아래 render_service_unit 이 새 이름으로 다시 쓴다.
  #  ⚠ APP_DIR(설치 디렉터리)은 건드리지 않는다 — 이동은 진행 중 세션·로그·DB 볼륨을 흔든다. 유닛 이름만 바꾼다.
  #  ⚠ docker compose 프로젝트명도 그대로다(docker-compose.yml 주석 참조 — 바꾸면 items-db 볼륨이 새로 생긴다).
  LEGACY_UNIT="context-ontology-gateway"
  if [ -f "/etc/systemd/system/${LEGACY_UNIT}.service" ]; then
    CUR_USER="$(systemctl show -p User --value "$LEGACY_UNIT" 2>/dev/null || echo "$(id -un)")"
    log "레거시 유닛(${LEGACY_UNIT}) → lively-gateway 전환 (User=$CUR_USER 승계)"
    sudo systemctl disable --now "$LEGACY_UNIT" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${LEGACY_UNIT}.service"
    sudo systemctl daemon-reload
  else
    CUR_USER="$(systemctl show -p User --value lively-gateway 2>/dev/null || echo "$(id -un)")"
  fi
  SERVICE_USER="${LIVELY_SERVICE_USER:-$CUR_USER}"
  if [ "$SERVICE_USER" != "$CUR_USER" ]; then
    log "게이트웨이 유저 마이그레이션: $CUR_USER → $SERVICE_USER (#524 P4)"
    sudo systemctl stop lively-gateway 2>/dev/null || true   # chown·유닛 교체 중 정지
  fi
  # 전용 서비스 유저(운영자와 다름 = lively 등)면 '이미 그 유저여도' 매 update 마다 불변식 멱등 재적용
  #  (셸=bash·그룹·.env 소유·세션 루트 repoint). 안 그러면 최초 마이그레이션(=유저 전환) 때만 적용돼, 그 뒤
  #  버전업으로 추가된 불변식(예: v0.1.21 셸·루트 픽스)이 이미-lively 박스엔 영영 안 붙는다. 비전용(=운영자)면 no-op.
  if [ "$SERVICE_USER" != "$(id -un)" ]; then
    SERVICE_USER="$(ensure_service_user "$SERVICE_USER")"
  fi
  export SERVICE_USER
fi
render_service_unit                 # 유닛 템플릿 변경(예: KillMode=process)을 이 박스에도 반영(단일 소스 — common.sh). 기존엔 코드만 갱신돼 유닛 픽스가 전파 안 되던 갭 해소.
ensure_host_memory_safety           # #1059 OOM 재발방지 — 기존 박스(고객사 A 등)도 update 로 swap·earlyoom 수령(멱등·비파괴). 비치명.
# 격리 인프라(#524) 리프레시 — 이 박스가 '격리 박스'면(box-spawn 존재) box-spawn/sudoers/provision-member 를
#  코드와 동기화(멱등). render_service_unit 과 같은 이유: 코드만 갱신되고 인프라(wrapper·sudoers)가 스테일해지는
#  갭 방지 → 격리 관련 버전업마다 install-isolation 을 손으로 다시 돌릴 필요 없음. 미설치 박스는 no-op(opt-in 유지).
if [ "$OS" = linux ] && [ -x /opt/lively/libexec/box-spawn ]; then
  log "격리 인프라 리프레시(install-isolation.sh — 멱등)"
  sudo bash "$DIR/linux/install-isolation.sh" || warn "격리 인프라 리프레시 경고 — 수동: sudo bash deploy/linux/install-isolation.sh"
  # 이미 프로비저닝된 격리 멤버의 훅 러너(run-custom 등)를 이 번들로 리프레시 — 멤버 kit 은 첫 세션에만
  #  설치돼(ensureMemberOsUser 빠른경로) 업뎃 후 stale → 러너 변경(예: #637 PostToolUse 전파)이 멤버에 안 가던
  #  갭 해소. 파일만·소유권유지·멱등·best-effort(토큰·세션·settings 무영향).
  log "격리 멤버 훅 러너 리프레시(refresh-member-kits.sh — 멱등)"
  sudo bash "$DIR/refresh-member-kits.sh" || warn "멤버 훅 러너 리프레시 경고 — 수동: sudo bash deploy/refresh-member-kits.sh"
fi
if [ "$OS" = linux ]; then
  sudo systemctl enable lively-gateway >/dev/null 2>&1 || true   # 레거시 전환 직후엔 아직 enable 이 안 돼 있다(멱등 — 재부팅 생존 보장)
  sudo systemctl restart lively-gateway
else
  # plist 변경 반영엔 재부트스트랩 필요(kickstart 는 로드된 정의만 재시작 → plist 변경 미반영).
  launchctl bootout "gui/$(id -u)/io.lvly.context-ontology" 2>/dev/null || true   # 레거시 label 정리(1회)
  rm -f "$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist"
  launchctl bootout "gui/$(id -u)/io.lvly.lively" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.lvly.lively.plist"
fi
wait_healthz
wait_ready   # #2578 — 스키마 마이그레이션·(단일→registry) 자가 재기동까지 끝난 뒤에야 시드·프록시로(healthz 는 listen 일 뿐)
# 기본 커넥터 카탈로그(#746) — DCR 지원 호스팅 OAuth MCP(Notion·Linear 등) '없으면 등록'(멱등, 기존 보존).
#  기존 박스도 업데이트 때 신규 기본 커넥터를 수령. 삭제로 영구 제외하려면 disable(존재하면 보존).
run_as_service node --env-file="$APP_DIR/.env" "$DIR/bootstrap-connectors.mjs" 2>&1 || warn "커넥터 시드 경고 — 수동: node --env-file=.env deploy/bootstrap-connectors.mjs"
proxy_up   # LIVELY_DOMAIN(.env) 설정 시 Caddy 재적용/기동(미설정 시 no-op) — 도메인 추가/변경도 여기서 반영

if [ "${1:-}" = "--kit" ]; then
  phase "3/3 중앙박스 키트 갱신(게이트웨이 유저 claude 훅/MCP/컨텍스트)"
  run_as_service bash "$DIR/install-kit.sh" || warn "키트 갱신 경고 — 나중에: bash deploy/install-kit.sh"
else
  log "3/3 키트 갱신 건너뜀 — kit/ 가 바뀌었으면 --kit 로 실행"
fi

ok "업데이트 완료 — ${PUBLIC_URL:-http://localhost:${PORT:-8080}}"
log "확인: /healthz · /readyz(schema=ready) · 웹UI /ui/ · 온보딩 /ui/#/onboarding"
