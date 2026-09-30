// v2/sess-input.ts — 곁칸에서 **지금 세션의 입력칸**에 글을 넣는 다리(#4135 곁칸 «프로젝트» 앱의 [본문 넣기]·[이 세션에 넣기]).
//
//  세션 화면(web/session-chat.ts)은 대화창과 터미널 둘 중 하나가 입력칸이다. 곁칸 부품은 그 화면을 모르고(다른 칸이다),
//   화면도 곁칸을 모른다 — 그래서 가운데에 이 작은 표를 둔다: 화면이 뜰 때 «이 세션(들)의 입력칸에 넣는 법»을 올려 두고,
//   곁칸은 세션 id 로 찾아 부른다. **넣기만 하고 보내지 않는다** — 사람이 읽고 고쳐서 보낸다.
//  잎 모듈이다(import 0) — 세션 화면과 곁칸 어느 쪽이 먼저 떠도 순환이 없다.
type Put = (text: string) => boolean;
interface Entry { ids: () => Array<string | null | undefined>; put: Put }
const entries: Entry[] = [];

/** 세션 화면이 뜰 때 부른다. ids 는 **부를 때마다 지금 값**을 준다(되살리기로 세션 id 가 바뀌어도 따라간다). 돌려주는 함수로 내린다. */
export function registerSessionInput(ids: Entry['ids'], put: Put): () => void {
  const e: Entry = { ids, put };
  entries.push(e);
  return () => { const i = entries.indexOf(e); if (i >= 0) entries.splice(i, 1); };
}

/** 이 세션(이름 여럿 중 하나라도 맞으면)의 입력칸에 글을 넣는다. 넣었으면 true — 그 세션 화면이 안 떠 있으면 false. 나중에 뜬 화면이 이긴다. */
export function putIntoSession(ids: Array<string | null | undefined>, text: string): boolean {
  const want = new Set(ids.filter((x): x is string => !!x));
  if (!want.size || !text) return false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.ids().some((x) => !!x && want.has(String(x)))) return e.put(text);
  }
  return false;
}
