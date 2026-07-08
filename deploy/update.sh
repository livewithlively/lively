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
  CUR_USER="$(systemctl show -p User --value context-ontology-gateway 2>/dev/null || echo "$(id -un)")"
  SERVICE_USER="${LIVELY_SERVICE_USER:-$CUR_USER}"
  if [ "$SERVICE_USER" != "$CUR_USER" ]; then
    log "게이트웨이 유저 마이그레이션: $CUR_USER → $SERVICE_USER (#524 P4)"
    sudo systemctl stop context-ontology-gateway 2>/dev/null || true   # chown·유닛 교체 중 정지
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
  sudo systemctl restart context-ontology-gateway
else
  # plist 변경 반영엔 재부트스트랩 필요(kickstart 는 로드된 정의만 재시작 → plist 변경 미반영).
  launchctl bootout "gui/$(id -u)/io.lvly.context-ontology" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.lvly.context-ontology.plist"
fi
wait_healthz
proxy_up   # LIVELY_DOMAIN(.env) 설정 시 Caddy 재적용/기동(미설정 시 no-op) — 도메인 추가/변경도 여기서 반영

if [ "${1:-}" = "--kit" ]; then
  phase "3/3 중앙박스 키트 갱신(게이트웨이 유저 claude 훅/MCP/컨텍스트)"
  run_as_service bash "$DIR/install-kit.sh" || warn "키트 갱신 경고 — 나중에: bash deploy/install-kit.sh"
else
  log "3/3 키트 갱신 건너뜀 — kit/ 가 바뀌었으면 --kit 로 실행"
fi

ok "업데이트 완료 — ${PUBLIC_URL:-http://localhost:${PORT:-8080}}"
log "확인: /healthz · 웹UI /ui/ · 온보딩 /ui/#/onboarding"
