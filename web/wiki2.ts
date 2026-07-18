// wiki2.ts — #968 WIKI2 탭: "지식 변경을 검토하는 GitHub". 목적은 정확히 둘 —
//  ① 검증: AI 가 만든/고친 지식(제안)을 사람이 승인해 정본으로 올린다.
//  ② 기록: 지식이 어떻게 변해왔는지 본다(날짜→카테고리, 자연어 요약 우선).
//  두 층위: 정본(사람 저작 · 외부 미러 · 사람이 승인한 것) / 제안(AI 저작 미승인 = pending 지식 + 수정 리비전).
//  데이터·액션은 전부 기존 자산 재사용: #783 검토 큐 API·승인/반려, #802 summary, lineDiff/diffView(review.ts),
//  사이드바(wiki-side — 유지 표면), 민트 틱(wiki-ui). 신규 백엔드는 /wiki2/feed 1본 + summary.by_category 뿐.
//  카드는 5행 고정 문법(설계 wiki2-change-review-tab-design-968 §v2.2):
//  헤더 → 요약(change_note)·계기 → 변경 블록(바뀜/추가/삭제 ≤3, 헤딩 컨텍스트로 파생) → 근거·영향 1줄 → 판정.
//  diff 소스·기호는 기본 화면에 노출하지 않는다 — '원문 비교'는 접힘(사람은 문장으로 판단, 의심될 때만 편다).
import { api, el, errorNote, relTime, renderMarkdown, state, toast } from './core.js';
import { skeleton } from './learn.js';
import { createWikiSide, knApplySideW, knSideResizeHandle } from './wiki-side.js';
import { wkTick } from './wiki-ui.js';
import { diffView, lineDiff, rqEnsureStyles } from './review.js';

// ── 스타일(1회 주입 — styles.css 불가침 관례) ──
function wk2Styles(): void {
  rqEnsureStyles();   // diffView(.rq-diff/.rq-dl) 재사용분
  if (document.getElementById('wk2-styles')) return;
  document.head.appendChild(el('style', { id: 'wk2-styles', text: `
.wk2-main{padding:18px 26px 40px;min-width:0}
.wk2-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.wk2-head h2{font-size:20px;font-weight:800;margin:0;flex:0 1 auto}
.wk2-head .sp{flex:1}
.wk2-vt{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:13px}
.wk2-vt button{font:inherit;padding:6px 16px;border:0;background:var(--bg);color:var(--ink-sub);cursor:pointer}
.wk2-vt button.on{background:var(--bg-tint);color:var(--ink);font-weight:700}
.wk2-layers{font-size:12.5px;color:var(--ink-sub);margin:6px 0 14px}
.wk2-layers b{font-family:ui-monospace,monospace;font-size:13px;color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
.wk2-layers .hu{color:var(--mint-deep)}
.wk2-sechead{display:flex;align-items:baseline;gap:8px;font-size:12.5px;color:var(--ink-sub);font-weight:700;padding:14px 0 6px;border-bottom:1px solid var(--line)}
.wk2-sechead .n{font-family:ui-monospace,monospace;font-weight:600;color:var(--muted-2)}
.wk2-row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line-row);cursor:pointer;font-size:13.5px}
.wk2-row:hover{background:var(--bg-tint)}
.wk2-row.cur{background:var(--bg-sel);box-shadow:inset 3px 0 0 var(--blue)}
.wk2-row .t{font-weight:700;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-row .k{color:var(--ink-sub);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-row .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);white-space:nowrap}
.wk2-row .sp{flex:1}
.wk2-conf{color:var(--coral-text);font-weight:800;font-size:11.5px;white-space:nowrap}
.wk2-pill{flex:none;font-size:10.5px;font-weight:800;padding:1px 8px;border-radius:999px;background:var(--bg-note);border:1px solid var(--line-note);color:var(--ink-note);white-space:nowrap}
.wk2-xp{border:1px solid var(--line);border-radius:12px;margin:8px 0 14px;background:var(--bg);overflow:hidden}
.wk2-xh{display:flex;align-items:baseline;gap:10px;padding:12px 16px 6px;flex-wrap:wrap}
.wk2-xh .t{font-size:15px;font-weight:800;color:var(--ink)}
.wk2-chip{font-size:11px;color:var(--ink-sub);border:1px solid var(--line);border-radius:999px;padding:0 8px;white-space:nowrap}
.wk2-xh .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);margin-left:auto}
.wk2-nl{padding:2px 16px 10px}
.wk2-sum{font-size:14px;font-weight:700;color:var(--ink);margin:4px 0 10px;max-width:70ch;line-height:1.55}
.wk2-sum .lbl{font-family:ui-monospace,monospace;font-size:10px;font-weight:600;color:var(--muted-2);margin-left:8px}
.wk2-chg{border-top:1px solid var(--line-row);padding:9px 0 8px}
.wk2-sect{font-size:12.5px;color:var(--ink);font-weight:700;margin-bottom:6px}
.wk2-op{display:inline-block;font-size:10.5px;font-weight:800;border-radius:5px;padding:0 6px;margin-right:7px;vertical-align:1px;background:var(--bg-tint);border:1px solid var(--line);color:var(--ink-sub)}
.wk2-op.del{background:var(--del-wash,#F7EDEA);border-color:var(--line);color:var(--coral-text)}
.wk2-ba{display:grid;grid-template-columns:32px 1fr;gap:4px 12px;font-size:13.5px;max-width:74ch}
.wk2-ba .lab{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2);padding-top:3px}
.wk2-ba .prev{color:var(--muted);min-width:0}
.wk2-ba .next{color:var(--ink);min-width:0}
.wk2-gone{color:var(--muted-2);text-decoration:line-through;text-decoration-color:var(--coral-text)}
.wk2-markt{background:var(--bg-punch,#EDF2FC);color:var(--blue-deep);padding:0 3px;border-radius:3px;font-weight:700}
.wk2-mdclip{max-height:220px;overflow:auto}
.wk2-mdclip .md-rendered p{margin:.3em 0}
.wk2-more{font-size:12px;color:var(--ink-sub);cursor:pointer;padding:6px 0 0}
.wk2-warn{margin:8px 0 0;padding:7px 10px;border:1px solid var(--line-note);border-radius:9px;background:var(--bg-note);font-size:12px;color:var(--ink-note)}
.wk2-evi{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;border-top:1px solid var(--line-row);padding:9px 16px;font-size:12.5px;color:var(--ink)}
.wk2-evi .lbl{font-family:ui-monospace,monospace;font-size:10px;font-weight:600;color:var(--muted-2);margin-right:2px}
.wk2-evi .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2)}
.wk2-evi .cap{color:var(--muted-2);font-size:11px;flex-basis:100%}
.wk2-raw{border-top:1px dashed var(--line);color:var(--muted-2);font-size:11px;font-family:ui-monospace,monospace;padding:7px 16px;cursor:pointer;user-select:none}
.wk2-raw:hover{color:var(--ink-sub)}
.wk2-rawbox{padding:0 16px 12px}
.wk2-act{display:flex;gap:10px;align-items:center;padding:10px 16px 14px;border-top:1px solid var(--line-row)}
.wk2-act .more{margin-left:auto;font-size:12px;color:var(--muted-2)}
.wk2-act .more a,.wk2-act .more button{font:inherit;font-size:12px;color:var(--ink-sub);background:none;border:0;cursor:pointer;padding:0 4px}
.wk2-day{margin-top:2px}
.wk2-dayh{display:flex;align-items:baseline;gap:10px;padding:16px 0 5px;border-bottom:1px solid var(--line);font-size:13.5px;font-weight:800;color:var(--ink)}
.wk2-dayh .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);font-weight:400}
.wk2-dom{font-size:11.5px;color:var(--muted-head);font-weight:800;padding:10px 0 2px}
.wk2-trow{display:flex;align-items:center;gap:10px;padding:6px 2px;font-size:13px;border-bottom:1px solid var(--line-row)}
.wk2-trow .tm{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);width:40px;flex:none}
.wk2-trow .t{font-weight:700;color:var(--ink);text-decoration:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-trow .t:hover{color:var(--blue-deep)}
.wk2-trow .k{color:var(--ink-sub);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-trow .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);white-space:nowrap}
.wk2-trow .sp{flex:1}
.wk2-mirror{margin:8px 0 2px;border:0;background:var(--bg-tint);border-radius:8px;font-size:12.5px;color:var(--ink-sub)}
.wk2-mirror summary{padding:7px 12px;cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center}
.wk2-mirror summary::-webkit-details-marker{display:none}
.wk2-mirror .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2)}
.wk2-mirror .wk2-trow{padding-left:12px;padding-right:12px;border-bottom:0}
.wk2-endmark{margin:20px 0 0;padding:10px 0;text-align:center;color:var(--muted-2);font-size:12px;border-top:1px dashed var(--line)}
.wk2-empty{padding:26px 2px;font-size:13.5px;color:var(--ink-sub)}
.wk2-empty .big{font-size:14.5px;font-weight:700;color:var(--ink);margin-bottom:4px}
.wk2-okdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mint,#0FB07E);margin-right:7px}
.wk2-navn{display:none}
.wk2-navn.on{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:800;
  font-variant-numeric:tabular-nums;color:var(--ink-note);background:var(--bg-note);border:1px solid var(--line-note)}
.wk2-cnt{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:800;
  font-variant-numeric:tabular-nums;color:var(--ink-note);background:var(--bg-note);border:1px solid var(--line-note);flex:none}
.wk2-kbd{margin-top:14px;font-size:11px;color:var(--muted-2);font-family:ui-monospace,monospace}
` }));
}

// ── 상단 탭 배지 — 검토 대기 총계(0이면 숨김, #802 관례). 60s 스로틀(라우팅마다 서버를 두드리지 않는다). ──
let wk2BadgeAt = 0;
export async function refreshWiki2NavBadge(n?: number): Promise<void> {
  wk2Styles();
  const sp = document.getElementById('wiki2-navn');
  if (!sp) return;
  let total = n;
  if (total == null) {
    if (Date.now() - wk2BadgeAt < 60_000) return;
    wk2BadgeAt = Date.now();
    try { const s = await api('/api/ui/review-queue/summary'); total = Number((s && s.total) || 0); }
    catch { total = 0; }   // memory scope 없음(403) 등 — 배지 없이 조용히
  } else wk2BadgeAt = Date.now();
  sp.textContent = total > 0 ? String(total) : '';
  sp.classList.toggle('on', total > 0);
}

// ── 큐 아이템(#783 큐 API 2본을 한 목록으로 — review.ts 와 동일 병합 규칙) ──
interface W2Item {
  key: string; kind: 'new' | 'edit'; name: string; title: string;
  cat: string; catName: string; whoKind: 'ai' | 'human' | 'connector'; who: string; agent: string | null;
  at: string; note: string | null;
  revId?: number; mode?: string; added?: number; removed?: number; conflict?: boolean; edits?: number;
}

// 큐 API 의 시각은 String(Date)("Thu Jul 16 2026 …") 포맷 — 피드(ISO)와 섞어 정렬하면 요일 이름끼리 비교돼 깨진다 → ISO 로 정규화.
const isoAt = (v: any): string => { const d = new Date(v); return isNaN(+d) ? String(v ?? '') : d.toISOString(); };

async function fetchQueue(): Promise<W2Item[]> {
  const [pk, pr] = await Promise.all([
    api('/api/ui/knowledge?lifecycle=pending&orderBy=updated_at&limit=500'),
    api('/api/ui/knowledge-revisions?status=pending&limit=500'),
  ]);
  const pending = (pk && pk.entries) || [];
  const revs = (pr && pr.entries) || [];
  return [
    ...pending.map((k: any): W2Item => ({
      key: 'new:' + k.name, kind: 'new', name: k.name, title: k.title || k.name,
      cat: k.category_key || '', catName: k.category_name || '미분류',
      whoKind: k.confidence === 'ai' ? 'ai' : (k.provenance === 'observed' ? 'connector' : 'human'),
      who: k.provenance === 'observed' ? (k.source || '자료 수집기') : (k.updated_by || '—'),
      agent: null, at: isoAt(k.updated_at), note: k.summary || null,
    })),
    ...revs.map((r: any): W2Item => ({
      key: 'rev:' + r.id, kind: 'edit', name: r.name, title: r.title || r.name,
      cat: r.category_key || '', catName: r.category_name || '미분류',
      whoKind: r.actor_kind === 'ai' ? 'ai' : 'human', who: r.proposed_by || '—', agent: r.agent || null,
      at: isoAt(r.updated_at), note: r.note || null,
      revId: r.id, mode: r.mode, added: r.added, removed: r.removed, conflict: !!r.conflict, edits: r.edits,
    })),
  ];
}

// ── 변경 블록 파생 — lineDiff 헝크를 헤딩 컨텍스트로 묶는다(클라 파생, 백엔드 0). ──
//  블록 어휘는 3개 고정: 바뀜(±) / 추가(+만) / 삭제(−만). 5행 카드 문법의 3행.
interface W2Block { op: '바뀜' | '추가' | '삭제'; heading: string; before: string[]; after: string[] }
function deriveBlocks(before: string, after: string): W2Block[] {
  const d = lineDiff(before, after);
  const blocks: W2Block[] = [];
  let heading = '';
  let cur: W2Block | null = null;
  const flush = () => { if (cur && (cur.before.length || cur.after.length)) blocks.push(cur); cur = null; };
  for (const l of d) {
    const h = /^(#{1,6})\s+(.*)/.exec(l.s || '');
    if (l.t === ' ') {
      flush();
      if (h) heading = h[2];
      continue;
    }
    // 헝크가 새 헤딩 줄로 시작하면 그 헤딩이 블록의 이름(새 절 추가/삭제의 대표 케이스).
    //  헝크 중간에 헤딩이 나오면 블록을 쪼갠다 — "문장 수정 + 새 절 추가"가 한 덩어리로 합쳐지지 않게(#968 v2.2: 블록=섹션 단위).
    if (h && cur && (cur.before.length || cur.after.length)) flush();
    if (!cur) cur = { op: '바뀜', heading: h ? h[2] : heading, before: [], after: [] };
    if (l.t === '-') cur.before.push(l.s); else cur.after.push(l.s);
  }
  flush();
  for (const b of blocks) b.op = b.before.length && b.after.length ? '바뀜' : (b.after.length ? '추가' : '삭제');
  return blocks;
}

// 단어 강조 — 1줄↔1줄 치환일 때만 문자 prefix/suffix 를 깎아 바뀐 가운데만 표시(그 외엔 통문장).
function wordSpans(a: string, b: string): { prev: any; next: any } | null {
  if (!a || !b || a === b) return null;
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  if (ea - s > a.length * 0.9 && eb - s > b.length * 0.9) return null;   // 사실상 전체 교체 — 강조 무의미
  return {
    prev: el('span', {}, el('span', { text: a.slice(0, s) }), el('span', { class: 'wk2-gone', text: a.slice(s, ea) }), el('span', { text: a.slice(ea) })),
    next: el('span', {}, el('span', { text: b.slice(0, s) }), el('span', { class: 'wk2-markt', text: b.slice(s, eb) }), el('span', { text: b.slice(eb) })),
  };
}

const clip = (s: string, n = 700): string => (s.length > n ? s.slice(0, n) + ' …' : s);
function mdClip(text: string) {
  return el('div', { class: 'wk2-mdclip md-rendered' }, renderMarkdown(clip(text) || '(없음)'));
}

// 구조 요약(폴백) — change_note 가 없을 때: 블록들에서 "『헤딩』 추가 · 『헤딩』 바뀜" 문장을 만든다.
function structSummary(blocks: W2Block[], added?: number, removed?: number): string {
  if (!blocks.length) return '내용 변화 없음(메타만 변경)';
  const parts = blocks.slice(0, 3).map((b) => (b.heading ? `『${b.heading}』 ` : '본문 ') + b.op);
  const size = added != null ? ` (+${added} −${removed ?? 0})` : '';
  return parts.join(' · ') + (blocks.length > 3 ? ` 외 ${blocks.length - 3}곳` : '') + size;
}

// ── 검증 카드(5행 문법) — 행 클릭 제자리 펼침. ──
async function fillCard(box: HTMLElement, it: W2Item, drop: (k: string) => void): Promise<void> {
  try {
    const [detail, kd] = await Promise.all([
      it.kind === 'edit' ? api('/api/ui/knowledge-revisions/' + it.revId) : Promise.resolve(null),
      api('/api/ui/knowledge/' + encodeURIComponent(it.name)).catch(() => null),
    ]);
    const k = (kd && kd.knowledge) || {};
    const nl = el('div', { class: 'wk2-nl' });

    // 행2 — 요약(제안자 change_note) 또는 구조 요약 폴백. 있는 척 금지: 폴백은 라벨로 구분.
    let before = '', after = '', mode = it.mode || '';
    if (it.kind === 'edit' && detail) {
      const rev = detail.revision, cur = detail.current;
      if (!cur) {
        box.replaceChildren(el('div', { class: 'wk2-nl' }, el('p', { class: 'wk2-warn', text: '대상 지식이 삭제되었습니다 — 반려로 정리하세요.' })));
        return;
      }
      mode = rev.mode;
      before = rev.mode === 'staged' ? (cur.body_md || '') : (rev.base_body_md || '');
      after = rev.mode === 'staged' ? (rev.new_body_md || '') : (cur.body_md || '');
      const blocks = deriveBlocks(before, after);
      nl.append(el('div', { class: 'wk2-sum' },
        el('span', { text: rev.note || structSummary(blocks, it.added, it.removed) }),
        el('span', { class: 'lbl', text: rev.note ? '제안 요약' : '구조 요약(요약 미제출)' })));
      if (it.conflict) {
        nl.append(el('p', { class: 'wk2-warn', text: '⚠ 제안 이후 라이브 본문이 또 바뀌었습니다 — 승인하면 그 변경을 이 제안본으로 덮어씁니다. 원문 비교로 확인하세요.' }));
      }
      // 행3 — 변경 블록(≤3, 초과분 펼침).
      const renderBlock = (b: W2Block) => {
        const sect = el('div', { class: 'wk2-sect' },
          el('span', { class: 'wk2-op' + (b.op === '삭제' ? ' del' : ''), text: b.op }),
          el('span', { text: b.heading || '본문' }));
        const kids: any[] = [sect];
        const bf = b.before.filter((s) => s.trim()), af = b.after.filter((s) => s.trim());
        const ws = b.op === '바뀜' && bf.length === 1 && af.length === 1 ? wordSpans(bf[0], af[0]) : null;
        if (b.op === '바뀜') {
          kids.push(el('div', { class: 'wk2-ba' },
            el('span', { class: 'lab', text: '이전' }),
            el('span', { class: 'prev' }, ws ? ws.prev : mdClip(b.before.join('\n'))),
            el('span', { class: 'lab', text: '이후' }),
            el('span', { class: 'next' }, ws ? ws.next : mdClip(b.after.join('\n')))));
        } else if (b.op === '추가') {
          kids.push(mdClip(b.after.join('\n')));
        } else {
          kids.push(el('div', { class: 'wk2-ba' },
            el('span', { class: 'lab', text: '삭제' }),
            el('span', { class: 'prev' }, mdClip(b.before.join('\n')))));
        }
        return el('div', { class: 'wk2-chg' }, ...kids);
      };
      blocks.slice(0, 3).forEach((b) => nl.append(renderBlock(b)));
      if (blocks.length > 3) {
        const more = el('div', { class: 'wk2-more', text: `${blocks.length - 3}곳 더 ▸` });
        more.onclick = () => { blocks.slice(3).forEach((b) => nl.insertBefore(renderBlock(b), more)); more.remove(); };
        nl.append(more);
      }
    } else {
      // 신규 제안 — 요약(summary) + 본문 프리뷰 + 중복 경고(#783 재사용).
      nl.append(el('div', { class: 'wk2-sum' },
        el('span', { text: it.note || (k.summary || '새 지식 제안') }),
        el('span', { class: 'lbl', text: '신규 제안' })));
      try {
        const sim = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: it.name, limit: '3' }));
        const hits = ((sim && sim.similar) || []).filter((s: any) => Number(s.score) >= 0.6);
        if (hits.length) {
          const strip = el('p', { class: 'wk2-warn' }, el('span', { text: '⚠ 비슷한 기존 지식이 있습니다 — 중복이면 반려하세요: ' }));
          hits.forEach((h: any, i: number) => {
            if (i) strip.append(el('span', { text: ' · ' }));
            strip.append(el('a', { href: '#/k/' + encodeURIComponent(h.name), text: (h.title || h.name) + ' (' + Math.round(Number(h.score) * 100) + '%)' }));
          });
          nl.append(strip);
        }
      } catch (_) { /* 임베딩 off */ }
      nl.append(el('div', { class: 'wk2-chg' },
        el('div', { class: 'wk2-sect' }, el('span', { class: 'wk2-op', text: '추가' }), el('span', { text: '전체 본문' })),
        mdClip(k.body_md || '(본문 없음)')));
    }

    // 행4 — 근거·영향 1줄. 근거는 개수가 아니라 이름+나이("이 지식의 출처" — 변경 단위 근거 연결은 아직 없다는 사실을 캡션으로).
    const evi = el('div', { class: 'wk2-evi' });
    const srcs: any[] = Array.isArray(k.sources) ? k.sources : [];
    const srcSpan = el('span', {}, el('span', { class: 'lbl', text: '출처' }));
    if (srcs.length) {
      srcs.slice(0, 3).forEach((s: any, i: number) => {
        if (i) srcSpan.append(el('span', { text: ' · ' }));
        srcSpan.append(el('span', { text: ' ' + (s.title || s.name || s.kind || '자료') + ' ' }),
          el('span', { class: 'm', text: s.occurred_at ? relTime(s.occurred_at) : '' }));
      });
      if (srcs.length > 3) srcSpan.append(el('span', { class: 'm', text: ` 외 ${srcs.length - 3}` }));
    } else srcSpan.append(el('span', { text: ' 연결된 출처 없음', style: 'color:var(--muted-2)' }));
    if (k.external_url) srcSpan.append(el('span', { text: ' · ' }), el('a', { href: String(k.external_url), target: '_blank', rel: 'noopener', text: '원본 열기 ↗' }));
    evi.append(srcSpan);
    const links = (k.links || {}) as any;
    const backN = Array.isArray(links.incoming) ? links.incoming.length : 0;
    const contraN = ([] as any[]).concat(links.incoming || [], links.outgoing || []).filter((l: any) => l.relation === 'contradicts').length;
    evi.append(el('span', {},
      el('span', { class: 'lbl', text: '영향' }),
      el('span', { text: ` 참조 ${backN}건 ` }),
      el('span', { class: 'm', text: '(자동 갱신되지 않음)' }),
      contraN ? el('span', { class: 'wk2-conf', text: ` · 충돌 ${contraN}` }) : null));
    evi.append(el('span', { class: 'cap', text: '출처는 지식 전체에 연결된 것입니다 — 이 변경만의 근거 연결은 아직 없습니다.' }));

    // 원문 비교 — 접힘(diff 는 의심될 때만).
    const rawT = it.kind === 'edit'
      ? el('div', { class: 'wk2-raw', text: `원문 비교(+${it.added ?? 0} −${it.removed ?? 0}${(it.edits || 1) > 1 ? ` · ${it.edits}회 누적 — 비교 기준은 최초 수정 전` : ''}) ▸` })
      : null;
    const rawBox = el('div', { class: 'wk2-rawbox', hidden: true });
    if (rawT) rawT.onclick = () => {
      const open = rawBox.hidden;
      rawBox.hidden = !open;
      rawT.textContent = rawT.textContent!.replace(open ? '▸' : '▾', open ? '▾' : '▸');
      if (open && !rawBox.childNodes.length) rawBox.append(diffView(before, after));
    };

    // 행5 — 판정. 동사는 mode 가 정한다(검토 대기=승인·반영 / 사후확인=확인·되돌리기).
    const applied = mode === 'applied';
    const ok = el('button', { class: 'btn btn-primary btn-sm', text: it.kind === 'new' ? '승인 · 반영' : (applied ? '확인 (이상 없음)' : '승인 · 반영') }) as HTMLButtonElement;
    const no = el('button', { class: 'btn btn-ghost btn-sm', text: it.kind === 'new' ? '반려' : (applied ? '되돌리기' : '반려 · 폐기') }) as HTMLButtonElement;
    ok.onclick = () => void w2Approve(it, drop);
    no.onclick = () => void w2Reject(it, drop);
    const act = el('div', { class: 'wk2-act' }, ok, no,
      el('span', { class: 'more' },
        el('a', { href: '#/k/' + encodeURIComponent(it.name), text: '⋯ 직접 수정으로 대체', title: 'WIKI 편집기에서 최종본을 직접 저장한 뒤, 이 제안은 반려로 닫으세요 — 제안본을 승인하면 직접 수정이 덮입니다.' })));
    box.replaceChildren(...[nl, evi, rawT, rawBox, act].filter(Boolean) as any[]);
  } catch (e) {
    box.replaceChildren(errorNote(e, '내용을 불러오지 못했습니다'));
  }
}

// ── 판정(엔드포인트는 #783 그대로) ──
async function w2Approve(it: W2Item, drop: (k: string) => void): Promise<void> {
  try {
    if (it.kind === 'new') {
      await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
      toast('승인 — 정본에 반영했습니다');
    } else {
      await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
      toast(it.mode === 'staged' ? '승인 — 수정을 반영했습니다' : '확인 — 검토 완료로 표시했습니다');
    }
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}
async function w2Reject(it: W2Item, drop: (k: string) => void): Promise<void> {
  const msg = it.kind === 'new'
    ? '이 지식을 반려할까요? 휴지통으로 이동하며 복원할 수 있습니다.'
    : it.mode === 'staged'
      ? '이 수정 제안을 반려할까요? 라이브 본문은 바뀌지 않습니다(제안만 폐기).'
      : '이 수정을 되돌릴까요? 라이브 본문이 수정 전 상태로 복구됩니다.';
  if (!confirm(msg)) return;
  try {
    if (it.kind === 'new') {
      await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/delete', { method: 'POST' });
      toast('반려했습니다(휴지통)');
    } else {
      await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'reject' }) });
      toast(it.mode === 'staged' ? '제안을 반려했습니다' : '수정을 되돌렸습니다');
    }
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

// ── 키보드(j/k/Enter/a/r — #783 관례, 자가 해제) ──
let wk2Keys: AbortController | null = null;
function installWk2Keys(listBox: HTMLElement, visible: () => W2Item[], ui: any, paint: () => void, drop: (k: string) => void): void {
  if (wk2Keys) wk2Keys.abort();
  wk2Keys = new AbortController();
  const inEditable = (t: any): boolean => {
    const e = (t && t.nodeType === 1 ? t : document.activeElement) as HTMLElement | null;
    return !!(e && e.closest && e.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .be, .xterm'));
  };
  document.addEventListener('keydown', (e: any) => {
    if (!document.body.contains(listBox)) { wk2Keys?.abort(); wk2Keys = null; return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inEditable(e.target)) return;
    const vis = visible();
    if (!vis.length) return;
    const cur = () => vis[Math.min(ui.cur, vis.length - 1)];
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); ui.cur = Math.min(vis.length - 1, ui.cur + 1); paint(); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); ui.cur = Math.max(0, ui.cur - 1); paint(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = cur(); if (!it) return;
      if (ui.open.has(it.key)) ui.open.delete(it.key); else ui.open.add(it.key);
      paint(); return;
    }
    if (e.key === 'a') { e.preventDefault(); const it = cur(); if (it) void w2Approve(it, drop); return; }
    if (e.key === 'r') { e.preventDefault(); const it = cur(); if (it) void w2Reject(it, drop); return; }
  }, { signal: wk2Keys.signal });
}

// ── 사이드바 카테고리 배지 — summary.by_category(key)를 트리 행(data-cat-val=id)에 얹는다(멱등). ──
function applySideBadges(sideEl: HTMLElement, bySpace: any, byCat: { key: string | null; n: number }[]): void {
  sideEl.querySelectorAll('.wk2-cnt').forEach((n) => n.remove());
  const keyToId = new Map<string, string>();
  for (const sk of ['business', 'product', 'system']) {
    for (const c of (bySpace[sk] || [])) keyToId.set(String(c.key), String(c.id));
  }
  for (const bc of byCat || []) {
    if (!bc.key || !bc.n) continue;
    const id = keyToId.get(String(bc.key));
    if (!id) continue;
    const row = sideEl.querySelector(`.kn-nav-cat[data-cat-val="${id}"] .pjv-side-navlabel`);
    if (row) row.after(el('span', { class: 'wk2-cnt', title: '검토 대기 ' + bc.n + '건', text: String(bc.n) }));
  }
}

// ════════ 라우터 진입 — #/wiki2(검증) · #/wiki2/history(기록) · ?cat=<카테고리 id> ════════
export async function renderWiki2(view: any, sub: string, params: URLSearchParams): Promise<void> {
  wk2Styles();
  const f = ((state as any).wiki2 = (state as any).wiki2 || { cat: '', by: '' });
  const mode: 'verify' | 'history' = sub === 'history' ? 'history' : 'verify';
  // 필터 상태 = URL(설계 §2). 파라미터 없는 맨 진입은 전체로 리셋(WIKI 관례).
  if (params && params.has('cat')) f.cat = params.get('cat') || '';
  else if (!params || Array.from(params.keys()).length === 0) { f.cat = ''; f.by = ''; }
  if (params && params.has('by')) f.by = params.get('by') || '';

  view.replaceChildren(el('div', { class: 'wk2-main' }, skeleton('WIKI2 를 여는 중')));

  function syncHash(m: 'verify' | 'history') {
    const p = new URLSearchParams();
    if (f.cat) p.set('cat', f.cat);
    if (m === 'history' && f.by) p.set('by', f.by);
    const qs = p.toString();
    history.replaceState(null, '', '#/wiki2' + (m === 'history' ? '/history' : '') + (qs ? '?' + qs : ''));
  }

  const main = el('section', { class: 'wk2-main' });
  const sideCtl = createWikiSide({
    selected: () => f.cat,
    onSelect: (v: string) => { f.cat = v || ''; syncHash(mode); sideCtl.rebuild(); void repaint(); },
    tools: false,   // 도구 섹션의 '검토 대기' 링크는 구 큐 — 이 탭 자체가 그 표면이라 중복 노출하지 않는다
  });

  let byCat: { key: string | null; n: number }[] = [];
  let mineKeys: string[] = [];
  let queueTotal = 0;

  async function loadSummary(): Promise<void> {
    try {
      const s = await api('/api/ui/review-queue/summary');
      byCat = (s && s.by_category) || [];
      mineKeys = (s && s.mine_category_keys) || [];
      queueTotal = Number((s && s.total) || 0);
    } catch (_) { byCat = []; mineKeys = []; queueTotal = 0; }
    void refreshWiki2NavBadge(queueTotal);
    applySideBadges(sideCtl.side, sideCtl.bySpace(), byCat);
  }

  const catObj = () => sideCtl.findCat(f.cat);
  const headTitle = () => (catObj() ? (catObj().name || catObj().key) : '전체');

  // ── 헤더(공용) — 이름 + [검증 N][기록] 토글 + 층위 한 줄(정본/제안). ──
  function headEl(m: 'verify' | 'history', verifyN: number, canonN: number | null, proposalN: number, extra?: any) {
    const bt = (key: 'verify' | 'history', label: string) => {
      const b = el('button', { class: key === m ? 'on' : '', text: label });
      b.onclick = () => {
        if (key === m) return;
        syncHash(key);
        void renderWiki2(view, key === 'history' ? 'history' : '', new URLSearchParams(location.hash.split('?')[1] || ''));
      };
      return b;
    };
    return el('div', {},
      el('div', { class: 'wk2-head' },
        el('h2', { text: headTitle() }),
        el('span', { class: 'sp' }),
        extra || null,
        el('div', { class: 'wk2-vt' }, bt('verify', '검증' + (verifyN ? ' ' + verifyN : '')), bt('history', '기록'))),
      el('div', { class: 'wk2-layers' },
        el('span', { class: 'hu' }, el('span', { text: '● 정본 ' }), el('b', { text: canonN == null ? '—' : String(canonN) })),
        el('span', { text: '  ·  제안 ' }), el('b', { text: String(proposalN) })));
  }

  // ── 검증 뷰 ──
  async function paintVerify(box: HTMLElement): Promise<void> {
    box.replaceChildren(skeleton('검증 대기 항목을 불러오는 중'));
    let items: W2Item[] = [];
    let canonN: number | null = null;
    // 게이트 상태 — 빈 상태가 '왜 비었는지'를 말해야 한다(설계 빈 상태 A: 결함이 아니라 선택된 다이얼 상태).
    //  정책 조회는 admin 전용이라 403 이면 null(판정 불가 — 일반 안내로 폴백).
    let gateOn: boolean | null = null;
    try {
      const catQ = f.cat ? '&category=' + encodeURIComponent(f.cat) : '';
      const [qItems, kc, pol] = await Promise.all([
        fetchQueue(),
        api('/api/ui/knowledge?limit=1' + catQ).catch(() => null),
        api('/api/ui/org/ingest-policy').catch(() => null),
      ]);
      items = qItems;
      canonN = kc ? Number(kc.total ?? 0) : null;
      if (pol) {
        const ps = (pol.policies || []) as any[];
        gateOn = ps.some((p) => p.enabled);   // 프리셋이든 세부 규칙이든 켜진 게 하나라도 있으면 게이트 작동 중
      }
    } catch (e) {
      box.replaceChildren(errorNote(e, '검증 대기 항목을 불러오지 못했습니다 — 검토 권한(memory)이 필요합니다'));
      return;
    }
    const selKey = catObj() ? String(catObj().key) : '';
    const inCat = (i: W2Item) => (!selKey ? true : i.cat === selKey);
    const all = items.filter(inCat);
    // 검토 대기(신규 + staged 수정)와 사후확인(applied)은 절대 섞지 않는다 — 검토 피로의 최대 변수.
    const waiting = all.filter((i) => !(i.kind === 'edit' && i.mode === 'applied'))
      .sort((a, b) => Number(!!b.conflict) - Number(!!a.conflict) || String(a.at).localeCompare(String(b.at)));   // 충돌 → 오래된 순(FIFO)
    const applied = all.filter((i) => i.kind === 'edit' && i.mode === 'applied')
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const ui = ((state as any).wiki2ui = (state as any).wiki2ui || { cur: 0, open: new Set<string>() });
    const ordered = () => [...waiting, ...applied];

    const listBox = el('div', {});
    const drop = (key: string) => {
      const idxW = waiting.findIndex((x) => x.key === key);
      if (idxW >= 0) waiting.splice(idxW, 1);
      const idxA = applied.findIndex((x) => x.key === key);
      if (idxA >= 0) applied.splice(idxA, 1);
      ui.open.delete(key);
      queueTotal = Math.max(0, queueTotal - 1);
      void refreshWiki2NavBadge(queueTotal);
      void loadSummary();
      paint();
    };

    const row = (it: W2Item, idx: number) => {
      const open = ui.open.has(it.key);
      const r = el('div', { class: 'wk2-row' + (ui.cur === idx ? ' cur' : ''), 'data-key': it.key },
        wkTick({ confidence: it.whoKind === 'human' ? 'human' : null, provenance: it.whoKind === 'connector' ? 'observed' : null }),
        el('span', { class: 't', text: it.title }),
        el('span', { class: 'k', text: it.note || (it.kind === 'new' ? '신규 제안' : (it.mode === 'applied' ? '수정 반영됨' : '수정 제안')) }),
        it.conflict ? el('span', { class: 'wk2-conf', text: '경합' }) : null,
        (it.edits || 1) > 1 ? el('span', { class: 'm', text: '×' + it.edits }) : null,
        el('span', { class: 'sp' }),
        el('span', { class: 'm', text: (it.agent || it.who) + ' · ' + relTime(it.at) }),
        el('span', { class: 'm', text: open ? '▾' : '▸' }));
      r.onclick = () => { ui.cur = idx; if (ui.open.has(it.key)) ui.open.delete(it.key); else ui.open.add(it.key); paint(); };
      const parts: any[] = [r];
      if (open) {
        const card = el('div', { class: 'wk2-xp' },
          el('div', { class: 'wk2-xh' },
            el('span', { class: 't', text: it.title }),
            el('span', { class: 'wk2-chip', text: it.kind === 'new' ? '신규 제안' : (it.mode === 'applied' ? '반영됨 · 사후확인' : '수정 제안') }),
            el('span', { class: 'm', text: (it.agent ? it.agent + ' · ' : '') + it.who + ' · ' + relTime(it.at) }),
          ),
          el('div', { class: 'wk2-cardbody' }, skeleton('불러오는 중')));
        const body = card.querySelector('.wk2-cardbody') as HTMLElement;
        void fillCard(body, it, drop);
        parts.push(card);
      }
      return parts;
    };

    const paint = () => {
      const ord = ordered();
      if (ui.cur >= ord.length) ui.cur = Math.max(0, ord.length - 1);
      const kids: any[] = [];
      kids.push(headEl('verify', waiting.length + applied.length, canonN, all.length));
      if (!ord.length) {
        const historyLink = () => { const a = el('a', { href: '#', text: '기록' }); a.onclick = (e: any) => { e.preventDefault(); syncHash('history'); void renderWiki2(view, 'history', new URLSearchParams('cat=' + f.cat)); }; return a; };
        if (gateOn === false) {
          // 빈 상태 A — 게이트 전부 auto: 대기가 비는 게 '정상 상태'임을 말한다(결함이 아니라 선택된 다이얼).
          kids.push(el('div', { class: 'wk2-empty' },
            el('div', { class: 'big', text: '지금은 모든 AI 변경이 검증 없이 즉시 반영되고 있습니다' }),
            el('div', {},
              el('span', { text: '사람 확인을 거치게 하려면 지식 검토 게이트를 켜세요 — ' }),
              el('a', { href: '#/system/ingest-policy', text: '게이트 정책 설정 →' })),
            el('div', { class: 'wk2-kbd', style: 'margin-top:8px' },
              el('span', { text: '켜면 이후의 AI 신규·수정 제안이 여기 쌓이고, 승인해야 정본에 반영됩니다. 최근 변화는 ' }), historyLink(), el('span', { text: ' 에서.' }))));
        } else {
          kids.push(el('div', { class: 'wk2-empty' },
            el('div', { class: 'big' }, el('span', { class: 'wk2-okdot' }), el('span', { text: '검증할 것이 없습니다' })),
            el('div', {},
              gateOn == null ? el('span', { text: '게이트가 꺼져 있으면 AI 변경이 검증 없이 바로 반영됩니다(관리자가 설정). ' }) : null,
              el('span', { text: '최근 변화는 ' }), historyLink(), el('span', { text: '에서 볼 수 있습니다.' }))));
        }
      } else {
        if (waiting.length) {
          kids.push(el('div', { class: 'wk2-sechead' }, el('span', { text: '검토 대기 — 승인해야 정본에 반영' }), el('span', { class: 'n', text: waiting.length + '건' })));
          waiting.forEach((it, i) => kids.push(...row(it, i)));
        }
        if (applied.length) {
          kids.push(el('div', { class: 'wk2-sechead' }, el('span', { text: '사후확인 — 이미 반영됨, 확인만 필요' }), el('span', { class: 'n', text: applied.length + '건' })));
          applied.forEach((it, i) => kids.push(...row(it, waiting.length + i)));
        }
        kids.push(el('div', { class: 'wk2-kbd', text: 'j/k 이동 · Enter 펼침 · a 승인 · r 반려' }));
      }
      listBox.replaceChildren(...kids);
    };
    paint();
    box.replaceChildren(listBox);
    installWk2Keys(listBox, ordered, ui, paint, drop);
  }

  // ── 기록 뷰 — 날짜 → 카테고리 그룹. 피드(feed)는 상태 스냅샷 파생(지식당 최신 1건)임을 하단에 긋는다. ──
  async function paintHistory(box: HTMLElement): Promise<void> {
    box.replaceChildren(skeleton('기록을 불러오는 중'));
    let feed: any[] = [];
    let qItems: W2Item[] = [];
    let canonN: number | null = null;
    try {
      const p = new URLSearchParams({ days: '14', limit: '400' });
      if (f.cat) p.set('category', f.cat);
      if (f.by === 'human' || f.by === 'ai') p.set('by', f.by);
      const catQ = f.cat ? '&category=' + encodeURIComponent(f.cat) : '';
      const [fd, qs, kc] = await Promise.all([
        api('/api/ui/wiki2/feed?' + p.toString()),
        fetchQueue().catch(() => [] as W2Item[]),
        api('/api/ui/knowledge?limit=1' + catQ).catch(() => null),
      ]);
      feed = (fd && fd.entries) || [];
      qItems = qs;
      canonN = kc ? Number(kc.total ?? 0) : null;
    } catch (e) {
      box.replaceChildren(errorNote(e, '기록을 불러오지 못했습니다'));
      return;
    }
    const selKey = catObj() ? String(catObj().key) : '';
    const pend = qItems.filter((i) => (!selKey ? true : i.cat === selKey))
      .filter((i) => (f.by === 'human' ? i.whoKind === 'human' : f.by === 'ai' ? i.whoKind === 'ai' : true));

    // 이벤트 병합 — 피드(반영·미러·보관) + 검토 대기(큐와 동일 집합, 격리 원칙상 피드엔 없음).
    interface Ev { at: string; kind: 'upd' | 'mirror' | 'archived' | 'pending'; name: string; title: string;
      catName: string; text: string; who: string; human: boolean; mirror: boolean; version?: number }
    const evs: Ev[] = [
      ...feed.map((r: any): Ev => ({
        at: String(r.activity_at || r.updated_at),
        kind: r.provenance === 'observed' ? 'mirror' : (r.lifecycle === 'archived' ? 'archived' : 'upd'),
        name: r.name, title: r.title || r.name, catName: r.category_name || '미분류',
        text: r.provenance === 'observed' ? '미러 싱크'
          : r.lifecycle === 'archived' ? '보관'
          : (r.change_note ? String(r.change_note) : (Number(r.version) === 1 ? '신규' : '수정') + ' v' + r.version),
        who: r.provenance === 'observed' ? (r.external_system || 'notion') : (r.updated_by || '—'),
        human: r.confidence === 'human', mirror: r.provenance === 'observed', version: Number(r.version),
      })),
      ...pend.map((i): Ev => ({
        at: i.at, kind: 'pending', name: i.name, title: i.title, catName: i.catName,
        text: i.note || (i.kind === 'new' ? '신규 제안' : '수정 제안'),
        who: i.agent || i.who, human: i.whoKind === 'human', mirror: false,
      })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const dayKey = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '—' : d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }); };
    const tm = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); };

    const bySel = el('select', { class: 'rq-sel', style: 'width:auto;padding:5px 8px;font-size:12.5px' },
      el('option', { value: '', text: '전체' }),
      el('option', { value: 'human', text: '사람' }),
      el('option', { value: 'ai', text: 'AI' })) as HTMLSelectElement;
    bySel.value = f.by || '';
    bySel.onchange = () => { f.by = bySel.value; syncHash('history'); void repaint(); };

    const kids: any[] = [headEl('history', queueTotal, canonN, pend.length, bySel)];

    // 날짜 그룹 → (미러는 그룹 밖 접힌 스트림 — 미분류라 도메인 아래 그리면 거짓) → 카테고리 그룹.
    const days = new Map<string, Ev[]>();
    for (const e of evs) {
      const k = dayKey(e.at);
      if (!days.has(k)) days.set(k, []);
      days.get(k)!.push(e);
    }
    if (!evs.length) {
      kids.push(el('div', { class: 'wk2-empty' },
        el('div', { class: 'big', text: '최근 14일 변화가 없습니다' }),
        el('div', { text: '지식이 인입되면(노션 미러 연결 · 에이전트 저작) 이 화면에 변화가 쌓입니다.' })));
    }
    for (const [dk, list] of days) {
      const mirrors = list.filter((e) => e.mirror);
      const rest = list.filter((e) => !e.mirror);
      const day = el('div', { class: 'wk2-day' },
        el('div', { class: 'wk2-dayh' }, el('span', { text: dk }),
          el('span', { class: 'm', text: `갱신 ${rest.length}${mirrors.length ? ' · 미러 싱크 ' + mirrors.length : ''}` })));
      const cats = new Map<string, Ev[]>();
      for (const e of rest) {
        if (!cats.has(e.catName)) cats.set(e.catName, []);
        cats.get(e.catName)!.push(e);
      }
      for (const [cn, ces] of cats) {
        if (!selKey && cats.size > 1) day.append(el('div', { class: 'wk2-dom', text: cn }));
        for (const e of ces) {
          day.append(el('div', { class: 'wk2-trow' },
            el('span', { class: 'tm', text: tm(e.at) }),
            wkTick({ confidence: e.human ? 'human' : null, provenance: null }),
            el('a', { class: 't', href: '#/k/' + encodeURIComponent(e.name), text: e.title }),
            el('span', { class: 'k', text: e.text }),
            e.kind === 'pending' ? el('span', { class: 'wk2-pill', text: '검토 대기' }) : null,
            el('span', { class: 'sp' }),
            el('span', { class: 'm', text: e.who }),
            e.kind === 'pending' ? (() => { const a = el('a', { href: '#', text: '검증 →', style: 'font-size:12px' }); a.onclick = (ev: any) => { ev.preventDefault(); syncHash('verify'); void renderWiki2(view, '', new URLSearchParams(f.cat ? 'cat=' + f.cat : '')); }; return a; })() : null));
        }
      }
      if (mirrors.length) {
        const det = el('details', { class: 'wk2-mirror' },
          el('summary', {}, el('span', { text: `○ 노션 미러 싱크 ${mirrors.length}건 — 미분류` }), el('span', { class: 'm', text: 'last_synced_at 기준 · 펼치기 ▸' })));
        for (const e of mirrors) {
          det.append(el('div', { class: 'wk2-trow' },
            el('span', { class: 'tm', text: tm(e.at) }),
            el('a', { class: 't', href: '#/k/' + encodeURIComponent(e.name), text: e.title }),
            el('span', { class: 'sp' }),
            el('span', { class: 'm', text: e.who })));
        }
        day.append(det);
      }
      kids.push(day);
    }
    kids.push(el('div', { class: 'wk2-endmark', text: '이 피드는 지식당 최신 상태 1건의 파생입니다 — 행 단위 상세 기록(diff)은 변화 원장이 쌓이는 시점부터 열립니다.' }));
    box.replaceChildren(...kids);
  }

  // repaint — 매번 새 surface 박스(#764 관례: 늦게 끝난 이전 렌더가 최신 화면을 못 덮는다).
  async function repaint(): Promise<void> {
    const box = el('div', {});
    main.replaceChildren(box);
    if (mode === 'history') await paintHistory(box);
    else await paintVerify(box);
  }

  const shell = el('div', { class: 'kn-shell' }, sideCtl.side, main);
  knApplySideW(shell);
  shell.append(knSideResizeHandle(shell));
  await sideCtl.ready;
  if (document.body.dataset.route !== 'wiki2') return;   // 로딩 중 탭 이탈 — 늦은 mount 가 남의 화면을 덮지 않게
  view.replaceChildren(shell);
  syncHash(mode);
  await loadSummary();
  if (document.body.dataset.route !== 'wiki2') return;
  await repaint();
}
