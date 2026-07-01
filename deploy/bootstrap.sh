#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# context-ontology 설치 부트스트랩 — "코드 없이 한 줄".
#
#   curl -fsSL <bootstrap-url> | PUBLIC_URL=… BOOTSTRAP_ADMIN_EMAIL=… sh
#   (또는 내려받아: PUBLIC_URL=… bash deploy/bootstrap.sh)
#
# 설계: '코드 획득'(이 스크립트, 교체 가능) 과 '설치'(deploy/install.sh, 전달 방식 무관) 를 분리한다.
#   → 온라인/오프라인 전환은 '코드 획득' 만 바꾸면 된다. install.sh 는 그대로.
#
# 코드 소스 (우선순위):
#   1) LIVELY_BUNDLE=<로컬 .tgz>  — 오프라인. 번들에 node_modules·dist 동봉 시 OFFLINE=1 과 함께(에어갭).
#   2) LIVELY_CODE_URL=<.tgz URL> — 온라인 다운로드. private 릴리스면 LIVELY_CODE_TOKEN(Bearer) 추가.
#   3) (기본) git clone        — 공개 레포(OSS). LIVELY_GIT_URL / LIVELY_GIT_REF 로 지정.
#
# 설치 옵션은 env 로 그대로 install.sh 에 전달:
#   PUBLIC_URL · BOOTSTRAP_ADMIN_EMAIL · BOOTSTRAP_ADMIN_PASSWORD · ORG_DOMAIN · WITH_EMBEDDINGS · OFFLINE · FORCE
# 디버그: LIVELY_FETCH_ONLY=1 → 코드만 받고 install.sh 실행 안 함(검증·CI용).
# ─────────────────────────────────────────────────────────────────────────────
APP_DIR="${LIVELY_APP_DIR:-$HOME/context-ontology}"
GIT_URL="${LIVELY_GIT_URL:-https://github.com/livewithlively/context-ontology.git}"
GIT_REF="${LIVELY_GIT_REF:-main}"

c() { printf '\033[%sm' "$1"; }
log() { printf '%s▸%s %s\n' "$(c '1;36')" "$(c 0)" "$*"; }
die() { printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl 필요"
command -v tar  >/dev/null 2>&1 || die "tar 필요"
mkdir -p "$APP_DIR"

# 릴리스 버전 편의 — LIVELY_VERSION(latest|vX.Y.Z)만 주면 GitHub 릴리스 에셋 URL 자동 구성(URL/번들 미지정 시).
REPO_SLUG="${LIVELY_REPO:-livewithlively/context-ontology}"
if [ -z "${LIVELY_CODE_URL:-}" ] && [ -z "${LIVELY_BUNDLE:-}" ] && [ -n "${LIVELY_VERSION:-}" ]; then
  if [ "$LIVELY_VERSION" = "latest" ]; then
    LIVELY_CODE_URL="https://github.com/${REPO_SLUG}/releases/latest/download/context-ontology.tgz"
  else
    LIVELY_CODE_URL="https://github.com/${REPO_SLUG}/releases/download/${LIVELY_VERSION}/context-ontology.tgz"
  fi
  log "LIVELY_VERSION=$LIVELY_VERSION → $LIVELY_CODE_URL"
fi

# ── 코드 획득 (교체 가능한 단계) ──
if [ -n "${LIVELY_BUNDLE:-}" ]; then
  log "코드 = 로컬 번들(오프라인): $LIVELY_BUNDLE"
  [ -f "$LIVELY_BUNDLE" ] || die "번들 파일 없음: $LIVELY_BUNDLE"
  tar -xzf "$LIVELY_BUNDLE" -C "$APP_DIR"
elif [ -n "${LIVELY_CODE_URL:-}" ]; then
  log "코드 = 다운로드: $LIVELY_CODE_URL"
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  if [ -n "${LIVELY_CODE_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer ${LIVELY_CODE_TOKEN}" "$LIVELY_CODE_URL" -o "$tmp" || die "다운로드 실패"
  else
    curl -fsSL "$LIVELY_CODE_URL" -o "$tmp" || die "다운로드 실패(private 면 LIVELY_CODE_TOKEN 필요)"
  fi
  tar -xzf "$tmp" -C "$APP_DIR"
else
  command -v git >/dev/null 2>&1 || die "git 없음 — LIVELY_CODE_URL 또는 LIVELY_BUNDLE 를 쓰세요(공개 레포면 git 설치)."
  log "코드 = git clone ${GIT_URL}@${GIT_REF}"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --depth=1 origin "$GIT_REF" || die "fetch 실패"
    git -C "$APP_DIR" reset --hard FETCH_HEAD
  else
    git clone --depth=1 --branch "$GIT_REF" "$GIT_URL" "$APP_DIR" || die "clone 실패"
  fi
fi

# ── 코드 루트 정규화 (tarball 이 <repo>-<ref>/ 한 겹 더 들어간 경우 등) ──
if [ ! -f "$APP_DIR/deploy/install.sh" ]; then
  inner="$(find "$APP_DIR" -maxdepth 3 -path '*/deploy/install.sh' 2>/dev/null | head -1)"
  [ -n "$inner" ] || die "deploy/install.sh 를 못 찾음 — 번들/아카이브 구조 확인."
  APP_DIR="$(cd "$(dirname "$inner")/.." && pwd)"
fi
log "코드 준비됨 → $APP_DIR"

if [ "${LIVELY_FETCH_ONLY:-0}" = "1" ]; then
  log "LIVELY_FETCH_ONLY=1 — install.sh 실행 생략."
  exit 0
fi

# ── 설치 위임 (전달 방식 무관) — env(PUBLIC_URL·OFFLINE·…) 그대로 상속 ──
log "설치 실행 → $APP_DIR/deploy/install.sh"
exec bash "$APP_DIR/deploy/install.sh"
