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
  #  ⚠ 형태 주의(실측으로 확인): `set -e` 는 함수 **중간의** 실패한 `&&` 리스트에는 안 걸린다.
  #   위험한 건 그런 줄이 함수의 **마지막 명령**이 될 때다 — 그 값이 곧 함수의 반환값이 되고,
  #   호출자(box-spawn = `set -euo pipefail`)가 거기서 죽는다. TZ 없는 세션이 대부분이라
  #   «어떤 박스에서는 세션이 아예 안 뜬다» 가 된다. 그래서 ⓐ `if … then … fi` 로 쓰고
  #   ⓑ 함수 끝에 `return 0` 을 둔다. 아래 시험이 그 반환값을 못박는다(session-env.test.mjs ③b).
  if [ -n "${TZ:-}" ]; then export TZ; fi
  if [ -n "${LIVELY_SESSION_ID:-}" ]; then export LIVELY_SESSION_ID; fi
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then export CLAUDE_CODE_OAUTH_TOKEN; fi

  # ⑥ 멤버 토큰 — 표면이 고른다(위 머리말). 리터럴은 코드·로그에 없다 — 파일에서만 읽는다.
  if [ "$_read_token" = 1 ] && [ -z "${LIVELY_TOKEN:-}" ] && [ -r "$_home/.lively/token" ]; then
    LIVELY_TOKEN="$(cat "$_home/.lively/token")" || true
    export LIVELY_TOKEN
  fi

  return 0
}
