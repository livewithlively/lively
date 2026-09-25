// projects/detail-hub-knowledge.ts — 허브 «연결된 지식» 위젯(#4135, 5판 시안 2026-09-25 원준: «지식의 입구는 검색이다. 위젯이 분류를 정하지 않는다»).
//   모든 크기 맨 위에 검색 상자(3×2 는 오른쪽 칸) — 치면 그 자리에서 의미검색(knowledge/semantic) 결과가 서고 [필요로 연결].
//   1×1  필요·산출 줄 + 추천 하나           1×N  «필요 — 세션이 읽고 시작» 카드 · 추천 · «산출 — 이 프로젝트가 만든 것»
//   2×1 · 3×1  필요 | 산출 두 단(추천은 필요 밑 점선)   2×2+  흐름: 필요 → [프로젝트 · 세션 N · 태스크 N] → 산출
//   3×2+ 흐름 + 오른쪽 검색 칸
//  연결/해제는 프로젝트 지식 API(POST /v6/projects/:id/knowledge {name, relation[, unlink]}) — 섹션(detail-knowledge)과 같은 문.
import { api, el, lifecycleDot, relTime, toast } from '../core.js';
import { type Fill, btn, footText, hubIcon } from './detail-hub-kit.js';

const knName = (k: any): string => String(k.name || k.knowledge_name || '');
const KN_NEW_TAB = { target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' };

export const fillKnowledge: Fill = (ctx, f, body, foot, sub) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const kn = P.knowledge || {};
  const req: any[] = kn.required || [], prod: any[] = kn.produced || [];
  const linked = new Set([...req, ...prod].map(knName));
  const open = () => ctx.openTool('knowledge');
  sub.textContent = '필요 ' + req.length + ' · 산출 ' + prod.length;

  let seq = 0;   // 검색 경합 가드 — 이 위젯 인스턴스만의 것(다시 그려진 뒤의 옛 검색이 새 결과를 흔들지 않게)
  const link = async (name: string, btn?: HTMLButtonElement | null, relation: 'required' | 'produced' = 'required') => {
    if (btn) btn.disabled = true;
    try { await api(o.base + pid + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation }) }); toast(relation === 'required' ? '필요 지식으로 연결했습니다' : '산출 지식으로 연결했습니다'); o.reload(); }
    catch (e: any) { toast('연결 실패 — ' + (e && e.message || e), true); if (btn) btn.disabled = false; }
  };
  const unlink = async (name: string, relation: string) => {
    try { await api(o.base + pid + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation, unlink: true }) }); toast('연결을 해제했습니다'); o.reload(); }
    catch (e: any) { toast('해제 실패 — ' + (e && e.message || e), true); }
  };
  // 한 줄 — 제목(새 탭) · 상태 점 · 관계 칩 · 호버 ✕
  const krow = (k: any, rel: 'required' | 'produced'): HTMLElement => {
    const name = knName(k);
    const r = el('div', { class: 'pjh-kr' }, hubIcon('doc', 13),
      el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: k.title || name }),
      (k.lifecycle && k.lifecycle !== 'active') ? lifecycleDot(k.lifecycle) : null,
      el('span', { class: 'pjh-kn-rel', text: rel === 'required' ? '필요' : '산출' }),
      el('button', { class: 'pjh-kr-x', type: 'button', title: '연결 해제', text: '✕', onclick: (e: Event) => { e.stopPropagation(); unlink(name, rel); } }));
    return r;
  };
  // 추천 줄 — 점선, [연결]
  const rrow = (m: any): HTMLElement => {
    const name = knName(m);
    const pct = Math.round((Number(m.similarity) || 0) * 100);
    return el('div', { class: 'pjh-kr rec' }, hubIcon('doc', 13),
      el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: m.title || name }),
      pct > 0 ? el('span', { class: 'pjh-kn-pct', text: pct + '%' }) : null,
      el('button', { class: 'pjh-kn-link', type: 'button', text: '연결', onclick: (e: Event) => { e.stopPropagation(); link(name, e.currentTarget as HTMLButtonElement); } }));
  };
  // 카드(1×N · 흐름) — 제목 + 한 줄 요약(있으면)
  const kcard = (k: any, rel: 'required' | 'produced'): HTMLElement => {
    const name = knName(k);
    const when = k.updated_at || k.created_at;
    return el('div', { class: 'pjh-kc' },
      el('div', { class: 'pjh-kc-h' }, el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: k.title || name }),
        el('button', { class: 'pjh-kr-x', type: 'button', title: '연결 해제', text: '✕', onclick: (e: Event) => { e.stopPropagation(); unlink(name, rel); } })),
      k.summary ? el('div', { class: 'pjh-kc-s', text: String(k.summary).slice(0, 120) }) : null,
      when ? el('div', { class: 'pjh-kc-d', text: relTime(when) }) : null);
  };
  const grp = (label: string, n: number, hint?: string): HTMLElement => el('div', { class: 'pjh-grp' }, el('b', { text: label }), el('span', { class: 'pjh-grp-n', text: String(n) }), hint ? el('span', { class: 'pjh-grp-h', text: '· ' + hint }) : null);

  // ── 검색 — 지식의 입구. 치면 본문이 결과로 바뀌고, 지우면 돌아온다. ──
  const results = el('div', { class: 'pjh-kres' });
  const searchBox = (placeholder = '필요한 지식 찾기 — 의미로 찾습니다…'): HTMLElement => {
    const inp = el('input', { type: 'search', class: 'pjh-search-in', placeholder }) as HTMLInputElement;
    let t: any = null;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      const q = inp.value.trim();
      t = setTimeout(async () => {
        if (!q) { results.replaceChildren(); results.hidden = true; normal.hidden = false; return; }
        const my = ++seq;
        results.hidden = false; normal.hidden = true;
        results.replaceChildren(el('div', { class: 'pjh-stat', text: '찾는 중…' }));
        let ms: any[] = [];
        try { ms = await api('/api/ui/knowledge/semantic?q=' + encodeURIComponent(q) + '&limit=8').then((d: any) => (d && d.entries) || []); } catch (_) { ms = []; }
        if (my !== seq) return;
        results.replaceChildren(el('div', { class: 'pjh-grp' }, el('b', { text: '결과' }), el('span', { class: 'pjh-grp-n', text: String(ms.length) })));
        if (!ms.length) results.append(el('div', { class: 'pjh-stat', text: '찾는 지식이 없습니다 — 열어서 직접 작성할 수 있습니다.' }));
        for (const m of ms) {
          const name = knName(m);
          results.append(el('div', { class: 'pjh-kr' }, hubIcon('doc', 13),
            el('div', { class: 'pjh-kr-b' }, el('a', { class: 'pjh-kr-t', href: '#/k/' + encodeURIComponent(name), ...KN_NEW_TAB, text: m.title || name }),
              m.snippet ? el('div', { class: 'pjh-kr-s', text: String(m.snippet).slice(0, 90) }) : null),
            linked.has(name) ? el('span', { class: 'pjh-kn-rel', text: '연결됨' })
              : el('button', { class: 'pjh-kn-link', type: 'button', text: '필요로 연결', onclick: (e: Event) => { e.stopPropagation(); link(name, e.currentTarget as HTMLButtonElement); } })));
        }
      }, 280);
    });
    return el('div', { class: 'pjh-search' }, hubIcon('search', 13), inp);
  };
  const normal = el('div', { class: 'pjh-kn-normal' });
  results.hidden = true;

  // ── 크기별 본문 ──
  const recHost = el('div', { class: 'pjh-krec' });
  // 빈 «필요» 의 문장 — 추천이 있으면 그걸 가리키고, 없으면 검색을 가리킨다(추천이 올 때 바꾼다).
  const emptyReq = el('div', { class: 'pjh-stat', text: '아직 없어요 — 위에서 찾아 연결하면 다음 세션부터 읽고 시작합니다.' });
  const footTxt = footText('필요 ' + req.length + ' · 산출 ' + prod.length);
  // 추천은 의미검색이라 늦게 온다(실측 20~30초) — 그동안 «찾는 중» 한 줄을 두어 나중에 줄이 생기는 게 갑작스럽지 않게.
  recHost.append(el('div', { class: 'pjh-stat pjh-krec-wait', text: '추천 지식을 찾는 중…' }));
  const paintRecs = (n: number, label = true) => ctx.D.recs().then((rs: any[]) => {
    const all = rs.filter((m) => !linked.has(knName(m)));
    const fresh = all.slice(0, n);
    recHost.replaceChildren();
    if (!fresh.length) return;
    footTxt.textContent = '필요 ' + req.length + ' · 산출 ' + prod.length + ' · 추천 ' + fresh.length;   // 바닥의 수 = 화면에 선 추천 줄 수(시안)
    emptyReq.textContent = '아직 없어요 — 아래 추천을 연결하거나 위에서 찾으세요.';
    if (label) recHost.append(el('div', { class: 'pjh-grp sub' }, el('b', { text: '추천' }), el('span', { class: 'pjh-grp-n', text: String(fresh.length) }), el('span', { class: 'pjh-grp-h', text: '· 연결하면 다음 세션부터 읽고 시작' })));
    for (const m of fresh) recHost.append(rrow(m));
  });
  const sidePane = w >= 3 && h >= 2;
  const flowView = w >= 2 && h >= 2 && !sidePane;   // 2×2 — 위 검색 상자 대신 «필요 지식 찾기» 점선 카드(누르면 그 자리에 검색)
  if (!sidePane && !flowView) body.append(searchBox());
  body.append(results, normal);

  if (w <= 1 && h <= 1) {
    for (const k of req) normal.append(krow(k, 'required'));
    for (const k of prod) normal.append(krow(k, 'produced'));
    if (!req.length && !prod.length) normal.append(emptyReq);   // 문장이 먼저, 추천 줄이 그 아래(1×N 과 같은 순서)
    normal.append(recHost); paintRecs(1, false);
  } else if (w <= 1) {
    normal.append(grp('필요', req.length, '세션이 읽고 시작'));
    for (const k of req) normal.append(kcard(k, 'required'));
    if (!req.length) normal.append(emptyReq);
    normal.append(recHost); paintRecs(2);
    normal.append(grp('산출', prod.length, '이 프로젝트가 만든 것'));
    for (const k of prod) normal.append(kcard(k, 'produced'));
    if (!prod.length) normal.append(el('div', { class: 'pjh-stat', text: '작업이 진행되면 여기에 쌓입니다.' }));
  } else if (h <= 1) {
    const reqCol = el('div', { class: 'pjh-kcol' }, grp('필요', req.length, w >= 3 ? '세션이 읽고 시작' : undefined), ...req.map((k) => krow(k, 'required')),
      req.length ? null : emptyReq, recHost);
    const prodCol = el('div', { class: 'pjh-kcol' }, grp('산출', prod.length, w >= 3 ? '이 프로젝트가 만든 것' : undefined), ...prod.map((k) => krow(k, 'produced')));
    if (!prod.length) prodCol.append(el('div', { class: 'pjh-stat', text: '작업이 진행되면 여기에 쌓입니다.' }));
    normal.append(el('div', { class: 'pjh-two-k', style: 'grid-template-columns:' + (w >= 3 ? '1.3fr 1fr' : '1fr 1fr') }, reqCol, prodCol));
    paintRecs(1, false);
  } else {
    // 흐름 — 필요 → [프로젝트] → 산출
    const sessN = el('span', { text: '세션 …' });
    ctx.D.sessions().then((ss: any[]) => { sessN.textContent = '세션 ' + ss.length; });
    const mid = el('div', { class: 'pjh-kmid' }, arrow(), el('div', { class: 'pjh-kpj', text: P.name || '이 프로젝트' }), el('span', { class: 'pjh-kpj-m' }, sessN, ' · 태스크 ' + ((P.tasks || []).length)), arrow());
    const findCard = el('button', { class: 'pjh-kc find', type: 'button' }, hubIcon('search', 13), '＋ 필요 지식 찾기');
    findCard.onclick = () => {
      let inp = body.querySelector('.pjh-search-in') as HTMLInputElement | null;
      if (!inp) { body.prepend(searchBox()); inp = body.querySelector('.pjh-search-in') as HTMLInputElement | null; }
      if (inp) inp.focus();
    };
    if (!req.length) emptyReq.textContent = '아직 없어요 — 찾아서 연결하면 다음 세션부터 읽고 시작합니다.';
    const left = el('div', { class: 'pjh-kside' }, el('div', { class: 'pjh-klabel' }, '필요 — 세션이 읽고 시작 ', el('span', { class: 'pjh-grp-n', text: String(req.length) })), ...req.map((k) => kcard(k, 'required')),
      req.length ? null : emptyReq, findCard, recHost);
    const right = el('div', { class: 'pjh-kside' }, el('div', { class: 'pjh-klabel' }, '산출 — 이 프로젝트가 만든 것 ', el('span', { class: 'pjh-grp-n', text: String(prod.length) })), ...prod.map((k) => kcard(k, 'produced')));
    if (!prod.length) right.append(el('div', { class: 'pjh-stat', text: '작업이 진행되면 여기에 쌓입니다.' }));
    normal.append(el('div', { class: 'pjh-kflow' }, left, mid, right));
    paintRecs(2);
  }
  const side = el('div', { class: 'pjh-side' });
  if (sidePane) {
    side.append(el('div', { class: 'pjh-side-l', text: '필요 지식 찾기' }), searchBox('찾을 말을 치세요…'), results);
    results.hidden = false;
    // 옆 칸에선 결과가 옆 칸에 서고 흐름은 그대로 남는다
    const wrap = el('div', { class: 'pjh-two-s', style: 'grid-template-columns:minmax(0,1fr) 320px' });
    body.replaceChildren(wrap); wrap.append(normal, side);
    normal.hidden = false;
    side.append(el('div', { class: 'pjh-stat', text: '찾을 말을 치면 뜻이 가까운 지식이 여기 섭니다. 연결하면 다음 세션부터 AI 가 그 문서를 읽고 시작합니다.' }));   // 결과 바로 아래(빈 칸 끝에 홀로 두지 않는다)
  }
  foot.append(footTxt, btn('지식', 'btn-ghost', open));
};
const arrow = (): HTMLElement => { const a = el('span', { class: 'pjh-karrow' }); a.innerHTML = '<svg viewBox="0 0 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h28"/><path d="M25 2l5 5-5 5"/></svg>'; return a; };
