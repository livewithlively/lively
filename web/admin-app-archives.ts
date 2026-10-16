// admin-app-archives.ts — [앱 보관] 패널(#4733 앱 v2-19 · #4778 앱 폴더). 관리자 전용.
//  ① 보관 표 = 앱이 표를 선언에서 빼거나(데이터가 있을 때) 칸을 지울 때(drop_columns) 그 데이터를 잃지 않으려고 옮겨 둔 표.
//   앱은 더 쓰지 않지만 워크스페이스 표 개수 한도에 세어지고, 앱을 고쳐서는 줄지 않는다 → 여기서 보고 비운다.
//   서버: GET /api/ui/app-archives(app_archives) · POST /api/ui/app-archives/clear(app_archive_clear). 비우기는 서버가 지우기 직전
//   앱 데이터 백업(7일)에 담는다 — 되살리기(app_data_restore)는 보관 표를 되살리지 않는다(백업에만 남는다 · 상민 2026-10-15).
//   앱을 지우면 그 앱의 보관 표는 제거가 함께 지운다 — 여기 남는 것은 주로 «주인 모름» · 지운 앱의 남은 것 · 쓰는 앱의 옛 값이다.
//  ② 보관한 앱 폴더(#4778) = 앱을 지울 때 그 앱 폴더(apps/<앱>/)를 옮겨 둔 것 — 같은 id 로 다시 만든 앱은 빈 앱 폴더로 시작한다.
//   보관 기간(앱 데이터와 같은 7일)이 지나면 정비가 지운다. 여기서 비우거나(되살릴 수 없다), 같은 id 의 앱이 다시 있으면 되돌린다.
//   서버: GET /api/ui/app-folder-archives(app_folder_archives) · POST …/clear(app_folder_archive_clear) · …/restore(app_folder_restore).
//  ③ 앱 없는 앱 폴더(고아) — 앱 행 없이 남은 앱 폴더. 정비는 훑지 않는다(상민 2026-10-16) — 여기서 보관으로 옮긴다(…/orphans).
import { api, cardHead, el, relTime, toast, uiText } from './core.js';
import { fmtBytes, sectionHead } from './admin-widgets.js';
// ⚠ confirmDialog 는 정의처(ui-primitives)에서 직접 — admin.ts 배럴을 거치면 순환이 된다(admin-ops 와 같은 이유).
import { confirmDialog } from './ui-primitives.js';

const OWNER_TEXT = { recorded: '', guessed: ' (이름으로 짐작)', unknown: '주인 모름' };
const REASON_TEXT = { install: '저장·설치', publish: '공개' };
//  앱 폴더를 어느 입구에서 옮겼나(서버 entry) — 표의 «어디서» 칸.
const ENTRY_TEXT = {
  remove: '관리자가 앱을 지움', discard: '나만 보는 앱을 지움', retire: '기본 앱 은퇴', 'draft-drop': '빈 앱 정리',
  create: '같은 이름으로 새로 만듦', orphan: '앱 없는 폴더를 옮김', unknown: '기록 없음',
};

//  표 모양 — 감사 패널(admin-audit-tools tu-styles)과 같은 방식으로 처음 그릴 때 한 번 넣는다(그 패널을 안 열어도 보이게).
function ensureStyles() {
  if (document.getElementById('aa-styles')) return;
  document.head.appendChild(el('style', { id: 'aa-styles', text: `
.aa-table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 12px}
.aa-table th{text-align:left;padding:6px 9px;font-size:11px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line)}
.aa-table td{padding:6px 9px;border-bottom:1px solid var(--line);color:var(--ink);word-break:break-all}
.aa-table td:first-child,.aa-table th:first-child{width:28px}
` }));
}

/** 카드 설명 — ⓘ 안에 숨기지 않고 제목 아래 한 줄로(비우기 · 되돌리기의 뜻을 누르기 전에 읽게). */
const hint = (text) => el('p', { class: 'admin-hint' }, ...uiText(text));

/** 앞으로의 시각 → «N일 뒤» · «N시간 뒤» · 이미 지났으면 «다음 정비 때». */
function untilText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '다음 정비 때';
  const h = Math.floor(ms / 3_600_000);
  return h < 24 ? `${Math.max(1, h)}시간 뒤` : `${Math.floor(h / 24)}일 뒤`;
}

/** 고르기 · 고른 것에 단추 하나 — 표 셋이 같은 꼴을 쓴다. */
function pickTable(heads, items, keyOf, cellsOf, picked, button, label) {
  for (const k of [...picked]) if (!items.some((it) => keyOf(it) === k)) picked.delete(k);
  const sync = () => { button.textContent = picked.size ? label(picked.size) : label(0); button.disabled = !picked.size; };
  const rows = items.map((it) => {
    const k = keyOf(it);
    const chk = el('input', { type: 'checkbox', 'aria-label': k }) as HTMLInputElement;
    chk.checked = picked.has(k);
    chk.addEventListener('change', () => { if (chk.checked) picked.add(k); else picked.delete(k); sync(); });
    return el('tr', {}, el('td', {}, chk), ...cellsOf(it));
  });
  sync();
  return el('table', { class: 'aa-table' },
    el('thead', {}, el('tr', {}, el('th', { text: '' }), ...heads.map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows));
}

function appArchivesEditor(detail, _data) {
  ensureStyles();
  const tablesBody = el('div');
  const foldersBody = el('div');
  const orphansCard = el('div', { class: 'card aa-orphans', hidden: true });
  detail.replaceChildren(
    sectionHead('앱 보관', '앱이 더는 쓰지 않는 표와 파일을 따로 옮겨 둔 곳입니다. 앱은 이 보관을 보지 못합니다.'),
    el('div', { class: 'card aa-tables' },
      cardHead('보관 표'),
      hint('앱이 표를 빼거나 칸을 지울 때, 그 안의 데이터를 잃지 않으려고 따로 옮겨 둔 표입니다. 앱은 더 쓰지 않지만 워크스페이스 표 개수 한도에 세어집니다. 비우면 지우기 직전 백업(7일)에 담은 뒤 지웁니다 — 백업에서 다시 되살리지는 않습니다.'),
      tablesBody),
    el('div', { class: 'card aa-folders' },
      cardHead('보관한 앱 폴더'),
      hint('앱을 지울 때 그 앱의 앱 폴더를 옮겨 둔 곳입니다. 같은 이름으로 다시 만든 앱은 빈 앱 폴더로 시작합니다. 보관 기간이 지나면 저절로 지웁니다. 같은 이름의 앱이 다시 있으면 되돌릴 수 있습니다.'),
      foldersBody),
    orphansCard);
  tablesBody.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
  foldersBody.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
  loadTables(tablesBody);
  loadFolders(foldersBody, orphansCard);
}

// ── ① 보관 표 ─────────────────────────────────────────────────────────────────────────────

function loadTables(body) {
  const picked = new Set<string>();

  async function load() {
    let r;
    try { r = await api('/api/ui/app-archives'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '보관 표를 불러오지 못했습니다: ' + e.message })); return; }
    build(r);
  }

  function build(r) {
    const list = (r.archives || []) as any[];
    const lim = r.table_limit || {};
    const summary = el('p', { class: 'storage-calc', text:
      `보관 표 ${list.length}개 · ${fmtBytes(r.bytes || 0)} — 워크스페이스 표 ${(lim.current ?? 0) + (lim.archived ?? 0)}개 / 한도 ${lim.limit ?? '?'}개(쓰는 표 ${lim.current ?? 0} · 보관 표 ${lim.archived ?? 0})` });
    if (!list.length) {
      body.replaceChildren(summary, el('p', { class: 'admin-hint', text: '보관 표가 없습니다.' }));
      return;
    }
    const clearBtn = el('button', { class: 'btn btn-danger btn-sm', type: 'button' }) as HTMLButtonElement;
    const table = pickTable(['앱', '무엇', '행', '크기', '언제', '까닭'], list, (a) => a.name, (a) => {
      const app = a.app_id ? `${a.app_id}${OWNER_TEXT[a.owner] ?? ''}` : OWNER_TEXT.unknown;
      const where = a.kind === 'column'
        ? (a.table && a.column ? `${a.table}.${a.column} 칸의 값` : '지운 칸의 값')
        : (a.table ? `${a.table} 표 통째` : '표 통째');
      return [
        el('td', { text: app }),
        el('td', { text: where, title: a.name }),
        el('td', { text: a.rows == null ? '?' : `${a.rows}행` }),
        el('td', { text: fmtBytes(a.bytes || 0) }),
        el('td', { text: a.archived_at ? relTime(a.archived_at) : '', title: a.archived_at || '' }),
        el('td', { text: a.reason ? (REASON_TEXT[a.reason] ?? a.reason) : '' }),
      ];
    }, picked, clearBtn, (n) => (n ? `고른 ${n}개 비우기` : '비울 표를 고르세요'));
    clearBtn.addEventListener('click', async () => {
      const names = [...picked];
      if (!names.length) return;
      const ok = await confirmDialog({
        title: `보관 표 ${names.length}개를 비울까요?`,
        message: '지우기 직전 앱 데이터 백업(7일)에 담은 뒤 지웁니다. 앱 데이터 되살리기는 보관 표를 되살리지 않습니다.',
        lines: names.slice(0, 8).concat(names.length > 8 ? [`… 외 ${names.length - 8}개`] : []),
        confirmText: '비우기', danger: true,
      });
      if (!ok) return;
      clearBtn.disabled = true;
      try {
        const out = await api('/api/ui/app-archives/clear', { method: 'POST', body: JSON.stringify({ names }) });
        const kept = (out.kept || []) as any[];
        for (const c of out.cleared || []) picked.delete(c.name);
        toast(`${(out.cleared || []).length}개 비웠어요${kept.length ? ` · ${kept.length}개는 남겼어요 — ${kept[0].why}` : ''}`, kept.length > 0);
      } catch (e: any) { toast(e.message, true); }
      finally { load(); }   // 무엇이 실패해도 목록은 지금 상태로 다시 그린다(지운 것이 화면에 남아 있지 않게)
    });
    body.replaceChildren(summary, table, el('div', { class: 'admin-actions' }, clearBtn));
  }

  load();
}

// ── ② 보관한 앱 폴더 · ③ 앱 없는 앱 폴더 ─────────────────────────────────────────────────────

function loadFolders(body, orphansCard) {
  const picked = new Set<string>();
  const pickedOrphans = new Set<string>();

  async function load() {
    let r;
    try { r = await api('/api/ui/app-folder-archives'); }
    catch (e: any) {
      body.replaceChildren(el('p', { class: 'admin-hint', text: '보관한 앱 폴더를 불러오지 못했습니다: ' + e.message }));
      orphansCard.hidden = true;
      return;
    }
    build(r);
    buildOrphans(r);
  }

  function build(r) {
    const list = (r.archives || []) as any[];
    const summary = el('p', { class: 'storage-calc', text:
      `보관한 앱 폴더 ${list.length}개 · ${fmtBytes(r.bytes || 0)} — 보관 기간 ${r.keep_days ?? '?'}일이 지나면 저절로 지웁니다.` });
    const scanNote = r.scan_error ? el('p', { class: 'admin-hint', text: `앱 폴더 자리를 훑지 못해 기록만 보입니다: ${r.scan_error}` }) : null;
    if (!list.length) {
      body.replaceChildren(summary, ...(scanNote ? [scanNote] : []), el('p', { class: 'admin-hint', text: '보관한 앱 폴더가 없습니다.' }));
      return;
    }
    const clearBtn = el('button', { class: 'btn btn-danger btn-sm', type: 'button' }) as HTMLButtonElement;
    const table = pickTable(['앱', '크기', '파일', '옮긴 때', '어디서', '지울 때', ''], list, (a) => a.name, (a) => {
      const size = a.missing ? '—' : a.bytes == null ? '?' : `${fmtBytes(a.bytes)}${a.truncated ? ' 이상' : ''}`;
      const files = a.missing ? '—' : a.files == null ? '?' : `${a.files}개${a.truncated ? ' 이상' : ''}`;
      const who = a.archived_by ? ` · ${a.archived_by}` : '';
      const restore = a.app_exists && !a.missing
        ? el('button', { class: 'btn btn-ghost btn-sm aa-restore', type: 'button', text: '되돌리기', onclick: () => restoreOne(a) })
        : null;
      return [
        el('td', { text: `${a.app_id}${a.missing ? ' (파일 없음)' : ''}`, title: a.name }),
        el('td', { text: size }),
        el('td', { text: files }),
        el('td', { text: relTime(a.archived_at), title: a.archived_at || '' }),
        el('td', { text: `${ENTRY_TEXT[a.entry] ?? a.entry}${who}` }),
        el('td', { text: untilText(a.expires_at), title: a.expires_at || '' }),
        el('td', {}, restore),
      ];
    }, picked, clearBtn, (n) => (n ? `고른 ${n}개 비우기` : '비울 보관을 고르세요'));
    clearBtn.addEventListener('click', async () => {
      const names = [...picked];
      if (!names.length) return;
      const byName = new Map(list.map((a) => [a.name, a]));
      const ok = await confirmDialog({
        title: `보관한 앱 폴더 ${names.length}개를 비울까요?`,
        message: '되살릴 수 없습니다. 이 보관이 그 앱 폴더의 마지막 사본입니다.',
        lines: names.slice(0, 8).map((n) => byName.get(n)?.app_id ?? n).concat(names.length > 8 ? [`… 외 ${names.length - 8}개`] : []),
        confirmText: '비우기', danger: true,
      });
      if (!ok) return;
      clearBtn.disabled = true;
      try {
        const out = await api('/api/ui/app-folder-archives/clear', { method: 'POST', body: JSON.stringify({ names }) });
        const kept = (out.kept || []) as any[];
        for (const c of out.cleared || []) picked.delete(c.name);
        toast(`${(out.cleared || []).length}개 비웠어요${kept.length ? ` · ${kept.length}개는 남겼어요 — ${kept[0].why}` : ''}`, kept.length > 0);
      } catch (e: any) { toast(e.message, true); }
      finally { load(); }
    });
    body.replaceChildren(summary, ...(scanNote ? [scanNote] : []), table, el('div', { class: 'admin-actions' }, clearBtn));
  }

  async function restoreOne(a) {
    const ok = await confirmDialog({
      title: `「${a.app_id}」 앱 폴더를 되돌릴까요?`,
      message: '지금 그 앱의 앱 폴더가 비어 있을 때만 되돌립니다. 파일이 있으면 아무것도 바꾸지 않습니다. 앱 데이터(표)는 앱 데이터 되살리기로 따로 되돌립니다.',
      confirmText: '되돌리기',
    });
    if (!ok) return;
    try {
      await api('/api/ui/app-folder-archives/restore', { method: 'POST', body: JSON.stringify({ name: a.name }) });
      picked.delete(a.name);
      toast(`「${a.app_id}」 앱 폴더를 되돌렸어요`);
    } catch (e: any) { toast(e.message, true); }
    finally { load(); }
  }

  function buildOrphans(r) {
    const list = (r.orphans || []) as any[];
    orphansCard.hidden = !list.length;
    if (!list.length) { orphansCard.replaceChildren(); pickedOrphans.clear(); return; }
    const moveBtn = el('button', { class: 'btn btn-sm', type: 'button' }) as HTMLButtonElement;
    const table = pickTable(['앱 이름', '크기', '파일'], list, (o) => o.app_id, (o) => [
      el('td', { text: o.app_id }),
      el('td', { text: `${fmtBytes(o.bytes || 0)}${o.truncated ? ' 이상' : ''}` }),
      el('td', { text: `${o.files ?? 0}개${o.truncated ? ' 이상' : ''}` }),
    ], pickedOrphans, moveBtn, (n) => (n ? `고른 ${n}개 보관으로 옮기기` : '옮길 폴더를 고르세요'));
    moveBtn.addEventListener('click', async () => {
      const ids = [...pickedOrphans];
      if (!ids.length) return;
      const ok = await confirmDialog({
        title: `앱 없는 앱 폴더 ${ids.length}개를 보관으로 옮길까요?`,
        message: `보관한 앱 폴더로 옮기고, 보관 기간(${r.keep_days ?? '?'}일)이 지나면 지웁니다. 그 사이에는 비우거나, 같은 이름의 앱을 다시 만든 뒤 되돌릴 수 있습니다.`,
        lines: ids.slice(0, 8).concat(ids.length > 8 ? [`… 외 ${ids.length - 8}개`] : []),
        confirmText: '보관으로 옮기기',
      });
      if (!ok) return;
      moveBtn.disabled = true;
      try {
        const out = await api('/api/ui/app-folder-archives/orphans', { method: 'POST', body: JSON.stringify({ app_ids: ids }) });
        const skipped = (out.skipped || []) as any[];
        for (const a of out.archived || []) pickedOrphans.delete(a.app_id);
        toast(`${(out.archived || []).length}개 옮겼어요${skipped.length ? ` · ${skipped.length}개는 그대로 뒀어요 — ${skipped[0].why}` : ''}`, skipped.length > 0);
      } catch (e: any) { toast(e.message, true); }
      finally { load(); }
    });
    orphansCard.replaceChildren(
      cardHead('앱 없는 앱 폴더'),
      hint('앱이 없는데 남아 있는 앱 폴더입니다. 같은 이름의 앱을 새로 만들면 저절로 보관으로 옮깁니다. 지금 옮기면 보관 기간이 지난 뒤 지웁니다.'),
      table, el('div', { class: 'admin-actions' }, moveBtn));
  }

  load();
}

export { appArchivesEditor };
