// session-actions.ts — AI 세션 **종료·목록제거 확인창의 단일 정의**(#1582).
//
// 왜 한 곳에 두나: 같은 동작(DELETE /api/ui/terminal/sessions/:id)이 네 화면에 흩어져 있었고, 화면마다
//  이름도 설명도 달랐다 — AI 세션 탭만 '종료' + 라이블리 모달 + "대화록은 남아요"(#1062)로 고쳐졌고,
//  대시보드 위젯·⋯메뉴·프로젝트 상세는 '삭제' + 브라우저 confirm + **"되돌릴 수 없어요"** 로 남아 있었다.
//  그 문구는 사실이 아니다(아래) — 그런데 가장 파괴적으로 읽히는 말이라, 사람들이 세션을 안 지우고
//  쌓아 두다가 박스 메모리를 잡아먹었다(상민님 신고). 어휘가 갈라지면 반드시 한쪽이 거짓말을 한다.
//
// ── 종료가 실제로 하는 일 (src/terminal/sessions.ts killSession) ──
//  ① tmux kill-session → 그 세션에서 돌던 작업이 즉시 중단된다(여기까지가 되돌릴 수 없는 부분)
//  ② org_session_state(desired-state) 행 삭제 → '복원 가능' 카드가 사라져 [복원] 경로가 끊긴다
//  파일은 **한 줄도 건드리지 않는다** — 작업 폴더·워크트리·커밋·로컬 대화록(~/.claude/…/<uuid>.jsonl) 전부 그대로다.
//  게다가 조직이 세션 공유를 켜 두었으면 대화록이 중앙에도 남아, 「📜 세션 기록」에서 다시 보고
//  「💬 이어 질문하기」(claude --resume)로 그 대화를 이어받을 수 있다.
//
// ⚠ 그래서 어느 쪽으로도 **단언하면 틀린다**: "되돌릴 수 없다"도 거짓이고, "대화록은 항상 남는다"도
//  조직이 세션 공유를 안 켰거나 그 하네스가 캡처 대상이 아니면(claude 만 지원) 거짓이다. 확인창을 그리기
//  직전에 서버에 정책을 물어(sessionLogPolicy) 그 조직·그 세션에서 참인 문장만 쓴다.
import { api, el } from './core.js';
// ⚠ confirmDialog 는 **정의처(ui-primitives)에서 직접** 가져온다 — admin.ts 배럴을 거치면 이 leaf 가
//  페이지 모듈을 역방향으로 끌어와 순환이 된다(admin-collector-presets.ts 와 같은 이유).
import { confirmDialog } from './ui-primitives.js';

// ── 세션 로그 정책(서버 = 단일 진실) ──
export interface SessionLogPolicy { enabled: boolean; harnesses: string[]; retentionDays: number }
// 조회는 세션당 한 번이면 충분하고(조직 설정이라 화면 도중 바뀌지 않는다) 확인창을 여는 순간에만 필요하다.
//  그래서 미리 받아두지 않고 lazy + 프로세스 캐시. 실패하면 null 을 캐시하지 않는다(다음 확인창에서 재시도).
let policyCache: SessionLogPolicy | null = null;
export async function sessionLogPolicy(): Promise<SessionLogPolicy | null> {
  if (policyCache) return policyCache;
  try {
    const d = await api('/api/ui/terminal/session-log-policy');
    const p: SessionLogPolicy = {
      enabled: !!(d && d.enabled),
      harnesses: Array.isArray(d && d.harnesses) ? d.harnesses.map((h) => String(h)) : [],
      retentionDays: Number(d && d.retentionDays) || 0,
    };
    policyCache = p;
    return p;
  } catch { return null; }   // 게이트웨이가 구버전이거나 네트워크가 죽었을 때 — 확인창은 '항상 참인' 문구로 폴백
}

// 대상 세션들의 하네스 집합. 목록이 비면(호출부가 안 넘겼으면) 판정을 못 하므로 보수 문구로 간다.
const harnessesOf = (sessions?: Array<{ harness?: string }>): string[] =>
  [...new Set((sessions || []).map((s) => String((s && s.harness) || '')).filter(Boolean))];

// 이 종료로 **중앙 세션 기록에 남는가** — 'all'(전부 남음) · 'none'(하나도 안 남음) · 'some'(섞임) · 'unknown'(판정 불가).
//  unknown = 정책을 못 받았거나 하네스를 모르는 경우 → 있지도 않은 안전을 약속하지 않는다.
type LogFate = 'all' | 'none' | 'some' | 'unknown';
function logFate(policy: SessionLogPolicy | null, harnesses: string[]): LogFate {
  if (!policy) return 'unknown';
  if (!policy.enabled) return 'none';          // 조직이 세션 공유를 안 켰다 = 중앙에 아무것도 안 올라간다
  if (!harnesses.length) return 'unknown';
  const kept = harnesses.filter((h) => policy.harnesses.includes(h)).length;
  return kept === harnesses.length ? 'all' : kept ? 'some' : 'none';
}

// 확인창 하단 안내문 — **그 조직·그 세션에서 참인 문장만**.
//  어느 경우에도 공통으로 참인 사실이 하나 있다: 종료는 파일을 건드리지 않는다. 그걸 먼저 말하고,
//  대화록이 중앙에 남는지는 판정 결과에 따라 덧붙인다.
function keepNote(fate: LogFate, policy: SessionLogPolicy | null): string {
  const keep = '작업 폴더와 파일은 그대로 남습니다.';
  const days = policy && policy.retentionDays > 0 ? ` (기록 ${policy.retentionDays}일 보관)` : '';
  // ⚠ 이모지는 칩(「」) **밖에** 둔다 — 칩 라벨에 공백이 있으면 nowrap 이 안 걸려(uiKeyCls) 좁은 확인창에서
  //  '📜' 와 '세션 기록' 이 서로 다른 줄로 갈라진다(실측). 이모지를 앞에 빼면 갈라져도 문장이 안 깨진다.
  if (fate === 'all') return `${keep} 대화 기록도 지워지지 않아요 — 📜 「세션 기록」에 남고, 거기서 💬 「이어 질문하기」로 이어받을 수 있어요.${days}`;
  if (fate === 'some') return `${keep} 대화 기록은 claude 세션만 📜 「세션 기록」에 남아 💬 「이어 질문하기」로 이어받을 수 있어요 — 나머지는 이 박스 안에만 남습니다.${days}`;
  if (fate === 'none') return `${keep} 대화 기록도 이 종료로는 지워지지 않지만, 📜 「세션 기록」에는 안 올라가 웹에서 다시 열 수는 없어요.`;
  return `${keep} 대화 기록도 이 종료로는 지워지지 않아요.`;   // unknown — 확인된 사실만
}

// ── 종료 확인(라이브 세션) — 카드 단건·일괄·⋯메뉴·프로젝트 상세가 **모두 이걸 쓴다**. ──
//  sessions 를 넘기면 하네스로 안내문을 정확히 고르고, 안 넘기면 '항상 참인' 보수 문구가 된다.
export async function confirmSessionEnd(opts: {
  title: string; lines?: string[]; sessions?: Array<{ harness?: string }>;
}): Promise<boolean> {
  const policy = await sessionLogPolicy();
  const fate = logFate(policy, harnessesOf(opts.sessions));
  return confirmDialog({
    title: opts.title, danger: true, confirmText: '종료', cancelText: '취소',
    message: '실행 중인 작업이 있으면 함께 중단됩니다.',
    lines: opts.lines || [],
    note: keepNote(fate, policy),
    // 기록이 실제로 남는 경우에만 증거를 건넨다 — 안 남는데 링크를 주면 빈 목록이 약속을 배신한다.
    extra: fate === 'all' || fate === 'some' ? sessionLogLink() : null,
  });
}

// ── 목록에서 지우기(restorable 세션) ── tmux 는 이미 죽었으니 끊을 작업이 없다. 지워지는 건 desired-state
//  (그 세션의 폴더·설정·초대를 기억해 둔 카드)뿐이라, '종료'와는 잃는 것이 다르다 → 문구·버튼을 따로 둔다.
export async function confirmSessionForget(opts: {
  title: string; lines?: string[]; sessions?: Array<{ harness?: string }>;
}): Promise<boolean> {
  const policy = await sessionLogPolicy();
  const fate = logFate(policy, harnessesOf(opts.sessions));
  return confirmDialog({
    title: opts.title, danger: true, confirmText: '지우기', cancelText: '취소',
    message: '이 세션 카드가 목록에서 사라지고, [복원]으로는 다시 열 수 없어요.',
    lines: opts.lines || [],
    note: keepNote(fate, policy),
    extra: fate === 'all' || fate === 'some' ? sessionLogLink() : null,
  });
}

// 목적격 조사 — 「자기소개」을(를) 같은 기계 표기를 없앤다. 끝글자가 한글이면 받침으로 을/를, 아니면(숫자·영문·기호) 종전 표기.
export function eulReul(name: string): string {
  const c = (name || '').trim().slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? '을' : '를';
  return '을(를)';
}

// ── 휴지통(#1851) — 지난 세션의 다음 단계. 잃는 것이 **없다**(표식 하나가 붙어 목록에서 빠질 뿐) → 위험 색 없이, 되돌릴 수 있다고 말한다. ──
//  원준 2026-08-23: "휴지통으로 보낸다는 내용이 떠야" — 종전 '지울까요?'(완전 삭제) 창과 반드시 달라야 한다.
//  원준 2026-08-24: "처음에는 팝업을 띄우되 [다시 보지 않기]를 체크하면 다음부턴 버튼만 눌러 바로 보내게" — 잃는 것이 없는
//  동작이라 매번 묻는 게 마찰이다. 체크는 **[휴지통으로]를 눌러 확정했을 때만** 기억한다(취소하면 안 남는다 — 웹터미널
//  첫 진입 안내의 '다시 보지 않기'와 같은 규칙). 되돌리는 문은 휴지통 화면 머리의 [다시 묻기](bins.ts).
const TRASH_SKIP_KEY = 'lively.v2.trash.skipConfirm';   // '1' = 묻지 않고 바로 휴지통으로. 브라우저 로컬(기기별).
export function trashConfirmSkipped(): boolean {
  try { return localStorage.getItem(TRASH_SKIP_KEY) === '1'; } catch (_) { return false; }   // 스토리지 차단 — 그냥 묻는다
}
export function setTrashConfirmSkipped(on: boolean): void {
  try { if (on) localStorage.setItem(TRASH_SKIP_KEY, '1'); else localStorage.removeItem(TRASH_SKIP_KEY); } catch (_) { /* noop */ }
}
//  원준 2026-08-24 "가독성 너무 안 좋고 딸깍 한 팝업 같다": 종전엔 같은 말(잃는 게 없다·되돌릴 수 있다)을 네 줄로 되풀이하고
//  회색 상자 두 개(note·체크행)가 쌓여 입력창처럼 보였다. #1582 규약대로 **잃는 것만** 말한다 — 여기선 없으니 한 문장이면 된다.
//  구조: 제목(무엇을) → 본문 1문장(무슨 일이 일어나나) → 보조 1줄(되돌리는 길·완전 삭제 자리) → 선택 1줄(묻지 않기) → 버튼.
export async function confirmSessionTrash(opts: { title: string; n?: number }): Promise<boolean> {
  if (trashConfirmSkipped()) return true;
  const n = opts.n || 1;
  const skip = el('input', { type: 'checkbox', id: 'sess-trash-skip' }) as HTMLInputElement;
  const ok = await confirmDialog({
    title: opts.title, confirmText: '휴지통으로', cancelText: '취소',
    message: (n > 1 ? `세션 ${n}개가 ` : '') + '목록에서 빠지고 휴지통으로 갑니다. 대화와 설정은 그대로 남아요.',
    lines: ['휴지통에서 [되돌리기]를 누르면 지난 세션으로 돌아옵니다. 완전히 지우는 건 휴지통에서만 할 수 있어요.'],
    extra: el('label', { class: 'ov-confirm-opt', for: 'sess-trash-skip' }, skip,
      el('span', { class: 'n', text: '다음부터 묻지 않고 바로 보내기' }),
      el('span', { class: 'h', text: '휴지통 화면에서 되돌릴 수 있어요' })),
  });
  if (ok && skip.checked) setTrashConfirmSkipped(true);
  return ok;
}

// ── 완전 삭제(휴지통 안에서만, #1851) — 두 창. 어느 쪽도 keepNote(종료·지우기용)를 쓰지 않는다: 그 문구는 "대화 기록은 안 지워진다"가
//  핵심 약속인데, 여기선 **지운다**(중앙 기록이 있으면 #1850 파기까지 함께 간다). 사실과 반대인 안심 문구가 제일 나쁘다(#1582 규약).
//  · confirmSessionPurgeLocal — 중앙 기록이 **없는** 세션 하나(되살리기 좌표만 있는 것). 잃는 것 = 되살리기.
//  · confirmSessionPurgeMany — 휴지통 비우기·여러 개 선택. 발자국을 모아 한 창에서 고른다(단일 창과 같은 모양·규칙).
export async function confirmSessionPurgeLocal(opts: { title: string }): Promise<boolean> {
  return confirmDialog({
    title: opts.title, danger: true, confirmText: '완전 삭제', cancelText: '취소',
    message: '이 세션이 목록에서 영영 사라지고, [되살리기]로는 다시 열 수 없어요.',
    note: '작업 폴더·파일·커밋은 그대로 남습니다. 이 세션은 중앙 대화 기록이 없어 지울 기록도 없어요.',
  });
}

/** 휴지통 조작 한 곳(#1851) — POST /api/ui/terminal/session-trash. ids 는 그 세션의 모든 이름(박스 id + 대화 uuid)을 넘긴다
 *  (서버도 desired-state 의 uuid 를 덧붙이지만, 기록만 남은 세션은 프론트가 아는 uuid 가 전부다). */
export async function sessionTrashOp(op: 'trash' | 'untrash' | 'purge' | 'empty', ids: string[] = []): Promise<{ done: string[]; skipped: Array<{ id: string; why: string }> }> {
  const r = await api('/api/ui/terminal/session-trash', { method: 'POST', body: JSON.stringify({ op, ids }) });
  return { done: Array.isArray(r && r.done) ? r.done : [], skipped: Array.isArray(r && r.skipped) ? r.skipped : [] };
}
/** 세션의 모든 이름 — 휴지통 표식은 두 이름에 다 붙어야 한다(views.ts mergeSessions 가 둘을 한 장으로 접는다). */
export const sessionNames = (s: { id: string; logId?: string | null }): string[] => [s.id, ...(s.logId ? [s.logId] : [])];

// ── 프로젝트 아카이브(#1851) — 삭제가 아니라 '평소 화면에서 치우기'. 도는 세션이 있으면 멈춘다는 사실만 위험으로 말한다. ──
export async function confirmProjectArchive(opts: { name: string; liveN: number }): Promise<boolean> {
  return confirmDialog({
    title: `「${opts.name}」${eulReul(opts.name)} 아카이브로 보낼까요?`, danger: opts.liveN > 0, confirmText: '아카이브로', cancelText: '취소',
    message: opts.liveN > 0
      ? `지금 돌고 있는 세션 ${opts.liveN}개는 그 자리에서 멈추고 지난 세션이 됩니다.`
      : '이 프로젝트와 그 아래 세션이 사이드바·보드에서 빠집니다.',
    lines: [
      '태스크·팀원·지식 연결·세션 기록은 전부 그대로예요.',
      '[아카이브] 화면에서 언제든 보관을 해제하면 원래 자리로 돌아옵니다.',
    ],
    note: '지우는 것이 아닙니다 — 되돌릴 수 있어요.',
  });
}

// ── 보관(reclaim=1) ── tmux 만 내리고 desired-state 는 남긴다. 잃는 것은 **돌던 실행뿐**이고,
//  설정·대화 좌표가 DB 에 남아 [되살리기](POST …/restore)가 --resume 으로 그 대화를 이어 붙인다.
//  그래서 이 약속만은 조직의 세션공유 설정과 무관하게 참이다(중앙 기록이 아니라 desired-state + 로컬 대화록에 기댄다).
export async function confirmSessionArchive(opts: { title: string; working: boolean }): Promise<boolean> {
  return confirmDialog({
    title: opts.title, danger: opts.working, confirmText: '보관', cancelText: '취소',
    message: opts.working ? '지금 돌고 있는 작업은 그 자리에서 멈춥니다.' : '돌고 있는 터미널을 내려놓습니다.',
    lines: [
      '세션이 사라지는 게 아니에요 — 설정과 대화는 그대로 남습니다.',
      '[보관한 세션]에서 [되살리기]를 누르면 그 대화를 이어서 다시 엽니다.',
    ],
  });
}

// 종료·제거 뒤 토스트 — '어디서 다시 볼 수 있는지'를 결과 메시지에서도 한 번 더 말한다(확인창을 읽지 않고
//  누른 사람에게 남는 유일한 안내라서). 중앙에 안 남는 경우엔 그 약속을 하지 않는다.
export async function endedToast(n: number, sessions?: Array<{ harness?: string }>): Promise<string> {
  const policy = await sessionLogPolicy();
  const head = n === 1 ? '세션을 종료했어요' : `${n}개 세션을 종료했어요`;
  return logFate(policy, harnessesOf(sessions)) === 'all' ? `${head} — 대화록은 📜 세션 기록에 남아 있어요` : head;
}

// 「📜 세션 기록」으로 가는 링크 — 확인창에서 '정말 남나?'를 그 자리에서 확인하고 싶은 사람을 위해
//  새 탭으로 연다(현재 확인창·작업 흐름을 끊지 않는다). 세션 기록 화면이 곧 그 약속의 증거다.
export function sessionLogLink(text?: string): HTMLElement {
  return el('a', {
    class: 'btn-text', target: '_blank', rel: 'noopener',
    href: location.pathname + '#/sessions', text: text || '📜 세션 기록 열어보기 →',
  }) as HTMLElement;
}

// ── 세션 기록 **완전 삭제**(#1850) ── 위 두 확인창과 잃는 것이 근본적으로 다르다.
//  · '종료'·'지우기' 는 **대화록을 건드리지 않는다**(그게 위 문구들의 핵심 약속이다).
//  · 이건 그 대화록 자체를 지운다 — 그래서 위 keepNote 를 재사용하면 정반대를 말하게 된다. 문구를 따로 짠다.
//
//  ── P2: 범위를 사람이 고른다 ──
//  종전엔 "이 세션이 만든 지식·프로젝트는 그대로 남아요 — 필요하면 각각 따로 지우세요"라고 **숙제를 떠넘겼다**.
//  원준 지적(2026-08-23): *"무슨 필요하면 각각 따로 지우라고 하냐... 지워지는 범위를 사용자가 체크해서 고르고
//  그거까지 제대로 삭제가 되는 기능이 필요함."* 그래서 확인창이 먼저 **이 세션이 남긴 것**을 조회해 보여주고,
//  고른 것만 함께 정리한다. 기본값은 **대화 기록만** — 무턱대고 지식·프로젝트를 지우지 않는다.
//  고친 지식은 지우지 않고 **세션 직전 판으로 되돌린다**(세션 전에도 있던 남의 것이므로).
export interface Footprint {
  tmux_session_id: string | null;
  knowledge_created: Array<{ name: string; title: string | null; touched_after?: boolean }>;
  knowledge_edited: Array<{ name: string; title: string | null; touched_after?: boolean }>;
  projects: Array<{ id: number; name: string; created_here: boolean; touched_after?: boolean; other_sessions?: number }>;
  sources: Array<{ id: number; title: string | null; kind: string | null }>;
  activities: number;
}
export interface PurgeChoice { log: boolean; knowledge: string[]; revert: string[]; projects: number[]; sources: number[]; activities: boolean }

async function fetchFootprint(sid: string, node: string): Promise<Footprint | null> {
  try {
    const d: any = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/footprint?node=${encodeURIComponent(node || '')}`);
    return {
      tmux_session_id: d?.tmux_session_id ?? null,
      knowledge_created: Array.isArray(d?.knowledge_created) ? d.knowledge_created : [],
      knowledge_edited: Array.isArray(d?.knowledge_edited) ? d.knowledge_edited : [],
      projects: Array.isArray(d?.projects) ? d.projects : [],
      sources: Array.isArray(d?.sources) ? d.sources : [],
      activities: Number(d?.activities) || 0,
    };
  } catch { return null; }   // 못 읽으면 대화 기록만 지우는 종전 흐름으로(있지도 않은 목록을 지어내지 않는다)
}

// 체크 한 줄 — 라벨 + (있으면) 그 안에 무엇이 들었는지 이름까지. 목록 없이 개수만 보이면 무엇을 지우는지 모른다.
function checkRow(id: string, label: string, names: string[], hint?: string): { el: HTMLElement; box: HTMLInputElement } {
  const box = el('input', { type: 'checkbox', id }) as HTMLInputElement;
  const kids: any[] = [el('span', { class: 'n', text: label })];
  if (hint) kids.push(el('span', { class: 'h', text: hint }));
  // ⚠ 제목을 그대로 이어 붙이면 안 된다 — 우리 지식 제목은 200자짜리도 있어서(실측) 확인창이 글자 벽이 된다.
  //  무엇이 사라지는지 알아볼 만큼만 보이면 된다: 한 줄에 하나씩, 42자에서 자른다.
  for (const n of names.slice(0, 5)) kids.push(el('span', { class: 'l', text: '· ' + (n.length > 42 ? n.slice(0, 42) + '…' : n) }));
  if (names.length > 5) kids.push(el('span', { class: 'l', text: `· 외 ${names.length - 5}건` }));
  return { el: el('label', { class: 'sess-purge-row', for: id }, box, el('span', { class: 'b' }, ...kids)), box };
}

// ── 결과물까지 함께 (원준 결정 2026-08-24) ──
//  "보관할 거면 아카이브로 보낼 거다. 휴지통으로 보내고 지우는 건 이 세션이 맘에 안 들 때니까 결과도 되돌려야 한다."
//  → 완전 삭제 창은 이 세션이 남긴 것(만든 지식·고친 지식·만든 프로젝트·자료·작업 기록)을 **기본 체크**로 보여 주고,
//    사람이 풀어서 남긴다. 규칙 B: **그 뒤에 남이 손댄 것은 고를 수 없다** — "남는 것"으로 이유와 함께 보여 준다.
//  세션 하나를 버리며 남의 작업을 날릴 수는 없다(서버도 같은 판정으로 한 번 더 거른다).
type FpItem = { key: string; label: string; sub?: string };
type FpGroup = { kind: 'kc' | 'ke' | 'pj' | 'src' | 'ac'; title: string; hint?: string; items: FpItem[]; count: number };
type FpKeep = { label: string; why: string };

// 발자국을 '고를 수 있는 묶음'과 '남는 것'으로 가른다 — 단일·일괄 확인창이 같은 판정을 쓴다.
function splitFootprint(fps: Footprint[]): { groups: FpGroup[]; keep: FpKeep[] } {
  const kc: FpItem[] = [], ke: FpItem[] = [], pj: FpItem[] = [], src: FpItem[] = [];
  const keep: FpKeep[] = [];
  let acts = 0;
  const seen = new Set<string>();
  for (const fp of fps) {
    for (const k of fp.knowledge_created) {
      const key = 'k:' + k.name; if (seen.has(key)) continue; seen.add(key);
      if (k.touched_after) keep.push({ label: k.title || k.name, why: '이 세션이 끝난 뒤에 수정된 문서라 남겨요' });
      else kc.push({ key: k.name, label: k.title || k.name });
    }
    for (const k of fp.knowledge_edited) {
      const key = 'k:' + k.name; if (seen.has(key)) continue; seen.add(key);
      if (k.touched_after) keep.push({ label: k.title || k.name, why: '이 세션이 끝난 뒤에 또 수정된 문서라 되돌리지 않아요' });
      else ke.push({ key: k.name, label: k.title || k.name });
    }
    for (const p of fp.projects) {
      const key = 'p:' + p.id; if (seen.has(key)) continue; seen.add(key);
      if (!p.created_here) continue;                       // 이 세션이 만들지 않은 프로젝트는 애초에 대상이 아니다(붙어만 있던 것)
      if (p.other_sessions) keep.push({ label: `#${p.id} ${p.name}`, why: `다른 세션 ${p.other_sessions}개가 붙어 있는 프로젝트라 남겨요` });
      else if (p.touched_after) keep.push({ label: `#${p.id} ${p.name}`, why: '이 세션이 끝난 뒤에 수정된 프로젝트라 남겨요' });
      else pj.push({ key: String(p.id), label: `#${p.id} ${p.name}` });
    }
    for (const x of fp.sources) {
      const key = 's:' + x.id; if (seen.has(key)) continue; seen.add(key);
      src.push({ key: String(x.id), label: x.title || `자료 #${x.id}` });
    }
    acts += fp.activities || 0;
  }
  const groups: FpGroup[] = [];
  if (kc.length) groups.push({ kind: 'kc', title: `만든 지식 ${kc.length}건 지우기`, items: kc, count: kc.length });
  if (ke.length) groups.push({ kind: 'ke', title: `고친 지식 ${ke.length}건 이 세션 전 내용으로 되돌리기`, items: ke, count: ke.length });
  if (pj.length) groups.push({ kind: 'pj', title: `만든 프로젝트 ${pj.length}건 지우기`, hint: '그 안의 작업·첨부·폴더도 함께', items: pj, count: pj.length });
  // 자료는 세션이 '만든' 것이 아니다 — 올렸거나 수집된 원본이 이 세션의 지식에 붙어 있는 것이다(원준 지적). 붙어 있는 관계로 말한다.
  if (src.length) groups.push({ kind: 'src', title: `원본 자료 ${src.length}건 지우기`, hint: '위에서 지우는 지식에만 붙어 있는 자료예요', items: src, count: src.length });
  if (acts) groups.push({ kind: 'ac', title: `작업 기록 ${acts}건 지우기`, items: [], count: acts });
  return { groups, keep };
}

// 확인창 한 판 — 단일·일괄이 같은 모양. 돌려주는 것은 kind 별 on/off (이름 목록은 호출자가 fp 로 다시 푼다).
async function purgeDialog(opts: {
  title: string; message: string; lines?: string[]; groups: FpGroup[]; keep: FpKeep[]; noFootprint?: boolean; kept: string[];
}): Promise<Set<string> | null> {
  const boxes: { kind: string; box: HTMLInputElement }[] = [];
  const rows: HTMLElement[] = [];
  if (opts.groups.length) {
    rows.push(el('p', { class: 'sess-purge-h' },
      el('span', { text: '함께 지울 것' }),
      el('span', { class: 'sub', text: '풀면 그것만 남겨요' })));
    for (const g of opts.groups) {
      const r = checkRow('pg-' + g.kind, g.title, g.items.map((i) => i.label), g.hint);
      r.box.checked = true;                                 // 기본 체크(원준 결정 ②) — "버린다 = 결과도 버린다"
      rows.push(r.el); boxes.push({ kind: g.kind, box: r.box });
    }
    // 한 번에 전부 풀기 — 체크를 하나씩 풀지 않아도 "세션만 지우기"로 갈 수 있게.
    const only = el('button', { class: 'btn-text sess-purge-only', type: 'button', text: '결과물은 남기고 대화 기록만 지우기' });
    only.addEventListener('click', () => { for (const b of boxes) { b.box.checked = false; b.box.dispatchEvent(new Event('change')); } });
    rows.push(only);
  } else if (opts.noFootprint) {
    // 다리(대화 uuid ↔ tmux 세션)가 없으면 작업 기록을 **찾을 수 없다**. 없다고 단언하지 않는다.
    rows.push(el('p', { class: 'sess-purge-h' },
      el('span', { text: '이 세션이 만든 지식·프로젝트·작업 기록은 찾지 못했어요' }),
      el('span', { class: 'sub', text: '있더라도 이 삭제로는 지워지지 않고 그대로 남습니다' })));
  }
  // 「남는 것」은 **선택을 따라 움직인다**(원준 2026-08-24: "내가 위에서 선택하는 것에 따라 동적으로 바뀌어야").
  //  고를 수 없는 것(남이 손댄 것)에 더해, 체크를 푼 묶음의 항목이 그 이유("체크를 풀어서")와 함께 여기로 내려온다.
  //  확인 직전에 "결국 무엇이 남나"를 한 자리에서 읽게 — 체크 상태를 머릿속에서 합산시키지 않는다.
  const keepBox = el('div', { class: 'sess-purge-keepbox' });
  const paintKeep = () => {
    const list: FpKeep[] = [...opts.keep];
    for (const g of opts.groups) {
      const b = boxes.find((x) => x.kind === g.kind);
      if (!b || b.box.checked) continue;
      if (g.items.length) for (const it of g.items) list.push({ label: it.label, why: g.kind === 'ke' ? '체크를 풀어서 이 세션이 고친 내용 그대로 남겨요' : '체크를 풀어서 남겨요' });
      else list.push({ label: g.title.replace(/ 지우기$/, ''), why: '체크를 풀어서 남겨요' });
    }
    keepBox.replaceChildren();
    if (!list.length) return;
    keepBox.append(el('p', { class: 'sess-purge-h' }, el('span', { text: `남는 것 · ${list.length}` })));
    for (const k of list.slice(0, 8)) keepBox.append(el('p', { class: 'sess-purge-keep' }, el('span', { class: 'n', text: k.label }), el('span', { class: 'w', text: k.why })));
    if (list.length > 8) keepBox.append(el('p', { class: 'sess-purge-keep' }, el('span', { class: 'w', text: `외 ${list.length - 8}건` })));
  };
  for (const b of boxes) b.box.addEventListener('change', paintKeep);
  rows.push(keepBox);
  paintKeep();
  const ok = await confirmDialog({
    title: opts.title, danger: true, confirmText: '완전 삭제', cancelText: '취소',
    message: opts.message,
    lines: [...(opts.lines || []), ...opts.kept],
    extra: rows.length ? el('div', { class: 'sess-purge' }, ...rows) : null,
  });
  if (!ok) return null;
  return new Set(boxes.filter((b) => b.box.checked).map((b) => b.kind));
}

// fp + kind 선택 → 이 세션의 실제 이름 목록(서버는 어차피 발자국 밖 이름을 거른다).
function choiceOf(fp: Footprint | null, on: Set<string>): PurgeChoice {
  const kc = (fp?.knowledge_created ?? []).filter((k) => !k.touched_after);
  const ke = (fp?.knowledge_edited ?? []).filter((k) => !k.touched_after);
  const pj = (fp?.projects ?? []).filter((p) => p.created_here && !p.touched_after && !p.other_sessions);
  return {
    log: true,
    knowledge: on.has('kc') ? kc.map((k) => k.name) : [],
    revert: on.has('ke') ? ke.map((k) => k.name) : [],
    projects: on.has('pj') ? pj.map((p) => p.id) : [],
    sources: on.has('src') ? (fp?.sources ?? []).map((x) => x.id) : [],
    activities: on.has('ac'),
  };
}

function keptLines(opts: { remoteNode?: string | null; live?: boolean }): string[] {
  const kept = ['작업 폴더의 파일·커밋은 그대로 남아요.'];
  if (opts.remoteNode) kept.push(`대화 파일이 다른 컴퓨터(${opts.remoteNode})에도 있다면 그건 여기서 지울 수 없어요.`);
  // 아직 도는 세션을 지우면 **이후 대화도 중앙에 안 올라간다**(재수집을 막는 장치라 그 세션 전체가 대상에서 빠진다).
  if (opts.live) kept.push('이 세션은 계속 쓸 수 있지만, 앞으로의 대화도 중앙 기록에 남지 않아요.');
  return kept;
}

export async function confirmSessionPurge(opts: {
  sid: string; node?: string | null; title: string; lines?: string[]; remoteNode?: string | null; live?: boolean;
}): Promise<PurgeChoice | null> {
  const fp = await fetchFootprint(opts.sid, opts.node || '');
  const { groups, keep } = splitFootprint(fp ? [fp] : []);
  const on = await purgeDialog({
    title: opts.title,
    message: '대화 기록이 영구히 지워지고, 되돌릴 수 없어요.',
    lines: opts.lines, groups, keep, noFootprint: !!fp && !fp.tmux_session_id, kept: keptLines(opts),
  });
  return on ? choiceOf(fp, on) : null;
}

// 일괄(비우기·여러 개 선택) — 발자국을 전부 모아 **한 창**에서 고른다. 결과는 세션별 선택으로 풀어 돌려준다.
export async function confirmSessionPurgeMany(opts: {
  sessions: Array<{ sid: string | null; node: string; label: string }>; title: string;
}): Promise<Map<string, PurgeChoice> | null> {
  const fps = new Map<string, Footprint | null>();
  await Promise.all(opts.sessions.filter((s) => s.sid).map(async (s) => { fps.set(s.sid!, await fetchFootprint(s.sid!, s.node)); }));
  const withLog = opts.sessions.filter((s) => s.sid).length;
  const { groups, keep } = splitFootprint([...fps.values()].filter((x): x is Footprint => !!x));
  const on = await purgeDialog({
    title: opts.title,
    message: `세션 ${opts.sessions.length}개가 영영 사라지고, 되돌릴 수 없어요.`,
    lines: withLog ? [`그중 ${withLog}개는 중앙 대화 기록도 함께 지워져요.`] : [],
    groups, keep, kept: ['작업 폴더의 파일·커밋은 그대로 남아요.'],
  });
  if (!on) return null;
  const out = new Map<string, PurgeChoice>();
  for (const s of opts.sessions) if (s.sid) out.set(s.sid, choiceOf(fps.get(s.sid) ?? null, on));
  return out;
}

// 완전 삭제 실행 — 서버가 실제로 지운 양을 돌려준다(화면은 그 값으로만 말한다, 추정 금지).
export interface PurgeResult {
  bytes: number; subagents: number; localFiles: number; localPending: string | null;
  knowledge_deleted: number; knowledge_reverted: number; knowledge_revert_failed: string[];
  projects_deleted: number; folders_deleted: number; sources_deleted: number; activities_deleted: number;
}
export async function purgeSessionRecord(sid: string, node: string, choice?: PurgeChoice | null): Promise<PurgeResult> {
  // ⚠ content-type 을 여기서 또 넣지 마라 — api() 가 'Content-Type' 을 넣는데 대소문자가 다른 키가 하나 더 있으면 fetch 가
  //  둘을 합쳐 `application/json, application/json` 으로 보내고, 서버 express.json 이 그걸 JSON 으로 안 읽어 **본문이 통째로
  //  빈다**(실측 2026-08-24: 완전 삭제 창의 선택이 서버에 한 번도 닿지 않았다 — knowledge_deleted 가 늘 0). api() 가 이제
  //  대소문자 무관하게 하나로 정리하지만, 호출처도 넣지 않는 게 맞다.
  const r: any = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/purge?node=${encodeURIComponent(node || '')}`, {
    method: 'POST', body: JSON.stringify(choice || { log: true }),
  });
  return {
    bytes: Number(r?.log?.bytes) || 0, subagents: Number(r?.log?.subagents) || 0,
    localFiles: Number(r?.localFiles) || 0, localPending: r?.localPending || null,
    knowledge_deleted: Number(r?.knowledge_deleted) || 0,
    folders_deleted: Number(r?.folders_deleted) || 0, sources_deleted: Number(r?.sources_deleted) || 0,
    knowledge_reverted: Number(r?.knowledge_reverted) || 0,
    knowledge_revert_failed: Array.isArray(r?.knowledge_revert_failed) ? r.knowledge_revert_failed : [],
    projects_deleted: Number(r?.projects_deleted) || 0,
    activities_deleted: Number(r?.activities_deleted) || 0,
  };
}

// 완전 삭제 뒤 토스트 — 실제로 일어난 일만. 못 한 것(되돌리기 실패·원격 파일)도 숨기지 않는다.
export function purgedToast(r: PurgeResult): string {
  const kb = r.bytes >= 1024 ? `${Math.round(r.bytes / 1024).toLocaleString()}KB` : `${r.bytes}B`;
  const parts = [`대화 기록을 완전히 지웠어요 (${kb}${r.subagents ? ` · 서브에이전트 ${r.subagents}개` : ''})`];
  if (r.knowledge_deleted) parts.push(`지식 ${r.knowledge_deleted}건 삭제`);
  if (r.knowledge_reverted) parts.push(`지식 ${r.knowledge_reverted}건 되돌림`);
  if (r.projects_deleted) parts.push(`프로젝트 ${r.projects_deleted}건 삭제` + (r.folders_deleted ? ` (폴더 ${r.folders_deleted}개 포함)` : ''));
  if (r.sources_deleted) parts.push(`자료 ${r.sources_deleted}건 삭제`);
  if (r.activities_deleted) parts.push(`작업 기록 ${r.activities_deleted}건 삭제`);
  if (r.localFiles) parts.push(`이 박스의 대화 파일 ${r.localFiles}개도 삭제`);
  if (r.knowledge_revert_failed.length) parts.push(`⚠ 되돌릴 판을 못 찾은 지식 ${r.knowledge_revert_failed.length}건은 그대로예요`);
  if (r.localPending) parts.push(`⚠ ${r.localPending} 컴퓨터의 파일은 그대로입니다`);
  return parts.join(' · ');
}
