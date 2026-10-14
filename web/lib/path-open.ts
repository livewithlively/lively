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

/**
 * 후보 여럿 → 여는 길 여럿(순서 그대로, 같은 것은 한 번). 터미널은 빈칸 앞 낱말을 붙인 상대 경로 후보를 긴 것 먼저, 화면에 그어진
 *  경로를 맨 끝에 싣는다(terminal.ts pathMatches 머리말). 둘 이상이면 셸이 **실제로 있는 첫 것**을 연다 — 글만으로는 `파일은 docs/a.md`
 *  와 `데모데이 발표덱/a.md` 를 가를 수 없다. 후보가 없는 옛 터미널이면 path·target 하나로 본다.
 */
export function pathOpenPlans(
  msg: { path?: unknown; target?: unknown; sid?: unknown; cands?: unknown },
  here: { projectId: number; loose: boolean; sessDir: (sid: string) => string | null },
): PathOpenPlan[] {
  const cands = Array.isArray(msg.cands) && msg.cands.length
    ? (msg.cands as Array<{ path?: unknown; target?: unknown }>).slice(0, 8)
    : [{ path: msg.path, target: msg.target }];
  const out: PathOpenPlan[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const plan = pathOpenPlan({ path: c && c.path, target: c && c.target, sid: msg.sid }, here);
    if (!plan) continue;
    const k = plan.via === 'session' ? 's:' + plan.sid + ':' + plan.rel : 'p:' + plan.rel;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(plan);
  }
  return out;
}

/**
 * 받은 경로가 그 자리에 없을 때 — 프로젝트 자료에서 **그 경로로 끝나는** 파일을 고른다(원준님 10-06 «파일 가끔씩 안열림 …
 *  너가 풀링크를 안주고 경로의 뒤쪽만 요약해서 줄 때가 있어서»). AI 는 `데모데이 발표덱/원준수정/x.html` 을 `원준수정/x.html` 로
 *  줄여 말하곤 한다 — 그 짧은 꼴은 세션 폴더 기준으로 풀려 «파일을 찾을 수 없다» 가 됐다.
 *  hits = 자료 검색(이름에 낱말이 든 것) 결과, tails = 찾는 꼴들(긴 것 먼저). 마디 경계로만 맞춘다(`b/x.md` 는 `ab/x.md` 가 아니다).
 *  ★ 엉뚱한 파일을 여는 것은 «못 찾았다» 보다 나쁘다(리뷰 차단 지적) — 그래서
 *   · 마디가 둘 이상인 꼴(`원준수정/x.html`)은 맞는 것 중 가장 최근에 고친 것(AI 가 방금 만들었다고 말한 파일일 가능성이 가장 높다).
 *   · 이름 하나뿐인 꼴(`README.md`)은 **딱 하나**일 때만 — 여럿이면 어느 것인지 모르므로 null(«찾을 수 없다» 그대로).
 *   · `node_modules` 속은 아예 보지 않는다.
 *  이름은 NFC 로 견준다(맥 노드는 NFD).
 */
//  truncated = 서버 검색이 상한(100)에서 끊겼다 — 그러면 «딱 하나» 를 확신할 수 없으므로 이름 하나뿐인 꼴은 고르지 않는다.
export function pickTailHit(hits: Array<{ path?: unknown; type?: unknown; mtime?: unknown }>, tails: string[], truncated = false): string | null {
  const nfc = (x: string): string => x.normalize('NFC');
  const files = hits
    .filter((h) => h && h.type === 'file' && typeof h.path === 'string' && !String(h.path).split('/').includes('node_modules'))
    .map((h) => ({ p: String(h.path), m: Number(h.mtime) || 0 }));
  for (const raw of tails) {
    const tail = nfc(String(raw || '').replace(/^\.\//, ''));
    if (!tail) continue;
    const ok = files.filter((h) => { const p = nfc(h.p); return p === tail || p.endsWith('/' + tail); });
    if (!ok.length) continue;
    if (!tail.includes('/') && (ok.length > 1 || truncated)) continue;   // 이름 하나 · 여럿(또는 다 못 봤다) — 고르지 않는다
    return ok.sort((a, b) => b.m - a.m)[0].p;
  }
  return null;
}
