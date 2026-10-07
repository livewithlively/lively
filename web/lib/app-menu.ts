// lib/app-menu.ts — 붙은 앱 탭의 ⋯ 메뉴 · 판 이력 · 런처 「빼기」의 **순수 판정**(#4600, 프로젝트 #4592).
//  DOM 을 모르는 잎이다 — 시험(scripts/session-app-menu.test.mjs)이 컴파일 결과를 그대로 불러 돌린다. 그리는 쪽은
//  web/v2/session-app-pane.ts · app-versions.ts · apps.ts.
//
//  왜 메뉴가 있나(원준 2026-10-07): 이 앱들은 완성품이 아니라 **각자 AI 에게 시켜 고쳐 쓰는 앱**이다. 「고치고 싶다」는 생각은
//   앱을 보고 있을 때 들므로 그 자리(앱 탭)에 문을 둔다 — 세션이 곧 빌더다. 별도 「앱 빌더」 앱은 만들지 않는다(기획안 2판 05절).

/** 서버 app_versions 한 줄(SPEC §1-3). */
export interface AppVersion {
  version_no: number;
  origin: 'builtin' | 'member';
  version: string;
  note: string | null;
  saved_by: string | null;
  saved_at: string;
  is_current: boolean;
}

/** 메뉴 한 줄 — ctx-menu.ts 의 CtxRow 와 같은 모양(잎이라 import 하지 않는다). */
export interface MenuRow { label: string; run?: () => void; danger?: boolean; sep?: boolean; off?: boolean; icon?: string; hint?: string }

export interface MenuHandlers {
  edit(): void;          // 「AI에게 고치기…」 — 세션 입력칸을 채운다(보내지 않는다)
  prefs(): void;         // 「표시 설정」 — 앱에 prefs-open 알림
  versions(): void;      // 「판 이력…」
  original(): void;      // 「원본으로 되돌리기」
  big(): void;           // 「크게 보기」
  detach(): void;        // 「이 세션에서 떼기」
}

/**
 * ⋯ 메뉴의 줄. 순서가 곧 뜻이다 — 고치는 길(AI·설정·판) → 보는 길(크게) → 떼기(위험색, 맨 아래 관례).
 *  @param app.hasFrame 앱 화면이 떠 있나(없으면 표시 설정을 보낼 곳이 없다)
 *  @param app.overridesBuiltin 워크스페이스 판이 원본을 덮고 있나(아니면 「원본으로」는 할 일이 없다)
 *  @param app.versionNo 지금 판 번호(모르면 null — 힌트를 비운다)
 */
export function sessAppMenuRows(app: { title: string; hasFrame: boolean; overridesBuiltin: boolean; versionNo: number | null }, h: MenuHandlers): MenuRow[] {
  return [
    { label: 'AI에게 고치기…', icon: 'pencil', hint: '세션에 말하기', run: h.edit },
    { label: '표시 설정', icon: 'sliders', off: !app.hasFrame, hint: app.hasFrame ? '나에게만' : '앱 화면이 없음', run: h.prefs },
    { label: '판 이력…', icon: 'clock', hint: app.versionNo ? `${app.versionNo}판` : undefined, run: h.versions },
    { label: '원본으로 되돌리기', icon: 'undo', off: !app.overridesBuiltin, hint: app.overridesBuiltin ? '릴리스 판으로' : '지금이 원본', run: h.original },
    { label: '', sep: true },
    { label: '크게 보기', icon: 'expand', run: h.big },
    { label: '이 세션에서 떼기', icon: 'x', danger: true, hint: '데이터는 남음', run: h.detach },
  ];
}

/** 「AI에게 고치기」가 세션 입력칸에 채우는 글 — 뒤를 사람이 잇는다. 보내지 않는다(그건 앱의 chat.send 몫). */
export function draftTextFor(title: string): string { return `「${title}」 앱을 이렇게 고쳐 줘: `; }

/** 방금 고침 띠의 글. */
export function bandText(ev: { version_no?: number; note?: string }): string {
  const n = ev.version_no ? `${ev.version_no}판 · ` : '';
  return `${n}방금 고침${ev.note ? ' · ' + ev.note : ''}`;
}

/**
 * 「되돌리기」가 갈 판 — 지금 판의 **바로 앞** 판. 없으면(판이 하나뿐) null.
 *  목록은 최신 먼저(서버 규약)라 is_current 다음 줄이 바로 앞 판이다. 순서가 깨져 있어도 번호로 다시 고른다.
 */
export function previousVersionNo(versions: readonly AppVersion[]): number | null {
  const cur = versions.find((v) => v.is_current);
  if (!cur) return null;
  const before = versions.filter((v) => v.version_no < cur.version_no).sort((a, b) => b.version_no - a.version_no);
  return before.length ? before[0].version_no : null;
}

/** 원본(릴리스) 판 번호 — 빌트인에서 갈라져 나온 앱만 갖는다. */
export function originVersionNo(versions: readonly AppVersion[]): number | null {
  const o = versions.filter((v) => v.origin === 'builtin').sort((a, b) => a.version_no - b.version_no)[0];
  return o ? o.version_no : null;
}

/** 판 이력 메뉴의 줄 — 지금 판은 누를 수 없고(「지금」), 나머지는 누르면 그 판으로 되돌린다. */
export function versionRows(versions: readonly AppVersion[], revert: (versionNo: number) => void): MenuRow[] {
  const when = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return [...versions].sort((a, b) => b.version_no - a.version_no).map((v) => {
    const who = v.origin === 'builtin' ? '원본 · 릴리스 ' + v.version : [v.saved_by, when(v.saved_at)].filter(Boolean).join(' · ');
    return {
      label: `${v.version_no}판${v.note ? ' · ' + v.note : v.origin === 'builtin' ? ' · 라이블리 기본 앱' : ''}`,
      hint: v.is_current ? '지금' : who,
      off: v.is_current,
      icon: v.is_current ? 'check' : undefined,
      run: v.is_current ? undefined : () => revert(v.version_no),
    };
  });
}
