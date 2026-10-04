// lib/list-fav.ts — 리스트 즐겨찾기를 «어디서 바꾸든 한 번에 맞춘다» 의 순수한 부분 (#3870)
//
//  원준 2026-10-04: "프로젝트 탭 들어갔을 때 뭔가 사이드바에 즐겨찾기 리스트 넣는 방법도 이상하고 뭔가 되게 많이 불편하거든?
//   이거 플로우가 엄청 어색하니까 수정좀 해봐"
//  실측(매니지드): 셸 [프로젝트] 사이드바 줄엔 즐겨찾기 단추가 없고 우클릭 메뉴에도 없었다. 넣는 길은 «리스트를 연 뒤 본문(액자)
//   브레드크럼 옆 ☆» 하나였고, 눌러서 저장이 돼도 사이드바의 즐겨찾기 줄은 그대로였다 — 사이드바는 즐겨찾기를 페이지당 한 번만
//   받고, 액자는 바꾼 것을 셸에 알리지 않았다. 새로고침해야 줄이 섰다.
//
//  여기는 두 가지만 든다(화면 없음 · 통신 없음):
//   ① 셸 ↔ 액자가 주고받는 알림 한 줄의 모양(LIST_FAV_MSG)과 읽는 법 — 양쪽이 같은 것을 쓴다.
//   ② 연달아 누를 때의 저장 순서(createFavSaver) — 응답 전에 또 누르면 요청이 뒤집혀 도착할 수 있다. 리스트마다 한 줄로 세운다.

export const LIST_FAV_MSG = 'lively:list-fav';

/** 알림 한 줄. id = 리스트 번호, on = 즐겨찾기에 있다. */
export interface ListFavChange { id: number; on: boolean }

export function listFavMsg(id: number, on: boolean): { type: string; id: number; on: boolean } {
  return { type: LIST_FAV_MSG, id, on };
}

/** 받은 것이 그 알림이면 내용을, 아니면 null. 번호는 양의 정수, on 은 불리언이어야 한다(«1» 같은 문자열 · 'true' 는 버린다). */
export function readListFavMsg(data: unknown): ListFavChange | null {
  const m = data as { type?: unknown; id?: unknown; on?: unknown } | null;
  if (!m || typeof m !== 'object' || m.type !== LIST_FAV_MSG) return null;
  if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id <= 0 || typeof m.on !== 'boolean') return null;
  return { id: m.id, on: m.on };
}

export interface FavSaverDeps {
  /** 서버에 저장한다. 실패하면 던진다. */
  save(id: number, on: boolean): Promise<unknown>;
  /** 저장이 됐다 — 서버가 아는 값이 on 이 됐다. */
  saved(id: number, on: boolean): void;
  /** 저장이 안 됐다 — 화면을 서버가 아는 값(back)으로 되돌려야 한다. */
  failed(id: number, back: boolean, err: unknown): void;
}

/**
 * 리스트마다 저장을 한 줄로 세운다.
 *  · want(id, on) — 사람이 방금 고른 값. 그 리스트의 저장이 돌고 있으면 끝난 뒤에 이어서 보낸다(누른 순서대로, 한 번에 하나).
 *  · 돌고 있는 저장이 끝났을 때 마지막으로 고른 값이 서버가 아는 값과 같으면 더 보내지 않는다(켰다 껐다 켰다 = 한 번).
 *  · 실패하면 그 리스트의 밀린 것을 버리고 failed 로 알린다 — 실패한 요청 뒤에 또 보내 봐야 사람이 본 화면과 어긋난다.
 *  · know(id, on) — 서버가 아는 값을 밖에서 알려 준다(처음 받은 목록 · 다른 창이 바꿨다는 알림).
 *    ⚠ 저장이 도는 중에 알려 온 값은 그 저장이 끝나면 덮인다(여기서 누른 것이 나중이라고 본다). 두 창에서 같은 리스트를 한 왕복 안에
 *     엇갈려 누르면 서버엔 늦게 닿은 쪽이 남는다 — 드문 일이라 다시 받아 맞추지는 않는다.
 */
export function createFavSaver(deps: FavSaverDeps): { want(id: number, on: boolean): void; know(id: number, on: boolean): void; busy(id: number): boolean } {
  const known = new Map<number, boolean>();
  const wanted = new Map<number, boolean>();
  const running = new Set<number>();
  const run = async (id: number): Promise<void> => {
    if (running.has(id)) return;
    running.add(id);
    let broke: { err: unknown } | null = null;
    try {
      for (;;) {
        const on = wanted.get(id);
        if (on == null || on === (known.get(id) ?? false)) break;
        try { await deps.save(id, on); }
        catch (err) { broke = { err }; break; }
        known.set(id, on);
        deps.saved(id, on);
      }
    } finally { running.delete(id); wanted.delete(id); }
    //  줄을 비운 뒤에 알린다 — failed 안에서 다시 고르면(want) 새 줄로 선다. 줄이 선 채로 부르면 그 고름이 위 finally 에 지워진다.
    if (broke) deps.failed(id, known.get(id) ?? false, broke.err);
  };
  return {
    want(id, on) { wanted.set(id, on); void run(id); },
    know(id, on) { known.set(id, on); },
    busy(id) { return running.has(id); },
  };
}
