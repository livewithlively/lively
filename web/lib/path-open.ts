// lib/path-open.ts — 터미널에서 누른 **파일 경로**를 곁칸 어디서 열지(#4562). 셸(v2/panes.ts)이 부른다.
//  경로를 글에서 찾고 «프로젝트 자료냐 세션 폴더냐» 를 가르는 것은 터미널(standalone/terminal.ts pathLinkTarget)이 하고,
//  여기는 **이 곁칸이 그걸 열 수 있나**만 정한다 — 그 곁칸이 어느 프로젝트의 것인지, 그 세션의 작업 폴더가 어디인지는 셸만 안다.
//  순수 함수라 DOM 없이 시험한다(scripts/terminal-path-link.test.mjs).

export type PathTarget = { kind: 'project'; id: number; rel: string } | { kind: 'session'; rel: string };
export type PathOpenPlan = { via: 'session'; sid: string; rel: string } | { via: 'project'; rel: string };

/** 뷰어로 들어가는 상대 경로인가 — 빈 마디·`.`·`..`·맨 앞 `/` 를 막는다. 터미널이 걸렀어도 문은 이쪽이라 다시 거른다. */
export function safeRel(r: unknown): r is string {
  return typeof r === 'string' && !!r && !r.startsWith('/') && !r.split('/').some((x) => x === '' || x === '.' || x === '..');
}

/** 경로 구분자 무관 정규화 — 노드가 윈도우면 `C:\\Users\\…\\project\\3966` 처럼 온다. 셸(v2/panes.ts)의 산출물 열기도 이걸 쓴다(한 벌). */
export const slash = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
export const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/**
 * 터미널이 보낸 알림 → 여는 길. 못 열면 null(터미널이 공유 폴더 뷰어로 떨어진다).
 *  · 그 세션의 작업 폴더 안(상대 경로 · 작업 폴더 밑의 절대 경로)이면 'session' — 셸이 산출물과 같은 길(openOut)로 연다:
 *    노드 세션은 노드의 파일을 직접, 프로젝트 세션은 프로젝트 자료로(그 판정은 openOut 의 것).
 *  · 그 밖의 `project/<번호>/` 경로는 **이 곁칸의 프로젝트**일 때만 'project'. 남의 프로젝트 번호면 이 뷰어는 못 읽는다.
 *  here.sessDir(sid) = 그 세션의 작업 폴더 — **이 곁칸이 모르는 세션이면 null**(남의 세션 번호로 파일을 열지 않는다).
 */
export function pathOpenPlan(
  msg: { path?: unknown; target?: unknown; sid?: unknown },
  here: { projectId: number; loose: boolean; sessDir: (sid: string) => string | null },
): PathOpenPlan | null {
  const t = msg.target as PathTarget | undefined;
  const raw = typeof msg.path === 'string' ? slash(msg.path) : '';
  if (!t || !raw || !safeRel(t.rel)) return null;
  const sid = typeof msg.sid === 'string' && msg.sid ? msg.sid : '';
  const dir = sid ? here.sessDir(sid) : null;
  if (sid && dir !== null) {
    let rel: string | null = null;
    if (t.kind === 'session' && !isAbs(raw)) rel = raw.replace(/^\.\//, '');
    else if (isAbs(raw) && dir && raw.startsWith(slash(dir) + '/')) rel = raw.slice(slash(dir).length + 1);
    if (rel !== null && safeRel(rel)) return { via: 'session', sid, rel };
  }
  if (t.kind === 'project' && !here.loose && here.projectId > 0 && Number(t.id) === here.projectId) return { via: 'project', rel: t.rel };
  return null;
}
