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
import { absTime, api, el, errorNote, relTime, renderMarkdown, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
import { confirmDialog } from './ui-primitives.js';
import { diffView, lineDiff, rqEnsureStyles } from './review.js';

const OP_LABEL: Record<string, string> = {
  insert: '문서 생성', update: '본문 수정', set_title: '제목 변경', delete: '삭제', restore: '복원',
  link_category: '분류 지정', unlink_category: '분류 해제', propose_category: '분류 제안',
  set_lifecycle: '상태 변경', set_wiki: 'WIKI 핀', move: '위치 이동', set_props_ui: '표시 설정',
  set_visibility: '공개범위 변경',
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
.kh-cat{flex:none;font-size:11.5px;color:var(--ink-sub);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kh-delta{flex:none;font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
.kh-delta .add{color:var(--mint-deep)}
.kh-delta .del{color:var(--coral-text)}
.kh-ver{flex:none;font-size:11px;color:var(--muted-2);font-variant-numeric:tabular-nums;min-width:52px;text-align:right}
.kh-exp{padding:2px 12px 14px;background:var(--bg-tint)}
.kh-exp-note{font-size:12px;color:var(--ink-sub);margin:0 0 8px}
.kh-exp-acts{display:flex;align-items:center;gap:8px;margin:10px 0 0}
.kh-cur{font-size:11.5px;color:var(--muted);font-weight:700}
.kh-why{display:block;padding:0 12px 9px 88px;font-size:12.5px;color:var(--ink-sub);line-height:1.5}
.kh-why.none{color:var(--muted-2);font-style:italic}
.kh-exp-why{margin:0 0 10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.kh-exp-why h4{margin:0 0 4px;font-size:11px;font-weight:800;color:var(--muted-head);letter-spacing:.03em}
.kh-exp-why p{margin:0;font-size:13px;color:var(--ink);line-height:1.55}
.kh-where{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:12px;color:var(--ink-sub)}
.kh-empty{padding:22px 14px;text-align:center;color:var(--muted);font-size:13px}
.kh-more{display:block;margin:10px auto 0}
.kh-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:0 0 8px}
.kh-seg button{padding:3px 11px;border:0;background:var(--bg);font:inherit;font-size:11.5px;font-weight:700;color:var(--muted-head);cursor:pointer}
.kh-seg button.on{background:var(--bg-punch);color:var(--blue-deep)}
.kh-mdiff{max-height:460px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:4px}
.kh-side{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kh-side-col{min-width:0;border:1px solid var(--line);border-radius:10px;background:var(--bg);overflow:hidden}
.kh-side-h{padding:6px 10px;font-size:11px;font-weight:800;letter-spacing:.02em;border-bottom:1px solid var(--line-row);background:var(--bg-tint);color:var(--muted-head)}
.kh-side-col.after .kh-side-h{color:var(--mint-deep)}
.kh-side-b{max-height:460px;overflow:auto;padding:8px 10px}
.kh-side-b .md{font-size:13.5px}
.kh-side-empty{color:var(--muted-2);font-style:italic;font-size:12.5px}
@media (max-width:900px){ .kh-side{grid-template-columns:1fr} }
.kh-md{position:relative;padding:1px 10px 1px 24px;border-radius:6px}
.kh-md.add{background:rgba(22,199,154,.10);box-shadow:inset 2px 0 0 var(--mint-deep)}
.kh-md.del{background:rgba(228,117,107,.10);box-shadow:inset 2px 0 0 var(--coral-text)}
.kh-md.del .md{opacity:.8}
.kh-md .md{font-size:13.5px}
.kh-md-sig{position:absolute;left:8px;top:5px;font-family:ui-monospace,monospace;font-size:12px;font-weight:800;user-select:none}
.kh-md.add .kh-md-sig{color:var(--mint-deep)}
.kh-md.del .kh-md-sig{color:var(--coral-text)}
.kh-mdskip{display:block;width:100%;text-align:left;padding:4px 10px;margin:3px 0;border:0;border-top:1px solid var(--line-row);border-bottom:1px solid var(--line-row);background:var(--bg-tint);color:var(--muted-2);font:inherit;font-size:11.5px;font-style:italic;cursor:pointer}
.kh-mdskip:hover{color:var(--ink-sub)}
`,
  }));
}

// ── 서식 diff — 줄 diff 를 **같은 유형끼리 묶어(run)** 덩어리마다 마크다운으로 렌더한다. ──
//  왜 덩어리 단위인가: 마크다운은 블록 문법이라 줄 하나씩 렌더하면 표·목록·코드펜스가 전부 부서진다.
//  연속된 추가/삭제/무변경을 한 덩어리로 모아 그 텍스트를 통째로 렌더해야 제목·표가 살아난다.
//  ⚠ 그래도 덩어리가 문법의 중간을 자를 수 있다(표의 구분행만 삭제된 경우 등) — 그럴 때 보라고 '원문' 토글이 있다.
function mdChunk(t: string, text: string): HTMLElement {
  const wrap = el('div', { class: 'kh-md' + (t === '+' ? ' add' : t === '-' ? ' del' : '') });
  if (t !== ' ') wrap.append(el('span', { class: 'kh-md-sig', 'aria-hidden': 'true', text: t }));
  wrap.append(renderMarkdown(text));
  return wrap;
}
function diffViewMd(before: string, after: string): HTMLElement {
  const d = lineDiff(before, after);
  const runs: { t: string; lines: string[] }[] = [];
  for (const l of d) {
    const last = runs[runs.length - 1];
    if (last && last.t === l.t) last.lines.push(l.s);
    else runs.push({ t: l.t, lines: [l.s] });
  }
  const box = el('div', { class: 'kh-mdiff' });
  if (!runs.some((r) => r.t !== ' ')) {
    box.append(el('div', { class: 'rq-dl skip', text: '내용 변화 없음(메타만 변경)' }));
    return box;
  }
  const CTX = 3, COLLAPSE = 8;   // 안 바뀐 긴 구간은 접는다 — 700줄 문서에서 한 줄 고친 걸 찾으려 스크롤하지 않게
  runs.forEach((r, idx) => {
    if (r.t === ' ' && r.lines.length > COLLAPSE) {
      const head = idx === 0 ? [] : r.lines.slice(0, CTX);
      const tail = idx === runs.length - 1 ? [] : r.lines.slice(-CTX);
      const mid = r.lines.slice(head.length, r.lines.length - tail.length);
      if (head.length) box.append(mdChunk(' ', head.join('\n')));
      const bar = el('button', { class: 'kh-mdskip', type: 'button', text: `⋯ 변화 없는 ${mid.length}줄 — 펼치기` });
      bar.onclick = () => bar.replaceWith(mdChunk(' ', mid.join('\n')));
      box.append(bar);
      if (tail.length) box.append(mdChunk(' ', tail.join('\n')));
    } else {
      box.append(mdChunk(r.t, r.lines.join('\n')));
    }
  });
  return box;
}

interface HistoryRow {
  audit_id: number; at: string; op: string; kind: 'content' | 'meta';
  // entity — 이 행이 어느 감사 축에서 왔나(knowledge | org_section). **화면엔 안 보인다**: 사람에겐 같은 문서를
  //  고친 한 사건이고, 어느 화면에서 고쳤는지는 채널(웹/MCP)로 이미 드러난다. 되돌리기 경로만 서버에서 갈린다.
  entity?: string;
  actor: string | null; actor_display: string | null; actor_kind: string | null; channel: string | null;
  version_before: number | null; version_after: number | null;
  added: number; removed: number;
  title_before: string | null; title_after: string | null; title_changed: boolean;
  category_before: string | null; category_after: string | null;
  note: string | null;         // 왜 고쳤는지 — 저장하며 함께 낸 한 줄(#1600)
  session_id: string | null;   // 어디서 고쳤는지 — 그 터미널 세션(#1600)
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
  // 기본은 **서식(마크다운 렌더)** — 사람이 읽는 건 원문이 아니라 문서다. 원문 diff 는 토글로.
  //  패널 단위 상태라 한 행에서 바꾸면 다음에 펼치는 행도 그 모드로 열린다(매번 다시 고르지 않게).
  let viewMode: 'md' | 'raw' | 'side' = 'side';   // #1600 기본 = 전/후 나란히(사람이 가장 먼저 묻는 것이 '뭐가 달라졌나')

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
    // 분류 변경은 ±줄수가 늘 0/0 이라 그 칸이 비어 있다 — 거기에 '무엇에서 무엇으로'를 넣는다(#1563).
    //  before 가 없으면 '→ X' 로만 쓴다: 그건 '분류가 없었다'일 수도, #1563 이전에 쌓여 **before 를 안 남긴**
    //  행일 수도 있어서, 있지도 않은 출발점을 지어내지 않는다.
    const catText = (r.category_before || r.category_after)
      ? (r.category_before ? r.category_before + ' → ' : '→ ') + (r.category_after || '(해제)')
      : '';
    const cat = catText ? el('span', { class: 'kh-cat', text: catText }) : null;
    // 버전 뱃지 — 부제다(§시간축이 1차). version 이 없는 op(표시설정 등)는 아예 안 그린다.
    const ver = el('span', { class: 'kh-ver', text: r.version_after != null ? 'v' + r.version_after : '' });
    const main = el('button', { class: 'kh-main', type: 'button',
      title: absTime(r.at) },
      el('span', { class: 'kh-when', text: relTime(r.at) }),
      // 무변경 update(에디터 자동저장 등)는 서버가 kind='meta' 로 준다 — '본문 수정'이라 쓰면 거짓말이 된다.
      el('span', { class: 'kh-op' + (r.kind === 'meta' ? ' meta' : ''),
        text: r.op === 'update' && r.kind === 'meta' ? '속성만 변경' : (OP_LABEL[r.op] || r.op) }),
      who, cat, delta, ver);
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
        // 받아온 전문을 행에 붙여 둔다 — 서식↔원문 토글이 다시 요청하지 않게(같은 감사행은 불변이다).
        (exp as any)._d = d;
        exp.replaceChildren(...expandedView(r, d, exp));
      } catch (e: any) {
        loaded = false;
        exp.replaceChildren(errorNote(e, '내용을 불러오지 못했습니다'));
      }
    };
    // 왜 고쳤나 — 목록에서 바로 보이게(펼치지 않아도). 안 적었으면 그 사실을 그대로 말한다.
    row.append(main, r.note
      ? el('span', { class: 'kh-why', text: r.note })
      : el('span', { class: 'kh-why none', text: '수정 이유를 적지 않았습니다.' }), exp);
    return row;
  }

  function expandedView(r: HistoryRow, d: any, exp: HTMLElement): any[] {
    const out: any[] = [];
    // ── 왜 고쳤나 ──
    const why = el('div', { class: 'kh-exp-why' }, el('h4', { text: '왜 고쳤나' }));
    why.append(r.note
      ? el('p', { text: r.note })
      : el('p', { style: 'color:var(--muted-2)', text: '이유가 적혀 있지 않습니다. 저장할 때 한 줄로 남기면 여기에 보입니다.' }));
    out.push(why);
    // ── 어디서 고쳤나 — 그 터미널 세션의 대화 기록으로 건너뛴다 ──
    const where = el('div', { class: 'kh-where' },
      el('span', { text: (r.actor_display || r.actor || '알 수 없음') + '님이 ' + absTime(r.at) + '에 '
        + (r.channel === 'mcp' ? 'AI 세션에서' : r.channel === 'web' ? '웹 화면에서' : (CHANNEL_LABEL[r.channel || ''] || '알 수 없는 곳') + '에서') + ' 저장했습니다.' }));
    if (r.session_id) {
      where.append(el('a', { class: 'btn btn-ghost btn-sm', href: '#/sessions/' + encodeURIComponent(r.session_id),
        title: '이 수정이 일어난 AI 세션의 대화 기록을 엽니다', text: '이때 무슨 대화였는지 보기 →' }));
    } else if (r.channel === 'mcp') {
      where.append(el('span', { style: 'color:var(--muted-2)', text: '(세션 기록 없음 — 이 기능이 생기기 전 수정입니다)' }));
    }
    out.push(where);
    if (r.title_changed) {
      out.push(el('p', { class: 'kh-exp-note', text: `제목: ${r.title_before || '(없음)'} → ${r.title_after || '(없음)'}` }));
    }
    // ── 경계 판정은 **본문 스냅샷의 유무**로 한다(스냅샷 객체의 유무가 아니라). ──
    //  link_category 같은 메타 op 은 after 가 `{category_id, state}` 라 객체는 있는데 body_md 가 없다.
    //  객체 유무로 판정하면 그 행이 '이 시점에 문서가 처음 만들어졌습니다'로 표시된다 — 실측으로 잡힌 거짓말이다
    //  (before 가 null 인 건 '문서가 없었다'가 아니라 '이 op 은 본문을 안 남긴다'는 뜻이었다).
    const bBody = d.before && typeof d.before.body_md === 'string' ? d.before.body_md : null;
    const aBody = d.after && typeof d.after.body_md === 'string' ? d.after.body_md : null;
    if (bBody === null && aBody === null) {
      // 분류 변경이면 목록 칩과 같은 정보를 문장으로 한 번 더 — 펼친 사람이 여기서 답을 얻게.
      if (r.category_before || r.category_after) {
        out.push(el('p', { class: 'kh-exp-note',
          text: `분류: ${r.category_before || '(없음)'} → ${r.category_after || '(해제)'}` }));
      }
      out.push(el('p', { class: 'kh-exp-note', text: '이 변경에는 본문 스냅샷이 없습니다(분류·표시 설정 등).' }));
      return out;
    }
    if (bBody === null) out.push(el('p', { class: 'kh-exp-note', text: '이 시점에 문서가 처음 만들어졌습니다.' }));
    if (aBody === null) out.push(el('p', { class: 'kh-exp-note', text: '이 변경으로 문서가 삭제됐습니다.' }));

    // 서식 ↔ 원문 토글. 다시 그리는 건 이 행뿐이고 요청은 없다(전문은 _d 에 이미 있다).
    const seg = el('div', { class: 'kh-seg', role: 'group', 'aria-label': '본문 표시 방식' });
    const mk = (label: string, mode: 'md' | 'raw' | 'side') => el('button', {
      class: viewMode === mode ? 'on' : '', type: 'button', text: label, 'aria-pressed': String(viewMode === mode),
      onclick: () => { if (viewMode === mode) return; viewMode = mode; exp.replaceChildren(...expandedView(r, d, exp)); },
    });
    seg.append(mk('전 · 후 나란히', 'side'), mk('바뀐 줄만', 'md'), mk('원본 텍스트', 'raw'));
    out.push(seg);

    //  전/후 나란히(#1600) — 왼쪽이 고치기 전, 오른쪽이 고친 뒤. 사람이 가장 먼저 묻는 '뭐가 달라졌나'에
    //   바로 답한다(줄 단위 diff 는 어디가 바뀌었는지는 알려주지만 '문서가 어떻게 됐나'는 안 보여준다).
    if (viewMode === 'side') {
      const col = (label: string, body: string | null, cls: string) => {
        const b = el('div', { class: 'kh-side-b' });
        if (body === null) b.append(el('div', { class: 'kh-side-empty', text: '이 시점엔 문서가 없었습니다.' }));
        else if (!body.trim()) b.append(el('div', { class: 'kh-side-empty', text: '(빈 문서)' }));
        else b.append(renderMarkdown(body));
        return el('div', { class: 'kh-side-col ' + cls }, el('div', { class: 'kh-side-h', text: label }), b);
      };
      out.push(el('div', { class: 'kh-side' },
        col('고치기 전', bBody, 'before'),
        col('고친 뒤', aBody, 'after')));
    } else {
      out.push(viewMode === 'md' ? diffViewMd(bBody || '', aBody || '') : diffView(bBody || '', aBody || ''));
    }

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
