// wiki2.ts — #968 WIKI2 탭 v3.1: 검증(AI 제안 → 사람 승인 → 정본 확정)과 변화(무엇 때문에 어떻게 바뀌어 어디에 닿았나).
//  화면 3장:
//   · 보드(#/wiki2)          — 담당 카테고리별 현황 카드(검토 대기 + 최근 변화). 목록 없음.
//   · 검토 플로우(#/wiki2/review) — 한 건씩 순차 검토. 카드 템플릿 5구역: 위상 → 제안 → 계기·출처 → 변경 → 결과.
//   · 기록(#/wiki2/history)   — 날짜→카테고리 그룹, 행 2줄 템플릿(제목+요약 / 제안 주체 → 확정 주체 · 정본 vN).
//  용어(화면): 확정 층 = '정본'(사람 저작·노션 미러·사람이 승인한 것) / AI 미확정 = '제안'. 동사 = 검토·승인·반려·보류·확정.
//  데이터·액션 전부 기존 자산: #783 큐 API·승인/반려(원장 보존 — reviewed_by), #802 summary(mine·by_category),
//  /wiki2/feed(activity_at·change_note·change_reviewed_by), lineDiff/diffView(review.ts), 사이드바(wiki-side), 민트 틱(wiki-ui).
//  신규 백엔드 0. 설계 전문: 지식 wiki2-change-review-tab-design-968 (v3.1 §템플릿).
import { api, el, errorNote, relTime, renderMarkdown, state, toast } from './core.js';
import { skeleton } from './learn.js';
import { createWikiSide, knApplySideW, knSideResizeHandle } from './wiki-side.js';
import { wkAurora, wkTick } from './wiki-ui.js'; // 오로라 커버(#764v2) — WIKI 홈 카테고리 카드와 같은 문법
import { diffView, lineDiff, rqEnsureStyles } from './review.js';
const TYPE_LABEL = {
    decision: '결정', concept: '개념', 'how-to': '런북', reference: '참조', research: '리서치', entity: '엔티티',
};
// ── 스타일(1회 주입 — styles.css 불가침 관례) ──
function wk2Styles() {
    rqEnsureStyles(); // diffView(.rq-diff/.rq-dl) 재사용분
    if (document.getElementById('wk2-styles'))
        return;
    document.head.appendChild(el('style', { id: 'wk2-styles', text: `
.wk2-main{padding:20px 28px 40px;min-width:0}
.wk2-board{max-width:1440px;margin:0 auto}
.wk2-hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.wk2-hero h2{font-size:19px;font-weight:800;margin:0}
.wk2-hero .sum{font-size:13px;color:var(--ink-sub)}
.wk2-hero .sum b{font-family:ui-monospace,monospace;color:var(--ink);font-variant-numeric:tabular-nums}
.wk2-hero .sp{flex:1}
.wk2-gateoff{margin:-6px 0 14px;font-size:12.5px;color:var(--ink-sub)}
.wk2-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}
.wk2-grid.single{grid-template-columns:minmax(380px,640px)}
.wk2-zone{background:var(--bg);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.wk2-zhead{padding:0 16px 0}
.wk2-zh-row{display:flex;align-items:baseline;gap:9px;margin-top:8px;min-width:0}
.wk2-zh-row .nm{font-size:15.5px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wk2-zh-row .own{font-size:10.5px;color:var(--ink-sub);border:1px solid var(--line);border-radius:999px;padding:0 7px;flex:none}
.wk2-zh-row .sp{flex:1}
.wk2-zh-row .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);white-space:nowrap}
.wk2-todo{margin:0 14px;border:1px solid var(--line-note);background:var(--bg-note);border-radius:10px;padding:11px 13px}
.wk2-todo .lb{font-size:10.5px;font-weight:800;letter-spacing:.05em;color:var(--ink-note);margin-bottom:5px}
.wk2-todo .q{font-size:13.5px;font-weight:650;color:var(--ink);line-height:1.5}
.wk2-todo .qm{font-size:11.5px;color:var(--ink-sub);margin-top:3px}
.wk2-todo .qm .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2)}
.wk2-todo .act{display:flex;align-items:center;gap:10px;margin-top:9px}
.wk2-todo .more{font-size:11.5px;color:var(--ink-sub)}
.wk2-todo.ok{background:var(--bg);border-color:var(--line)}
.wk2-todo.ok .q{font-weight:600;color:var(--ink-sub);font-size:12.5px}
.wk2-okdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mint,#0FB07E);margin-right:7px}
.wk2-fu{padding:10px 16px 4px;flex:1}
.wk2-fu .lb{font-size:10.5px;font-weight:800;letter-spacing:.05em;color:var(--muted-2);margin-bottom:4px}
.wk2-fur{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line-row);font-size:12.5px}
.wk2-fur:last-child{border-bottom:0}
.wk2-fur .tx{color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.wk2-fur .tx b{font-weight:650}
.wk2-fur .tx .who{color:var(--ink-sub)}
.wk2-fur .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2);white-space:nowrap}
.wk2-zf{display:flex;align-items:center;padding:8px 16px 12px}
.wk2-zf a{font-size:12px}
.wk2-zf .sp{flex:1}
.wk2-others{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.wk2-others .lb{font-size:11px;color:var(--muted-2);font-weight:700}
.wk2-oc{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:5px 14px;font-size:12.5px;color:var(--ink-sub);cursor:pointer}
.wk2-oc:hover{color:var(--ink)}
.wk2-oc .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2)}
.wk2-oc .n{background:var(--bg-note);color:var(--ink-note);border:1px solid var(--line-note);border-radius:999px;font-family:ui-monospace,monospace;font-size:10px;padding:0 6px}
.wk2-flowbar{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.wk2-flowbar .ttl{font-size:15px;font-weight:800}
.wk2-flowbar .prog{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted-2)}
.wk2-flowbar .bar{flex:1;height:4px;border-radius:2px;background:var(--bg-tint);overflow:hidden;max-width:220px}
.wk2-flowbar .bar i{display:block;height:100%;background:var(--blue);border-radius:2px;transition:width .2s}
.wk2-flowbar .quit{margin-left:auto;font-size:12px;color:var(--ink-sub);background:none;border:0;cursor:pointer}
.wk2-fcard{max-width:760px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.wk2-standing{padding:16px 22px 10px;border-bottom:1px solid var(--line-row)}
.wk2-standing .t{font-size:16.5px;font-weight:800;margin-bottom:3px;color:var(--ink)}
.wk2-standing .st{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12px;color:var(--ink-sub)}
.wk2-standing .st .ok{color:var(--mint-deep);font-weight:700}
.wk2-standing .st .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2)}
.wk2-standing .st .dot{color:var(--muted-2)}
.wk2-prop{display:flex;align-items:baseline;gap:10px;padding:11px 22px 0;flex-wrap:wrap}
.wk2-chip{font-size:11px;color:var(--ink-sub);border:1px solid var(--line);border-radius:999px;padding:0 8px;white-space:nowrap}
.wk2-chip.pr{border-color:var(--line-note);background:var(--bg-note);color:var(--ink-note);font-weight:700}
.wk2-prop .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);margin-left:auto}
.wk2-fbody{padding:4px 22px}
.wk2-fsum{font-size:15px;font-weight:700;line-height:1.6;margin:6px 0 2px;max-width:62ch;color:var(--ink)}
.wk2-fwhy{font-size:12.5px;color:var(--ink-sub);margin:2px 0 12px;max-width:72ch}
.wk2-fwhy .lbl{font-family:ui-monospace,monospace;font-size:10px;color:var(--muted-2);margin-right:5px}
.wk2-fwhy .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2)}
.wk2-chg{border-top:1px solid var(--line-row);padding:10px 0 9px}
.wk2-sect{font-size:12.5px;font-weight:700;margin-bottom:6px;color:var(--ink)}
.wk2-op{display:inline-block;font-size:10.5px;font-weight:800;border-radius:5px;padding:0 6px;margin-right:7px;background:var(--bg-tint);border:1px solid var(--line);color:var(--ink-sub)}
.wk2-op.del{color:var(--coral-text)}
.wk2-ba{display:grid;grid-template-columns:32px 1fr;gap:4px 12px;font-size:13.5px;max-width:70ch}
.wk2-ba .lab{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2);padding-top:3px}
.wk2-ba .prev{color:var(--muted);min-width:0}
.wk2-ba .next{color:var(--ink);min-width:0}
.wk2-gone{color:var(--muted-2);text-decoration:line-through;text-decoration-color:var(--coral-text)}
.wk2-markt{background:var(--bg-punch,#EDF2FC);color:var(--blue-deep);padding:0 3px;border-radius:3px;font-weight:700}
.wk2-mdclip{max-height:240px;overflow:auto;font-size:13.5px}
.wk2-mdclip .md-rendered p{margin:.3em 0}
.wk2-more{font-size:12px;color:var(--ink-sub);cursor:pointer;padding:6px 0 0}
.wk2-warn{margin:8px 0 0;padding:7px 10px;border:1px solid var(--line-note);border-radius:9px;background:var(--bg-note);font-size:12px;color:var(--ink-note)}
.wk2-fevi{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;border-top:1px solid var(--line-row);padding:10px 22px;font-size:12.5px;color:var(--ink)}
.wk2-fevi .lbl{font-family:ui-monospace,monospace;font-size:10px;color:var(--muted-2)}
.wk2-fevi .m{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--muted-2)}
.wk2-raw{margin-left:auto;color:var(--muted-2);font-size:11px;font-family:ui-monospace,monospace;cursor:pointer;user-select:none}
.wk2-raw:hover{color:var(--ink-sub)}
.wk2-rawbox{padding:0 22px 12px}
.wk2-outcome{border-top:1px solid var(--line-row);padding:11px 22px 12px;display:grid;gap:7px;font-size:12.5px;background:var(--bg-tint)}
.wk2-outcome .row{display:grid;grid-template-columns:64px 1fr;gap:10px;max-width:76ch}
.wk2-outcome .k{font-weight:800;color:var(--mint-deep)}
.wk2-outcome .k.no{color:var(--muted-2)}
.wk2-outcome .v{color:var(--ink-sub)}
.wk2-outcome .v b{color:var(--ink);font-weight:650}
.wk2-fact{display:flex;gap:12px;align-items:center;padding:12px 22px 18px;border-top:1px solid var(--line-row)}
.wk2-fact .skip{font-size:12.5px;color:var(--ink-sub);background:none;border:0;cursor:pointer;padding:4px 6px}
.wk2-fact .skip:hover{color:var(--ink)}
.wk2-fact .sp{flex:1}
.wk2-fkbd{max-width:760px;margin:10px auto 0;text-align:center;font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2)}
.wk2-done{max-width:680px;margin:30px auto 0;text-align:center;padding:34px 20px;background:var(--bg);border:1px solid var(--line);border-radius:16px}
.wk2-done .big{font-size:16px;font-weight:800;margin-bottom:6px;color:var(--ink)}
.wk2-done .dim{font-size:13px;color:var(--ink-sub)}
.wk2-dayh{display:flex;align-items:baseline;gap:10px;padding:16px 0 5px;border-bottom:1px solid var(--line);font-size:13.5px;font-weight:800;color:var(--ink)}
.wk2-dayh .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);font-weight:400}
.wk2-dom{font-size:11.5px;color:var(--muted-head);font-weight:800;padding:10px 0 2px}
.wk2-trow{display:flex;gap:10px;align-items:baseline;padding:7px 2px;font-size:13px;border-bottom:1px solid var(--line-row)}
.wk2-trow .tm{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2);width:40px;flex:none}
.wk2-trow .body{min-width:0;flex:1}
.wk2-trow .l1{display:flex;gap:8px;align-items:baseline;min-width:0}
.wk2-trow .l1 .t{font-weight:700;color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-trow .l1 .t:hover{color:var(--blue-deep)}
.wk2-trow .l1 .k{color:var(--ink-sub);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk2-trow .l1 .sp{flex:1}
.wk2-trow .l2{font-size:11.5px;color:var(--muted-2);margin-top:1px}
.wk2-trow .l2 b{color:var(--ink-sub);font-weight:650}
.wk2-pill{flex:none;font-size:10.5px;font-weight:800;padding:1px 8px;border-radius:999px;background:var(--bg-note);border:1px solid var(--line-note);color:var(--ink-note);white-space:nowrap}
.wk2-mirror{margin:8px 0 2px;border:0;background:var(--bg-tint);border-radius:8px;font-size:12.5px;color:var(--ink-sub)}
.wk2-mirror summary{padding:7px 12px;cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center}
.wk2-mirror summary::-webkit-details-marker{display:none}
.wk2-mirror .m{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted-2)}
.wk2-mirror .wk2-trow{padding-left:12px;padding-right:12px;border-bottom:0}
.wk2-endmark{margin:20px 0 0;padding:10px 0;text-align:center;color:var(--muted-2);font-size:12px;border-top:1px dashed var(--line)}
.wk2-empty{padding:26px 2px;font-size:13.5px;color:var(--ink-sub)}
.wk2-empty .big{font-size:14.5px;font-weight:700;color:var(--ink);margin-bottom:4px}
.wk2-navn{display:none}
.wk2-navn.on{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:800;
  font-variant-numeric:tabular-nums;color:var(--ink-note);background:var(--bg-note);border:1px solid var(--line-note)}
.wk2-cnt{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:800;
  font-variant-numeric:tabular-nums;color:var(--ink-note);background:var(--bg-note);border:1px solid var(--line-note);flex:none}
.wk2-vt{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:13px}
.wk2-vt button{font:inherit;padding:6px 16px;border:0;background:var(--bg);color:var(--ink-sub);cursor:pointer}
.wk2-vt button.on{background:var(--bg-tint);color:var(--ink);font-weight:700}
` }));
}
// ── 상단 탭 배지 — 검토 대기 총계(0이면 숨김, #802 관례). 60s 스로틀. ──
let wk2BadgeAt = 0;
export async function refreshWiki2NavBadge(n) {
    wk2Styles();
    const sp = document.getElementById('wiki2-navn');
    if (!sp)
        return;
    let total = n;
    if (total == null) {
        if (Date.now() - wk2BadgeAt < 60_000)
            return;
        wk2BadgeAt = Date.now();
        try {
            const s = await api('/api/ui/review-queue/summary');
            total = Number((s && s.total) || 0);
        }
        catch {
            total = 0;
        }
    }
    else
        wk2BadgeAt = Date.now();
    sp.textContent = total > 0 ? String(total) : '';
    sp.classList.toggle('on', total > 0);
}
// 큐 API 의 시각은 String(Date) 포맷 — 피드(ISO)와 섞어 정렬하면 깨진다 → ISO 정규화.
const isoAt = (v) => { const d = new Date(v); return isNaN(+d) ? String(v ?? '') : d.toISOString(); };
async function fetchQueue() {
    const [pk, pr] = await Promise.all([
        api('/api/ui/knowledge?lifecycle=pending&orderBy=updated_at&limit=500'),
        api('/api/ui/knowledge-revisions?status=pending&limit=500'),
    ]);
    const pending = (pk && pk.entries) || [];
    const revs = (pr && pr.entries) || [];
    return [
        ...pending.map((k) => ({
            key: 'new:' + k.name, kind: 'new', name: k.name, title: k.title || k.name,
            cat: k.category_key || '', catName: k.category_name || '미분류',
            whoKind: k.confidence === 'ai' ? 'ai' : (k.provenance === 'observed' ? 'connector' : 'human'),
            who: k.provenance === 'observed' ? (k.source || '자료 수집기') : (k.updated_by || '—'),
            agent: null, at: isoAt(k.updated_at), note: k.summary || null,
        })),
        ...revs.map((r) => ({
            key: 'rev:' + r.id, kind: 'edit', name: r.name, title: r.title || r.name,
            cat: r.category_key || '', catName: r.category_name || '미분류',
            whoKind: r.actor_kind === 'ai' ? 'ai' : 'human', who: r.proposed_by || '—', agent: r.agent || null,
            at: isoAt(r.updated_at), note: r.note || null,
            revId: r.id, mode: r.mode, added: r.added, removed: r.removed, conflict: !!r.conflict, edits: r.edits,
        })),
    ];
}
// change_note = "요약. 계기 — …" 관례 — 있으면 요약/계기를 쪼개 템플릿 두 슬롯에 담는다.
function splitNote(note) {
    const m = /(?:^|[\s.·])계기\s*[—\-–:]\s*/.exec(note);
    if (!m)
        return { sum: note, cause: null };
    return {
        sum: note.slice(0, m.index).trim().replace(/[.·]\s*$/, ''),
        cause: note.slice(m.index + m[0].length).trim(),
    };
}
function deriveBlocks(before, after) {
    const d = lineDiff(before, after);
    const blocks = [];
    let heading = '';
    let cur = null;
    const flush = () => { if (cur && (cur.before.length || cur.after.length))
        blocks.push(cur); cur = null; };
    for (const l of d) {
        const h = /^(#{1,6})\s+(.*)/.exec(l.s || '');
        if (l.t === ' ') {
            flush();
            if (h)
                heading = h[2];
            continue;
        }
        // 헝크 중간 헤딩에서 블록 분리 — "문장 수정 + 새 절 추가"가 한 덩어리로 합쳐지지 않게(섹션 단위 블록).
        if (h && cur && (cur.before.length || cur.after.length))
            flush();
        if (!cur)
            cur = { op: '바뀜', heading: h ? h[2] : heading, before: [], after: [] };
        if (l.t === '-')
            cur.before.push(l.s);
        else
            cur.after.push(l.s);
    }
    flush();
    for (const b of blocks)
        b.op = b.before.length && b.after.length ? '바뀜' : (b.after.length ? '추가' : '삭제');
    return blocks;
}
// 단어 강조 — 1줄↔1줄 치환일 때만 문자 prefix/suffix 를 깎아 바뀐 가운데만 표시.
function wordSpans(a, b) {
    if (!a || !b || a === b)
        return null;
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s])
        s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
        ea--;
        eb--;
    }
    if (ea - s > a.length * 0.9 && eb - s > b.length * 0.9)
        return null;
    return {
        prev: el('span', {}, el('span', { text: a.slice(0, s) }), el('span', { class: 'wk2-gone', text: a.slice(s, ea) }), el('span', { text: a.slice(ea) })),
        next: el('span', {}, el('span', { text: b.slice(0, s) }), el('span', { class: 'wk2-markt', text: b.slice(s, eb) }), el('span', { text: b.slice(eb) })),
    };
}
const clip = (s, n = 700) => (s.length > n ? s.slice(0, n) + ' …' : s);
function mdClip(text) {
    return el('div', { class: 'wk2-mdclip md-rendered' }, renderMarkdown(clip(text) || '(없음)'));
}
// 구조 요약(폴백) — change_note 미제출 시 블록에서 "『헤딩』 바뀜 · …" 문장 생성.
function structSummary(blocks, added, removed) {
    if (!blocks.length)
        return '내용 변화 없음(메타만 변경)';
    const parts = blocks.slice(0, 3).map((b) => (b.heading ? `『${b.heading}』 ` : '본문 ') + b.op);
    const size = added != null ? ` (+${added} −${removed ?? 0})` : '';
    return parts.join(' · ') + (blocks.length > 3 ? ` 외 ${blocks.length - 3}곳` : '') + size;
}
// ── 판정(엔드포인트 #783 그대로) ──
async function w2Approve(it) {
    try {
        if (it.kind === 'new') {
            await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
            toast('승인 — 정본으로 확정했습니다');
        }
        else {
            await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
            toast(it.mode === 'staged' ? '승인 — 정본에 확정했습니다' : '확인 완료로 표시했습니다');
        }
        return true;
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
        return false;
    }
}
async function w2Reject(it) {
    const msg = it.kind === 'new'
        ? '이 지식을 반려할까요? 휴지통으로 이동하며 복원할 수 있습니다.'
        : it.mode === 'staged'
            ? '이 수정 제안을 반려할까요? 현재 정본은 바뀌지 않습니다(제안만 폐기).'
            : '이 수정을 되돌릴까요? 정본이 수정 전 상태로 복원됩니다.';
    if (!confirm(msg))
        return false;
    try {
        if (it.kind === 'new') {
            await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/delete', { method: 'POST' });
            toast('반려했습니다(휴지통)');
        }
        else {
            await api('/api/ui/knowledge-revisions/' + it.revId + '/review', { method: 'POST', body: JSON.stringify({ decision: 'reject' }) });
            toast(it.mode === 'staged' ? '제안을 반려했습니다' : '수정을 되돌렸습니다');
        }
        return true;
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
        return false;
    }
}
// ── 사이드바 카테고리 배지(멱등) ──
function applySideBadges(sideEl, bySpace, byCat) {
    sideEl.querySelectorAll('.wk2-cnt').forEach((n) => n.remove());
    const keyToId = new Map();
    for (const sk of ['business', 'product', 'system']) {
        for (const c of (bySpace[sk] || []))
            keyToId.set(String(c.key), String(c.id));
    }
    for (const bc of byCat || []) {
        if (!bc.key || !bc.n)
            continue;
        const id = keyToId.get(String(bc.key));
        if (!id)
            continue;
        const row = sideEl.querySelector(`.kn-nav-cat[data-cat-val="${id}"] .pjv-side-navlabel`);
        if (row)
            row.after(el('span', { class: 'wk2-cnt', title: '검토 대기 ' + bc.n + '건', text: String(bc.n) }));
    }
}
// 피드 행 → "무엇이 — 어떻게 · 누가" 한 줄 재료.
function feedLine(r) {
    if (r.provenance === 'observed')
        return { sum: '노션 원본 갱신 반영', who: r.external_system || 'notion' };
    if (r.change_note) {
        const { sum } = splitNote(String(r.change_note));
        const who = r.change_reviewed_by ? `AI 제안, ${r.change_reviewed_by} 승인` : (r.confidence === 'human' ? String(r.updated_by || '') : 'AI');
        return { sum, who };
    }
    const verb = Number(r.version) === 1 ? '신규' : '수정 v' + r.version;
    return { sum: verb, who: r.confidence === 'human' ? String(r.updated_by || '') : 'AI' };
}
// ════════ 라우터 진입 — #/wiki2(보드) · #/wiki2/review(플로우) · #/wiki2/history(기록) · ?cat=<id> ════════
export async function renderWiki2(view, sub, params) {
    wk2Styles();
    const f = (state.wiki2 = state.wiki2 || { cat: '', by: '' });
    const mode = sub === 'history' ? 'history' : (sub === 'review' ? 'flow' : 'board');
    if (params && params.has('cat'))
        f.cat = params.get('cat') || '';
    else if (mode === 'board' && (!params || Array.from(params.keys()).length === 0)) {
        f.cat = '';
        f.by = '';
    }
    if (params && params.has('by'))
        f.by = params.get('by') || '';
    const scopeOut = !!(params && params.get('scope') === 'out'); // 담당 외 대기만
    view.replaceChildren(el('div', { class: 'wk2-main' }, skeleton('WIKI2 를 여는 중')));
    function hashFor(m, extra) {
        const p = new URLSearchParams();
        if (f.cat)
            p.set('cat', f.cat);
        if (m === 'history' && f.by)
            p.set('by', f.by);
        for (const [k, v] of Object.entries(extra || {}))
            if (v)
                p.set(k, v);
        const qs = p.toString();
        return '#/wiki2' + (m === 'flow' ? '/review' : m === 'history' ? '/history' : '') + (qs ? '?' + qs : '');
    }
    const syncHash = (m) => history.replaceState(null, '', hashFor(m, scopeOut ? { scope: 'out' } : undefined));
    const main = el('section', { class: 'wk2-main' });
    const sideCtl = createWikiSide({
        selected: () => f.cat,
        onSelect: (v) => { f.cat = v || ''; location.hash = hashFor(mode === 'flow' ? 'board' : mode); },
        tools: false,
    });
    let byCat = [];
    let mineKeys = [];
    let queueTotal = 0;
    async function loadSummary() {
        try {
            const s = await api('/api/ui/review-queue/summary');
            byCat = (s && s.by_category) || [];
            mineKeys = (s && s.mine_category_keys) || [];
            queueTotal = Number((s && s.total) || 0);
        }
        catch (_) {
            byCat = [];
            mineKeys = [];
            queueTotal = 0;
        }
        void refreshWiki2NavBadge(queueTotal);
        applySideBadges(sideCtl.side, sideCtl.bySpace(), byCat);
    }
    const allCats = () => {
        const bs = sideCtl.bySpace();
        return [].concat(bs.business || [], bs.product || [], bs.system || []);
    };
    const catByKey = (key) => allCats().find((c) => String(c.key) === String(key)) || null;
    const gone = () => document.body.dataset.route !== 'wiki2';
    // ══════ 보드 ══════
    async function paintBoard(box) {
        box.replaceChildren(skeleton('현황을 불러오는 중'));
        let items = [];
        let feed = [];
        let gateOn = null;
        try {
            const [qs, fd, pol] = await Promise.all([
                fetchQueue(),
                api('/api/ui/wiki2/feed?days=7&limit=400').catch(() => null),
                api('/api/ui/org/ingest-policy').catch(() => null),
            ]);
            items = qs;
            feed = (fd && fd.entries) || [];
            if (pol)
                gateOn = (pol.policies || []).some((p) => p.enabled);
        }
        catch (e) {
            box.replaceChildren(errorNote(e, '검토 현황을 불러오지 못했습니다 — 검토 권한(memory)이 필요합니다'));
            return;
        }
        const selCat = f.cat ? sideCtl.findCat(f.cat) : null;
        const owned = (selCat ? [selCat] : mineKeys.map(catByKey).filter(Boolean));
        const ownedKeys = new Set(owned.map((c) => String(c.key)));
        // 담당 카테고리별 정본 수 — limit=1 total 만(가볍게, 병렬).
        const canonN = new Map();
        await Promise.all(owned.map(async (c) => {
            try {
                const r = await api('/api/ui/knowledge?limit=1&category=' + encodeURIComponent(String(c.id)));
                canonN.set(String(c.key), Number(r.total ?? 0));
            }
            catch (_) { /* 생략 — 카드 메타만 빠짐 */ }
        }));
        if (gone())
            return;
        const waitingOf = (key) => items.filter((i) => i.cat === key && !(i.kind === 'edit' && i.mode === 'applied'))
            .sort((a, b) => Number(!!b.conflict) - Number(!!a.conflict) || String(a.at).localeCompare(String(b.at)));
        const appliedOf = (key) => items.filter((i) => i.cat === key && i.kind === 'edit' && i.mode === 'applied');
        const outItems = items.filter((i) => !ownedKeys.has(i.cat));
        const weekOwned = feed.filter((r) => ownedKeys.has(String(r.category_key || ''))).length;
        const nWait = items.filter((i) => !(i.kind === 'edit' && i.mode === 'applied')).length;
        const nAck = items.length - nWait;
        const kids = [];
        kids.push(el('div', { class: 'wk2-hero' }, el('h2', { text: selCat ? (selCat.name || selCat.key) : '검토 현황' }), el('span', { class: 'sum' }, el('span', { text: '검토 대기 ' }), el('b', { text: String(nWait) }), el('span', { text: ' · 사후확인 ' }), el('b', { text: String(nAck) }), el('span', { text: '  ｜  이번 주 ' + (selCat ? '변화 ' : '담당 카테고리 변화 ') }), el('b', { text: String(selCat ? feed.filter((r) => String(r.category_key || '') === String(selCat.key)).length : weekOwned) })), el('span', { class: 'sp' }), (() => {
            const n = selCat ? (waitingOf(String(selCat.key)).length + appliedOf(String(selCat.key)).length) : items.length;
            const b = el('button', { class: 'btn btn-primary', text: '검토 시작' + (n ? ` (${n})` : '') });
            b.disabled = !n;
            b.onclick = () => { location.hash = hashFor('flow'); };
            return b;
        })()));
        if (queueTotal === 0 && gateOn === false) {
            kids.push(el('div', { class: 'wk2-gateoff' }, el('span', { text: '지금은 모든 AI 변경이 검증 없이 즉시 반영되고 있습니다 — ' }), el('a', { href: '#/system/ingest-policy', text: '게이트 정책 설정 →' })));
        }
        const zoneCard = (c, opts) => {
            const key = String(c.key);
            const waiting = waitingOf(key), applied = appliedOf(key);
            const first = waiting[0] || applied[0] || null;
            const rows = feed.filter((r) => String(r.category_key || '') === key).slice(0, opts && opts.extended ? 8 : 3);
            const cn = canonN.get(key);
            // 커버 = WIKI 홈 카테고리 카드와 동일 문법(#764v2 오로라 + 겹침 이니셜 타일) — 두 탭이 같은 얼굴.
            const initial = (Array.from(String(c.name || c.key || '?').trim())[0] || '?').toUpperCase();
            const cover = wkAurora(String(c.key || c.id), c.space, { cls: 'wk-ccard-cover', watermark: initial });
            const head = el('div', { class: 'wk-ccard-body wk2-zhead' }, el('span', { class: 'wk-ccard-ic letter', 'aria-hidden': 'true', text: initial }), el('div', { class: 'wk2-zh-row' }, el('span', { class: 'nm', text: c.name || c.key }), mineKeys.includes(key) ? el('span', { class: 'own', text: '담당' }) : null, el('span', { class: 'sp' }), el('span', { class: 'm', text: (cn != null ? `정본 ${cn} · ` : '') + `이번 주 ${feed.filter((r) => String(r.category_key || '') === key).length}` })));
            let todo;
            if (first) {
                const isAck = first.kind === 'edit' && first.mode === 'applied';
                const goBtn = el('button', { class: 'btn btn-primary btn-sm', text: '검토 →' });
                goBtn.onclick = () => { f.cat = String(c.id); location.hash = hashFor('flow'); };
                todo = el('div', { class: 'wk2-todo' }, el('div', { class: 'lb', text: `검토 대기 · ${waiting.length + applied.length}` }), el('div', { class: 'q', text: first.note ? splitNote(first.note).sum : (first.kind === 'new' ? '신규 문서 제안' : '수정 제안') }), el('div', { class: 'qm' }, el('span', { text: first.title + (isAck ? ' — 이미 반영됨, 사후확인 · ' : ' · ') }), el('span', { class: 'm', text: `AI(${first.agent || first.who}) · ${relTime(first.at)}` })), el('div', { class: 'act' }, goBtn, waiting.length && applied.length ? el('span', { class: 'more', text: `사후확인 ${applied.length}건 포함` }) : null));
            }
            else {
                todo = el('div', { class: 'wk2-todo ok' }, el('div', { class: 'q' }, el('span', { class: 'wk2-okdot' }), el('span', { text: '검토 대기 없음' })));
            }
            const fu = el('div', { class: 'wk2-fu' }, el('div', { class: 'lb', text: '최근 변화' }));
            if (!rows.length)
                fu.append(el('div', { class: 'wk2-fur' }, el('span', { class: 'tx', style: 'color:var(--muted-2)', text: '이번 주 변화 없음' })));
            for (const r of rows) {
                const L = feedLine(r);
                fu.append(el('div', { class: 'wk2-fur' }, wkTick({ confidence: r.confidence === 'human' ? 'human' : null, provenance: r.provenance === 'observed' ? 'observed' : null }), el('span', { class: 'tx' }, el('b', { text: r.title || r.name }), el('span', { text: ' — ' + L.sum }), L.who ? el('span', { class: 'who', text: ' · ' + L.who }) : null), el('span', { class: 'm', text: relTime(r.activity_at || r.updated_at) })));
            }
            const histA = el('a', { href: '#', text: '기록 →' });
            histA.onclick = (e) => { e.preventDefault(); f.cat = String(c.id); location.hash = hashFor('history'); };
            return el('div', { class: 'wk2-zone' }, cover, head, todo, fu, el('div', { class: 'wk2-zf' }, el('span', { class: 'sp' }), histA));
        };
        const grid = el('div', { class: 'wk2-grid' + (selCat ? ' single' : '') });
        for (const c of owned)
            grid.append(zoneCard(c, { extended: !!selCat }));
        // 담당 외 대기 카드(전체 보기에서만) — 다른 카테고리에서 기다리는 것.
        if (!selCat && outItems.length) {
            const first = outItems.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
            const isAck = first.kind === 'edit' && first.mode === 'applied';
            const goBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '검토 →' });
            goBtn.onclick = () => { f.cat = ''; location.hash = hashFor('flow', { scope: 'out' }); };
            const today = feed.filter((r) => { const d = new Date(r.activity_at || r.updated_at); const n = new Date(); return d.toDateString() === n.toDateString(); });
            const histA = el('a', { href: '#', text: '전체 기록 →' });
            histA.onclick = (e) => { e.preventDefault(); f.cat = ''; location.hash = hashFor('history'); };
            grid.append(el('div', { class: 'wk2-zone' }, wkAurora('wiki2-out', 'system', { cls: 'wk-ccard-cover', watermark: '외' }), el('div', { class: 'wk-ccard-body wk2-zhead' }, el('span', { class: 'wk-ccard-ic letter', 'aria-hidden': 'true', text: '외' }), el('div', { class: 'wk2-zh-row' }, el('span', { class: 'nm', text: '담당 외 대기' }), el('span', { class: 'sp' }), el('span', { class: 'm', text: outItems.length + '건' }))), el('div', { class: 'wk2-todo' }, el('div', { class: 'lb', text: `다른 카테고리의 검토 대기 · ${outItems.length}` }), el('div', { class: 'q', text: first.note ? splitNote(first.note).sum : (first.kind === 'new' ? '신규 문서 제안' : '수정 제안') }), el('div', { class: 'qm' }, el('span', { text: `${first.title}${isAck ? ' — 이미 반영됨, 사후확인' : ''} · ${first.catName} · ` }), el('span', { class: 'm', text: `AI(${first.agent || first.who}) · ${relTime(first.at)}` })), el('div', { class: 'act' }, goBtn)), el('div', { class: 'wk2-fu' }, el('div', { class: 'lb', text: '조직 전체' }), el('div', { class: 'wk2-fur' }, el('span', { class: 'tx', text: `오늘 변화 ${today.length}건 · 미러 갱신 ${today.filter((r) => r.provenance === 'observed').length}건` }))), el('div', { class: 'wk2-zf' }, el('span', { class: 'sp' }), histA)));
        }
        kids.push(grid);
        // 그 외 카테고리 칩(전체 보기에서만).
        if (!selCat) {
            const rest = allCats().filter((c) => !ownedKeys.has(String(c.key)));
            if (rest.length) {
                const strip = el('div', { class: 'wk2-others' }, el('span', { class: 'lb', text: '그 외 카테고리' }));
                const byCatMap = new Map(byCat.map((b) => [String(b.key), b.n]));
                for (const c of rest) {
                    const chipEl = el('span', { class: 'wk2-oc', role: 'button', tabindex: '0' }, el('span', { text: c.name || c.key }), Number.isFinite(Number(c.knowledge_count)) ? el('span', { class: 'm', text: String(c.knowledge_count) }) : null, byCatMap.get(String(c.key)) ? el('span', { class: 'n', text: String(byCatMap.get(String(c.key))) }) : null);
                    chipEl.addEventListener('click', () => { f.cat = String(c.id); location.hash = hashFor('board'); });
                    strip.append(chipEl);
                }
                kids.push(strip);
            }
        }
        if (!owned.length && !outItems.length) {
            kids.push(el('div', { class: 'wk2-empty' }, el('div', { class: 'big', text: '담당 카테고리가 없습니다' }), el('div', { text: '팀의 오너 카테고리가 설정되면 여기에 현황 카드가 표시됩니다. 사이드바에서 카테고리를 직접 선택할 수도 있습니다.' })));
        }
        box.replaceChildren(...kids);
    }
    // ══════ 검토 플로우 — 한 건씩. 카드 5구역: 위상 → 제안 → 계기·출처 → 변경 → 결과. ══════
    async function paintFlow(box) {
        box.replaceChildren(skeleton('검토 항목을 불러오는 중'));
        let items = [];
        try {
            items = await fetchQueue();
        }
        catch (e) {
            box.replaceChildren(errorNote(e, '검토 항목을 불러오지 못했습니다 — 검토 권한(memory)이 필요합니다'));
            return;
        }
        const selCat = f.cat ? sideCtl.findCat(f.cat) : null;
        const ownedSet = new Set(mineKeys.map(String));
        let scoped = items;
        if (selCat)
            scoped = items.filter((i) => i.cat === String(selCat.key));
        else if (scopeOut)
            scoped = items.filter((i) => !ownedSet.has(i.cat));
        // 순서: (전체일 때) 담당 먼저 → 그 외. 그 안에서 대기(경합 → 오래된 순) → 사후확인.
        const rank = (i) => (i.kind === 'edit' && i.mode === 'applied' ? 1 : 0);
        scoped = scoped.slice().sort((a, b) => Number(ownedSet.has(b.cat)) - Number(ownedSet.has(a.cat))
            || rank(a) - rank(b)
            || Number(!!b.conflict) - Number(!!a.conflict)
            || String(a.at).localeCompare(String(b.at)));
        const stats = { approved: 0, rejected: 0, acked: 0, held: 0 };
        let idx = 0;
        let keys = null;
        const quit = () => { keys?.abort(); keys = null; location.hash = hashFor('board'); };
        const bar = el('span', { class: 'bar' }, el('i', {}));
        const prog = el('span', { class: 'prog' });
        const quitBtn = el('button', { class: 'quit', text: '닫기 (Esc)' });
        quitBtn.onclick = quit;
        const holder = el('div', {});
        const kbd = el('div', { class: 'wk2-fkbd', text: 'a 승인 · r 반려 · s 보류 · Esc 닫기 — 처리하면 다음 건으로 진행' });
        box.replaceChildren(el('div', { class: 'wk2-flowbar' }, el('span', { class: 'ttl', text: '지식 검토' + (selCat ? ' — ' + (selCat.name || selCat.key) : scopeOut ? ' — 담당 외' : '') }), prog, bar, quitBtn), holder, kbd);
        const setProg = () => {
            prog.textContent = `${Math.min(idx + 1, scoped.length)} / ${scoped.length}`;
            bar.firstChild.style.width = scoped.length ? `${Math.round((idx / scoped.length) * 100)}%` : '0%';
        };
        const showDone = () => {
            keys?.abort();
            keys = null;
            prog.textContent = `${scoped.length} / ${scoped.length}`;
            bar.firstChild.style.width = '100%';
            kbd.textContent = '';
            const processed = stats.approved + stats.rejected + stats.acked;
            const parts = [];
            if (stats.approved)
                parts.push(`승인 ${stats.approved}`);
            if (stats.acked)
                parts.push(`확인 ${stats.acked}`);
            if (stats.rejected)
                parts.push(`반려 ${stats.rejected}`);
            if (stats.held)
                parts.push(`보류 ${stats.held}`);
            const histA = el('a', { href: '#', text: '기록에서 보기' });
            histA.onclick = (e) => { e.preventDefault(); location.hash = hashFor('history'); };
            const boardA = el('a', { href: '#', text: '보드로 →' });
            boardA.onclick = (e) => { e.preventDefault(); location.hash = hashFor('board'); };
            holder.replaceChildren(el('div', { class: 'wk2-done' }, el('div', { class: 'big' }, el('span', { class: 'wk2-okdot' }), el('span', { text: processed ? `검토 완료 — ${processed}건 처리 (${parts.join(' · ')})` : (scoped.length ? `검토 종료 — ${parts.join(' · ') || '처리 없음'}` : '검토할 항목이 없습니다') })), el('div', { class: 'dim' }, el('span', { text: processed ? '확정된 내용은 각 지식의 정본에 반영되었습니다 · ' : '' }), histA, el('span', { text: '  ·  ' }), boardA)));
            void loadSummary();
        };
        const next = () => { idx++; if (idx >= scoped.length)
            showDone();
        else
            void showCard(); };
        async function showCard() {
            setProg();
            const it = scoped[idx];
            holder.replaceChildren(el('div', { class: 'wk2-fcard' }, el('div', { style: 'padding:30px' }, skeleton('불러오는 중'))));
            let detail = null, kd = null;
            try {
                [detail, kd] = await Promise.all([
                    it.kind === 'edit' ? api('/api/ui/knowledge-revisions/' + it.revId) : Promise.resolve(null),
                    api('/api/ui/knowledge/' + encodeURIComponent(it.name)).catch(() => null),
                ]);
            }
            catch (e) {
                holder.replaceChildren(errorNote(e, '내용을 불러오지 못했습니다'));
                return;
            }
            if (gone())
                return;
            const k = (kd && kd.knowledge) || {};
            const isAck = it.kind === 'edit' && it.mode === 'applied';
            const curVer = detail && detail.current ? Number(detail.current.version) : Number(k.version || 1);
            // ① 위상 — 이 지식이 지금 무엇인가.
            const stBits = [];
            if (it.kind === 'new')
                stBits.push(el('span', { class: 'ok', text: '신규 제안 — 아직 정본 아님' }));
            else if (k.provenance === 'observed')
                stBits.push(el('span', { text: '노션 미러 — 원본이 진실' }));
            else
                stBits.push(el('span', { class: 'ok', text: '정본 v' + curVer }));
            const catType = [it.catName || k.category_name, TYPE_LABEL[String(k.type)] || k.type].filter(Boolean).join(' · ');
            if (catType) {
                stBits.push(el('span', { class: 'dot', text: '·' }), el('span', { text: catType }));
            }
            if (it.kind !== 'new' && k.updated_by) {
                stBits.push(el('span', { class: 'dot', text: '·' }), el('span', {}, el('span', { text: `마지막 수정 ${k.updated_by}${k.confidence === 'human' ? '' : '(AI)'} ` }), el('span', { class: 'm', text: relTime(String(k.updated_at)) })));
            }
            const links = (k.links || {});
            const backs = Array.isArray(links.incoming) ? links.incoming : [];
            stBits.push(el('span', { class: 'dot', text: '·' }), el('span', { text: `참조 문서 ${backs.length}` }));
            const standing = el('div', { class: 'wk2-standing' }, el('div', { class: 't', text: it.title }), el('div', { class: 'st' }, ...stBits));
            // ② 제안.
            const chipTxt = it.kind === 'new' ? 'AI 신규 제안' : (isAck ? 'AI 수정 — 반영됨 · 사후확인' : 'AI 수정 제안');
            const prop = el('div', { class: 'wk2-prop' }, el('span', { class: 'wk2-chip pr', text: chipTxt }), el('span', { class: 'm', text: `${it.agent || it.who} · ${relTime(it.at)}${(it.edits || 1) > 1 ? ` · ${it.edits}회 누적` : ''}` }));
            // ③④ 본문 — 요약·계기 + 변경 블록.
            const body = el('div', { class: 'wk2-fbody' });
            let before = '', after = '';
            const noteSplit = it.note ? splitNote(it.note) : null;
            if (it.kind === 'edit' && detail) {
                const rev = detail.revision, cur = detail.current;
                if (!cur) {
                    body.append(el('p', { class: 'wk2-warn', text: '대상 지식이 삭제되었습니다 — 반려로 정리하세요.' }));
                }
                else {
                    before = rev.mode === 'staged' ? (cur.body_md || '') : (rev.base_body_md || '');
                    after = rev.mode === 'staged' ? (rev.new_body_md || '') : (cur.body_md || '');
                    const blocks = deriveBlocks(before, after);
                    body.append(el('div', { class: 'wk2-fsum', text: noteSplit ? noteSplit.sum : structSummary(blocks, it.added, it.removed) }));
                    const whyBits = [];
                    if (noteSplit && noteSplit.cause)
                        whyBits.push(el('span', { class: 'lbl', text: '계기' }), el('span', { text: noteSplit.cause + '  ' }));
                    else if (!noteSplit)
                        whyBits.push(el('span', { class: 'lbl', text: '요약' }), el('span', { text: '제안자가 변경 요약을 제출하지 않아 구조 요약으로 표시합니다  ' }));
                    const srcs = Array.isArray(k.sources) ? k.sources : [];
                    if (srcs.length) {
                        whyBits.push(el('span', { class: 'lbl', text: '출처' }));
                        srcs.slice(0, 2).forEach((s, i) => {
                            whyBits.push(el('span', { text: (i ? ' · ' : '') + (s.title || s.name || s.kind || '자료') + ' ' }), el('span', { class: 'm', text: s.occurred_at ? relTime(s.occurred_at) : '' }));
                        });
                    }
                    if (k.external_url)
                        whyBits.push(el('span', { text: '  ' }), el('a', { href: String(k.external_url), target: '_blank', rel: 'noopener', text: '원본 열기 ↗' }));
                    if (whyBits.length)
                        body.append(el('div', { class: 'wk2-fwhy' }, ...whyBits));
                    if (it.conflict)
                        body.append(el('p', { class: 'wk2-warn', text: '⚠ 제안 이후 정본이 또 수정되었습니다 — 승인하면 그 수정을 이 제안본으로 덮어씁니다. 원문 비교로 확인하세요.' }));
                    const renderBlock = (b) => {
                        const sect = el('div', { class: 'wk2-sect' }, el('span', { class: 'wk2-op' + (b.op === '삭제' ? ' del' : ''), text: b.op }), el('span', { text: b.heading || '본문' }));
                        const kids2 = [sect];
                        const bf = b.before.filter((s) => s.trim()), af = b.after.filter((s) => s.trim());
                        const ws = b.op === '바뀜' && bf.length === 1 && af.length === 1 ? wordSpans(bf[0], af[0]) : null;
                        if (b.op === '바뀜') {
                            kids2.push(el('div', { class: 'wk2-ba' }, el('span', { class: 'lab', text: '이전' }), el('span', { class: 'prev' }, ws ? ws.prev : mdClip(b.before.join('\n'))), el('span', { class: 'lab', text: '이후' }), el('span', { class: 'next' }, ws ? ws.next : mdClip(b.after.join('\n')))));
                        }
                        else if (b.op === '추가')
                            kids2.push(mdClip(b.after.join('\n')));
                        else
                            kids2.push(el('div', { class: 'wk2-ba' }, el('span', { class: 'lab', text: '삭제' }), el('span', { class: 'prev' }, mdClip(b.before.join('\n')))));
                        return el('div', { class: 'wk2-chg' }, ...kids2);
                    };
                    blocks.slice(0, 3).forEach((b) => body.append(renderBlock(b)));
                    if (blocks.length > 3) {
                        const more = el('div', { class: 'wk2-more', text: `${blocks.length - 3}곳 더 ▸` });
                        more.onclick = () => { blocks.slice(3).forEach((b) => body.insertBefore(renderBlock(b), more)); more.remove(); };
                        body.append(more);
                    }
                }
            }
            else {
                body.append(el('div', { class: 'wk2-fsum', text: (noteSplit && noteSplit.sum) || k.summary || '새 지식 제안' }));
                if (noteSplit && noteSplit.cause)
                    body.append(el('div', { class: 'wk2-fwhy' }, el('span', { class: 'lbl', text: '계기' }), el('span', { text: noteSplit.cause })));
                try {
                    const sim = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: it.name, limit: '3' }));
                    const hits = ((sim && sim.similar) || []).filter((s) => Number(s.score) >= 0.6);
                    if (hits.length) {
                        const strip = el('p', { class: 'wk2-warn' }, el('span', { text: '⚠ 비슷한 기존 지식이 있습니다 — 중복이면 반려하세요: ' }));
                        hits.forEach((h, i) => {
                            if (i)
                                strip.append(el('span', { text: ' · ' }));
                            strip.append(el('a', { href: '#/k/' + encodeURIComponent(h.name), target: '_blank', rel: 'noopener', text: (h.title || h.name) + ' (' + Math.round(Number(h.score) * 100) + '%)' }));
                        });
                        body.append(strip);
                    }
                }
                catch (_) { /* 임베딩 off */ }
                body.append(el('div', { class: 'wk2-chg' }, el('div', { class: 'wk2-sect' }, el('span', { class: 'wk2-op', text: '추가' }), el('span', { text: '전체 본문' })), mdClip(k.body_md || '(본문 없음)')));
            }
            // 원문 비교(접힘).
            const evi = el('div', { class: 'wk2-fevi' });
            const rawBox = el('div', { class: 'wk2-rawbox', hidden: true });
            if (it.kind === 'edit') {
                const rawT = el('span', { class: 'wk2-raw', text: `원문 비교(+${it.added ?? 0} −${it.removed ?? 0}) ▸` });
                rawT.onclick = () => {
                    const open = rawBox.hidden;
                    rawBox.hidden = !open;
                    rawT.textContent = rawT.textContent.replace(open ? '▸' : '▾', open ? '▾' : '▸');
                    if (open && !rawBox.childNodes.length)
                        rawBox.append(diffView(before, after));
                };
                evi.append(el('span', {}, el('span', { class: 'lbl', text: '전문 대조' })), rawT);
            }
            else {
                const openA = el('a', { href: '#/k/' + encodeURIComponent(it.name), target: '_blank', rel: 'noopener', text: '문서로 열기 ↗' });
                evi.append(el('span', {}, el('span', { class: 'lbl', text: '전문' }), el('span', { text: ' ' })), openA);
            }
            // ⑤ 결과 — 판정의 의미.
            const topRefs = backs.slice(0, 3).map((b) => b.title || b.name).filter(Boolean);
            const refTxt = backs.length
                ? `참조 문서 ${backs.length}건(${topRefs.map((t) => t).join(' · ')}${backs.length > 3 ? ` 외 ${backs.length - 3}` : ''})이 확정된 내용을 근거로 참조합니다.`
                : '이 지식을 참조하는 문서는 아직 없습니다.';
            let okK = '승인하면', okV = [], noK = '반려하면', noV = '';
            if (it.kind === 'new') {
                okV = [el('span', { text: '이 문서가 ' }), el('b', { text: '정본으로 등록' }), el('span', { text: '되어 검색·세션 주입에 노출됩니다.' })];
                noV = '제안은 휴지통으로 이동합니다(복원 가능).';
            }
            else if (isAck) {
                okK = '확인하면';
                okV = [el('span', { text: '반영된 내용(' }), el('b', { text: 'v' + curVer }), el('span', { text: ')이 검토 완료로 표시됩니다. ' }), el('span', { text: refTxt })];
                noK = '되돌리면';
                noV = `정본이 수정 전 내용(v${detail && detail.revision ? detail.revision.base_version ?? curVer - 1 : curVer - 1})으로 복원됩니다.`;
            }
            else {
                okV = [el('span', { text: '이 내용이 ' }), el('b', { text: `정본 v${curVer + 1}로 확정` }), el('span', { text: '됩니다. ' }), el('span', { text: refTxt })];
                noV = `제안은 폐기되고 현재 정본(v${curVer})이 그대로 유지됩니다.`;
            }
            const outcome = el('div', { class: 'wk2-outcome' }, el('div', { class: 'row' }, el('span', { class: 'k', text: okK }), el('span', { class: 'v' }, ...okV)), el('div', { class: 'row' }, el('span', { class: 'k no', text: noK }), el('span', { class: 'v', text: noV })));
            // 판정.
            const okBtn = el('button', { class: 'btn btn-primary', text: it.kind === 'new' ? '승인' : (isAck ? '확인' : '승인') });
            const noBtn = el('button', { class: 'skip', text: isAck ? '되돌리기' : '반려' });
            const holdBtn = el('button', { class: 'skip', text: '보류' });
            const lock = (b) => { okBtn.disabled = b; noBtn.disabled = b; holdBtn.disabled = b; };
            okBtn.onclick = async () => { lock(true); const ok = await w2Approve(it); if (!ok) {
                lock(false);
                return;
            } if (isAck)
                stats.acked++;
            else
                stats.approved++; next(); };
            noBtn.onclick = async () => { lock(true); const ok = await w2Reject(it); if (!ok) {
                lock(false);
                return;
            } stats.rejected++; next(); };
            holdBtn.onclick = () => { stats.held++; next(); };
            const act = el('div', { class: 'wk2-fact' }, noBtn, holdBtn, el('span', { class: 'sp' }), okBtn);
            holder.replaceChildren(el('div', { class: 'wk2-fcard' }, standing, prop, body, evi, rawBox, outcome, act));
            if (keys)
                keys.abort();
            keys = new AbortController();
            const inEditable = (t) => {
                const e2 = (t && t.nodeType === 1 ? t : document.activeElement);
                return !!(e2 && e2.closest && e2.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
            };
            document.addEventListener('keydown', (e) => {
                if (!document.body.contains(holder)) {
                    keys?.abort();
                    keys = null;
                    return;
                }
                if (e.metaKey || e.ctrlKey || e.altKey)
                    return;
                if (inEditable(e.target))
                    return;
                if (e.key === 'a') {
                    e.preventDefault();
                    okBtn.click();
                }
                else if (e.key === 'r') {
                    e.preventDefault();
                    noBtn.click();
                }
                else if (e.key === 's') {
                    e.preventDefault();
                    holdBtn.click();
                }
                else if (e.key === 'Escape') {
                    e.preventDefault();
                    quit();
                }
            }, { signal: keys.signal });
        }
        if (!scoped.length)
            showDone();
        else
            void showCard();
    }
    // ══════ 기록 — 날짜→카테고리, 행 2줄(제목+요약 / 제안 주체 → 확정 주체 · 정본 vN). ══════
    async function paintHistory(box) {
        box.replaceChildren(skeleton('기록을 불러오는 중'));
        let feed = [];
        let qItems = [];
        try {
            const p = new URLSearchParams({ days: '14', limit: '400' });
            if (f.cat)
                p.set('category', f.cat);
            if (f.by === 'human' || f.by === 'ai')
                p.set('by', f.by);
            const [fd, qs] = await Promise.all([
                api('/api/ui/wiki2/feed?' + p.toString()),
                fetchQueue().catch(() => []),
            ]);
            feed = (fd && fd.entries) || [];
            qItems = qs;
        }
        catch (e) {
            box.replaceChildren(errorNote(e, '기록을 불러오지 못했습니다'));
            return;
        }
        if (gone())
            return;
        const selCat = f.cat ? sideCtl.findCat(f.cat) : null;
        const selKey = selCat ? String(selCat.key) : '';
        const pend = qItems.filter((i) => (!selKey ? true : i.cat === selKey))
            .filter((i) => (f.by === 'human' ? i.whoKind === 'human' : f.by === 'ai' ? i.whoKind === 'ai' : true));
        const evs = [
            ...feed.map((r) => {
                const L = feedLine(r);
                let sub = '';
                if (r.provenance === 'observed')
                    sub = '노션 미러 — 원본이 진실';
                else if (r.change_note && r.change_reviewed_by)
                    sub = `AI 제안 → ${r.change_reviewed_by} 승인 · 정본 v${r.version} 확정`;
                else if (r.change_note)
                    sub = `AI 수정 · 정본 v${r.version}`;
                else if (r.confidence === 'human')
                    sub = `${r.updated_by || '사람'} 직접 수정 · 정본 v${r.version}`;
                else
                    sub = `AI 수정 · v${r.version}`;
                if (r.lifecycle === 'archived')
                    sub = '보관됨 · ' + sub;
                return {
                    at: String(r.activity_at || r.updated_at), kind: r.provenance === 'observed' ? 'mirror' : (r.lifecycle === 'archived' ? 'archived' : 'upd'),
                    name: r.name, title: r.title || r.name, catName: r.category_name || '미분류',
                    sum: L.sum, sub, human: r.confidence === 'human', mirror: r.provenance === 'observed',
                };
            }),
            ...pend.map((i) => ({
                at: i.at, kind: 'pending', name: i.name, title: i.title, catName: i.catName,
                sum: i.note ? splitNote(i.note).sum : (i.kind === 'new' ? '신규 제안' : '수정 제안'),
                sub: `AI(${i.agent || i.who}) 제안 · 승인 대기`, human: i.whoKind === 'human', mirror: false,
            })),
        ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
        const dayKey = (iso) => { const d = new Date(iso); return isNaN(+d) ? '—' : d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }); };
        const tm = (iso) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); };
        const bySel = el('select', { class: 'rq-sel', style: 'width:auto;padding:5px 8px;font-size:12.5px' }, el('option', { value: '', text: '전체' }), el('option', { value: 'human', text: '사람' }), el('option', { value: 'ai', text: 'AI' }));
        bySel.value = f.by || '';
        bySel.onchange = () => { f.by = bySel.value; syncHash('history'); void repaint(); };
        const boardBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '보드 →' });
        boardBtn.onclick = () => { location.hash = hashFor('board'); };
        const kids = [el('div', { class: 'wk2-hero' }, el('h2', { text: (selCat ? (selCat.name || selCat.key) + ' — ' : '') + '기록' }), el('span', { class: 'sum' }, el('span', { text: '최근 14일 ' }), el('b', { text: String(evs.length) }), el('span', { text: '건' })), el('span', { class: 'sp' }), bySel, boardBtn)];
        const days = new Map();
        for (const e2 of evs) {
            const kkey = dayKey(e2.at);
            if (!days.has(kkey))
                days.set(kkey, []);
            days.get(kkey).push(e2);
        }
        if (!evs.length) {
            kids.push(el('div', { class: 'wk2-empty' }, el('div', { class: 'big', text: '최근 14일 변화가 없습니다' }), el('div', { text: '지식이 인입되면(노션 미러 연결 · 에이전트 저작) 이 화면에 변화가 쌓입니다.' })));
        }
        const trow = (e2, showTm = true) => {
            const goFlow = e2.kind === 'pending' ? (() => { const a = el('a', { href: '#', text: '검토 →', style: 'font-size:12px;white-space:nowrap' }); a.onclick = (ev) => { ev.preventDefault(); location.hash = hashFor('flow'); }; return a; })() : null;
            return el('div', { class: 'wk2-trow' }, showTm ? el('span', { class: 'tm', text: tm(e2.at) }) : null, wkTick({ confidence: e2.human ? 'human' : null, provenance: e2.mirror ? 'observed' : null }), el('div', { class: 'body' }, el('div', { class: 'l1' }, el('a', { class: 't', href: '#/k/' + encodeURIComponent(e2.name), target: '_blank', rel: 'noopener', text: e2.title }), el('span', { class: 'k', text: e2.sum }), e2.kind === 'pending' ? el('span', { class: 'wk2-pill', text: '검토 대기' }) : null, el('span', { class: 'sp' }), goFlow), el('div', { class: 'l2', text: e2.sub })));
        };
        for (const [dk, list] of days) {
            const mirrors = list.filter((e2) => e2.mirror);
            const rest = list.filter((e2) => !e2.mirror);
            const day = el('div', {}, el('div', { class: 'wk2-dayh' }, el('span', { text: dk }), el('span', { class: 'm', text: `변화 ${rest.length}${mirrors.length ? ' · 미러 갱신 ' + mirrors.length : ''}` })));
            const cats = new Map();
            for (const e2 of rest) {
                if (!cats.has(e2.catName))
                    cats.set(e2.catName, []);
                cats.get(e2.catName).push(e2);
            }
            for (const [cn, ces] of cats) {
                if (!selKey && cats.size > 1)
                    day.append(el('div', { class: 'wk2-dom', text: cn }));
                for (const e2 of ces)
                    day.append(trow(e2));
            }
            if (mirrors.length) {
                const det = el('details', { class: 'wk2-mirror' }, el('summary', {}, el('span', { text: `○ 노션 미러 갱신 ${mirrors.length}건 — 미분류` }), el('span', { class: 'm', text: '펼치기 ▸' })));
                for (const e2 of mirrors)
                    det.append(trow(e2));
                day.append(det);
            }
            kids.push(day);
        }
        kids.push(el('div', { class: 'wk2-endmark', text: '이 피드는 지식당 최신 상태 1건의 파생입니다 — 행 단위 상세 기록(diff)은 변화 원장이 쌓이는 시점부터 열립니다.' }));
        box.replaceChildren(...kids);
    }
    async function repaint() {
        const box = el('div', { class: 'wk2-board' }); // 전 뷰 1180px 컨테이너 — 와이드 화면에서 카드가 잘게 쪼개지지 않게(#764 wk-wide 동형)
        main.replaceChildren(box);
        if (mode === 'history')
            await paintHistory(box);
        else if (mode === 'flow')
            await paintFlow(box);
        else
            await paintBoard(box);
    }
    const shell = el('div', { class: 'kn-shell' }, sideCtl.side, main);
    knApplySideW(shell);
    shell.append(knSideResizeHandle(shell));
    await sideCtl.ready;
    if (gone())
        return;
    view.replaceChildren(shell);
    syncHash(mode);
    await loadSummary();
    if (gone())
        return;
    await repaint();
}
