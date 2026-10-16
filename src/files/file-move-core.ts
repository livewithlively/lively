// 옛 경로 → 새 경로(#4688)의 순수 부분 — 경로 다듬기 · 접두 맞추기 · 기록 따라가기. DB 는 v6/file-move-store.ts,
//  라우트 배선(자료 좌표 옮기기와 함께)은 files/file-move.ts. 여기는 DB·FS 무관이라 시험이 그대로 돈다(file-move-core.test.ts).
//
//  기록은 «그 자리(scope) 기준 상대경로» 다 — 공유 루트면 링크의 path 그대로(`project/<id>/…` 포함), 개인 폴더면 그 사람 폴더 기준.
//  폴더는 한 줄로 하위 전부를 덮는다(접두). 그래서 옛 경로 하나에 기록이 여럿 걸릴 수 있고(폴더 줄 · 그 안 파일 줄),
//  가장 긴 접두가 이긴다 — 더 구체적인 기록이 더 나중의 사실이다(폴더를 옮긴 뒤 그 안 파일 이름을 바꾸면 파일 줄이 생긴다).
import path from "node:path";

/** 따라가는 단계 상한(#4688 «여러 번 옮긴 연쇄는 상한을 둔다»). 기록할 때 연쇄를 접으므로 대개 한 번에 닿는다 —
 *  폴더 줄 + 그 안 파일 줄처럼 접두가 겹칠 때 두세 번. 기록이 꼬여도 이 안에서 끝난다. */
export const MOVE_FOLLOW_MAX = 8;

/**
 * 자리 기준 상대경로를 기록·비교용으로 다듬는다 — 구분자는 '/', 앞뒤·겹친 '/' 와 '.' 조각을 걷는다.
 *  '..' 이 섞였거나 비면 null(기록하지도 따라가지도 않는다). 글자 꼴(NFC/NFD)은 건드리지 않는다 — 링크의 경로는 목록에 뜬
 *  디스크 이름 그대로이고, 기록의 옛 경로도 디스크 이름 그대로라 그대로 맞춰야 맞는다.
 */
export function normalizeMovePath(rel: unknown): string | null {
  const segs = String(rel ?? "").split(path.sep).join("/").replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!segs.length || segs.some((s) => s === "..")) return null;
  return segs.join("/");
}

/** 자기 + 조상(자리 맨 위 "" 는 빼고), **긴 것부터** — 가장 긴 접두 기록을 고를 후보다. */
export function movePrefixes(rel: string): string[] {
  const segs = rel.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = segs.length; i >= 1; i--) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** p 가 from 자신이거나 그 아래면 to 쪽으로 옮긴 경로, 아니면 null. 경계는 '/' 로만 — `a/b` 기록이 `a/bc` 를 잡지 않는다. */
export function applyMovePrefix(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(from + "/")) return to + p.slice(from.length);
  return null;
}

/** 기록 한 줄. at = 그 기록이 옮겨 놓은 것이 **to 에 도착한 때**(DB 시각 글자 — 그대로 다시 넘긴다, v6/file-move-store). */
export interface MoveRecord { from: string; to: string; at?: string | null }
export interface FollowDeps {
  /**
   * 이 경로를 담는 가장 긴 접두 기록(자기 포함) — 없으면 null.
   *  since 가 있으면 그때 이후(같은 때 포함)에 생긴 기록만 본다 — 앞 걸음이 옮겨 놓은 것이 그 자리에 **도착한 뒤의** 일만 그것의 다음 걸음이다.
   *  그 전 기록은 그 경로를 앞서 쓰던 다른 것의 일이다(같은 이름 폴더를 다시 쓰는 경우).
   */
  lookup(p: string, since: string | null): Promise<MoveRecord | null>;
  /** 그 자리에 지금 실제로 무엇이 있나(경로 봉쇄를 지난 뒤). */
  exists(p: string): Promise<boolean>;
  /** 이 사람이 그 자리를 볼 수 있나 — 닿은 자리를 **새로** 판정한다(옛 자리의 판정을 물려받지 않는다). */
  visible(p: string): boolean | Promise<boolean>;
}

/**
 * 옛 경로를 기록대로 따라가 «지금 실제로 있고 이 사람이 볼 수 있는» 자리를 찾는다. 못 찾으면 null.
 *  - 실제 파일이 이긴다 — 따라가다 무엇이 있는 자리에 닿으면 거기서 멈춘다. 그 자리가 안 보이면 null(더 가지 않는다 —
 *    있는데 못 보는 자리는 그 너머도 열지 않는다).
 *  - 옛 경로 자체에 무엇이 있는지는 부르는 쪽이 먼저 본다(있으면 따라가지 않는다 — 옛 자리에 새 파일이 생긴 경우).
 *  - 첫 걸음은 시각을 가리지 않고, 다음 걸음부터는 앞 기록의 도착 시각 이후 기록만 본다(lookup since).
 *  - 단계는 max 까지, 지난 자리로 돌아오면 멈춘다.
 */
export async function followMoves(start: string, deps: FollowDeps, max = MOVE_FOLLOW_MAX): Promise<{ path: string; hops: number } | null> {
  const seen = new Set<string>([start]);
  let cur = start;
  let since: string | null = null;
  for (let hop = 1; hop <= max; hop++) {
    const rec = await deps.lookup(cur, since);
    if (!rec) return null;
    const next = applyMovePrefix(cur, rec.from, rec.to);
    if (next === null || seen.has(next)) return null;
    seen.add(next);
    if (await deps.exists(next)) return (await deps.visible(next)) ? { path: next, hops: hop } : null;
    cur = next;
    since = rec.at ?? since;
  }
  return null;
}
