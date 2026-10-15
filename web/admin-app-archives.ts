// admin-app-archives.ts — [앱 보관 표] 패널(#4733 앱 v2-19). 관리자 전용.
//  보관 표 = 앱이 표를 선언에서 빼거나(데이터가 있을 때) 칸을 지울 때(drop_columns) 그 데이터를 잃지 않으려고 옮겨 둔 표.
//  앱은 더 쓰지 않지만 워크스페이스 표 개수 한도에 세어지고, 앱을 고쳐서는 줄지 않는다 → 여기서 보고 비운다.
//  서버: GET /api/ui/app-archives(app_archives) · POST /api/ui/app-archives/clear(app_archive_clear). 비우기는 서버가 지우기 직전
//   앱 데이터 백업(7일)에 담는다 — 되살리기(app_data_restore)는 보관 표를 되살리지 않는다(백업에만 남는다 · 상민 2026-10-15).
//  앱을 지우면 그 앱의 보관 표는 제거가 함께 지운다 — 여기 남는 것은 주로 «주인 모름» · 지운 앱의 남은 것 · 쓰는 앱의 옛 값이다.
import { api, el, relTime, toast, uiText } from './core.js';
import { fmtBytes, sectionHead } from './admin-widgets.js';
// ⚠ confirmDialog 는 정의처(ui-primitives)에서 직접 — admin.ts 배럴을 거치면 순환이 된다(admin-ops 와 같은 이유).
import { confirmDialog } from './ui-primitives.js';

const OWNER_TEXT = { recorded: '', guessed: ' (이름으로 짐작)', unknown: '주인 모름' };
const REASON_TEXT = { install: '저장·설치', publish: '공개' };

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

function appArchivesEditor(detail, _data) {
  ensureStyles();
  const body = el('div');
  detail.replaceChildren(
    sectionHead('앱 보관 표', '앱이 표를 빼거나 칸을 지울 때, 그 안의 데이터를 잃지 않으려고 따로 옮겨 둔 표입니다. 앱은 더 쓰지 않지만 워크스페이스 표 개수 한도에 세어집니다. 비우면 지우기 직전 백업(7일)에 담은 뒤 지웁니다 — 백업에서 다시 되살리지는 않습니다.'),
    el('div', { class: 'card' }, body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
  const picked = new Set<string>();

  async function load() {
    let r;
    try { r = await api('/api/ui/app-archives'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '보관 표를 불러오지 못했습니다: ' + e.message })); return; }
    build(r);
  }

  function build(r) {
    const list = (r.archives || []) as any[];
    for (const n of [...picked]) if (!list.some((a) => a.name === n)) picked.delete(n);
    const lim = r.table_limit || {};
    const summary = el('p', { class: 'storage-calc', text:
      `보관 표 ${list.length}개 · ${fmtBytes(r.bytes || 0)} — 워크스페이스 표 ${(lim.current ?? 0) + (lim.archived ?? 0)}개 / 한도 ${lim.limit ?? '?'}개(쓰는 표 ${lim.current ?? 0} · 보관 표 ${lim.archived ?? 0})` });
    if (!list.length) {
      body.replaceChildren(summary, el('p', { class: 'admin-hint', text: '보관 표가 없습니다.' }));
      return;
    }
    const clearBtn = el('button', { class: 'btn btn-danger btn-sm', type: 'button' }) as HTMLButtonElement;
    const sync = () => { clearBtn.textContent = picked.size ? `고른 ${picked.size}개 비우기` : '비울 표를 고르세요'; clearBtn.disabled = !picked.size; };
    const rows = list.map((a) => {
      const chk = el('input', { type: 'checkbox', 'aria-label': a.name }) as HTMLInputElement;
      chk.checked = picked.has(a.name);
      chk.addEventListener('change', () => { if (chk.checked) picked.add(a.name); else picked.delete(a.name); sync(); });
      const app = a.app_id ? `${a.app_id}${OWNER_TEXT[a.owner] ?? ''}` : OWNER_TEXT.unknown;
      const where = a.kind === 'column'
        ? (a.table && a.column ? `${a.table}.${a.column} 칸의 값` : '지운 칸의 값')
        : (a.table ? `${a.table} 표 통째` : '표 통째');
      return el('tr', {},
        el('td', {}, chk),
        el('td', { text: app }),
        el('td', { text: where, title: a.name }),
        el('td', { text: a.rows == null ? '?' : `${a.rows}행` }),
        el('td', { text: fmtBytes(a.bytes || 0) }),
        el('td', { text: a.archived_at ? relTime(a.archived_at) : '', title: a.archived_at || '' }),
        el('td', { text: a.reason ? (REASON_TEXT[a.reason] ?? a.reason) : '' }));
    });
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
    sync();
    body.replaceChildren(
      summary,
      el('table', { class: 'aa-table' },
        el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: '앱' }), el('th', { text: '무엇' }), el('th', { text: '행' }),
          el('th', { text: '크기' }), el('th', { text: '언제' }), el('th', { text: '까닭' }))),
        el('tbody', {}, ...rows)),
      el('div', { class: 'admin-actions' }, clearBtn));
  }

  load();
}

export { appArchivesEditor };
