// v2/mention-text.ts — 새 세션 컴포저의 **@이름 초대**(#3778) 가운데 글자만 다루는 순수 함수.
//  DOM·네트워크가 없어 src 테스트가 transpile 해 그대로 돌린다(composer-mention.test.ts). 화면 부품은 compose-mention.ts.
//
//  ── 왜 @이름인가(원준 2026-09-09) ──
//  초대는 «보통 안 넣지만 넣을 때는 반드시 보여야 하는» 값이다. 단추를 하나 더 두면 줄이 늘고(설정·＋·시키기로 끝내자는
//  요청), 설정 창 안에 접으면 «누가 보나»가 보내기 전에 안 보인다. 슬랙처럼 지시문에 @ 를 치면 목록이 뜨고 고르면 된다.
//
//  ── 슬랙과 다른 점 하나 ──
//  고른 사람은 **글에 남지 않는다**(원준: «@사람이름 이걸 본문에 표시하지는 마»). 목록에서 고르는 순간 치던 `@윤` 을 글에서
//  걷어 내고, 그 사람은 아래 칩 줄에만 선다. 그러니 초대의 정본은 글이 아니라 칩(고른 사람 집합)이다.
//  · 질의: 커서 앞 토큰이 `@…` 이고(앞이 처음이거나 공백) 그 안에 공백이 없을 때만 «고르는 중»이다. 이메일(a@b.c)은 안 열린다.
//  · 보낼 때 꼬리에 «함께 보는 사람: …» 한 줄 — 세션을 여는 AI 도, 초대받은 사람도 그 사실을 본다.

export interface MentionMember { id: string; name: string; kind?: string }

/** 커서 앞에서 «@ 뒤에 치는 중인 글자» — 고르는 중이 아니면 null. */
export function mentionQuery(text: string, caret: number): string | null {
  if (caret <= 0) return null;
  const head = text.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(head[at - 1])) return null;   // 이메일·경로 속 @ 는 아니다
  const q = head.slice(at + 1);
  if (/\s/.test(q)) return null;                          // 공백이 나왔으면 고르는 중이 아니다
  return q;
}

/** 후보 — 앞글자 일치 먼저, 그다음 부분 일치. 나(meId)와 이미 부른 사람(exclude)은 뺀다. 이름이 빈 사람은 후보가 아니다. */
export function mentionMatches(members: readonly MentionMember[], q: string, opts?: { meId?: string; exclude?: Set<string>; limit?: number }): MentionMember[] {
  const needle = q.trim().toLowerCase();
  const starts: MentionMember[] = [];
  const contains: MentionMember[] = [];
  for (const m of members) {
    if (!m || !m.id || !String(m.name || '').trim()) continue;
    if (opts?.meId && m.id === opts.meId) continue;
    if (opts?.exclude?.has(m.id)) continue;
    const n = String(m.name).toLowerCase();
    if (n.startsWith(needle)) starts.push(m);
    else if (needle && (n.includes(needle) || String(m.id).toLowerCase().includes(needle))) contains.push(m);
  }
  return [...starts, ...contains].slice(0, opts?.limit ?? 8);
}

/** 고른 뒤 — 치던 `@…` 를 글에서 걷어 낸다(커서는 그 자리). 뒤에 바로 글자가 이어지면 공백 하나를 남기지 않는다. */
export function removeMentionQuery(text: string, caret: number): { text: string; caret: number } {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(head[at - 1])) || /\s/.test(head.slice(at + 1))) return { text, caret };
  let before = text.slice(0, at);
  let after = text.slice(caret);
  // «봐줘 @윤| 지금» → «봐줘 | 지금» 이 아니라 «봐줘 |지금» — 공백이 둘 남지 않게 한쪽만 남긴다.
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^\s+/, '');
  if (!after && /\s$/.test(before)) before = before.replace(/\s+$/, '');
  return { text: before + after, caret: before.length };
}

/** 지시 꼬리 — 첨부 꼬리와 같은 자리에 «함께 보는 사람» 한 줄. 아무도 없으면 ''. */
export function mentionTail(names: readonly string[]): string {
  return names.length ? '\n\n함께 보는 사람(이 세션에 초대됨): ' + names.join(', ') : '';
}
