// wiki-history.ts — 문서 변경 이력 패널(#1546). 위키 문서의 '갱신 N분 전' 속성을 누르면 열린다.
//
//  데이터는 org_content_audit — 모든 지식 쓰기가 이미 before/after 전문을 남기고 있어서, 새 저장소 없이
//   '문서 한 건의 시간축'으로 읽기만 하면 된다(서버: v6/knowledge-history-store.ts).
//
//  화면 설계:
//   · 시간축이 1차, 버전 번호는 뱃지다 — set_wiki·move·set_props_ui 는 version 을 안 올려서(의도) 같은 번호가
//     여러 행에 걸린다. "v7→v8"을 축으로 삼으면 어긋나 보인다.
//   · 기본은 내용 변경만 — 실측상 감사행의 절반 가까이가 분류(link_category)라, 안 접으면 '누가 본문을
//     고쳤나'가 잡음에 묻힌다. '메타 변경도' 토글로 편다.
//   · 본문은 클릭한 행에서만 — 목록 응답엔 본문이 없다(문서 하나가 감사행 100건 × 30KB 인 사례가 있다).
//   · diff 는 검토 큐 것을 그대로 쓴다(review.ts diffView + .rq-diff 스타일) — 같은 변경에 두 화면이 다른
//     모양을 보이지 않게. classifications.ts 가 rqEnsureStyles 를 재사용하는 것과 같은 관례.
import { absTime, api, el, errorNote, relTime, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
import { confirmDialog } from './ui-primitives.js';
import { diffView, rqEnsureStyles } from './review.js';

const OP_LABEL: Record<string, string> = {
  insert: '문서 생성', update: '본문 수정', set_title: '제목 변경', delete: '삭제', restore: '복원',
  link_category: '분류 지정', unlink_category: '분류 해제', propose_category: '분류 제안',
  set_lifecycle: '상태 변경', set_wiki: 'WIKI 핀', move: '위치 이동', set_props_ui: '표시 설정',
  link_knowledge: '문서 연결', unlink_knowledge: '연결 해제',
  link_source: '자료 연결', unlink_source: '자료 연결 해제',
};
const CHANNEL_LABEL: Record<string, string> = {
  mcp: 'MCP', web: '웹', connector: '커넥터', cli: 'CLI', migration: '마이그레이션', unknown: '기타',
};

function khEnsureStyles(): void {
  rqEnsureStyles();   // .rq-diff/.rq-dl — diff 본체
  if (document.getElementById('kh-styles')) return;
  document.head.appendChild(el('style', {
    id: 'kh-styles',
    text: `
.kh-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.kh-bar .kh-sub{font-size:12px;color:var(--muted);margin-right:auto}
.kh-rows{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.kh-row{border-bottom:1px solid var(--line-row)}
.kh-row:last-child{border-bottom:0}
.kh-main{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;text-align:left;width:100%;background:none;border:0;font:inherit;box-sizing:border-box}
.kh-main:hover{background:var(--bg-tint)}
.kh-row.open .kh-main{background:var(--bg-sel)}
.kh-when{flex:none;font-size:12px;color:var(--ink-sub);min-width:76px}
.kh-op{flex:none;font-size:11px;font-weight:800;padding:2px 7px;border-radius:6px;border:1px solid var(--line);color:var(--ink-sub);background:var(--bg)}
.kh-op.meta{color:var(--muted-2)}
.kh-who{flex:1;min-width:0;font-size:12.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kh-kind{font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:5px;margin-left:6px;border:1px solid var(--line)}
.kh-kind.ai{background:var(--bg-note);border-color:var(--line-note);color:var(--ink-note)}
.kh-kind.human{background:var(--bg-success);border-color:var(--mint-soft,#7FE0C4);color:var(--mint-deep)}
.kh-delta{flex:none;font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
.kh-delta .add{color:var(--mint-deep)}
.kh-delta .del{color:var(--coral-text)}
.kh-ver{flex:none;font-size:11px;color:var(--muted-2);font-variant-numeric:tabular-nums;min-width:52px;text-align:right}
.kh-exp{padding:2px 12px 14px;background:var(--bg-tint)}
.kh-exp-note{font-size:12px;color:var(--ink-sub);margin:0 0 8px}
.kh-exp-acts{display:flex;align-items:center;gap:8px;margin:10px 0 0}
.kh-cur{font-size:11.5px;color:var(--muted);font-weight:700}
.kh-empty{padding:22px 14px;text-align:center;color:var(--muted);font-size:13px}
.kh-more{display:block;margin:10px auto 0}
`,
  }));
}

interface HistoryRow {
  audit_id: number; at: string; op: string; kind: 'content' | 'meta';
  actor: string | null; actor_display: string | null; actor_kind: string | null; channel: string | null;
  version_before: number | null; version_after: number | null;
  added: number; removed: number;
  title_before: string | null; title_after: string | null; title_changed: boolean;
}

// name 문서의 이력 패널을 연다.
//  currentVersion — 지금 화면이 보고 있는 knowledge.version. '이 행이 곧 현재 상태인가'를 정확히 판정해
//   현재 버전에 되돌리기 버튼을 띄우지 않기 위한 값(그 판정을 행 순서로 어림하면 메타 필터 상태에 따라 틀린다).
export function openKnHistory(
  name: string, opts: { canEdit?: boolean; currentVersion?: number | null; onReverted?: () => void } = {},
): void {
  khEnsureStyles();
  const body = el('div', { class: 'kh-panel' }, skeleton('이력을 불러오는 중'));
  const back: any = overlayBox('변경 이력', body);

  let includeMeta = false;
  let offset = 0;
  let total = 0;
  const rows: HistoryRow[] = [];

  const metaChip = el('button', {
    class: 'rq-chip', type: 'button', text: '메타 변경도',
    title: '분류·핀·위치 이동·표시 설정 등 내용이 아닌 변경도 함께 봅니다',
    onclick: () => { includeMeta = !includeMeta; offset = 0; rows.length = 0; load(); },
  });
  const sub = el('span', { class: 'kh-sub' });
  const bar = el('div', { class: 'kh-bar' }, sub, metaChip);
  const list = el('div', { class: 'kh-rows' });
  const moreWrap = el('div');

  async function load(): Promise<void> {
    metaChip.classList.toggle('on', includeMeta);
    if (!rows.length) body.replaceChildren(bar, skeleton('이력을 불러오는 중'));
    try {
      const r = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/history'
        + '?limit=50&offset=' + offset + (includeMeta ? '&include_meta=true' : ''));
      total = Number(r.total || 0);
      rows.push(...((r.entries || []) as HistoryRow[]));
      offset = rows.length;
      paint(!!r.has_more);
    } catch (e: any) {
      body.replaceChildren(bar, errorNote(e, '이력을 불러오지 못했습니다'));
    }
  }

  function paint(hasMore: boolean): void {
    sub.textContent = total
      ? `${total}건${includeMeta ? '' : ' (내용 변경만)'}`
      : (includeMeta ? '기록된 변경이 없습니다' : '내용 변경 기록이 없습니다');
    list.replaceChildren(...(rows.length
      ? rows.map(rowEl)
      : [el('div', { class: 'kh-empty', text: includeMeta
        ? '이 문서에는 기록된 변경이 없습니다.'
        : '본문·제목이 바뀐 적이 없습니다. 분류·핀 같은 변경은 ‘메타 변경도’를 켜서 보세요.' })]));
    moreWrap.replaceChildren(...(hasMore
      ? [el('button', { class: 'btn btn-ghost btn-sm kh-more', type: 'button', text: '더 보기', onclick: () => load() })]
      : []));
    body.replaceChildren(bar, list, moreWrap);
  }

  function whoText(r: HistoryRow): string {
    const who = r.actor_display || r.actor || '알 수 없음';
    const ch = r.channel ? CHANNEL_LABEL[r.channel] || r.channel : '';
    return ch ? `${who} · ${ch}` : who;
  }

  function rowEl(r: HistoryRow): HTMLElement {
    const row = el('div', { class: 'kh-row' });
    const delta = el('span', { class: 'kh-delta' });
    if (r.added) delta.append(el('span', { class: 'add', text: '+' + r.added }));
    if (r.added && r.removed) delta.append(document.createTextNode(' '));
    if (r.removed) delta.append(el('span', { class: 'del', text: '−' + r.removed }));
    const kindBadge = r.actor_kind === 'ai' || r.actor_kind === 'human'
      ? el('span', { class: 'kh-kind ' + r.actor_kind, text: r.actor_kind === 'ai' ? 'AI' : '사람' })
      : null;
    const who = el('span', { class: 'kh-who' }, document.createTextNode(whoText(r)), kindBadge);
    // 버전 뱃지 — 부제다(§시간축이 1차). version 이 없는 op(표시설정 등)는 아예 안 그린다.
    const ver = el('span', { class: 'kh-ver', text: r.version_after != null ? 'v' + r.version_after : '' });
    const main = el('button', { class: 'kh-main', type: 'button',
      title: absTime(r.at) },
      el('span', { class: 'kh-when', text: relTime(r.at) }),
      // 무변경 update(에디터 자동저장 등)는 서버가 kind='meta' 로 준다 — '본문 수정'이라 쓰면 거짓말이 된다.
      el('span', { class: 'kh-op' + (r.kind === 'meta' ? ' meta' : ''),
        text: r.op === 'update' && r.kind === 'meta' ? '속성만 변경' : (OP_LABEL[r.op] || r.op) }),
      who, delta, ver);
    const exp = el('div', { class: 'kh-exp' });
    exp.style.display = 'none';
    let loaded = false;
    (main as any).onclick = async () => {
      const open = exp.style.display !== 'none';
      exp.style.display = open ? 'none' : '';
      row.classList.toggle('open', !open);
      if (open || loaded) return;
      loaded = true;
      exp.replaceChildren(skeleton('내용을 불러오는 중'));
      try {
        const d = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/history/' + r.audit_id);
        exp.replaceChildren(...expandedView(r, d));
      } catch (e: any) {
        loaded = false;
        exp.replaceChildren(errorNote(e, '내용을 불러오지 못했습니다'));
      }
    };
    row.append(main, exp);
    return row;
  }

  function expandedView(r: HistoryRow, d: any): any[] {
    const out: any[] = [];
    if (r.title_changed) {
      out.push(el('p', { class: 'kh-exp-note', text: `제목: ${r.title_before || '(없음)'} → ${r.title_after || '(없음)'}` }));
    }
    // before/after 가 null 인 경계 — '내용이 빈 버전'과 '그 시점엔 문서가 없었음'은 다르다.
    if (!d.before && !d.after) {
      out.push(el('p', { class: 'kh-exp-note', text: '이 변경에는 본문 스냅샷이 없습니다(분류·표시 설정 등).' }));
      return out;
    }
    if (!d.before) out.push(el('p', { class: 'kh-exp-note', text: '이 시점에 문서가 처음 만들어졌습니다.' }));
    if (!d.after) out.push(el('p', { class: 'kh-exp-note', text: '이 변경으로 문서가 삭제됐습니다.' }));
    out.push(diffView((d.before && d.before.body_md) || '', (d.after && d.after.body_md) || ''));

    const isCurrent = opts.currentVersion != null && r.version_after != null && r.version_after === opts.currentVersion;
    const acts = el('div', { class: 'kh-exp-acts' });
    if (isCurrent) {
      acts.append(el('span', { class: 'kh-cur', text: '현재 버전입니다' }));
    } else if (opts.canEdit && d.after) {
      // 되돌리기는 이 행 **직후 상태(after)** 로 간다 = 사람이 목록에서 보고 있는 그 버전.
      //  '이 변경 취소'(before)는 굳이 두 번째 버튼으로 늘리지 않는다 — 마지막 변경 취소는 Cmd+Z(#702)가 이미 한다.
      acts.append(el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: '이 버전으로 되돌리기',
        onclick: async (ev: any) => {
          const btn = ev.currentTarget;
          const ok = await confirmDialog({
            title: '이 버전으로 되돌릴까요?',
            message: `${relTime(r.at)}의 내용(${r.version_after != null ? 'v' + r.version_after : '해당 시점'})을 현재 문서에 다시 적용합니다.`,
            lines: ['지금 본문은 사라지지 않습니다 — 되돌린 결과가 새 버전으로 쌓이고, 이력은 그대로 남습니다.'],
            confirmText: '되돌리기',
          });
          if (!ok) return;
          btn.disabled = true;
          try {
            await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/revert',
              { method: 'POST', body: JSON.stringify({ audit_id: r.audit_id, to: 'after' }) });
            toast('되돌렸습니다 — 새 버전으로 저장됐습니다');
            back.remove();
            if (opts.onReverted) opts.onReverted();
          } catch (e: any) {
            btn.disabled = false;
            toast((e && e.message) || '되돌리지 못했습니다', true);
          }
        },
      }));
    }
    if (acts.childNodes.length) out.push(acts);
    return out;
  }

  load();
}
