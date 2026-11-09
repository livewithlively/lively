// v2/transfer.ts — **워크스페이스 간 옮기기** 창 (#5458, 2026-11-09 윤상민)
//
// 이 창에서 관리자는 지식을 파일로 내보내고, 다른 워크스페이스에서 만든 파일을 가져온다.
//  매니지드↔셀프호스팅 · 셀프호스팅↔셀프호스팅 · 매니지드↔매니지드 세 조합을 파일 하나로 모두 덮는다.
//
// 결정(상민님 2026-11-09):
//  · 내보낼 것은 **분류 단위**로 고르고, 분류를 펼쳐 문서를 하나씩 고를 수도 있다. 문서 이름 찾기도 둔다.
//  · 대상자를 제한한 지식은 받는 쪽에서 공개로 들어간다 — 내보낼 때 미리보기에서 그 사실을 알린다.
//  · 비밀번호는 걸지 말지 고른다. 비밀번호 칸은 사이트 비밀번호가 아니라 type=text + 가림(#1250 — 브라우저가 계정 비번으로 저장하지 않게).
//  · 내보내기·가져오기 모두 관리자만(서버가 막는다 — 이 창은 관리자에게만 입구를 그린다).
//
// 화면 규칙: 탭마다 primary 단추 하나(파일 받기 / 가져오기). 확인은 confirmDialog. 찾기 칸은 글자를 치는 동안
//  그 칸을 다시 그리지 않는다(#1883 — 결과 영역만 바꾼다).
import { api, apiUrl, currentWorkspace, el, secretInput, toast, TOKEN_KEY } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { icon } from './icons.js';

// ── 서버 모양 ────────────────────────────────────────────────────────────────
interface Cat { key: string; name: string | null; count: number; archived: number; restricted: number }
interface Doc { name: string; title: string | null; is_folder: boolean; restricted: boolean; archived: boolean; category: string; category_name: string | null }
interface Preview { knowledge: number; folders_added: number; categories: number; sources: number; restricted: number; body_bytes: number; missing: string[]; notes: string[] }
interface PlanItem { ref: string; title: string | null; category: string; is_folder: boolean; status: string; new_name: string; existing: string | null; action: string; actions: string[]; reason?: string; notes: string[] }
interface PlanCat { ref: string; name: string | null; count: number; suggestion: { action: 'map'; to: string; why: string } | { action: 'create'; key: string; name: string | null } }
interface Plan { origin: { name: string | null; gateway_url: string | null }; bundle_created_at: string; summary: Record<string, number>; knowledge: PlanItem[]; categories: PlanCat[]; sources: { count: number; existing: number; fresh: number }; problems: Array<{ path: string; reason: string }>; notes: string[] }
interface Batch { id: number; state: string; file_name: string | null; sealed: boolean; origin: { name: string | null }; created_at: string; applied_at: string | null; summary: Record<string, number> | null; error: string | null; result: { counts?: Record<string, number>; knowledge?: Array<{ ref: string; name: string | null; ok: boolean; action: string; error?: string; notes?: string[] }>; undo?: { deleted: number; restored: number; kept: Array<{ name: string; reason: string }> } } | null; plan?: Plan }

const UNSORTED_REF = '__none__';
const STATUS_LABEL: Record<string, string> = {
  new: '새 문서', name_taken: '이름이 겹침', reimport_update: '원본이 바뀜', reimport_unchanged: '바뀐 것 없음',
  reimport_local_changed: '여기서 고침', reimport_conflict: '양쪽 다 고침', reimport_deleted: '여기서 지움', invalid: '들일 수 없음',
};
const BATCH_LABEL: Record<string, string> = {
  planned: '미리보기', applying: '들이는 중', applied: '들임', partial: '일부만 들임', failed: '실패',
  undoing: '되돌리는 중', undone: '되돌림', expired: '만료',
};
/** 사람이 확인해야 하는 판정 — 이것들만 펼쳐 보이고 나머지는 접어 둔다. */
const NEEDS_REVIEW = new Set(['name_taken', 'reimport_conflict', 'reimport_local_changed', 'reimport_deleted', 'invalid']);

function actionLabel(a: string, it: PlanItem): string {
  switch (a) {
    case 'create': return it.status === 'reimport_deleted' ? `다시 만들기 (${it.new_name})` : '새로 만들기';
    case 'rename': return `새 이름으로 따로 (${it.new_name})`;
    case 'overwrite': return `덮어쓰기 (${it.existing ?? it.ref})`;
    case 'update': return `갱신 (${it.existing ?? it.ref})`;
    default: return '건너뛰기';
  }
}

// ── 파일이 오가는 두 요청 — JSON 이 아니라 api() 를 못 쓴다(같은 인증 머리글을 손으로 싣는다) ─────
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) h['Authorization'] = 'Bearer ' + token;
  const ws = currentWorkspace();
  if (ws && ws !== 'primary') h['x-lively-workspace'] = ws;
  return h;
}
async function failure(res: Response): Promise<Error & { code?: string }> {
  let data: { error?: string; code?: string } | null = null;
  try { data = await res.json(); } catch (_) { /* 본문 없음 */ }
  const e = new Error((data && data.error) || `요청 실패 (${res.status})`) as Error & { code?: string };
  e.code = data?.code;
  return e;
}

let openBack: HTMLElement | null = null;

/** 창을 연다. tab = 처음 보일 탭. */
export function openTransfer(tab: 'export' | 'import' = 'export'): void {
  if (openBack) return;
  const close = (): void => { openBack?.remove(); openBack = null; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || document.querySelector('.ov-back')) return; // 확인창이 떠 있으면 Esc 는 그쪽 몫
    e.stopPropagation(); close();
  };
  const body = el('div', { class: 'v2wss-b v2xfer-b' });
  const tabExport = el('button', { type: 'button', text: '내보내기' });
  const tabImport = el('button', { type: 'button', text: '가져오기' });
  const show = (which: 'export' | 'import'): void => {
    tabExport.classList.toggle('on', which === 'export');
    tabImport.classList.toggle('on', which === 'import');
    tabExport.setAttribute('aria-selected', String(which === 'export'));
    tabImport.setAttribute('aria-selected', String(which === 'import'));
    body.replaceChildren(which === 'export' ? exportPane() : importPane());
  };
  tabExport.addEventListener('click', () => show('export'));
  tabImport.addEventListener('click', () => show('import'));
  const head = el('header', { class: 'v2wss-h' },
    el('span', { class: 'v2xfer-h-ic' }, icon('moveto')),
    el('div', { class: 'v2wss-h-txt' },
      el('h2', { class: 'v2wss-h-title', text: '워크스페이스 간 옮기기' }),
      el('div', { class: 'v2wss-h-sub', text: '지식을 파일로 내보내고, 다른 워크스페이스에서 그 파일을 가져옵니다.' })),
    el('button', { class: 'v2mem-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close }, icon('x')));
  const tabs = el('div', { class: 'seg-tabs v2xfer-tabs', role: 'tablist' }, tabExport, tabImport);
  const box = el('div', { class: 'v2wss v2xfer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '워크스페이스 간 옮기기' }, head, tabs, body);
  const back = el('div', { class: 'v2wss-back' }, box) as HTMLElement;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  openBack = back;
  show(tab);
}

// ═══ 내보내기 ═══════════════════════════════════════════════════════════════

function exportPane(): HTMLElement {
  const catAll = new Set<string>();                 // 분류 통째로
  const picked = new Map<string, Set<string>>();    // 분류 key → 하나씩 고른 문서 이름
  const docsOf = new Map<string, Doc[]>();          // 펼친 분류의 문서(캐시)
  const expanded = new Set<string>();
  let cats: Cat[] = [];
  let includeArchived = false;
  let includeSources = false;

  const listBox = el('div', { class: 'v2xfer-cats', role: 'group', 'aria-label': '내보낼 분류와 문서' }, el('p', { class: 'v2-wspop-hint', text: '분류를 불러오는 중입니다…' }));
  const previewBox = el('div', { class: 'v2xfer-preview', 'aria-live': 'polite' });
  const searchIn = el('input', { type: 'search', class: 'v2xfer-search', placeholder: '문서 제목이나 이름으로 찾기', 'aria-label': '문서 찾기' }) as HTMLInputElement;
  const searchOut = el('div', { class: 'v2xfer-search-out' });
  const pwOn = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const pw1 = secretInput({ placeholder: '비밀번호(8자 이상)', 'aria-label': '비밀번호' });
  const pw2 = secretInput({ placeholder: '비밀번호 한 번 더', 'aria-label': '비밀번호 확인' });
  const pwRow = el('div', { class: 'v2xfer-pw', hidden: true }, pw1, pw2,
    el('p', { class: 'v2-wspop-hint', text: '비밀번호를 건 파일은 라이블리 가져오기 화면에서만 열립니다. 비밀번호는 받는 분께 따로 알려 주세요.' }));
  const pwNote = el('p', { class: 'v2xfer-err', 'aria-live': 'polite' });
  const go = el('button', { class: 'btn btn-primary', type: 'button', disabled: true }, icon('download'), ' 파일 받기') as HTMLButtonElement;

  const pickedCount = (): number => [...picked.values()].reduce((n, s) => n + s.size, 0);
  const selection = (): { categories: string[]; knowledge: string[]; include_sources: boolean; include_archived: boolean } => ({
    categories: [...catAll],
    knowledge: [...picked.entries()].filter(([k]) => !catAll.has(k)).flatMap(([, s]) => [...s]),
    include_sources: includeSources,
    include_archived: includeArchived,
  });
  const hasSelection = (): boolean => catAll.size > 0 || pickedCount() > 0;
  const pwProblem = (): string | null => {
    if (!pwOn.checked) return null;
    if (pw1.value.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
    if (pw1.value !== pw2.value) return '두 비밀번호가 다릅니다.';
    return null;
  };
  const syncGo = (): void => {
    const p = pwProblem();
    pwNote.textContent = pwOn.checked && (pw1.value || pw2.value) ? (p ?? '') : '';
    go.disabled = !hasSelection() || !!p;
  };

  // 미리보기 — 고른 것이 바뀔 때마다(조금 기다렸다가) 서버에 몇 건인지 묻는다.
  let pvTimer: number | undefined;
  let pvSeq = 0;
  const refreshPreview = (): void => {
    syncGo();
    window.clearTimeout(pvTimer);
    if (!hasSelection()) { previewBox.replaceChildren(el('p', { class: 'v2-wspop-hint', text: '분류나 문서를 고르면 무엇이 몇 건 담기는지 여기에 나옵니다.' })); return; }
    pvTimer = window.setTimeout(async () => {
      const seq = ++pvSeq;
      try {
        const r = await api('/api/ui/transfer/export/preview', { method: 'POST', body: JSON.stringify(selection()) }) as { preview: Preview };
        if (seq !== pvSeq) return;
        const p = r.preview;
        const parts = [`지식 ${p.knowledge}건`, `분류 ${p.categories}개`];
        if (includeSources) parts.push(`자료 ${p.sources}건`);
        //  replaceChildren 은 null 을 글자 «null» 로 그린다 — 빈 칸은 걸러서 넘긴다.
        previewBox.replaceChildren(...[
          el('p', { class: 'v2xfer-preview-n', text: `담기는 것: ${parts.join(' · ')}` }),
          p.folders_added ? el('p', { class: 'v2-wspop-hint', text: `고른 문서가 들어 있는 폴더 ${p.folders_added}개를 함께 담습니다(받는 쪽에서 위치가 유지됩니다).` }) : null,
          ...p.notes.map((n) => el('p', { class: n.includes('공개로') ? 'v2xfer-note v2xfer-note--warn' : 'v2xfer-note', text: n })),
        ].filter(Boolean));
      } catch (e) {
        if (seq === pvSeq) previewBox.replaceChildren(el('p', { class: 'v2xfer-err', text: (e as Error).message }));
      }
    }, 350);
  };

  const loadDocs = async (key: string): Promise<Doc[]> => {
    const hit = docsOf.get(key);
    if (hit) return hit;
    const r = await api(`/api/ui/transfer/catalog/knowledge?category=${encodeURIComponent(key)}${includeArchived ? '&include_archived=1' : ''}`) as { knowledge: Doc[] };
    docsOf.set(key, r.knowledge);
    return r.knowledge;
  };

  const toggleCat = (key: string, on: boolean): void => {
    picked.delete(key);
    if (on) catAll.add(key); else catAll.delete(key);
    paintList(); paintSearch(); refreshPreview();
  };
  const toggleDoc = async (d: Doc, on: boolean): Promise<void> => {
    const key = d.category;
    if (catAll.has(key)) {
      // 통째로 고른 분류에서 하나를 빼면 → 나머지를 하나씩 고른 것으로 바꾼다.
      const all = await loadDocs(key);
      catAll.delete(key);
      picked.set(key, new Set(all.map((x) => x.name).filter((n) => n !== d.name || on)));
    } else {
      const s = picked.get(key) ?? new Set<string>();
      if (on) s.add(d.name); else s.delete(d.name);
      if (s.size) picked.set(key, s); else picked.delete(key);
      // 분류의 문서를 전부 하나씩 골랐으면 → 통째로 고른 것과 같다(이후 새로 생기는 문서까지 담는 쪽).
      const all = docsOf.get(key);
      if (all && all.length && s.size === all.length) { catAll.add(key); picked.delete(key); }
    }
    paintList(); paintSearch(); refreshPreview();
  };
  const isPicked = (d: Doc): boolean => catAll.has(d.category) || !!picked.get(d.category)?.has(d.name);

  const docRow = (d: Doc): HTMLElement => {
    const cb = el('input', { type: 'checkbox', 'aria-label': d.title || d.name }) as HTMLInputElement;
    cb.checked = isPicked(d);
    cb.addEventListener('change', () => { void toggleDoc(d, cb.checked); });
    return el('label', { class: 'v2xfer-doc' }, cb,
      el('span', { class: 'v2xfer-doc-t' }, d.is_folder ? icon('folder') : null, d.title || d.name),
      d.restricted ? el('span', { class: 'v2xfer-tag', text: '대상자 제한' }) : null,
      d.archived ? el('span', { class: 'v2xfer-tag', text: '보관' }) : null);
  };

  const paintList = (): void => {
    if (!cats.length) { listBox.replaceChildren(el('p', { class: 'v2-wspop-hint', text: '내보낼 지식이 없습니다.' })); return; }
    const rows = cats.map((c) => {
      const n = c.count + (includeArchived ? c.archived : 0);
      const cb = el('input', { type: 'checkbox', 'aria-label': `${c.name || c.key} 분류 전체` }) as HTMLInputElement;
      cb.checked = catAll.has(c.key);
      cb.indeterminate = !catAll.has(c.key) && (picked.get(c.key)?.size ?? 0) > 0;
      cb.disabled = n === 0;
      cb.addEventListener('change', () => toggleCat(c.key, cb.checked));
      const open = expanded.has(c.key);
      const more = el('button', { class: 'btn-text v2xfer-more', type: 'button', 'aria-expanded': String(open), disabled: n === 0,
        text: open ? '접기' : '문서 고르기', onclick: async () => {
          if (expanded.has(c.key)) expanded.delete(c.key);
          else { expanded.add(c.key); try { await loadDocs(c.key); } catch (e) { toast((e as Error).message); expanded.delete(c.key); } }
          paintList();
        } });
      const sub = (picked.get(c.key)?.size ?? 0) > 0 && !catAll.has(c.key) ? ` · ${picked.get(c.key)!.size}건 고름` : '';
      const head = el('div', { class: 'v2xfer-cat' },
        el('label', { class: 'v2xfer-cat-l' }, cb, el('span', { class: 'v2xfer-cat-t', text: c.key === UNSORTED_REF ? '(분류 없음)' : (c.name || c.key) })),
        el('span', { class: 'v2xfer-cat-n', text: `${n}건${sub}` }),
        c.restricted ? el('span', { class: 'v2xfer-tag', title: '받는 쪽에서는 공개로 들어갑니다', text: `제한 ${c.restricted}` }) : null,
        more);
      const docs = open ? (docsOf.get(c.key) ?? []) : [];
      return el('div', { class: 'v2xfer-catrow' }, head,
        open ? el('div', { class: 'v2xfer-docs' }, docs.length ? docs.map(docRow) : el('p', { class: 'v2-wspop-hint', text: '문서가 없습니다.' })) : null);
    });
    listBox.replaceChildren(...rows);
  };

  // 찾기 — 결과 영역만 다시 그린다(입력칸은 그대로 — 한글 조합이 깨지지 않게).
  let lastResults: Doc[] = [];
  let sTimer: number | undefined;
  const paintSearch = (): void => {
    if (!searchIn.value.trim()) { searchOut.replaceChildren(); return; }
    searchOut.replaceChildren(lastResults.length
      ? el('div', { class: 'v2xfer-docs' }, lastResults.map((d) => el('div', { class: 'v2xfer-found' }, docRow(d),
          el('span', { class: 'v2xfer-found-c', text: d.category === UNSORTED_REF ? '(분류 없음)' : (d.category_name || d.category) }))))
      : el('p', { class: 'v2-wspop-hint', text: '찾는 문서가 없습니다.' }));
  };
  searchIn.addEventListener('input', () => {
    window.clearTimeout(sTimer);
    sTimer = window.setTimeout(async () => {
      const qv = searchIn.value.trim();
      if (!qv) { lastResults = []; paintSearch(); return; }
      try {
        const r = await api(`/api/ui/transfer/catalog/knowledge?q=${encodeURIComponent(qv)}`) as { knowledge: Doc[] };
        if (searchIn.value.trim() !== qv) return;
        lastResults = r.knowledge;
        paintSearch();
      } catch (e) { searchOut.replaceChildren(el('p', { class: 'v2xfer-err', text: (e as Error).message })); }
    }, 300);
  });

  const allBtn = el('button', { class: 'btn-text', type: 'button', text: '모두 고르기', onclick: () => {
    for (const c of cats) if (c.count + (includeArchived ? c.archived : 0) > 0) catAll.add(c.key);
    picked.clear(); paintList(); paintSearch(); refreshPreview();
  } });
  const noneBtn = el('button', { class: 'btn-text', type: 'button', text: '모두 풀기', onclick: () => {
    catAll.clear(); picked.clear(); paintList(); paintSearch(); refreshPreview();
  } });

  const optSources = el('input', { type: 'checkbox' }) as HTMLInputElement;
  optSources.addEventListener('change', () => { includeSources = optSources.checked; refreshPreview(); });
  const optArchived = el('input', { type: 'checkbox' }) as HTMLInputElement;
  optArchived.addEventListener('change', () => { includeArchived = optArchived.checked; docsOf.clear(); paintList(); refreshPreview(); });
  pwOn.addEventListener('change', () => { (pwRow as HTMLElement).hidden = !pwOn.checked; if (pwOn.checked) pw1.focus(); syncGo(); });
  pw1.addEventListener('input', syncGo);
  pw2.addEventListener('input', syncGo);

  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    const label = go.lastChild as Text;
    const was = label.textContent;
    label.textContent = ' 파일을 만드는 중…';
    try {
      const res = await fetch(apiUrl('/api/ui/transfer/export'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...selection(), password: pwOn.checked ? pw1.value : undefined }),
      });
      if (!res.ok) throw await failure(res);
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : 'lively-transfer.zip';
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name }) as HTMLAnchorElement;
      document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(`파일을 받았습니다(${name}). 받는 워크스페이스의 [워크스페이스 설정 ▸ 워크스페이스 간 옮기기 ▸ 가져오기]에서 올려 주세요.`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      label.textContent = was;
      syncGo();
    }
  });

  void (async () => {
    try {
      const r = await api('/api/ui/transfer/catalog') as { categories: Cat[] };
      cats = r.categories;
      paintList();
    } catch (e) {
      listBox.replaceChildren(el('p', { class: 'v2xfer-err', text: `분류를 불러오지 못했습니다 — ${(e as Error).message}` }));
    }
  })();
  refreshPreview();

  return el('div', { class: 'v2xfer-pane' },
    el('section', { class: 'v2wss-sec' },
      el('div', { class: 'v2xfer-sec-h' }, el('h3', { class: 'v2wss-sec-t', text: '내보낼 지식' }), el('span', { class: 'v2xfer-sec-acts' }, allBtn, noneBtn)),
      el('p', { class: 'v2-wspop-hint', text: '분류를 고르면 그 분류의 지식이 모두 담깁니다. 문서를 하나씩 고르려면 [문서 고르기]를 누르거나 아래에서 찾아 주세요.' }),
      listBox,
      el('div', { class: 'v2xfer-searchrow' }, icon('search'), searchIn),
      searchOut),
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '함께 담을 것' }),
      el('label', { class: 'v2xfer-opt' }, optSources, el('span', { text: '연결된 자료도 함께 담습니다(받는 쪽에 이미 있는 원본은 연결만 합니다).' })),
      el('label', { class: 'v2xfer-opt' }, optArchived, el('span', { text: '보관한 지식도 함께 담습니다.' })),
      el('label', { class: 'v2xfer-opt' }, pwOn, el('span', { text: '파일에 비밀번호를 겁니다.' })),
      pwRow, pwNote),
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '미리보기' }),
      previewBox,
      el('div', { class: 'v2-wspop-actions' }, go)));
}

// ═══ 가져오기 ═══════════════════════════════════════════════════════════════

function importPane(): HTMLElement {
  const root = el('div', { class: 'v2xfer-pane' });
  const showStart = (): void => { root.replaceChildren(startView(showPlan, showResult)); };
  const showPlan = (batch: Batch, plan: Plan, targets: Array<{ key: string; name: string | null }>): void => {
    root.replaceChildren(planView(batch, plan, targets, showStart, showResult));
  };
  const showResult = (batch: Batch): void => { root.replaceChildren(resultView(batch, showStart)); };
  showStart();
  return root;
}

/** 첫 화면 — 파일 올리기 + 지난 가져오기 목록 */
function startView(onPlan: (b: Batch, p: Plan, t: Array<{ key: string; name: string | null }>) => void, onResult: (b: Batch) => void): HTMLElement {
  const fileIn = el('input', { type: 'file', accept: '.zip,.lively,application/zip,application/octet-stream', hidden: true }) as HTMLInputElement;
  const pick = el('button', { class: 'btn btn-primary', type: 'button' }, icon('upload'), ' 파일 고르기') as HTMLButtonElement;
  const status = el('p', { class: 'v2-wspop-hint', 'aria-live': 'polite', text: '다른 워크스페이스에서 [내보내기]로 받은 .zip 또는 .lively 파일을 올려 주세요. 올려도 바로 들어가지 않습니다 — 먼저 미리보기를 보여 드립니다.' });
  const pw = secretInput({ placeholder: '내보낼 때 정한 비밀번호', 'aria-label': '파일 비밀번호' });
  const pwGo = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '열기' });
  const pwRow = el('div', { class: 'v2xfer-pw', hidden: true }, pw, pwGo);
  const drop = el('div', { class: 'v2xfer-drop' }, el('span', { class: 'v2xfer-drop-ic' }, icon('upload')), el('span', { text: '여기에 파일을 끌어다 놓아도 됩니다.' }));
  let current: File | null = null;

  const upload = async (file: File, password?: string): Promise<void> => {
    current = file;
    pick.disabled = true;
    status.textContent = `«${file.name}» 을 읽는 중입니다…`;
    try {
      const res = await fetch(apiUrl('/api/ui/transfer/upload'), {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'application/octet-stream',
          'X-Lively-Bundle-Name': encodeURIComponent(file.name),
          ...(password ? { 'X-Lively-Bundle-Password': encodeURIComponent(password) } : {}),
        }),
        body: file,
      });
      if (!res.ok) throw await failure(res);
      const r = await res.json() as { batch: Batch; plan: Plan; target_categories: Array<{ key: string; name: string | null }> };
      onPlan(r.batch, r.plan, r.target_categories);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'password_required' || err.code === 'wrong_password') {
        (pwRow as HTMLElement).hidden = false;
        status.textContent = err.message;
        pw.focus();
      } else {
        status.textContent = err.message;
      }
    } finally {
      pick.disabled = false;
    }
  };
  pick.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) { (pwRow as HTMLElement).hidden = true; pw.value = ''; void upload(f); } fileIn.value = ''; });
  pwGo.addEventListener('click', () => { if (current && pw.value) void upload(current, pw.value); });
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && current && pw.value) void upload(current, pw.value); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('on'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('on');
    const f = e.dataTransfer?.files?.[0];
    if (f) { (pwRow as HTMLElement).hidden = true; pw.value = ''; void upload(f); }
  });

  const history = el('div', { class: 'v2xfer-hist' }, el('p', { class: 'v2-wspop-hint', text: '지난 가져오기를 불러오는 중입니다…' }));
  void (async () => {
    try {
      const r = await api('/api/ui/transfer/imports') as { imports: Batch[] };
      if (!r.imports.length) { history.replaceChildren(el('p', { class: 'v2-wspop-hint', text: '아직 가져온 파일이 없습니다.' })); return; }
      history.replaceChildren(...r.imports.map((b) => {
        const c = b.result?.counts;
        const what = c ? `만듦 ${c.created ?? 0} · 갱신 ${c.updated ?? 0} · 건너뜀 ${c.skipped ?? 0}${c.failed ? ` · 실패 ${c.failed}` : ''}`
          : (b.summary ? `지식 ${b.summary.total ?? 0}건` : '');
        const openIt = async (): Promise<void> => {
          try {
            const g = await api(`/api/ui/transfer/imports/${b.id}`) as { batch: Batch; target_categories: Array<{ key: string; name: string | null }> };
            if (g.batch.state === 'planned' && g.batch.plan) onPlan(g.batch, g.batch.plan, g.target_categories);
            else onResult(g.batch);
          } catch (e) { toast((e as Error).message); }
        };
        return el('div', { class: 'v2xfer-histrow' },
          el('div', { class: 'v2xfer-hist-t' },
            el('b', { text: b.file_name || `가져오기 #${b.id}` }),
            el('span', { text: `${b.origin?.name ? `«${b.origin.name}» 에서 · ` : ''}${new Date(b.created_at).toLocaleString()}${what ? ` · ${what}` : ''}` })),
          el('span', { class: 'v2xfer-state', text: BATCH_LABEL[b.state] ?? b.state }),
          el('button', { class: 'btn-text', type: 'button', text: b.state === 'planned' ? '이어서 보기' : '보기', onclick: openIt }));
      }));
    } catch (e) {
      history.replaceChildren(el('p', { class: 'v2xfer-err', text: `지난 가져오기를 불러오지 못했습니다 — ${(e as Error).message}` }));
    }
  })();

  return el('div', {},
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '파일 올리기' }),
      drop, status, pwRow, fileIn,
      el('div', { class: 'v2-wspop-actions' }, pick)),
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '지난 가져오기' }),
      history));
}

/** 미리보기 — 분류 맞추기 · 확인할 문서의 행동 고르기 · 자료 포함 여부 → [가져오기] */
function planView(batch: Batch, plan: Plan, targets: Array<{ key: string; name: string | null }>, back: () => void, onResult: (b: Batch) => void): HTMLElement {
  const catChoice = new Map<string, HTMLSelectElement>();
  const itemChoice = new Map<string, HTMLSelectElement>();

  const s = plan.summary;
  const created = new Date(plan.bundle_created_at);
  const intro = el('p', { class: 'v2xfer-intro', text: `${plan.origin.name ? `«${plan.origin.name}» 에서 ` : ''}${isNaN(created.getTime()) ? '' : `${created.toLocaleString()} 에 `}만든 파일입니다. 지식 ${s.total ?? 0}건이 들어 있습니다.` });
  const chips = el('div', { class: 'v2xfer-chips' });
  const paintChips = (): void => {
    const count: Record<string, number> = { create: 0, rename: 0, update: 0, overwrite: 0, skip: 0 };
    for (const it of plan.knowledge) count[itemChoice.get(it.ref)?.value ?? it.action] = (count[itemChoice.get(it.ref)?.value ?? it.action] ?? 0) + 1;
    chips.replaceChildren(...[
      el('span', { class: 'v2xfer-chip', text: `새로 만들기 ${count.create}` }),
      el('span', { class: 'v2xfer-chip', text: `새 이름으로 ${count.rename}` }),
      el('span', { class: 'v2xfer-chip', text: `갱신·덮어쓰기 ${count.update + count.overwrite}` }),
      el('span', { class: 'v2xfer-chip', text: `건너뛰기 ${count.skip}` }),
      s.invalid ? el('span', { class: 'v2xfer-chip v2xfer-chip--warn', text: `들일 수 없음 ${s.invalid}` }) : null,
    ].filter(Boolean));
  };

  // 분류 맞추기
  const catRows = plan.categories.map((c) => {
    const sel = el('select', { class: 'v2xfer-sel', 'aria-label': `${c.name || c.ref} 분류를 어디로 맞출지` }) as HTMLSelectElement;
    const newKey = c.suggestion.action === 'create' ? c.suggestion.key : c.ref;
    sel.append(el('option', { value: '__create__', text: `새 분류로 만들기 (${newKey})` }));
    for (const t of targets) sel.append(el('option', { value: t.key, text: `여기의 «${t.name || t.key}» 에 넣기` }));
    sel.value = c.suggestion.action === 'map' ? c.suggestion.to : '__create__';
    catChoice.set(c.ref, sel);
    const why = c.suggestion.action === 'map'
      ? ({ before: '지난번에 맞춘 대로', same_key: '같은 분류가 있어', same_name: '이름이 같은 분류가 있어' } as Record<string, string>)[c.suggestion.why] ?? ''
      : '여기에 같은 분류가 없어';
    return el('div', { class: 'v2xfer-maprow' },
      el('div', { class: 'v2xfer-map-from' }, el('b', { text: c.ref === UNSORTED_REF ? '(분류 없음)' : (c.name || c.ref) }), el('span', { text: `${c.count}건 · ${why} 이렇게 제안합니다.` })),
      sel);
  });

  // 문서 — 확인이 필요한 것만 펼치고, 그대로 들어가는 것은 접어 둔다.
  const reviewRows: HTMLElement[] = [];
  const plainRows: HTMLElement[] = [];
  for (const it of plan.knowledge) {
    const row = el('div', { class: 'v2xfer-item' + (it.status === 'invalid' ? ' is-invalid' : '') },
      el('div', { class: 'v2xfer-item-t' },
        el('b', { text: it.title || it.ref }),
        el('span', { class: 'v2xfer-state', text: STATUS_LABEL[it.status] ?? it.status }),
        it.reason ? el('span', { class: 'v2xfer-err', text: it.reason }) : null,
        ...it.notes.map((n) => el('span', { class: 'v2xfer-note', text: n }))));
    if (it.actions.length > 1) {
      const sel = el('select', { class: 'v2xfer-sel', 'aria-label': `${it.title || it.ref} 처리 방법` }) as HTMLSelectElement;
      for (const a of it.actions) sel.append(el('option', { value: a, text: actionLabel(a, it) }));
      sel.value = it.action;
      sel.addEventListener('change', paintChips);
      itemChoice.set(it.ref, sel);
      row.append(sel);
    }
    (NEEDS_REVIEW.has(it.status) ? reviewRows : plainRows).push(row);
  }
  const plainBox = el('div', { class: 'v2xfer-items', hidden: true }, ...plainRows);
  const plainToggle = el('button', { class: 'btn-text', type: 'button', 'aria-expanded': 'false', text: `그대로 들어가는 문서 ${plainRows.length}건 펼쳐 보기`, onclick: () => {
    const open = (plainBox as HTMLElement).hidden;
    (plainBox as HTMLElement).hidden = !open;
    plainToggle.setAttribute('aria-expanded', String(open));
    plainToggle.textContent = open ? `그대로 들어가는 문서 ${plainRows.length}건 접기` : `그대로 들어가는 문서 ${plainRows.length}건 펼쳐 보기`;
  } });

  const srcCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  srcCb.checked = true;
  const go = el('button', { class: 'btn btn-primary', type: 'button', text: '가져오기' }) as HTMLButtonElement;
  const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '목록으로', onclick: back });
  go.addEventListener('click', async () => {
    const knowledge: Record<string, string> = {};
    for (const [ref, sel] of itemChoice) knowledge[ref] = sel.value;
    const categories: Record<string, unknown> = {};
    for (const [ref, sel] of catChoice) categories[ref] = sel.value === '__create__' ? { action: 'create' } : { action: 'map', to: sel.value };
    const overwrites = Object.values(knowledge).filter((a) => a === 'overwrite' || a === 'update').length;
    const creates = plan.knowledge.filter((it) => { const a = knowledge[it.ref] ?? it.action; return a === 'create' || a === 'rename'; }).length;
    if (!creates && !overwrites) { toast('들일 문서가 없습니다 — 처리 방법을 하나 이상 바꿔 주세요.'); return; }
    const lines = [`새로 만드는 지식 ${creates}건`];
    if (overwrites) lines.push(`지금 내용을 바꾸는 지식 ${overwrites}건 — 바꾸기 전 판을 남겨 두어 [되돌리기]로 돌릴 수 있습니다.`);
    if (!await confirmDialog({ title: '이 내용으로 가져올까요?', lines, confirmText: '가져오기' })) return;
    go.disabled = true;
    go.textContent = '가져오는 중…';
    try {
      const r = await api(`/api/ui/transfer/imports/${batch.id}/apply`, { method: 'POST', body: JSON.stringify({ knowledge, categories, include_sources: srcCb.checked }) }) as { batch: Batch };
      toast(r.batch.state === 'partial' ? '일부 문서를 들이지 못했습니다 — 결과에서 이유를 확인해 주세요.' : '가져왔습니다.');
      onResult(r.batch);
    } catch (e) {
      toast((e as Error).message);
      go.disabled = false;
      go.textContent = '가져오기';
    }
  });
  paintChips();

  return el('div', {},
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '미리보기' }),
      intro, chips,
      ...plan.notes.map((n) => el('p', { class: 'v2xfer-note', text: n })),
      ...plan.problems.map((p) => el('p', { class: 'v2xfer-err', text: `${p.path}: ${p.reason}` }))),
    plan.categories.length ? el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '분류 맞추기' }),
      el('p', { class: 'v2-wspop-hint', text: '보낸 곳의 분류를 여기의 어느 분류에 넣을지 정합니다.' }),
      ...catRows) : null,
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: `확인할 문서 ${reviewRows.length}건` }),
      reviewRows.length ? el('div', { class: 'v2xfer-items' }, ...reviewRows) : el('p', { class: 'v2-wspop-hint', text: '확인할 문서가 없습니다. 모두 그대로 들어갑니다.' }),
      plainRows.length ? plainToggle : null, plainBox),
    plan.sources.count ? el('section', { class: 'v2wss-sec' },
      el('label', { class: 'v2xfer-opt' }, srcCb, el('span', { text: `연결된 자료 ${plan.sources.count}건도 함께 들입니다(여기에 이미 있는 ${plan.sources.existing}건은 연결만 합니다).` }))) : null,
    el('div', { class: 'v2-wspop-actions v2xfer-acts' }, cancel, go));
}

/** 결과 — 무엇을 했나 + [되돌리기](사람만) */
function resultView(batch: Batch, back: () => void): HTMLElement {
  const c = batch.result?.counts ?? {};
  const failed = (batch.result?.knowledge ?? []).filter((k) => !k.ok);
  const noted = (batch.result?.knowledge ?? []).filter((k) => k.ok && k.notes?.length);
  const undo = batch.result?.undo;
  const canUndo = batch.state === 'applied' || batch.state === 'partial';
  const undoBtn = el('button', { class: 'btn-text btn-text-danger', type: 'button', text: '이번 가져오기 되돌리기' }) as HTMLButtonElement;
  undoBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '이번 가져오기를 되돌릴까요?', danger: true, confirmText: '되돌리기',
      lines: [
        `새로 만든 지식 ${c.created ?? 0}건은 휴지통으로 갑니다. 가져온 뒤 고친 내용도 함께 갑니다(휴지통에서 되살릴 수 있습니다).`,
        `덮어쓴 지식 ${c.updated ?? 0}건은 가져오기 전 판으로 돌아갑니다.`,
        '이번에 새로 만든 분류와 자료는 비어 있으면 지웁니다.',
      ],
    });
    if (!ok) return;
    undoBtn.disabled = true;
    try {
      const r = await api(`/api/ui/transfer/imports/${batch.id}/undo`, { method: 'POST', body: '{}' }) as { batch: Batch };
      toast('되돌렸습니다.');
      root.replaceWith(resultView(r.batch, back));
    } catch (e) { toast((e as Error).message); undoBtn.disabled = false; }
  });
  const root = el('div', {},
    el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: `결과 — ${BATCH_LABEL[batch.state] ?? batch.state}` }),
      el('div', { class: 'v2xfer-chips' },
        el('span', { class: 'v2xfer-chip', text: `만듦 ${c.created ?? 0}` }),
        el('span', { class: 'v2xfer-chip', text: `갱신 ${c.updated ?? 0}` }),
        el('span', { class: 'v2xfer-chip', text: `건너뜀 ${c.skipped ?? 0}` }),
        c.failed ? el('span', { class: 'v2xfer-chip v2xfer-chip--warn', text: `실패 ${c.failed}` }) : null),
      batch.error ? el('p', { class: 'v2xfer-err', text: batch.error }) : null,
      undo ? el('p', { class: 'v2xfer-note', text: `되돌림: 휴지통으로 ${undo.deleted}건 · 이전 판으로 ${undo.restored}건${undo.kept.length ? ` · 남긴 것 ${undo.kept.length}건` : ''}` }) : null,
      ...(undo?.kept ?? []).map((k) => el('p', { class: 'v2xfer-err', text: `${k.name}: ${k.reason}` }))),
    failed.length ? el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: `들이지 못한 문서 ${failed.length}건` }),
      ...failed.map((k) => el('p', { class: 'v2xfer-err', text: `${k.ref}: ${k.error ?? '이유를 알 수 없습니다'}` }))) : null,
    noted.length ? el('section', { class: 'v2wss-sec' },
      el('h3', { class: 'v2wss-sec-t', text: '알아 둘 것' }),
      ...noted.slice(0, 50).map((k) => el('p', { class: 'v2xfer-note', text: `${k.name ?? k.ref}: ${(k.notes ?? []).join(' ')}` }))) : null,
    el('div', { class: 'v2-wspop-actions v2xfer-acts' },
      el('button', { class: 'btn btn-ghost', type: 'button', text: '목록으로', onclick: back }),
      canUndo ? undoBtn : null));
  return root;
}
