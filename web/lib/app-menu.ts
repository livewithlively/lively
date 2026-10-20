// lib/app-menu.ts — 붙은 앱 탭의 ⋯ 메뉴 · 판 이력 · 런처 「빼기」의 **순수 판정**(#4600, 프로젝트 #4592).
//  DOM 을 모르는 잎이다 — 시험(scripts/session-app-menu.test.mjs)이 컴파일 결과를 그대로 불러 돌린다. 그리는 쪽은
//  web/v2/session-app-pane.ts · app-versions.ts · apps.ts.
//
//  왜 메뉴가 있나(원준 2026-10-07): 이 앱들은 완성품이 아니라 **각자 AI 에게 시켜 고쳐 쓰는 앱**이다. 「고치고 싶다」는 생각은
//   앱을 보고 있을 때 들므로 그 자리(앱 탭)에 문을 둔다 — 세션이 곧 빌더다. 별도 「앱 빌더」 앱은 만들지 않는다(기획안 2판 05절).

import { verName } from './studio-flow.js';   // #4632 판 번호는 버전 이름으로(초안 · V2 …) — 원준 2026-10-15 «판 이라는 워딩 전면 금지»

/** 서버 app_versions 한 줄(SPEC §1-3). */
export interface AppVersion {
  version_no: number;
  origin: 'builtin' | 'member';
  version: string;
  note: string | null;
  saved_by: string | null;
  saved_at: string;
  is_current: boolean;
  /** #4667 모두가 쓰는 판(공개 앱만 — 나만 보는 앱은 늘 false). */
  is_published?: boolean;
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
  /** #4482 「새 탭에서 열기」 — 맨 앱 주소(라이블리 밖 · 폰 홈 화면). 앱 주소가 꺼진 워크스페이스면 없다(줄을 그리지 않는다). */
  tab?(): void;
  /** #4489 「이 세션 대화로 돌린 실행…」 — 앱이 붙은 세션에서 실행(분기)을 선언했을 때만 있다(없으면 줄을 그리지 않는다). */
  forkRuns?(): void;
}

/**
 * ⋯ 메뉴의 줄. 순서가 곧 뜻이다 — 고치는 길(AI·설정·판) → 보는 길(크게) → 떼기(위험색, 맨 아래 관례).
 *  @param app.hasPrefs 앱 화면이 떠 있고 **표시 설정을 받겠다고 구독**했나(SDK lively.ui.onPrefsOpen → ui/subscribe {topic:'prefs-open'}).
 *                      안 했으면 보내 봐야 받을 곳이 없다 — 흐리게 두고 까닭을 힌트로(격리 리뷰).
 *  @param app.overridesBuiltin 워크스페이스 판이 원본을 덮고 있나(아니면 「원본으로」는 할 일이 없다)
 *  @param app.versionNo 지금 판 번호(모르면 null — 힌트를 비운다 · 옛 게이트웨이는 안 준다)
 */
export function sessAppMenuRows(app: { title: string; hasPrefs: boolean; overridesBuiltin: boolean; versionNo: number | null }, h: MenuHandlers): MenuRow[] {
  return [
    { label: 'AI에게 고치기…', icon: 'pencil', hint: '세션에 말하기', run: h.edit },
    { label: '표시 설정', icon: 'sliders', off: !app.hasPrefs, hint: app.hasPrefs ? '나에게만' : '이 앱은 표시 설정이 없어요', run: h.prefs },
    { label: '버전 이력…', icon: 'clock', hint: app.versionNo ? verName(app.versionNo) : undefined, run: h.versions },
    ...(h.forkRuns ? [{ label: '이 세션 대화로 돌린 실행…', icon: 'list', hint: '보이지 않는 실행', run: h.forkRuns }] : []),
    { label: '원본으로 되돌리기', icon: 'undo', off: !app.overridesBuiltin, hint: app.overridesBuiltin ? '릴리스 버전으로' : '지금이 원본', run: h.original },
    { label: '', sep: true },
    { label: '크게 보기', icon: 'expand', hint: '새 탭 · 화면 가득', run: h.big },
    ...(h.tab ? [{ label: '새 탭에서 열기', icon: 'ext', hint: '앱 주소 · 폰 홈 화면', run: h.tab }] : []),
    { label: '이 세션에서 떼기', icon: 'x', danger: true, hint: '데이터는 남음', run: h.detach },
  ];
}

/**
 * 이 «데이터가 바뀌었다» 사건이 앱 화면이 제 손으로 쓴 것인가 — 그렇다면 onChange 를 안 건 앱을 다시 불러오지 않는다(쓰던 화면이 처음으로 돌아간다).
 *  'app-ui' = 라이블리 화면의 다리로 쓴 것 · 'app-front' = 앱 주소의 같은 주소 API(/_lively/*, #4482)로 쓴 것. 그 밖(세션의 AI · 다른 사람)은 바깥 변경이다.
 */
export function isOwnWriteSource(source: unknown): boolean { return source === 'app-ui' || source === 'app-front'; }

/** #4489 이 세션 대화로 돈 분기 실행 한 줄(app_ai_runs 요약의 필요한 칸). */
export interface ForkRunSummary { id: number; status: string; requester: string; label: string | null; prompt_preview: string | null; created_at: string }
const RUN_STATUS_KO: Record<string, string> = { queued: '기다리는 중', running: '도는 중', done: '끝남', failed: '실패', canceled: '취소' };

/** 「이 세션 대화로 돌린 실행」 메뉴의 줄 — 최신 먼저(서버 규약). 줄 = «상태 · 요청 요지», 힌트 = «#번호 · 누가 · 언제». */
export function forkRunRows(runs: readonly ForkRunSummary[], open: (id: number) => void): MenuRow[] {
  const when = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return runs.map((r) => {
    const gist = String(r.label || r.prompt_preview || '요청').replace(/\s+/g, ' ').trim();
    return {
      label: `${RUN_STATUS_KO[r.status] ?? r.status} · ${gist.length > 40 ? gist.slice(0, 40) + '…' : gist}`,
      hint: [`#${r.id}`, r.requester, when(r.created_at)].filter(Boolean).join(' · '),
      run: () => open(r.id),
    };
  });
}

/** 실행 하나를 눌렀을 때 보일 말 — 끝났으면 이 세션에 남긴 메모, 실패면 사유, 아니면 상태. */
export function forkRunNote(r: { status?: string; session_note?: string | null; error?: string | null } | null | undefined): string {
  const st = r && r.status;
  if (st === 'done') return r!.session_note ? '이 세션에 남긴 메모: ' + r!.session_note : '끝났어요(남긴 메모가 없어요).';
  if (st === 'failed') return '실패했어요: ' + (r!.error || '사유 기록 없음');
  if (st === 'canceled') return '취소한 실행이에요.';
  return st === 'running' || st === 'queued' ? '아직 도는 중이에요.' : '실행 상태를 알 수 없어요.';
}

/** 「AI에게 고치기」가 세션 입력칸에 채우는 글 — 뒤를 사람이 잇는다. 보내지 않는다(그건 앱의 chat.send 몫). */
export function draftTextFor(title: string): string { return `「${title}」 앱을 이렇게 고쳐 줘: `; }

/** 방금 고침 띠의 글. */
export function bandText(ev: { version_no?: number; note?: string }): string {
  const n = ev.version_no ? `${verName(ev.version_no)} · ` : '';
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
      label: `${verName(v.version_no)}${v.note ? ' · ' + v.note : v.origin === 'builtin' ? ' · 라이블리 기본 앱' : ''}`,
      hint: v.is_current ? '지금' : who,
      off: v.is_current,
      icon: v.is_current ? 'check' : undefined,
      run: v.is_current ? undefined : () => revert(v.version_no),
    };
  });
}
