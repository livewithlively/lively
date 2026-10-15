// 하네스를 끄기 전에 남긴 쪽지(#4695 T5)를 대화창이 되돌린다 — 순수 도우미(표는 scripts/stop-note-web.test.mjs).
//
//  서버(sessions/session-stop-rule.ts)는 «완료+안 봄 N분 · 질의+안 봄 M분» 이면 하네스를 끄고, 끄기 직전 화면에서 읽은 쪽지를 세션 행에 싣는다
//  (SessionInfo.stopNote — 복원 가능 행에만). 이 모듈은 그 쪽지로 ① 입력칸에 되돌릴 글 ② 답을 기다리던 질문의 답 문장을 만든다.
//  ⚠ claude 는 다시 열어도 그 질문 창이 안 뜬다(실측 3/3 — 질문이 대화 파일에도 안 남는다). 그래서 답은 «앞서 물은 ‹질문›에 대한 답: ‹선택›»
//   프롬프트로 보낸다(규칙 정본). codex 는 승인 요청이 대화 파일에 남아 다시 열면 같은 창이 다시 뜬다(reappears) — 그때는 열기만 한다.

/** 서버 쪽지 모양(src/sessions/session-state.ts SessionStopNote 와 같다). */
export interface StopNoteItem { header?: string; text: string; options: Array<{ n: number; label: string; desc?: string }>; multi?: boolean; free?: boolean }
export interface StopNoteQuestion { kind: 'ask' | 'permission' | 'plan' | 'other'; items: StopNoteItem[]; target?: string; reappears?: boolean }
export interface StopNote { at: number; why: 'done' | 'asking' | 'exited'; harness: string; draft?: string; question?: StopNoteQuestion }

/** 서버가 준 값이 쪽지 모양인가 — 아니면 null(모르는 모양을 그리지 않는다). */
export function stopNoteOf(v: unknown): StopNote | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  if (typeof n.at !== 'number' || (n.why !== 'done' && n.why !== 'asking' && n.why !== 'exited')) return null;
  const note: StopNote = { at: n.at, why: n.why, harness: String(n.harness ?? '') };
  if (typeof n.draft === 'string' && n.draft.trim()) note.draft = n.draft;
  const q = n.question as Record<string, unknown> | undefined;
  if (q && typeof q === 'object' && Array.isArray(q.items) && q.items.length) {
    const items = (q.items as unknown[]).flatMap((it): StopNoteItem[] => {
      if (!it || typeof it !== 'object') return [];
      const o = it as Record<string, unknown>;
      const options = Array.isArray(o.options) ? (o.options as unknown[]).flatMap((op) => {
        const x = op as Record<string, unknown>;
        return x && typeof x.label === 'string' && x.label.trim() ? [{ n: Number(x.n) || 0, label: x.label, ...(typeof x.desc === 'string' && x.desc ? { desc: x.desc } : {}) }] : [];
      }) : [];
      const text = typeof o.text === 'string' ? o.text : '';
      if (!text && !options.length) return [];
      return [{ ...(typeof o.header === 'string' && o.header ? { header: o.header } : {}), text, options, ...(o.multi ? { multi: true } : {}), ...(o.free ? { free: true } : {}) }];
    });
    const kind = q.kind === 'ask' || q.kind === 'permission' || q.kind === 'plan' ? q.kind : 'other';
    if (items.length) note.question = { kind, items, ...(typeof q.target === 'string' && q.target ? { target: q.target } : {}), ...(q.reappears ? { reappears: true } : {}) };
  }
  return note;
}

/** 대화창 안내 한 줄 — 왜 이 세션의 AI 가 꺼져 있나(완결된 문장으로). */
export function stopNoteWhy(note: StopNote): string {
  if (note.why === 'asking') return '답을 기다리는 동안 아무도 보지 않아 AI 를 꺼 두었어요';
  if (note.why === 'exited') return 'AI 가 끝나 세션을 닫아 두었어요';
  return '작업이 끝나고 아무도 보지 않아 AI 를 꺼 두었어요';
}

/** 질문 하나의 이름 — 머리(질문 이름)가 있으면 그것, 없으면 질문 글의 마지막 줄. */
function itemTitle(it: StopNoteItem): string {
  const lines = it.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const q = lines.length ? lines[lines.length - 1] : '';
  return q || it.header || '질문';
}

/**
 * 답 문장 — 다시 띄운 AI 에게 보낼 프롬프트(«앞서 물은 ‹질문›에 대한 답: ‹선택›»). 고른 답이 하나도 없으면 빈 문자열.
 *  @param picks 질문마다 고른 선택지 이름들(여러 개 고르기면 여럿) · 직접 쓴 답(free)
 */
export function stopAnswerPrompt(q: StopNoteQuestion, picks: Array<{ labels: string[]; free?: string }>): string {
  const parts: string[] = [];
  q.items.forEach((it, i) => {
    const p = picks[i];
    if (!p) return;
    const ans = [...p.labels.map((l) => l.trim()).filter(Boolean), ...(p.free && p.free.trim() ? [p.free.trim()] : [])];
    if (!ans.length) return;
    if (q.kind === 'permission') {
      const what = q.target ? `‹${q.target}›` : `‹${itemTitle(it)}›`;
      parts.push(`앞서 실행 허락을 물은 ${what}에 대한 답: ‹${ans.join(', ')}›`);
    } else {
      parts.push(`앞서 물은 ‹${itemTitle(it)}›에 대한 답: ‹${ans.join(', ')}›`);
    }
  });
  if (!parts.length) return '';
  //  AI 는 그 질문을 기억하지 못한다(대화 파일에 없다) — 무엇을 이어 하라는 것인지 한 줄을 덧붙인다.
  return [...parts, '(이 세션은 질문에 답을 기다리다 꺼졌다가 다시 열렸어요. 위 답을 반영해 하던 일을 이어서 해 주세요.)'].join('\n');
}

/**
 * 질문 카드가 떠 있을 때 입력칸에 **직접 쓴** 답 — 그 질문(들)을 붙여 보낸다. AI 는 그 질문을 기억하지 못한다(대화 파일에 없다).
 *  질문이 하나면 그 질문의 답으로, 여럿이면 질문들을 나열하고 한 답으로 붙인다.
 */
export function stopFreeAnswerPrompt(q: StopNoteQuestion, text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (q.items.length === 1) return stopAnswerPrompt(q, [{ labels: [], free: t }]);
  const names = q.items.map((it) => `‹${itemTitle(it)}›`).join(' · ');
  return [`앞서 물은 질문(${names})에 대한 답: ‹${t}›`, '(이 세션은 질문에 답을 기다리다 꺼졌다가 다시 열렸어요. 위 답을 반영해 하던 일을 이어서 해 주세요.)'].join('\n');
}

// ── 입력칸의 쓰던 글 — 세션별로 기억한다(하네스 상태 무관, #4695 T5 ⑤) ───────────────────────────────────────
//  종전엔 전달에 실패한 글만 같은 창 메모리(web/v2/quick-session.ts)에 있어, 다른 세션에 다녀오면 쓰던 글이 사라졌다.
//  브라우저 저장소(이 사람·이 기계)에 둔다 — 못 쓰는 환경(사생활 보호 창 등)이면 조용히 종전대로 동작한다.
const COMPOSE_PREFIX = 'lv-compose:';
const NOTE_SEEN_PREFIX = 'lv-stopnote-seen:';
/** 너무 오래된 쓰던 글은 버린다 — 그 세션을 몇 주 뒤에 열었을 때 낡은 글이 튀어나오지 않게. */
export const COMPOSE_KEEP_MS = 14 * 24 * 60 * 60_000;
/** 쓰던 글 상한(저장소 한도를 한 세션이 다 쓰지 않게). */
export const COMPOSE_MAX_CHARS = 20_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (s?: Store | null): Store | null => {
  if (s) return s;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

export function loadComposeDraft(sessionId: string, now = Date.now(), s?: Store | null): string {
  const st = store(s);
  if (!st || !sessionId) return '';
  try {
    const raw = st.getItem(COMPOSE_PREFIX + sessionId);
    if (!raw) return '';
    const o = JSON.parse(raw) as { t?: unknown; at?: unknown };
    if (typeof o.t !== 'string' || typeof o.at !== 'number' || now - o.at > COMPOSE_KEEP_MS) { st.removeItem(COMPOSE_PREFIX + sessionId); return ''; }
    return o.t;
  } catch { return ''; }
}

export function saveComposeDraft(sessionId: string, text: string, now = Date.now(), s?: Store | null): void {
  const st = store(s);
  if (!st || !sessionId) return;
  try {
    if (!text.trim()) { st.removeItem(COMPOSE_PREFIX + sessionId); return; }
    st.setItem(COMPOSE_PREFIX + sessionId, JSON.stringify({ t: text.slice(0, COMPOSE_MAX_CHARS), at: now }));
  } catch { /* 저장소가 막혔다 — 종전대로 메모리에만 남는다 */ }
}

/** 이 쪽지의 쓰다 만 글을 이미 입력칸에 돌려 둔 적이 있나 — 사람이 지운 뒤 다시 채우지 않으려고(쪽지는 끈 시각으로 갈린다). */
export function stopDraftSeen(sessionId: string, at: number, s?: Store | null): boolean {
  const st = store(s);
  if (!st) return false;
  try { return st.getItem(NOTE_SEEN_PREFIX + sessionId) === String(at); } catch { return false; }
}
export function markStopDraftSeen(sessionId: string, at: number, s?: Store | null): void {
  const st = store(s);
  if (!st) return;
  try { st.setItem(NOTE_SEEN_PREFIX + sessionId, String(at)); } catch { /* 막혔다 — 다음에 한 번 더 채워질 뿐이다 */ }
}
