# ─────────────────────────────────────────────────────────────────────────────
# 세션 env 계약 — **정본 한 벌** (#2258 이동 2)
#
#  이 파일은 실행되지 않는다. `source` 해서 `lvly_session_env` 를 부른다.
#
# ── 왜 생겼나 ────────────────────────────────────────────────────────────────
# 실행 표면이 넷인데(매니지드 세션 · 셀프호스트 중앙박스 · 멤버 로컬 · 위탁 워커) **같은 env 계약이
#  세 언어로 세 번** 적혀 있었다(exec-env-asis-tobe-2258). 그 대가가 실측으로 드러났다 —
#  2026-09-01 에 셋을 나란히 놓으니 이미 갈려 있었다:
#
#      항목                     매니지드   셀프호스트   로컬·워커
#      PATH 멤버bin 우선          ✔        ✔         ✖
#      PATH 상속(${PATH:+…})      ✖        ✔         ✖
#      TERM=xterm-256color       ✔        ✔         ✖
#      TZ 통과                    ✔        ✔         ✖
#      LIVELY_TOKEN 파일읽기       ✖        ✔         ✖
#
#  갈린 자리마다 «그 표면에서만 나는 버그» 가 하나씩 붙는다. 그래서 계약을 여기 한 벌로 두고
#  표면들이 **소비**한다(설계가 말한 «통일할 것은 격리가 아니라 계약»).
#
# ── 표면별로 **정당하게 다른 것**은 인자로 받는다 ───────────────────────────
#  · PATH 상속 — 컨테이너는 상속할 PATH 가 없다(도커가 준 최소값). 박스는 게이트웨이 유닛 PATH 를
#    이어받아야 한다. 그래서 `--inherit-path` 로 표면이 고른다. 「다르다」가 아니라 「고른다」로 만든다.
#  · 토큰 파일 읽기 — 박스는 멤버 홈의 `~/.lively/token` 을 읽지만, 매니지드 세션은 브로커가 env 로
#    실어 준다. `--read-token-file` 로 고른다.
#
# ⚠ 이 파일을 고치면 **세 표면이 함께 바뀐다.** 그게 목적이다. 대신 한쪽만 필요한 변경이면
#  인자로 갈라라 — 여기서 분기를 늘리면 계약이 다시 셋이 된다.
# ⚠ 값은 절대 echo/로그하지 않는다(토큰이 지난다).
# ─────────────────────────────────────────────────────────────────────────────

#  세션 프로세스가 받아야 할 env 를 **현재 셸에 export** 한다.
#   사용: lvly_session_env <osuser> <home> [--inherit-path] [--read-token-file]
lvly_session_env() {
  local _u="${1:?osuser 필요}" _home="${2:?home 필요}"
  shift 2
  local _inherit_path=0 _read_token=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --inherit-path)    _inherit_path=1 ;;
      --read-token-file) _read_token=1 ;;
      *) ;;   # 모르는 인자는 무시 — 호출자가 늘어나도 여기서 죽지 않는다
    esac
    shift
  done

  # ① 신원 — 세 표면 공통.
  export USER="$_u" LOGNAME="$_u" HOME="$_home"

  # ② PATH — **멤버 소유 bin 이 시스템보다 앞**(#1023). 이유: claude 가 root 전역으로 깔린 박스는
  #   비-root 멤버가 못 고쳐 자동 업뎃이 no_permissions 로 스테일된다. 멤버 홈의 self-update claude 를
  #   우선 해소하고, 없으면 파일이 없어 시스템 claude 로 자연 폴백(무회귀).
  if [ "$_inherit_path" = 1 ]; then
    export PATH="$_home/.local/bin:$_home/.npm-global/bin:${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  else
    export PATH="$_home/.local/bin:$_home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi

  # ③ 로케일 — 없으면 tmux 한글 렌더가 깨진다(게이트웨이 불변식과 동일).
  : "${LANG:=C.UTF-8}"; : "${LC_ALL:=C.UTF-8}"; : "${LC_CTYPE:=C.UTF-8}"
  export LANG LC_ALL LC_CTYPE

  # ④ TERM — 웹터미널은 tmux pane → control mode → **xterm.js(브라우저)** 로 렌더된다. 그래서
  #   xterm-256color 로 강제하는 게 렌더러와 일치하고 가장 견고하다: sudo 가 TERM 을 'unknown' 으로
  #   떨구거나, tmux 가 넘긴 'tmux-256color' terminfo 가 그 박스에 없으면(ncurses-term 미설치 흔함)
  #   claude/Codex 의 Ink TUI 가 REPL 진입에서 죽는다(#524). xterm-256color 는 terminfo 가 어디에나 있다.
  export TERM=xterm-256color

  # ⑤ 통과 항목 — **설정돼 있을 때만** 손댄다(미설정이면 종전 동작 = 무회귀).
  #   TZ(#778) 조직 시간대 · LIVELY_SESSION_ID(#852) 이 pane 이 어느 세션인지 ·
  #   CLAUDE_CODE_OAUTH_TOKEN(#1289) 자격 리스.
  #  ⚠ **이건 필터가 아니다.** sudo(env_keep)나 tmux(-e)가 넘겨준 값은 이미 환경변수라 여기 없어도 자식에게
  #   간다 — 아래 세 줄은 계약을 코드에 못박은 표식일 뿐, 통과 여부를 정하지 않는다. «어느 이름이 sudo
  #   경계를 넘는가» 의 단일 출처는 `src/terminal/session-env-contract.ts` 이고 sudoers 의 env_keep 은
  #   거기서 생성된다(#2599 T1). 새 변수를 세션에 흘리고 싶으면 여기 줄을 늘리지 말고 **그 계약**에 선언하라.
  #  ⚠ 형태 주의(실측으로 확인): `set -e` 는 함수 **중간의** 실패한 `&&` 리스트에는 안 걸린다.
  #   위험한 건 그런 줄이 함수의 **마지막 명령**이 될 때다 — 그 값이 곧 함수의 반환값이 되고,
  #   호출자(box-spawn = `set -euo pipefail`)가 거기서 죽는다. TZ 없는 세션이 대부분이라
  #   «어떤 박스에서는 세션이 아예 안 뜬다» 가 된다. 그래서 ⓐ `if … then … fi` 로 쓰고
  #   ⓑ 함수 끝에 `return 0` 을 둔다. 아래 시험이 그 반환값을 못박는다(session-env.test.mjs ③b).
  if [ -n "${TZ:-}" ]; then export TZ; fi
  if [ -n "${LIVELY_SESSION_ID:-}" ]; then export LIVELY_SESSION_ID; fi
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then export CLAUDE_CODE_OAUTH_TOKEN; fi

  # ⑦ node 도구 힙 상한 — **세션 대신 명령이 죽게 한다** (#3546)
  #   V8 은 자기 힙 천장을 «머신 메모리»에서 파생하는데, 컨테이너 안에서 그 값은 **세션 캡 전체**다
  #   (실측 2026-09-04, 캡 1536MB 매니지드 세션: node 기본 heap_size_limit = **792MB**). 그런데 그 캡
  #   안에는 claude 와 MCP 가 이미 ~1.0GB 상주한다 — 즉 V8 은 «792MB 까지 써도 된다» 고 믿고 GC 를
  #   미루는데 실제 여유는 그 절반이다. 그래서 `npx tsc --noEmit` 한 번이 cgroup OOM 을 불러
  #   **세션 컨테이너를 통째로** 데려갔다(실측: 그 호출 중간에서 트랜스크립트가 끊겼다).
  #   힙을 미리 묶으면 같은 상황이 «그 명령만 heap out of memory 로 실패» 로 끝난다 — 세션과 대화는 산다.
  #   같은 실측에서 힙을 520MB 로 묶은 `tsc` 는 peak RSS 584MB 로 **정상 완료**했다. 도구가 무거워서가
  #   아니라 **자기 여유를 잘못 알아서** 죽는 것이다.
  #  ⚠ claude 자신은 네이티브 ELF 라 이 값에 안 걸린다(src/sessions/session-memory-policy.ts 머리말).
  #   여기서 조이는 대상은 사람이 세션에서 돌리는 node 도구(tsc·번들러·린터)다.
  #  · 사람이 명시한 NODE_OPTIONS 는 건드리지 않는다(미설정일 때만 기본값을 준다).
  #  · 메모리가 넉넉한 표면(> 4GB)에는 안 건다 — 거긴 이 실패 모드가 없다(무회귀).
  #  · 35% 근거(2026-09-04 실측, 이 레포 콜드 `tsc --noEmit` = 증분 캐시 제거 후):
  #      힙 560MB → heap OOM(exit 134) · 힙 660MB → 통과. 즉 필요량은 560 < x ≤ 660.
  #      캡 1536 → 537MB : 여유(실측 835MB) 안에 안전하게 들어가지만 이 레포엔 **모자란다** —
  #        그때 죽는 것은 세션이 아니라 그 명령 하나이고, 메시지가 «캡을 올려라» 를 정확히 말한다.
  #      캡 2560 → 896MB : 660MB 를 넘어 **실제로 통과한다.**
  #      어느 쪽이든 힙 + 비힙(~150~200MB) < 그 캡의 실측 여유라 컨테이너는 안 죽는다.
  #  ⚠ 캡 1536 에서는 **어떤 힙 값을 골라도** 이 레포를 콜드 타입체크할 수 없다(세션이 이미 ~1.0GB
  #   상주). 힙 캡은 부족한 메모리를 만들어내지 못한다 — 안전판이지 해결책이 아니다.
  #  · 메모리 출처는 시험이 갈아낄 수 있다(LVLY_MEMINFO) — CI 머신 크기에 시험이 좌우되면 안 된다.
  #    같은 파일의 LVLY_SESSION_ENV_LIB 와 같은 성격의 seam 이다.
  _lvly_meminfo="${LVLY_MEMINFO:-/proc/meminfo}"
  if [ -z "${NODE_OPTIONS:-}" ] && [ -r "$_lvly_meminfo" ]; then
    _lvly_mem_mb="$(awk '/^MemTotal:/ { print int($2/1024) }' "$_lvly_meminfo" 2>/dev/null || echo 0)"
    if [ "${_lvly_mem_mb:-0}" -gt 0 ] && [ "${_lvly_mem_mb}" -le 4096 ]; then
      _lvly_heap_mb=$(( _lvly_mem_mb * 35 / 100 ))
      if [ "$_lvly_heap_mb" -lt 256 ]; then _lvly_heap_mb=256; fi
      export NODE_OPTIONS="--max-old-space-size=${_lvly_heap_mb}"
    fi
    unset _lvly_mem_mb _lvly_heap_mb 2>/dev/null || true
  fi
  unset _lvly_meminfo 2>/dev/null || true

  # ⑥ 멤버 토큰 — 표면이 고른다(위 머리말). 리터럴은 코드·로그에 없다 — 파일에서만 읽는다.
  if [ "$_read_token" = 1 ] && [ -z "${LIVELY_TOKEN:-}" ] && [ -r "$_home/.lively/token" ]; then
    LIVELY_TOKEN="$(cat "$_home/.lively/token")" || true
    export LIVELY_TOKEN
  fi

  return 0
}
