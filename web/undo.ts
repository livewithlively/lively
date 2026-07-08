// #702 전역 실행취소 — Cmd/Ctrl+Z 로 '내가 웹에서 한 마지막 콘텐츠 변경'을 되돌린다(Shift+Z / Ctrl+Y = 다시 실행).
//  서버 content_undo(/api/ui/undo)가 감사 스냅샷(org_content_audit before/after)을 역적용 — 페이지·컴포넌트 무관하게
//  모든 감사되는 액션(상태·수정·삭제·링크…)이 한 키로 취소된다. 텍스트 입력(네이티브 undo)과 블록에디터(#657z 자체
//  스택)는 각자 소유 — 편집 대상 안에 포커스가 있으면 이 전역 핸들러는 비켜선다.
//  스택 시맨틱: 이 탭 세션이 undoneIds(이미 되돌린 감사 id)를 기억해 Z 연타가 점점 옛 작업으로 걸어가고,
//  새 작업을 하면 그게 최신이라 자연히 먼저 취소된다(에디터 관례와 동일). 새로고침 = 스택 리셋(서버가 남의 작업·
//  내 리버트 행을 거르므로 안전).
import { api, state, toast } from './core.js';

const undoneIds: number[] = [];   // 이 탭에서 이미 되돌린 원본 감사 id (서버 픽 제외 목록)
const redoIds: number[] = [];     // 다시 실행 후보(LIFO) — 마지막으로 되돌린 원본 감사 id
let busy = false;

// 텍스트 편집 소유자 안에 있으면 전역 undo 를 비켜선다 — 네이티브 입력 undo / 블록에디터 자체 스택(#657z) / xterm.
function inEditableOwner(t: any): boolean {
  const el = (t && t.nodeType === 1 ? t : document.activeElement) as HTMLElement | null;
  return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .be, .xterm'));
}

// 되돌림 반영 — 현재 라우트를 다시 렌더(데이터 재조회). 터미널 탭은 재렌더가 세션 화면을 끊으므로 제외.
function rerenderRoute() {
  const page = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard');
  if (page === 'terminal') return;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

async function doUndo() {
  try {
    const r = await api('/api/ui/undo', { method: 'POST', body: JSON.stringify({ skip: undoneIds.slice(-200) }) });
    if (r && r.undone) {
      undoneIds.push(r.undone.id);
      redoIds.push(r.undone.id);
      toast('↩︎ 실행 취소 — ' + r.undone.label);
      rerenderRoute();
    }
  } catch (e: any) {
    if (e.status === 404) toast('되돌릴 내 작업이 없습니다');
    else if (e.status !== 401) toast('실행 취소 실패 — ' + e.message, true);
  }
}

async function doRedo() {
  const id = redoIds[redoIds.length - 1];
  if (!id) { toast('다시 실행할 작업이 없습니다'); return; }
  try {
    const r = await api('/api/ui/undo', { method: 'POST', body: JSON.stringify({ reapply: id }) });
    redoIds.pop();
    const i = undoneIds.indexOf(id);
    if (i >= 0) undoneIds.splice(i, 1); // 다시 실행됐으니 이후 Z 가 이 작업을 다시 취소할 수 있게
    if (r && r.redone) { toast('↪︎ 다시 실행 — ' + r.redone.label); rerenderRoute(); }
  } catch (e: any) {
    if (e.status !== 401) toast('다시 실행 실패 — ' + e.message, true);
  }
}

export function installGlobalUndo() {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.altKey) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = (e.key || '').toLowerCase();
    const isUndo = k === 'z' && !e.shiftKey;
    const isRedo = (k === 'z' && e.shiftKey) || (e.ctrlKey && k === 'y');
    if (!isUndo && !isRedo) return;
    if (!state.me) return;               // 미로그인(게이트) — 관여하지 않음
    if (inEditableOwner(e.target)) return; // 텍스트/블록에디터가 소유 — 네이티브·자체 undo 에 양보
    e.preventDefault();
    if (busy) return;                    // 키 반복 연타 중 중복 호출 방지(직전 요청 완료 후 다음 Z)
    busy = true;
    (isRedo ? doRedo() : doUndo()).finally(() => { busy = false; });
  });
}
