// lib/proj-none.ts — 프로젝트에 안 붙은 세션 묶음의 이름과, 그 묶음에 서면 안 되는 것의 잣대 한 자리 (#4551, 원준 2026-10-05).
//
//  신고: "<프로젝트 없음> 이라는 게 직관적으로 어떤 폴더인지 감이 안 와. 사용자는 어떤 세션을 열든 자연스럽게 프로젝트가
//   만들어져 매치되는데, 프로젝트에 매치 안 된 세션이 있다는 게 이해가 안 갈 것 같음."
//
//  ★ 실측(원준 계정, 2026-10-05) — 그 묶음 76개 중 사람이 연 작업 세션은 13개뿐이었다. 위탁 워커 54 · 로그인 셸 9 ·
//   자동 프로젝트 생성(8/25) 이전의 옛 세션 11 · 소속 기록이 없는 것 2. 이름이 «프로젝트 없음» 이라 «내 세션이 왜
//   프로젝트가 없지» 로 읽혔다 — 실제로는 대부분 사람이 연 세션이 아니었다.
//  ⇒ ① 이름을 [프로젝트] 사이드바가 이미 쓰는 「기타 (미분류)」로 맞춘다(두 곳이 같은 말을 한다).
//    ② 끝난 로그인 세션은 목록에 세우지 않는다 — 로그인 절차용 셸이라 다시 열 일이 없다.
//  잎 모듈인 이유는 home-pins · sess-fold 와 같다 — 이 잣대가 화면 코드 안에 있으면 시험할 데가 없다(scripts/proj-none.test.mjs).

/** 프로젝트에 안 붙은 세션 묶음의 이름. [프로젝트] 사이드바의 리스트 없는 프로젝트 묶음과 같은 말이다. */
export const NO_PROJECT_NAME = '기타 (미분류)';

/** 이 판정이 세션 목록의 한 행(서버 응답 그대로)에게 묻는 것. */
export interface LoginRowLike {
  /** 서버가 실어 주면 그 값이 정본이다(human · task · managed · app · login). 옛 서버 · 옛 노드는 안 싣는다. */
  kind?: string | null;
  label?: string | null;
  title?: string | null;
}

//  로그인 세션을 여는 자리 둘이 붙이는 이름 — 서버 자리(src/terminal/ai-login-run.ts «AI 로그인 (codex)»)와
//   화면 자리(web/lib/ai-login-inline.ts 등 «내 계정 로그인 (Claude Code)»). 괄호가 없는 꼴(session-form)도 받는다.
const LOGIN_LABEL_RE = /^(AI 로그인|내 계정 로그인)(\s*\(.*\))?$/;

/**
 * 로그인 절차용 세션인가.
 *  ⚠ 종류(kind)만 믿지 않는다 — 화면에서 연 Claude 로그인 창은 종류가 human 으로 적힌다(로그인 대상(loginFor)이 codex ·
 *   grok 일 때만 login 이 된다, src/sessions/session-kind.ts). 그래서 이름도 함께 본다.
 */
export function isLoginSessRow(r: LoginRowLike | null | undefined): boolean {
  if (!r) return false;
  if (String(r.kind || '').toLowerCase() === 'login') return true;
  return LOGIN_LABEL_RE.test(String(r.label || r.title || '').trim());
}

/**
 * 목록에 세우지 않을 로그인 세션 — **끝난 것만**.
 *  ⚠ 도는 로그인 세션은 그대로 둔다 — 지금 로그인하고 있는 창이 그 세션이라, 목록에서 지우면 그 창이 가리킬 세션이 없어진다.
 */
export function isSpentLoginSess(r: LoginRowLike | null | undefined, alive: boolean): boolean {
  return !alive && isLoginSessRow(r);
}
