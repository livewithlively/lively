// v2/task-picks.ts — 새 세션 자리(?new=1)의 **담은 태스크**(#4135). 곁칸 «프로젝트» 앱의 [담기]와 가운데 글칸의 태스크
//  배지가 같은 목록을 본다 — 한쪽에서 넣고 빼고 순서를 바꾸면 다른 쪽이 따라 그린다. 순서가 곧 세션의 «이 세션의 태스크» 1. 2.
//  울타리는 곁칸 한 벌의 뿌리(ctx.paneRoot()) — 문서 전체로 뿌리면 열려 있는 다른 세션 탭의 글칸까지 받는다(PartCtx.paneRoot 머리말).
//  잎 모듈이다(import 0).
interface Box { ids: number[]; subs: Set<(ids: number[]) => void> }
const boxes = new WeakMap<HTMLElement, Box>();
const boxOf = (root: HTMLElement): Box => {
  let b = boxes.get(root);
  if (!b) { b = { ids: [], subs: new Set() }; boxes.set(root, b); }
  return b;
};

export const taskPicks = (root: HTMLElement): number[] => boxOf(root).ids.slice();

/** 목록을 통째로 바꾼다(중복·0 은 걸러진다) — 담기·빼기·순서 바꾸기가 모두 이 한 길. */
export function setTaskPicks(root: HTMLElement, ids: number[]): void {
  const b = boxOf(root);
  const next: number[] = [];
  for (const x of ids) { const n = Number(x); if (n > 0 && !next.includes(n)) next.push(n); }
  if (next.join() === b.ids.join()) return;
  b.ids = next;
  for (const fn of [...b.subs]) { try { fn(next.slice()); } catch (_) { /* 한 구독자의 실패가 다른 쪽을 막지 않게 */ } }
}

export function toggleTaskPick(root: HTMLElement, id: number): void {
  const cur = taskPicks(root);
  setTaskPicks(root, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
}

export function onTaskPicks(root: HTMLElement, fn: (ids: number[]) => void): () => void {
  const b = boxOf(root);
  b.subs.add(fn);
  return () => { b.subs.delete(fn); };
}
