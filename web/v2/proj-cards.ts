// [프로젝트] 사이드바 카드 계획 — 순수(#4233 안 1, 원준 2026-09-25 «4. 안 1. 좋아.»). DOM 을 모른다:
//  폴더 · 리스트 · 열린 프로젝트 수 · 즐겨찾기 · 고른 스코프 · 접은 카드 · 편 카드 → 고정 줄 · 이름표 · 카드.
//  renderProjects(web/v2/side.ts)는 이 결과를 그리기만 한다 — 위키 사이드바의 wiki-cards.ts 와 같은 짝이다.
//
//  ── 규칙 ── (검토판 project/4233/projects-sidebar-review.html 안 1)
//  · 구조는 그대로다(즐겨찾기 · 폴더 › 하위 폴더 › 리스트). 묶음을 보여 주는 방식만 위키 사이드바와 같게 한다.
//  · 맨 위 고정 줄: 즐겨찾기 리스트(리스트 순서) → 「기타 (미분류)」(리스트에 안 든 열린 프로젝트가 있을 때만).
//  · 최상위 폴더마다 이름표 한 줄, 그 아래 하위 폴더마다 카드 한 장. 최상위 폴더에 바로 든 리스트는 카드 한 장
//    (하위 폴더 카드가 있으면 「그 밖의 리스트」, 없으면 「리스트」). 하위 폴더 카드에는 그 아래 폴더의 리스트까지 트리 순서로 든다.
//  · 폴더 밖 리스트는 맨 끝 이름표 「폴더 밖」 아래 카드 「리스트」 한 장. 보관 폴더와 그 아래는 없다.
//  · 열린 프로젝트가 0 인 리스트는 카드 끝 줄 «빈 리스트 M» 으로 접힌다.
//  · 고른 리스트가 즐겨찾기면 **고정 줄만** 켜진다(종전엔 즐겨찾기 줄과 트리 줄이 함께 켜졌다 — 검토판 진단).
//    즐겨찾기가 아니면 카드 줄이 켜지고, 그 줄까지는 보이게 하며(forced), 빈 리스트면 카드를 끝까지 편다. 그 카드는 접혀 있어도 편다.

export interface ProjCardList { id: number; name: string; folder_id?: number | null }
export interface ProjCardFolder { id: number; name: string; parent_id?: number | null; settings?: { kind?: string | null } | null }

export interface ProjCard<L> {
  /** 접힘 · 「N개 더」 상태의 키. 하위 폴더 카드는 폴더 id, 바로 든 리스트 카드는 `rest:<최상위 폴더 id>`, 폴더 밖은 `rest:root`. */
  key: string;
  /** 하위 폴더 카드면 그 폴더 id(머리를 누르면 그 폴더 보드). 리스트 모음 카드는 null. */
  folderId: number | null;
  name: string;
  /** 열린 프로젝트가 있는 리스트 — 줄 나누기 대상, 트리 순서. */
  rows: L[];
  /** 열린 프로젝트가 0 인 리스트 — 끝 줄로 접힌다. */
  empties: L[];
  /** 카드 안 열린 프로젝트 합. */
  count: number;
  open: boolean;
  /** 「N개 더」로 편 카드이거나 고른 빈 리스트가 든 카드 — 줄 나누기에서 빠지고 끝까지 보인다. */
  full: boolean;
  /** 고른 리스트가 rows 의 몇 번째까지 보여야 하나(1부터). 0 = 없음. */
  forced: number;
}
export interface ProjCardGroup<L> {
  /** 최상위 폴더 id. 폴더 밖 묶음은 null. */
  folderId: number | null;
  name: string;
  cards: ProjCard<L>[];
}
export interface ProjCardPlan<L> {
  favs: L[];
  /** 「기타 (미분류)」 줄의 수. 0 이면 그 줄은 없다. */
  noneN: number;
  groups: ProjCardGroup<L>[];
  /** 켜진 줄의 자리 — 'fav:<id>' · 'card:<id>' · 'none' · 'folder:<id>' · ''. 한 줄만 켜진다. */
  onKey: string;
}

export const PROJ_ROOT_KEY = 'rest:root';
export const PROJ_REST_NAME = '그 밖의 리스트';
export const PROJ_LISTS_NAME = '리스트';
export const PROJ_LOOSE_GROUP = '폴더 밖';

/**
 * @param sel 지금 스코프 — side.ts projScopeKey 와 같은 모양('L<id>' · 'F<id>' · 'none' · '').
 * @param closed 사람이 접은 카드 키(계정에 저장되는 FOLD_CLOSED_STORE) · @param more 「N개 더」로 편 카드 키(페이지 수명).
 */
export function planProjCards<L extends ProjCardList>(input: {
  lists: readonly L[] | null | undefined;
  folders: readonly ProjCardFolder[] | null | undefined;
  openByList: ReadonlyMap<number, number>;
  noneN: number;
  favIds: ReadonlySet<number> | null | undefined;
  sel: string;
  closed: ReadonlySet<string>;
  more: ReadonlySet<string>;
}): ProjCardPlan<L> {
  const lists = [...(input.lists || [])];
  const folders = [...(input.folders || [])];
  const favIds = input.favIds || new Set<number>();
  const kids = new Map<number | null, ProjCardFolder[]>();
  for (const f of folders) { const k = f.parent_id ?? null; const a = kids.get(k); if (a) a.push(f); else kids.set(k, [f]); }
  const archived = new Set<number>();
  const mark = (f: ProjCardFolder): void => { if (archived.has(f.id)) return; archived.add(f.id); for (const c of kids.get(f.id) || []) mark(c); };
  for (const f of folders) if (f.settings && f.settings.kind === 'archive') mark(f);
  const live = (f: ProjCardFolder): boolean => !archived.has(f.id);
  const listsIn = (fid: number | null): L[] => lists.filter((l) => (l.folder_id ?? null) === fid);
  const openN = (l: L): number => input.openByList.get(l.id) || 0;
  //  폴더와 그 아래 모든 폴더의 리스트 — 폴더 자신의 리스트 먼저, 그다음 하위 폴더 차례로(트리 순서).
  const deep = (f: ProjCardFolder): L[] => [...listsIn(f.id), ...(kids.get(f.id) || []).filter(live).flatMap(deep)];

  const selList = /^L(\d+)$/.exec(input.sel);
  const selId = selList ? Number(selList[1]) : 0;
  const selFav = !!selId && favIds.has(selId);
  const favs = lists.filter((l) => favIds.has(l.id));

  const card = (key: string, folderId: number | null, name: string, ls: L[]): ProjCard<L> => {
    const rows = ls.filter((l) => openN(l) > 0);
    const empties = ls.filter((l) => openN(l) <= 0);
    //  고른 리스트가 즐겨찾기면 카드 쪽은 켜지도 끌어당기지도 않는다(한 줄만 켜진다).
    const mine = !!selId && !selFav && ls.some((l) => l.id === selId);
    const at = mine ? rows.findIndex((l) => l.id === selId) : -1;
    const selEmpty = mine && at < 0;
    return {
      key, folderId, name, rows, empties,
      count: ls.reduce((a, l) => a + openN(l), 0),
      open: !input.closed.has(key) || mine,
      full: input.more.has(key) || selEmpty,
      forced: at >= 0 ? at + 1 : 0,
    };
  };

  const groups: ProjCardGroup<L>[] = [];
  for (const top of (kids.get(null) || []).filter(live)) {
    const subs = (kids.get(top.id) || []).filter(live);
    const cards = subs.map((s) => card(String(s.id), s.id, s.name, deep(s)));
    const direct = listsIn(top.id);
    if (direct.length || !subs.length) cards.push(card('rest:' + top.id, null, subs.length ? PROJ_REST_NAME : PROJ_LISTS_NAME, direct));
    groups.push({ folderId: top.id, name: top.name, cards });
  }
  const loose = listsIn(null);
  if (loose.length) groups.push({ folderId: null, name: PROJ_LOOSE_GROUP, cards: [card(PROJ_ROOT_KEY, null, PROJ_LISTS_NAME, loose)] });

  const selFolder = /^F(\d+)$/.exec(input.sel);
  const onKey = selId ? (selFav ? 'fav:' + selId : 'card:' + selId)
    : input.sel === 'none' ? 'none'
    : selFolder ? 'folder:' + selFolder[1] : '';
  return { favs, noneN: Math.max(0, input.noneN || 0), groups, onKey };
}
