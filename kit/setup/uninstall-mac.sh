#!/usr/bin/env bash
set -euo pipefail
# lively 컨텍스트 **제거** — Mac (설치의 역연산). ⚠ 캐노니컬 제거기는 `lively uninstall`(user-uninstall.mjs) 이고
#   이건 번들에 동봉되는 UX 래퍼다 — CLI 가 없거나 깨졌을 때의 경로.
# ----------------------------------------------------------------
# uninstall = 머신에서 lively 셋업을 **영구 제거**(오프보딩/정리/하드리셋).
#   ≠ incognito(LIVELY_OFF=1): incognito 는 설치는 그대로, 훅만 일시 off. 언제든 복귀.
#   uninstall 은 ~/.claude·~/.codex·~/.zshrc 의 lively 영역 + ~/.lively 자산을 실제로 떼어낸다.
#
# 하는 일(전부 surgical · 백업 먼저 · idempotent):
#   [1] 설치된 하네스 자동 감지 → 어댑터 uninstall(claude: settings.json 훅 + `claude mcp remove lively`; codex: config.toml 블록)
#   [2] ~/.zshrc 의 LIVELY_TOKEN 센티넬 블록 제거
#   [3] ~/.lively 제거 — 기본 휴지통 이동(되돌릴 수 있음), --purge 면 하드 삭제
#
# ▶ 사용법:  bash setup/uninstall-mac.sh [--dry-run] [--purge] [--harness claude|codex|all]
#   --dry-run            무엇을 지울지 출력만(변경 없음)
#   --purge              ~/.lively 를 휴지통 이동 대신 하드 삭제(백업 포함 완전 제거)
#   --harness <h>        대상 하네스 한정(기본 all)
#   --yes                확인 프롬프트 생략(스크립트/CI)
# (설치 묶음 안에서 직접 실행한다.)

DRY=0; PURGE=0; YES=0; HARNESS="all"
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; PASS_ARGS+=("--dry-run"); shift ;;
    --purge)   PURGE=1; PASS_ARGS+=("--purge"); shift ;;
    --yes|-y)  YES=1; shift ;;
    --harness) HARNESS="${2:-all}"; PASS_ARGS+=("--harness" "${2:-all}"); shift 2 ;;
    --uninstall) shift ;;  # 옛 설치기 경유 호출에서 흘러들어와도 무시(하위호환)
    -h|--help)
      echo "사용법: bash setup/uninstall-mac.sh [--dry-run] [--purge] [--harness claude|codex|all] [--yes]"
      exit 0 ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

echo
echo "=== Lively 컨텍스트 제거 (Mac) ==="
echo "  (영구 제거입니다. 일시 off 만 원하면 환경변수 LIVELY_OFF=1 — 이건 incognito 라 설치는 유지됩니다.)"
echo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 제거기 선택: kit 안이면 setup/uninstall.mjs(어댑터 import), 발행물(번들)이면 setup/user-uninstall.mjs(self-contained).
if [ -f "$SCRIPT_DIR/uninstall.mjs" ]; then
  ORCH="$SCRIPT_DIR/uninstall.mjs"
elif [ -f "$SCRIPT_DIR/user-uninstall.mjs" ]; then
  ORCH="$SCRIPT_DIR/user-uninstall.mjs"
else
  ORCH=""
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ node 가 필요합니다(제거기는 node 로 동작). Node.js 설치 후 다시 실행하세요."
  exit 1
fi
if [ -z "$ORCH" ]; then
  echo "✗ 제거기를 찾지 못함(setup/uninstall.mjs 또는 setup/user-uninstall.mjs)."
  exit 1
fi

# 무엇을 지울지 먼저 보여준다(항상 dry-run 으로 미리보기) — 실 변경 전 확인.
if [ "$DRY" = "0" ] && [ "$YES" = "0" ]; then
  echo "── 제거 미리보기(dry-run) ──"
  node "$ORCH" --dry-run $([ "$PURGE" = 1 ] && echo --purge) $([ "$HARNESS" != "all" ] && echo --harness "$HARNESS") || true
  echo
  if [ ! -t 0 ]; then
    echo "비대화형 셸 — 확인 프롬프트를 띄울 수 없습니다. 실제 제거하려면 --yes 를, 미리보기만 원하면 --dry-run 을 주세요."
    exit 1
  fi
  read -rp "위 항목을 실제로 제거할까요? [y/N] " yn
  if [[ ! "${yn:-n}" =~ ^[Yy]$ ]]; then
    echo "취소했습니다(아무것도 변경하지 않음)."
    exit 0
  fi
  echo
fi

# 실제 실행(또는 --dry-run 명시 시 미리보기만).
# bash 3.2(macOS 기본) + set -u 에서 빈 배열 확장이 "unbound variable" 이 되는 것을 회피.
node "$ORCH" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}

echo
if [ "$DRY" = "1" ]; then
  echo "=== dry-run 끝 — 아무것도 변경하지 않았습니다. 실제 제거는 --dry-run 빼고 다시 실행하세요. ==="
else
  echo "=== 제거 끝 ==="
  echo "  · 새 터미널을 열거나 \`unset LIVELY_TOKEN\` 으로 현재 셸의 잔여 토큰 env 를 정리하세요."
  echo "  · 확인:  claude mcp list  (lively 가 더 이상 안 보여야 함)"
  if [ "$PURGE" = "0" ]; then
    echo "  · 되돌리려면 ~/.lively.removed-* 를 ~/.lively 로 옮기고 setup 을 재실행하세요."
  fi
fi
