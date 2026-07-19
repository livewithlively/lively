// learn.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { api, el, errorNote, pageHead, renderMarkdown, state, sv } from './core.js';
import { copyButton, deployCommands, installCmd, loadAdmin } from './admin.js';
import { isGuideTourDone, isSectionDone, startGuideTour } from './guide-tour.js'; // Lively 둘러보기(#761) — 크로스탭 스포트라이트 투어
import { DOC_PAGES } from './docs-content.js'; // 사용설명서 원고(#780) — Claude Code docs 형식
// 안내(#/learn) — 지식유형/수집 ground-truth(GET /api/ui/learn = kind_registry + data_source) 렌더.
//  비개발자 대상: V4 본질 종류 4종(R·K·H·W) 중심 + 통합 예정 legacy 종류는 graceful 표시 + 데이터소스별 수집방식. 읽기 전용.
//  V4: 종류(kind)·주제(area=space+domain)·출처(provenance)는 별개 축 — 종류는 본질, 주제는 도메인, 출처는 채널 사실.
//  non-stale: 서버가 DB 를 그대로 반환하므로 정의를 DB 에서 고치면 이 화면도 즉시 반영(런북과 동일 데이터).
//  §0.5 절제: 무채색 카드 + 작은 상태 점만, 채운 배지 금지. 자유텍스트는 안전 마크다운 렌더 재사용.
// ════════════════════════════════════════════
// 가이드(#/learn) — 비개발자가 이 서비스 '전체'와 '각 메뉴'를 한 번에 이해하도록 재구성(2026-06-30).
//  두 기둥: ① 히어로 = 서비스를 관통하는 한 문장 + 작동 3단계 ② 메뉴 한눈에 보기 = 탭별 친절 설명.
//  보조: 처음이라면(순서 경로) + WIKI 에 쌓이는 '지식 한 덩어리'(R·K·H·W) 예시. 정적 — API 불필요.
// ── 사용 가이드 = 문서 사이트(#780) — code.claude.com/docs/ko 형식: 좌측 사이드바(그룹>페이지) + 본문. ──
//  옛 서브탭 바(.sub-cats)는 폐지 — 사이드바가 내비를 전담한다. 원고(md)는 docs-content.ts, 렌더는
//  core.renderMarkdown(:::tabs 지원). 설치·둘러보기·메뉴 한눈에 보기는 인터랙티브 화면 그대로 셸 안에 들어간다.
//  active 키: 'overview'(=#/learn) | DOC_PAGES slug(#/learn/docs/<slug>) | 'install' | 'tour' | 'menu'.
const DOCS_NAV = [
    // 라이블리가 '무엇이고 어떻게 도는지' — 먼저 읽고 이해하는 개괄 정보(액션 아님). 그래서 '시작하기'가 아니라 '라이블리 소개'.
    { group: '라이블리 소개', items: [
            { key: 'overview', label: '라이블리 개요', href: '#/learn' },
            { key: 'how-it-works', label: '라이블리가 동작하는 방식', href: '#/learn/docs/how-it-works' },
        ] },
    // 읽는 문서가 아니라 '직접 해서 시작하는' 것들 — 온보딩 입구·예시·프로젝트 체험·화면 위 투어. '시작하기'(온보딩
    //  입구, #846/850)가 맨 위인 이유: 여기 없으면 홈 칩(미완일 때만)이 사라진 뒤 URL 직접 치는 것 말고 들어갈 길이 없다.
    //  #1000 URI 통일: 직접 해보기 그룹은 전부 #/start/* — '시작하기'(#/start) 아래로 examples·project·tour 를 모은다
    //  (옛 #/learn/docs/examples · #/learn/tour 는 리다이렉트로 보존, main.ts). 첫 항목 라벨을 '시작하기'로 바꿔(옛 'AI
    //  세션 체험') 그룹명 '직접 해보기'와 겹치지 않게 하고 페이지 H1(start.ts)과 맞춘다.
    { group: '직접 해보기', items: [
            { key: 'start', label: '시작하기', href: '#/start' },
            { key: 'examples', label: '이런 걸 시켜보세요', href: '#/start/examples' }, // #853 세션에 무엇을 시킬지 예시 · #1000 URI #/start/*
            { key: 'start-project', label: '프로젝트 체험', href: '#/start/project' }, // #853 프로젝트 한 바퀴 손수 투어
            { key: 'tour', label: 'Lively 둘러보기', href: '#/start/tour' }, // #1000 #/learn/tour → #/start/tour
        ] },
    { group: '화면별 안내', items: [
            { key: 'home', label: '홈 (대시보드)', href: '#/learn/docs/home' },
            { key: 'terminal', label: '내 AI 세션', href: '#/learn/docs/terminal' },
            { key: 'projects', label: '프로젝트', href: '#/learn/docs/projects' },
            { key: 'wiki', label: 'WIKI', href: '#/learn/docs/wiki' },
            { key: 'domainmap', label: '도메인 맵', href: '#/learn/docs/domainmap' },
            { key: 'admin', label: '관리', href: '#/learn/docs/admin' },
        ] },
    { group: '레퍼런스', items: [
            { key: 'cli', label: 'AI 세션 명령어', href: '#/learn/docs/cli' },
            { key: 'glossary', label: '용어집', href: '#/learn/docs/glossary' },
            // #762 '문서 안내(IA·규칙)'(plan) 가이드 항목 숨김(사용자 요청) — 복원: 아래 줄 주석 해제(라우트 리다이렉트도 renderLearnDocs 에서 제거).
            // { key: 'plan', label: '문서 안내 (IA·규칙)', href: '#/learn/docs/plan' },
        ] },
];
function docsSidebar(active) {
    const side = el('nav', { class: 'docs-side', 'aria-label': '사용 가이드 문서' });
    for (const g of DOCS_NAV) {
        const box = el('div', { class: 'docs-side-group' }, el('div', { class: 'docs-side-title', text: g.group }));
        for (const it of g.items) {
            box.append(el('a', { class: 'docs-item' + (it.key === active ? ' active' : ''), href: it.href,
                'aria-current': it.key === active ? 'page' : null, text: it.label }));
        }
        side.append(box);
    }
    return side;
}
// 문서 셸 — 사이드바 + 본문. 모든 사용 가이드 화면(문서·설치·둘러보기·메뉴·온보딩)이 이 셸 안에서 렌더된다.
//  export: #/start(start.ts)도 이 셸을 쓴다 — 사이드바에서 들어갔는데 사이드바가 사라지면 길을 잃는다.
export function docsShell(view, active, ...content) {
    const article = el('article', { class: 'docs-body' }, ...content);
    wireGuideLinks(article); // #780 원고 링크 동작: 같은 페이지=부드러운 스크롤 / 다른 카테고리·탭·외부=새 브라우저 탭
    view.replaceChildren(el('div', { class: 'docs-layout' }, docsSidebar(active), article));
    document.getElementById('view').focus?.();
}
// 해시 라우트를 페이지 키/쿼리/프래그먼트로 분해. '#/learn/docs/wiki?focus=required' → {page:'/learn/docs/wiki', query:'focus=required', frag:''}
function guideRouteKey(hash) {
    let h = String(hash || '');
    const hi = h.indexOf('#');
    if (hi >= 0)
        h = h.slice(hi + 1); // 선두 '#' 제거
    let frag = '';
    const fi = h.indexOf('#');
    if (fi >= 0) {
        frag = h.slice(fi + 1);
        h = h.slice(0, fi);
    } // 2차 #앵커
    let query = '';
    const qi = h.indexOf('?');
    if (qi >= 0) {
        query = h.slice(qi + 1);
        h = h.slice(0, qi);
    }
    return { page: h.replace(/\/+$/, ''), query, frag };
}
// 원고(프로즈) 안의 링크 동작(#780) — 목적지가 지금 이 페이지면 부드럽게 스크롤, 다른 세부 카테고리·다른 탭·외부면 새 브라우저 탭.
//  사이드바(.docs-side)와 #/start 의 인터랙티브 카드는 건드리지 않는다: 렌더된 원고(.docs-md/.docs-lead) 안의 링크만 가로챈다.
//  ⌘/ctrl/⇧/가운데클릭·자체 preventDefault 한 링크는 그대로 둔다(네이티브 새 탭·전용 핸들러 보존).
function wireGuideLinks(article) {
    article.addEventListener('click', (ev) => {
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey)
            return;
        const a = ev.target?.closest?.('a[href]');
        if (!a || !a.closest('.docs-md, .docs-lead'))
            return; // 렌더된 원고 안의 링크만
        const href = a.getAttribute('href') || '';
        if (!href || href === '#')
            return;
        if (href.startsWith('#')) {
            const tgt = guideRouteKey(href), cur = guideRouteKey(location.hash);
            if (tgt.page && tgt.page === cur.page) { // ── 같은 페이지 → 부드러운 스크롤
                ev.preventDefault();
                let to = tgt.frag ? document.getElementById(tgt.frag) : null;
                if (!to && /(^|&)focus=required(&|$)/.test(tgt.query))
                    to = document.getElementById('learn-required');
                if (to) {
                    to.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    to.style.transition = 'box-shadow .3s ease'; // 도착 지점 살짝 강조(#317 focus 하이라이트와 동일)
                    to.style.boxShadow = '0 0 0 2px var(--blue)';
                    setTimeout(() => { to.style.boxShadow = ''; }, 1200);
                }
                else {
                    article.scrollIntoView({ behavior: 'smooth', block: 'start' }); // 앵커 없는 자기 링크 → 맨 위로
                }
                return;
            }
            ev.preventDefault(); // ── 다른 세부 카테고리·다른 탭 → 새 브라우저 탭
            window.open(location.href.split('#')[0] + href, '_blank', 'noopener');
        }
        else if (/^https?:\/\//i.test(href)) { // ── 외부 링크 → 새 브라우저 탭
            ev.preventDefault();
            window.open(href, '_blank', 'noopener');
        }
    });
}
// 페이지 아이브로 — 사이드바 그룹명을 히어로(guide-hero-eyebrow)와 같은 언어로 머리 위에 얹는다(#780 디자인 통일).
export function docsEyebrow(key) {
    for (const g of DOCS_NAV)
        if (g.items.some((i) => i.key === key))
            return el('div', { class: 'docs-eyebrow', text: g.group });
    return null;
}
// ── 원고(md) → 가이드 카드의 연속(#780 디자인 통일). ────────────────────────────────────────
//  문서가 히어로·WIKI 설명 카드와 '같이 만든 물건'으로 보이려면, 흘러가는 마크다운이 아니라 제품의 카드 문법이어야 한다:
//  ## 섹션 하나 = .card 하나(card-head h2 + guide-lead + 구조화된 본문). 첫 H2 앞 도입부는 카드 밖 리드(히어로 리드).
//  카피는 손대지 않는다 — 같은 문장을 제품의 시각 언어(피처 카드·번호 단계·이동 카드)로 다시 조판할 뿐이다.
function docsBody(md, ...lead) {
    const secs = [{ title: null, lines: [] }];
    let fence = false, depth = 0;
    for (const line of String(md || '').split('\n')) {
        if (/^(```|~~~)/.test(line))
            fence = !fence;
        else if (!fence && /^:::\s*[a-zA-Z_-]/.test(line))
            depth++;
        else if (!fence && line.trim() === ':::')
            depth = Math.max(0, depth - 1);
        const h2 = !fence && !depth && /^##\s+(.+)$/.exec(line);
        if (h2) {
            secs.push({ title: h2[1].trim(), lines: [] });
            continue;
        }
        secs[secs.length - 1].lines.push(line);
    }
    const cards = el('div', { class: 'guide-cards' }, ...lead.filter(Boolean)); // 히어로 등 앞머리 카드도 같은 흐름(간격 통일)
    for (const s of secs) {
        const body = s.lines.join('\n').trim();
        if (!body)
            continue;
        if (s.title && /^다음\s*단계/.test(s.title))
            continue; // #req 각 페이지 끝 '다음 단계' 링크 묶음은 렌더 제외 — 사이드바와 중복되는 군더더기 내비
        if (!s.title) {
            // 도입부 — 문단·인용까지만 카드 밖 리드. 표·목록·코드 같은 '내용'이 시작되면 그 아래는 제목 없는 카드로
            //  감싼다(용어집처럼 본문이 통째로 표인 문서가 카드 밖으로 새는 것 방지).
            const at = s.lines.findIndex((l) => /^\s*(\||[-*+]\s|\d+\.\s|```|~~~|:::)/.test(l));
            const lead = (at < 0 ? s.lines : s.lines.slice(0, at)).join('\n').trim();
            const rest = at < 0 ? '' : s.lines.slice(at).join('\n').trim();
            if (lead)
                cards.append(el('div', { class: 'md-rendered docs-lead' }, renderMarkdown(lead)));
            if (rest)
                cards.append(el('div', { class: 'card docs-card' }, el('div', { class: 'md-rendered docs-md' }, docsDecorate(renderMarkdown(rest)))));
            continue;
        }
        cards.append(el('div', { class: 'card docs-card' }, el('div', { class: 'card-head' }, el('h2', { text: s.title })), el('div', { class: 'md-rendered docs-md' }, docsDecorate(renderMarkdown(body)))));
    }
    return cards;
}
// 렌더된 마크다운을 제품 시각 언어로 승격 — 문장은 그대로, 조판만 바꾼다.
//  ① 첫 문단 = 리드(guide-lead) ② '**굵은 제목** — 설명' 목록 = 피처 카드 그리드(kn-axis-opt 문법)
//  ③ 링크로 시작하는 목록('다음 단계') = 이동 카드 그리드(tabguide-card 문법) ④ 번호 목록 = 번호 단계(guide-path 문법)
function docsDecorate(root) {
    const lead = root.querySelector(':scope > .md-p');
    if (lead)
        lead.classList.add('guide-lead');
    for (const ul of Array.from(root.querySelectorAll('ul.md-list'))) {
        const lis = Array.from(ul.children);
        if (!lis.length)
            continue;
        const first = (li) => li.firstElementChild && li.firstElementChild === li.firstChild ? li.firstElementChild.tagName : '';
        const strip = (box) => {
            const n = box.firstChild;
            if (n && n.nodeType === 3)
                n.textContent = String(n.textContent).replace(/^\s*[—–-]\s*/, '');
        };
        // ② 피처 카드 — 모든 항목이 굵은 제목으로 시작할 때
        if (lis.every((li) => first(li) === 'STRONG')) {
            const grid = el('div', { class: 'docs-featgrid' });
            for (const li of lis) {
                // 제목의 인라인 노드를 그대로 옮긴다(텍스트만 뽑지 않는다) — '**[화면](#/system/…)**' 처럼
                //  굵은 제목 안에 링크가 든 원고(관리 문서의 '전체 지도')에서 링크가 통째로 버려지던 것 방지.
                const t = el('div', { class: 'docs-feat-t' });
                const strong = li.firstElementChild;
                while (strong.firstChild)
                    t.append(strong.firstChild);
                strong.remove();
                const d = el('div', { class: 'docs-feat-d' });
                while (li.firstChild)
                    d.append(li.firstChild);
                strip(d);
                grid.append(el('div', { class: 'docs-feat' }, t, d));
            }
            ul.replaceWith(grid);
            continue;
        }
        // ③ 이동 카드 — 모든 항목이 링크로 시작할 때(문서 끝 '다음 단계')
        if (lis.every((li) => first(li) === 'A')) {
            const grid = el('div', { class: 'docs-linkgrid' });
            for (const li of lis) {
                const a = li.firstElementChild;
                const card = el('a', { class: 'docs-linkcard', href: a.getAttribute('href') || '#' });
                card.append(el('span', { class: 'docs-linkcard-t' }, el('span', { text: a.textContent }), el('span', { class: 'docs-linkcard-arrow', 'aria-hidden': 'true', text: '→' })));
                a.remove();
                const d = el('span', { class: 'docs-linkcard-d' });
                while (li.firstChild)
                    d.append(li.firstChild);
                strip(d);
                if (d.textContent.trim())
                    card.append(d);
                grid.append(card);
            }
            ul.replaceWith(grid);
        }
    }
    // ⑤ 표 — 가로 스크롤 래퍼로 감싼다(좁은 화면에서 카드를 밀지 않게). 폭·정렬은 CSS(.docs-tablewrap).
    for (const t of Array.from(root.querySelectorAll('table.md-table'))) {
        const wrap = el('div', { class: 'docs-tablewrap' });
        t.replaceWith(wrap);
        wrap.append(t);
    }
    // ④ 번호 단계 — 순서 목록을 제품의 번호 뱃지 줄(guide-path)로
    for (const ol of Array.from(root.querySelectorAll('ol.md-list'))) {
        const steps = el('div', { class: 'docs-steps' });
        Array.from(ol.children).forEach((li, i) => {
            const body = el('div', { class: 'docs-step-body' });
            while (li.firstChild)
                body.append(li.firstChild);
            steps.append(el('div', { class: 'docs-step' }, el('span', { class: 'docs-step-num', 'aria-hidden': 'true', text: String(i + 1) }), body));
        });
        ol.replaceWith(steps);
    }
    return root;
}
// md 문서 페이지 한 장 — slug 로 원고를 찾아 렌더. wiki 페이지엔 기존 인터랙티브 카드 2장을 이어 붙인다(내용 보존).
//  머리(아이브로+제목)는 원고의 첫 # 제목을 승격해 그린다 — 문구는 원고 그대로, 표현만 히어로 문법.
async function renderLearnDocs(view, slug) {
    // #762 '문서 안내(IA·규칙)'(#/learn/docs/plan) 페이지 숨김(사용자 요청) — 개요로 리다이렉트. 원고(DOC_PAGES['plan'])는 보존.
    //  복원: 이 줄 삭제 + learn.ts nav 의 plan 항목 주석 해제.
    if (slug === 'plan') {
        location.replace('#/learn');
        return;
    }
    const page = DOC_PAGES.find((p) => p.slug === slug);
    if (!page) {
        location.replace('#/learn');
        return;
    }
    const h1 = /^#\s+(.+)\r?\n/.exec(page.md);
    const md = h1 ? page.md.slice(h1[0].length) : page.md;
    const body = [
        docsEyebrow(slug),
        el('h1', { class: 'docs-title', text: (h1 ? h1[1] : page.title).trim() }),
        docsBody(md),
    ];
    if (slug === 'wiki') {
        body.push(el('div', { class: 'guide-cards', style: 'margin-top:18px' }, kindsCard(), // WIKI 에 쌓이는 '지식 한 덩어리'란? (#317 이관 — 구 가이드 랜딩에서)
        projectKnowledgeCard() // 필요지식을 연결하면 뭐가 좋나 — #/learn/docs/wiki?focus=required 대상
        ));
    }
    docsShell(view, slug, ...body);
    // 프로젝트 '연결된 지식' 부제의 [자세히]로 들어오면 해당 카드로 스크롤 + 잠깐 강조(#317).
    if (slug === 'wiki' && /[?&]focus=required(?:&|$)/.test(location.hash)) {
        requestAnimationFrame(() => {
            const card = document.getElementById('learn-required');
            if (!card)
                return;
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.style.transition = 'box-shadow .3s ease';
            card.style.boxShadow = '0 0 0 2px var(--blue)';
            setTimeout(() => { card.style.boxShadow = ''; }, 1500);
        });
    }
}
// #/learn — 문서 홈 = '라이블리 개요'. 히어로(서비스 정의+작동 3단계)를 원고 위에 얹는다(구 가이드 랜딩 보존).
async function renderLearn(view) {
    // 구 딥링크 #/learn?focus=required(#317) — 필요지식 카드는 WIKI 문서 페이지로 이사했다.
    if (/[?&]focus=required(?:&|$)/.test(location.hash)) {
        location.replace('#/learn/docs/wiki?focus=required');
        return;
    }
    const page = DOC_PAGES.find((p) => p.slug === 'overview');
    docsShell(view, 'overview', docsBody(page ? page.md : '', heroCard())); // 히어로 = 같은 카드 흐름의 첫 장(간격 통일)
}
// ── ① 히어로 — 이 서비스가 통째로 뭔지(한 문장) + 작동 원리 3단계 ──
function heroCard() {
    return el('div', { class: 'card guide-hero' }, el('div', { class: 'guide-hero-eyebrow', text: 'LIVELY CONTEXT' }), el('h2', { class: 'guide-hero-title' }, 'Lively는 회사가 쓰는 AI를 위한 ', el('span', { class: 'accent', text: '공용 맥락 저장소' }), '예요.'), el('p', { class: 'guide-hero-lead', text: 'AI(Claude Code·Codex)는 범용 지식은 풍부하지만, 우리 회사가 무슨 일을 하는지·어떤 규칙이 있는지·지금 뭐가 진행 중인지는 모릅니다. 그래서 보통은 일을 시킬 때마다 배경을 처음부터 설명해야 해요. 이 도구는 그 배경(회사의 규칙·지식·진행상황)을 한곳에 모아두고, 구성원이 AI를 켤 때마다 자동으로 전달합니다. 그래서 누가 AI를 켜든, 회사를 ‘이미 아는’ 상태에서 일을 시작합니다.' }), 
    // 4단계 순환(#780) — 일한 결과가 다시 ①로 쌓인다. 되돌아가는 레일(guide-loop)이 그 순환을 그린다.
    el('div', { class: 'guide-cycle' }, el('div', { class: 'guide-flow' }, flowStep('layers', '모아두기', '회사의 규칙·지식·할 일을 이곳에 정리해 둡니다.'), flowArrow(), flowStep('send', '자동 전달', '구성원이 AI를 켜면 그 내용이 자동으로 AI에게 들어갑니다.'), flowArrow(), flowStep('zap', '바로 일 시작', 'AI가 회사 상황을 아는 상태로, 별도 설명 없이 바로 일을 시작합니다.'), flowArrow(), flowStep('save', '다시 쌓기', '일하며 내린 결정·만든 결과를 AI가 지식으로 기록합니다.')), el('div', { class: 'guide-loop' }, el('span', { class: 'guide-loop-label' }, el('span', { class: 'guide-loop-key', 'aria-hidden': 'true', text: '↻' }), el('b', { text: '남긴 지식은 다시 [모아두기]로' }), el('span', { class: 'guide-loop-sub', text: '쓸수록 AI가 받는 맥락이 정확해집니다' })))), el('div', { class: 'guide-remember' }, el('span', { class: 'guide-remember-key', text: '핵심 한 줄' }), el('p', { text: '여기에 잘 정리해 둘수록, 우리 회사의 모든 AI 세션이 더 정확한 맥락을 받고 시작합니다.' })));
}
// 작동 3단계 — 아이콘 + 제목 + 한 줄.
function flowStep(icon, title, desc) {
    return el('div', { class: 'guide-flow-step' }, el('span', { class: 'guide-flow-icon' }, tabIcon(icon)), el('div', { class: 'guide-flow-title', text: title }), el('p', { class: 'guide-flow-desc', text: desc }));
}
function flowArrow() { return el('div', { class: 'guide-flow-arrow', 'aria-hidden': 'true', text: '→' }); }
// ── ② 메뉴 한눈에 보기 — 주요 화면 7개를 성격이 비슷한 묶음(챕터) 4개로 그룹핑(#761: 상단 내비 개편 반영) ──
//  ① 시작(홈=대시보드) ② 실무=AI로 직접 일하기(터미널·프로젝트) ③ 저장소=회사 지식·코드 데이터(WIKI·도메인 맵) ④ 설정·도움말(관리·사용가이드).
//  #617 이후 IA: 터미널(AI 세션)은 상단 탭이 아니라 '홈'에서 열고, 옛 상단 '시작하기'는 사용 가이드 서브탭(#/learn/install)으로 이동.
//  탭 객체: [아이콘, 이름, 태그, 강조색, 강조배경, 한줄요약, 친절설명, 링크, 링크라벨, 현재페이지?].
const GUIDE_CHAPTERS = [
    { num: '1', title: '시작', sub: '로그인하면 처음 만나는 내 화면', tabs: [
            { icon: 'home', name: '홈', tag: '로그인 후 첫 화면', hue: '#2D6BF0', bg: '#EEF4FF',
                summary: '내 일과 팀 소식을 한눈에 모은 대시보드',
                desc: '라이블리에 들어오면 가장 먼저 만나는 나만의 화면이에요. 내가 맡은 프로젝트, 팀이 공유하는 폴더, 최신 알림, 내가 켜 둔 AI 세션, 팀의 작업 기록을 한 화면에 모아 보여줍니다. 여기 ‘내 AI 세션’에서 [+ 새 세션]을 누르면 곧바로 AI와 대화를 시작할 수 있어요.',
                href: '#/dashboard', link: '홈 열기' },
        ] },
    { num: '2', title: '실무', sub: 'AI로 직접 일하고, 진행 상황을 관리해요', tabs: [
            { icon: 'terminal', name: '내 AI 세션', tag: '설치 없이 바로', hue: '#0FA37E', bg: '#EBF9F4',
                summary: '웹에서 곧장 AI와 대화하는 곳',
                desc: '브라우저에서 바로 AI와 대화하는 화면이에요. 회사 맥락이 이미 들어 있는 AI를 띄워, 까만 창에 하고 싶은 말을 그냥 입력하면 됩니다. 홈의 ‘내 AI 세션’에서 [+ 새 세션]으로 열 수 있고, 대화는 서버에 저장돼 창을 닫아도 이어서 쓸 수 있어요. 비개발자에게 가장 쉬운 출발점입니다.',
                href: '#/terminal', link: '내 AI 세션 열기' },
            { icon: 'trello', name: '프로젝트', tag: '진행상황 파악', hue: '#6E59D9', bg: '#F1EEFC',
                summary: '회사에서 지금 무슨 일이 진행 중인지',
                desc: '진행 중·완료된 프로젝트와 할 일을 모아 보는 곳이에요. 누가 무엇을 했고 지금 무엇을 하는지(작업 현황)를 한눈에 볼 수 있어, 팀 전체의 흐름을 따라가기 좋습니다. 사업·제품·시스템별로도 훑어볼 수 있어요.',
                href: '#/projects2', link: '프로젝트 열기' },
        ] },
    { num: '3', title: '저장소', sub: 'AI가 읽는 회사의 코드·지식이 쌓이는 데이터예요', tabs: [
            { icon: 'book-open', name: 'WIKI', tag: '회사 지식 창고', hue: '#1E54CC', bg: '#EAF0FF',
                summary: 'AI에게 전달되는 ‘회사의 지식’이 쌓이는 곳',
                desc: '회사가 쌓아온 규칙·자료·결정·절차를 모아둔 지식 창고예요. 여기 정리된 내용이 바로 AI에게 자동으로 전달되는 ‘회사 맥락’입니다. 사업·제품·시스템으로 분류돼 있고, 검색으로 원하는 내용을 찾을 수 있어요.',
                href: '#/knowledge', link: 'WIKI 열기' },
            { icon: 'share-2', name: '도메인 맵', tag: '주로 개발자용', hue: '#1BAEB0', bg: '#E9F7F7',
                summary: '제품 코드가 어떤 덩어리로 이뤄졌는지 보는 지도',
                desc: '우리 제품의 코드가 어떤 기능 덩어리(도메인)로 구성돼 있는지, ‘하려던 것(의도)’과 ‘실제 만들어진 것(코드)’이 얼마나 맞는지를 보여주는 지도예요. 기술적인 화면이라 개발에 관심 있는 분이 참고하면 좋습니다. (아직 준비 중인 기능이라 내용이 불완전할 수 있어요.)',
                href: '#/domainmap', link: '도메인 맵 열기' },
        ] },
    { num: '4', title: '설정 · 도움말', sub: '환경을 설정하고, 사용법을 안내해요', tabs: [
            { icon: 'sliders', name: '관리', tag: '주로 관리자용', hue: '#5A6B85', bg: '#EDF1F7',
                summary: '위 모든 것을 설정하고 편집하는 곳',
                desc: '접속·구성원 같은 기본 설정부터, AI에게 가르칠 회사 규칙·용어, AI가 동작하는 방식까지 설정하는 곳이에요. 항목마다 ‘구성원에게 어떤 효과가 생기는지’를 함께 보여줍니다. 누구나 볼 수 있지만, 실제 수정은 관리자만 할 수 있어요.',
                href: '#/system', link: '관리 열기' },
            { icon: 'compass', name: '사용 가이드', tag: '지금 이 페이지', hue: '#B84E44', bg: '#FBEFEE',
                summary: '이 도구 전체를 설명하는 안내서',
                desc: '지금 보고 있는 안내서예요. 왼쪽 목차로 나뉘어 있어요 — ‘시작하기’는 이 서비스가 무엇이고 어떻게 동작하는지, ‘화면별 안내’(지금 이 화면 포함)는 각 메뉴가 무슨 일을 하는지, ‘직접 해보기’는 내 AI 세션을 만들거나 화면을 눌러 보며 배우는 투어예요.',
                current: true },
        ] },
];
function tabsGuideCard() {
    const chapters = GUIDE_CHAPTERS.map((c) => {
        const grid = el('div', { class: 'tabguide-grid' + (c.tabs.length === 1 ? ' tabguide-grid--single' : '') });
        for (const t of c.tabs)
            grid.append(tabCard(t));
        return el('div', { class: 'tabchapter' }, el('div', { class: 'tabchapter-head' }, el('span', { class: 'tabchapter-num', 'aria-hidden': 'true', text: c.num }), el('div', { class: 'tabchapter-headtext' }, el('div', { class: 'tabchapter-title', text: c.title }), el('div', { class: 'tabchapter-sub', text: c.sub }))), grid);
    });
    // 제목은 페이지 h1('메뉴 한눈에 보기')이 이미 말하므로 카드 머리는 두지 않는다(#780 — 서브탭 분리).
    return el('div', { class: 'card' }, el('p', { class: 'guide-lead', text: '이 도구의 주요 화면은 성격에 따라 네 묶음이에요 — ① 시작(홈), ② 실무(AI 세션·프로젝트), ③ 저장소(WIKI·도메인 맵), ④ 설정·도움말(관리·사용 가이드). 묶음별로 한 번만 훑어두면 길을 잃지 않아요.' }), ...chapters);
}
// 탭 한 칸 — 현재 페이지는 클릭 불가 카드(점선), 나머지는 클릭하면 해당 탭으로 이동하는 링크 카드.
function tabCard(t) {
    const top = el('div', { class: 'tabguide-top' }, el('span', { class: 'tabguide-icon', style: 'color:' + t.hue + ';background:' + t.bg }, tabIcon(t.icon)), el('div', { class: 'tabguide-headtext' }, el('div', { class: 'tabguide-name', text: t.name }), el('span', { class: 'tabguide-tag', text: t.tag })));
    const summary = el('div', { class: 'tabguide-summary', text: t.summary });
    const desc = el('p', { class: 'tabguide-desc', text: t.desc });
    if (t.current) {
        return el('div', { class: 'tabguide-card is-current' }, top, summary, desc, el('span', { class: 'tabguide-current', text: '지금 보고 있는 화면이에요' }));
    }
    return el('a', { class: 'tabguide-card', href: t.href }, top, summary, desc, el('span', { class: 'tabguide-go' }, t.link, el('span', { class: 'tabguide-go-arrow', 'aria-hidden': 'true', text: '→' })));
}
// ── 메뉴 한눈에 보기(#/learn/menu, #780) — 문서 셸 안의 인터랙티브 페이지. ──
//  내용(GUIDE_CHAPTERS·tabsGuideCard)은 그대로 재사용한다 — 옮기기만 하고 카피는 손대지 않는다.
async function renderLearnMenu(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, '메뉴 ', el('span', { class: 'accent', text: '한눈에 보기' })));
    docsShell(view, 'menu', docsEyebrow('menu'), head, el('div', { class: 'guide-cards' }, tabsGuideCard()));
}
// ── WIKI 에 쌓이는 '지식 한 덩어리'란? — 현재 모델(2026-06-30): 카테고리 1개 + 직교 두 축(주입/출처). ──
//  옛 R·K·H·W '종류'는 폐기. WIKI 탭과 동일 용어·칩(kn-chip)으로 맞춘다: 주입=항상 주입/검색, 출처=저작/외부 미러.
//  '할 일·과업'은 더 이상 지식이 아니라 [프로젝트] 탭(맥락의 변화)으로 분리됨.
function kindsCard() {
    // WIKI 탭의 injection/provenance 칩과 동일 스타일.
    const chip = (mod, label) => el('span', { class: 'kn-chip ' + mod, text: label });
    // 추상 → 눈으로: 실제 '한 덩어리' 예시 한 장 + 거기 붙는 분류/꼬리표.
    const example = el('div', { class: 'gloss-example' }, el('span', { class: 'gloss-example-tag', text: '이런 게 한 덩어리예요' }), el('div', { class: 'gloss-example-title', text: '경쟁사 가격 비교 (2월 조사)' }), el('div', { class: 'gloss-example-body', text: 'A사 월 9,900원, B사 월 14,000원, 우리 월 12,000원 — 우리가 중간 가격대.' }), el('div', { class: 'kn-ex-meta' }, el('span', { class: 'kn-cat-pill', text: '분야: 시장·경쟁' }), el('span', { class: 'kn-ex-meta-sep', text: '·' }), chip('kn-inject-recalled', '검색'), chip('kn-prov-authored', '저작')), el('div', { class: 'kn-ex-cap', text: '↑ 한 덩어리에는 ‘분야(카테고리)’ 하나와 속성 두 개(주입·출처)가 붙습니다.' }));
    // 축 1 — 주입(언제 AI에게 전달되나)
    const injAxis = el('div', { class: 'kn-axis' }, el('div', { class: 'kn-axis-q', text: '주입 — 언제 AI에게 전달되나?' }), el('p', { class: 'kn-axis-sub', text: '이 지식이 AI 대화에 들어가는 시점.' }), knOpt(chip('kn-inject-always', '항상 주입'), '회사 규칙·페르소나처럼 모든 대화에 늘 자동으로 들어가요.', '추측으로 답하지 않기 — 근거 없으면 “잘 모르겠다”고 말한다'), knOpt(chip('kn-inject-recalled', '검색'), '평소엔 주입되지 않고, 관련된 일을 할 때 AI가 검색해 읽습니다.', '경쟁사 가격 비교 · 새 팀원 온보딩 절차'));
    // 축 2 — 출처(어디서 왔나)
    const provAxis = el('div', { class: 'kn-axis' }, el('div', { class: 'kn-axis-q', text: '출처 — 어디서 왔나?' }), el('p', { class: 'kn-axis-sub', text: '이 지식의 원본이 어디 있나.' }), knOpt(chip('kn-prov-authored', '저작'), '이 안에서 직접 써넣은 지식. 원본이 여기 있어요.', '우리가 정리한 결정·런북·조사'), knOpt(chip('kn-prov-observed', '외부 미러'), '노션·클릭업 등 외부 도구에서 동기화해 가져온 사본입니다. 원본 편집은 외부 도구에서 합니다.', '미러된 노션 문서 · 클릭업 과업'));
    return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '조금 더: WIKI에 쌓이는 ‘지식 한 덩어리’란?' })), el('p', { class: 'guide-lead', text: 'WIKI에 담기는 지식은 제목과 내용으로 된 짧은 글 한 장이에요 — 메모 한 장, 문서 한 페이지 같은 거죠. 회사가 오래 기억해야 할 사실·결정·규칙·설명서가 한 덩어리씩 쌓입니다.' }), example, el('p', { class: 'guide-kinds-q', text: '두 속성은 각각 이런 질문에 답합니다:' }), el('div', { class: 'kn-axis-grid' }, injAxis, provAxis), el('div', { class: 'guide-note' }, el('span', { class: 'kn-chip kn-pin', text: '📌 인덱스' }), el('div', {}, el('b', { text: '특히 중요한 지식' }), '은 인덱스에 ‘핀’해 두면, 제목이 매 대화 첫머리에 항상 포함되어 모두가 바로 발견해요.')), el('p', { class: 'admin-hint', style: 'margin-top:12px' }, '‘지금 진행 중인 ', el('b', { text: '할 일·과업' }), '’은 WIKI가 아니라 ', el('a', { href: '#/projects2', text: '[프로젝트] 탭' }), '에서 다룹니다 — WIKI에는 ‘오래 남는 기록’만 담습니다.'), el('p', { class: 'admin-hint', style: 'margin-top:6px' }, '실제 지식들은 ', el('a', { href: '#/knowledge', text: '[WIKI] 탭' }), '에서 볼 수 있어요.'));
}
// 축 옵션 한 줄 — 칩 + 설명 + 작은 예시.
function knOpt(chipEl, desc, ex) {
    return el('div', { class: 'kn-axis-opt' }, el('div', { class: 'kn-axis-opt-head' }, chipEl), el('div', { class: 'kn-axis-opt-desc', text: desc }), el('div', { class: 'kn-axis-opt-ex' }, el('b', { text: '예: ' }), ex));
}
// ── 그 지식을 [프로젝트]에 '필요지식'으로 연결하면? — 맥락의 기록(WIKI) → 맥락의 변화(프로젝트) 다리. 비개발자용(#317). ──
//  새 CSS 없이 hero 의 guide-flow + guide-remember 패턴 재사용(같은 '3단계' 시각 언어로 통일).
function projectKnowledgeCard() {
    return el('div', { class: 'card', id: 'learn-required' }, el('div', { class: 'card-head' }, el('h2', { text: '프로젝트에 ‘필요지식’을 연결하면 뭐가 좋나요' })), el('p', { class: 'guide-lead', text: 'WIKI에 쌓인 지식은 [프로젝트]에서 ‘필요지식’으로 연결할 수 있어요. 어떤 일을 시작하기 전에 “이건 먼저 알아야 한다”는 지식을 골라 붙여두면, 그 프로젝트를 맡는 AI가 그 내용을 검색으로 찾을 필요 없이 처음부터 아는 상태로 일을 시작합니다.' }), el('div', { class: 'guide-flow' }, flowStep('book-open', '지식 고르기', '관련된 결정·규칙·자료를 그 프로젝트의 ‘필요지식’으로 연결해요.'), flowArrow(), flowStep('send', '자동으로 전달', '그 프로젝트를 맡은 AI에게 그 지식이 처음부터 함께 전달돼요.'), flowArrow(), flowStep('zap', '헤매지 않고 시작', '배경을 다시 묻거나 모른 채 추측하지 않고, 팀의 결정대로 정확히 일해요.')), el('div', { class: 'guide-remember' }, el('span', { class: 'guide-remember-key', text: '왜 좋나' }), el('p', { text: '필요지식을 붙여두면 AI가 ‘회사를 아는 채로’를 넘어 ‘이 프로젝트를 아는 채로’ 시작합니다 — 같은 배경을 반복해 설명하지 않아도 돼요.' })), el('p', { class: 'admin-hint', style: 'margin-top:12px' }, '‘필요’는 시작 전에 참고할 지식, ‘산출’은 그 프로젝트가 일하며 새로 만들어 낸 지식이에요. 산출은 처음엔 비어 있는 게 정상 — 일이 진행되며 쌓여요.'), el('p', { class: 'admin-hint', style: 'margin-top:6px' }, '프로젝트를 열고 ‘지식 흐름’에서 ', el('b', { text: '[✨ 지식 찾기]' }), '를 누르면 관련 지식을 추천해 줘요. ', el('a', { href: '#/projects2', text: '[프로젝트] 탭' }), '에서 직접 해볼 수 있어요.'));
}
// 탭/단계 아이콘 — feather 스타일 라인 아이콘(taskmodal 의 sv 패턴 재사용). 무채 스트로크, currentColor 상속.
const GUIDE_ICONS = {
    home: [['path', { d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['polyline', { points: '9 22 9 12 15 12 15 22' }]],
    'play-circle': [['circle', { cx: 12, cy: 12, r: 10 }], ['polygon', { points: '10 8 16 12 10 16 10 8' }]],
    terminal: [['polyline', { points: '4 17 10 11 4 5' }], ['line', { x1: 12, y1: 19, x2: 20, y2: 19 }]],
    trello: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 }], ['line', { x1: 9, y1: 8, x2: 9, y2: 16 }], ['line', { x1: 15, y1: 8, x2: 15, y2: 11 }]],
    'share-2': [['circle', { cx: 18, cy: 5, r: 3 }], ['circle', { cx: 6, cy: 12, r: 3 }], ['circle', { cx: 18, cy: 19, r: 3 }],
        ['line', { x1: 8.59, y1: 13.51, x2: 15.42, y2: 17.49 }], ['line', { x1: 15.41, y1: 6.51, x2: 8.59, y2: 10.49 }]],
    'book-open': [['path', { d: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z' }], ['path', { d: 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z' }]],
    sliders: [['line', { x1: 4, y1: 21, x2: 4, y2: 14 }], ['line', { x1: 4, y1: 10, x2: 4, y2: 3 }], ['line', { x1: 12, y1: 21, x2: 12, y2: 12 }],
        ['line', { x1: 12, y1: 8, x2: 12, y2: 3 }], ['line', { x1: 20, y1: 21, x2: 20, y2: 16 }], ['line', { x1: 20, y1: 12, x2: 20, y2: 3 }],
        ['line', { x1: 1, y1: 14, x2: 7, y2: 14 }], ['line', { x1: 9, y1: 8, x2: 15, y2: 8 }], ['line', { x1: 17, y1: 16, x2: 23, y2: 16 }]],
    compass: [['circle', { cx: 12, cy: 12, r: 10 }], ['polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' }]],
    layers: [['polygon', { points: '12 2 2 7 12 12 22 7 12 2' }], ['polyline', { points: '2 17 12 22 22 17' }], ['polyline', { points: '2 12 12 17 22 12' }]],
    send: [['line', { x1: 22, y1: 2, x2: 11, y2: 13 }], ['polygon', { points: '22 2 15 22 11 13 2 9 22 2' }]],
    zap: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]],
    // '다시 쌓기'(#780 순환 4단계) — 일한 결과를 지식으로 남겨 되돌려 놓는다(feather save).
    save: [['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }],
        ['polyline', { points: '17 21 17 13 7 13 7 21' }], ['polyline', { points: '7 3 7 8 15 8' }]],
};
function tabIcon(name) {
    const svg = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of (GUIDE_ICONS[name] || []))
        svg.append(sv(t, a));
    return svg;
}
// ── Lively 둘러보기(#/learn/tour, #761) — 실제 화면 위 스포트라이트 투어의 랜딩. ──
//  시작만 여기서: 진행은 guide-tour.ts(장면 오케스트레이터)가 상단 탭 클릭 → 라우팅 → 재개로 이어 간다.
//  §0.5 채색 예산: 채운 파란 버튼은 [▶ 둘러보기 시작] 1개뿐 — 코스별 버튼은 ghost.
async function renderLearnTour(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, 'Lively ', el('span', { class: 'accent', text: '둘러보기' })));
    const intro = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '눌러보며 익혀요' })), el('p', { class: 'guide-lead', text: '실제 화면 위에서 지금 눌러야 할 곳을 표시하며 한 단계씩 안내합니다. 처음부터 쭉 볼 수도 있고, 아래에서 원하는 섹션만 골라 볼 수도 있습니다. 진행 중 언제든 화면 위 ✕ 버튼이나 ESC 키로 멈출 수 있습니다.' }), isGuideTourDone() ? el('p', { class: 'admin-hint', text: '✓ 세 섹션을 모두 봤어요 — 언제든 다시 볼 수 있어요.' }) : null, el('div', { class: 'step-cta' }, el('button', { class: 'btn btn-primary', text: '▶ 처음부터 쭉 보기 (약 3분)', onclick: () => startGuideTour() })), el('p', { class: 'admin-hint', style: 'margin:6px 0 0', text: '프로젝트 → 도메인 맵 → WIKI 순서로 진행돼요.' }));
    // 섹션 한 줄(#780) — 골라 들어가는 게 주 동선이라 진입 버튼을 각 줄에 두고, 본 섹션은 ✓ 로 표시한다.
    //  pathStep 과 같은 시각 언어(번호·제목·설명). §0.5 채색 예산: 채운 파란 버튼은 위 '처음부터 쭉 보기' 하나뿐.
    const courseRow = (num, key, title, desc) => el('div', { class: 'guide-path-step' }, el('div', { class: 'guide-path-num', 'aria-hidden': 'true', text: num }), el('div', { class: 'guide-path-body' }, el('div', { class: 'guide-path-title' }, el('span', { text: title }), isSectionDone(key) ? el('span', { class: 'admin-hint', style: 'margin-left:8px;font-weight:400', text: '✓ 봤어요' }) : null), el('p', { class: 'guide-path-desc', text: desc }), el('button', { class: 'btn btn-sm btn-ghost guide-path-btn', text: '▶ ' + title.split(' — ')[0] + '만 보기', onclick: () => startGuideTour([key]) })));
    const courses = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '섹션만 골라 보기' })), el('p', { class: 'guide-lead', text: '급하면 필요한 것만 봐도 돼요. 각 섹션은 따로 시작하고 따로 끝나요.' }), el('div', { class: 'guide-path' }, courseRow('1', 'projects', '프로젝트 — 일의 흐름', '회사의 일이 어디서 어떻게 진행되는지: 보드와 리스트, 프로젝트 상세, 그리고 AI에게 전달하는 \'필요지식\'.'), courseRow('2', 'domainmap', '도메인 맵 — 코드의 구조', '제품 코드가 어떤 도메인 단위로 나뉘어 있는지, 하려던 것(should)과 실제(is)의 대조.'), courseRow('3', 'wiki', 'WIKI — AI가 읽는 지식', '회사 지식이 어떻게 분류·검색되는지, 지식 한 덩어리와 핀(인덱스)의 의미.')));
    const extra = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '더 해보기' })), el('p', { class: 'admin-hint', text: 'AI 세션을 직접 만들어 첫 대화까지 해보는 실습 가이드는 별도로 있어요.' }), el('div', { class: 'step-cta', style: 'margin-bottom:0' }, el('a', { class: 'btn btn-sm btn-ghost', href: '#/dashboard?tour=1', text: '홈에서 따라하며 만들기 →' }), 
    // #762 '#/learn/install' 페이지 숨김 → 같은 설치 화면을 품은 '시작하기'(#/start)로 링크(복원 시 '#/learn/install'·'내 AI 세션 생성'으로 되돌리기).
    el('a', { class: 'btn btn-sm btn-ghost', href: '#/start', text: '내 컴퓨터에 설치하기 — 시작하기 →' })));
    docsShell(view, 'tour', docsEyebrow('tour'), head, el('div', { class: 'guide-cards' }, intro, courses, extra));
}
// 설치 탭(#/install) — 모든 구성원의 첫 행동. 비개발자도 그대로 따라 하도록 구성한다.
//  핵심: 쓰는 곳이 두 갈래라 시작법이 다르다 — (web) 라이블리 [터미널] 탭=서버에서 claude/codex 가 돌고
//  회사맥락이 이미 설치돼 있어 '설치 0' / (local) 내 컴퓨터 터미널=내 머신에 한 번 설치. mode 토글로 분기.
//  게이트웨이 주소는 org 프로필에서(loadAdmin — 비-admin 도 안전: tokens redact).
async function renderInstall(view) {
    // 부제 없음(#780) — 문서 셸의 다른 페이지들과 제목 줄을 맞춘다. 화면 이름은 '내 AI 세션 생성'(사이드바와 동일).
    const head = pageHead('내 AI 세션 생성', null, [], '생성');
    const slot = el('div', { class: 'install-guide' });
    slot.append(skeleton('설치 안내를 준비하는 중'));
    // 설치 후 명령·Claude/Codex 차이·문제 해결은 별도 문서(#/learn/docs/cli)로 분리 — 설치 페이지는 '설치까지'만.
    docsShell(view, 'install', docsEyebrow('install'), head, slot);
    onboardingBanner().then((b) => { if (b)
        head.before(b); }); // 온보딩 진행 배너(미완 시) — 제목 '위'로 → #/onboarding
    loadAdmin().then((data) => drawInstallGuide(slot, data))
        .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
}
// 설치 화면을 '팝업(모달)'으로 — #/start ② '내 컴퓨터에서도 쓰기'와 '예전 환경 가져오기'에서 호출. 페이지 이동 없이 그 자리에서.
//  #1000: 설치는 모달이 유일 표면이다(옛 전체페이지 #/start/setup 은 폐지 → #/start 리다이렉트). 그래서 '전체보기 ↗' 링크를 없앴다.
//  사이드바 없이 설치 가이드(drawInstallGuide)만 담는다. 프로젝트 상세 팝업(.pjv-pm)과 같은 셸을 재사용한다.
function openInstallModal() {
    const back = el('div', { class: 'pjv-pm-back' });
    const box = el('div', { class: 'pjv-pm' });
    const bodyEl = el('div', { class: 'pjv-pm-body' });
    const closeBtn = el('button', { class: 'pjv-pm-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', text: '✕' });
    box.append(el('div', { class: 'pjv-pm-head' }, el('b', { class: 'pjv-pm-title', text: '내 컴퓨터에 설치' }), closeBtn), bodyEl);
    back.append(box);
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('hashchange', close);
        document.body.classList.remove('pjv-pm-open');
        back.remove();
    };
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.pjv-pop, .tour-root, .ov-back'))
        close(); }
    back.addEventListener('mousedown', (e) => { if (e.target === back)
        close(); });
    closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
    document.addEventListener('keydown', onKey, true);
    // 모달엔 사이드바가 없어 라우팅(뒤로가기·딥링크)이 유일한 이탈 경로다 — 해시가 바뀌면 닫아 다음 화면 위에 남지 않게(#1000).
    window.addEventListener('hashchange', close);
    document.body.append(back);
    document.body.classList.add('pjv-pm-open');
    const slot = el('div', { class: 'install-guide' }, skeleton('설치 안내를 준비하는 중'));
    bodyEl.append(slot);
    // 이미 '로컬에서 만들기'로 들어왔으니 상단 '어디서 쓰나' 선택 카드는 숨기고 로컬 설치 가이드만 바로 보여준다(중복 제거).
    loadAdmin().then((data) => drawInstallGuide(slot, data, { noChooser: true }))
        .catch((e) => slot.replaceChildren(errorNote(e, '설치 안내를 불러오지 못했습니다')));
    return close;
}
// 설치 가이드 — 먼저 '어디서 쓰나'(web/local) 를 고르게 하고, 고른 모드의 가이드만 렌더. slot 안만 교체.
//  opts.noChooser — 이미 '로컬'을 고르고 들어온 팝업(openInstallModal)에선 상단 '어디서 쓰나' 선택 카드를 숨기고
//   로컬 가이드만 바로 보여준다(중복 제거). OS 토글 재렌더에도 opts 를 그대로 넘겨 유지한다.
function drawInstallGuide(slot, data, opts) {
    const noChooser = !!(opts && opts.noChooser);
    const gw = (data.profile.gateway_url || window.location.origin).replace(/\/mcp$/, '').replace(/\/$/, '');
    const mode = noChooser ? 'local' : (state.start.mode === 'local' ? 'local' : 'web');
    // ── 어디서 쓰나 — 두 갈래 선택(카드 클릭 시 아래 가이드가 바뀜). 설명은 한 줄만(#780 → 장황함 제거). ──
    const chooser = noChooser ? null : el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '어디서 AI를 쓰실 건가요?' })), el('p', { class: 'admin-hint', style: 'margin-bottom:12px' }, '어느 쪽을 골라도 같은 AI에 같은 회사 맥락이 들어갑니다. 고민되면 ', el('b', { text: '설치 없이 바로 쓰는 왼쪽' }), ' 으로 시작하세요.'), el('div', { class: 'mode-choice' }, modeCard('web', '라이블리 웹에서 바로', '설치 없이 · 브라우저만', '비개발자 친화', mode, slot, data), modeCard('local', '내 컴퓨터에서', '한 번 설치 · 약 5분', '개발자 친화', mode, slot, data)));
    const guide = mode === 'web' ? webGuideNodes() : localGuideNodes(gw, slot, data, opts);
    slot.replaceChildren(...(chooser ? [chooser] : []), ...guide);
}
// 모드 선택 카드(라이블리 웹 vs 내 컴퓨터). 선택 시 재렌더.
//  audience = 카드별 대상 핀(비개발자 친화 / 개발자 친화). '상황' 한 줄(who)은 위 안내와 겹쳐 제거(#780).
function modeCard(key, title, tag, audience, active, slot, data) {
    const on = key === active;
    const pick = () => { if (state.start.mode !== key) {
        state.start.mode = key;
        drawInstallGuide(slot, data);
    } };
    return el('div', {
        class: 'mode-card' + (on ? ' active' : ''), role: 'button', tabindex: '0',
        'aria-pressed': on ? 'true' : 'false',
        onclick: pick,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
        } },
    }, el('span', { class: 'mode-card-radio', 'aria-hidden': 'true' }), el('div', { class: 'mode-card-head' }, el('div', { class: 'mode-card-title', text: title }), el('span', { class: 'mode-card-tag', text: tag })), el('div', { class: 'mode-card-who' }, el('span', { class: 'mode-card-who-label', text: audience })));
}
// (web) 라이블리 웹에서 쓰는 사람 — 내 컴퓨터엔 설치 0. AI 는 서버에서 회사맥락을 가진 채 돈다.
//  세션 만들기는 [홈]에서 한다(#780) — 예전엔 터미널 탭으로 보냈으나, 홈의 「내 AI 세션」 카드가 첫 화면이자 상시 진입점.
function webGuideNodes() {
    const callout = el('div', { class: 'card install-callout' }, el('div', { class: 'callout-strong', text: '내 컴퓨터엔 아무것도 설치하지 않습니다.' }), el('p', { class: 'callout-sub', text: 'AI는 라이블리 서버에서 실행되고, 회사 맥락·규칙도 거기에 이미 준비돼 있어요. 브라우저만 있으면 바로 시작할 수 있습니다.' }));
    // 따라하기 투어 — 홈(#/dashboard?tour=1)으로 이동하면서 스포트라이트를 켠다(main.ts → startDashboardSessionTour).
    //  눌러야 할 곳만 밝게 남기고 나머지를 덮은 뒤, 실제 버튼을 직접 누르며 한 단계씩 진행한다.
    //  §0.5 예산: 채운 blue primary 는 이 화면 1개뿐(따라하며 만들기).
    const tourBtn = el('a', {
        class: 'btn btn-primary', href: '#/dashboard?tour=1',
        text: '홈에서 따라하며 만들기 →',
    });
    const newWinBtn = el('a', {
        class: 'btn btn-ghost', href: '#/dashboard?tour=1', target: '_blank', rel: 'noopener',
        text: '새 창으로 열기 ↗',
    });
    const steps = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '홈에서 내 AI 세션 만들기' })), el('p', { class: 'admin-hint', text: '아래 버튼을 누르면 홈(대시보드)으로 넘어가면서, 눌러야 할 곳만 밝게 강조해 한 단계씩 짚어주는 “따라하기”가 시작돼요. 화면 속 버튼을 직접 누르며 진행하면 됩니다.' }), el('div', { class: 'step-cta' }, tourBtn, newWinBtn), 
    // 미리보기 — 따라하기가 짚어줄 순서. JS 안내가 안 떠도 흐름을 알 수 있게 남겨 둔다(폴백).
    el('div', { class: 'step-list' }, installStep(1, '홈에서 [+ 새 세션] 누르기', el('p', { class: 'step-p' }, '홈 가운데 ', el('b', { text: '「내 AI 세션」' }), ' 카드에서 ', el('b', { text: '[+ 새 세션]' }), ' 을 누르면 만들기 창이 홈 화면 위에 바로 열려요.')), installStep(2, '작업 폴더와 AI를 고르고 이름 정하기', el('p', { class: 'step-p' }, '작업 폴더(', el('b', { text: '공유 워크스페이스' }), ' 또는 ', el('b', { text: '개인 폴더' }), '), 사용할 AI(', el('b', { text: 'Claude Code' }), ' 또는 ', el('b', { text: 'Codex' }), '), 세션 이름을 정하세요.'), el('p', { class: 'step-note', text: '잘 모르겠으면 — 작업 폴더는 [개인 폴더], AI는 [Claude Code]를 그대로 두면 됩니다.' })), installStep(3, '[생성하기] → 바로 요청 입력하기', el('p', { class: 'step-p', text: '[생성하기]를 누르면 새 탭에 세션 창이 열려요. 거기에 요청할 내용을 입력하면 됩니다 — 회사 맥락·규칙은 이미 들어가 있어요.' }), el('p', { class: 'step-note', text: '세션은 창을 닫아도 서버에 남아 있어요. 다음에 홈의 「내 AI 세션」에서 [열기]로 이어서 쓰면 됩니다.' }))));
    return [callout, steps];
}
// (local) 내 컴퓨터 터미널에서 쓰는 사람 — 내 머신에 한 번 설치. OS 토글로 단계가 바뀐다.
function localGuideNodes(gw, slot, data, opts) {
    const os = state.start.os === 'windows' ? 'windows' : 'mac';
    const isWin = os === 'windows';
    const callout = el('div', { class: 'card install-callout' }, el('div', { class: 'callout-strong', text: '내 컴퓨터에 한 번 설치합니다 (약 5분).' }), el('p', { class: 'callout-sub', text: '설치하면 내 노트북에서 claude(또는 codex)를 켤 때마다 회사 맥락이 자동으로 들어와요. 처음 딱 한 번만 하면 끝입니다.' }));
    // ── 준비물 — 대부분 이미 있음. 막히기 쉬운 node 는 확인법까지 명시(없으면 hooks 미설치=조용한 반쪽설치). ──
    const needs = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '준비물 (잠깐 확인)' })), el('p', { class: 'admin-hint', text: '아래만 있으면 됩니다. 대부분 이미 갖춰져 있어요.' }), checklist([
        ['내 컴퓨터 (Mac 또는 Windows)', '회사에서 쓰는 본인 노트북이면 됩니다.'],
        ['명령 입력 창', isWin ? 'Windows 에 기본으로 들어 있는 PowerShell 을 씁니다. 여는 법은 아래 1단계에서 알려드립니다.'
                : 'macOS 에 기본으로 들어 있는 ‘터미널’ 앱을 씁니다. 여는 법은 아래 1단계에서 알려드립니다.'],
        ['Node.js — 없어도 됩니다', '이미 있으면 그대로 쓰고, 없으면 설치기가 관리자 권한 없이 알아서 준비해요. 따로 받아 둘 필요가 없습니다.'],
        ['회사 계정', '설치 마지막에 회사 계정으로 로그인하는 브라우저 창이 한 번 뜹니다.'],
    ]));
    // ── 2. 단계 — OS 토글을 카드 헤더에 두고, 단계 본문이 OS 에 맞게 바뀐다 ──
    const osTabs = el('div', { class: 'os-tabs' }, ...[['mac', 'macOS'], ['windows', 'Windows']].map(([o, label]) => el('button', {
        class: 'btn btn-sm ' + (o === os ? 'btn-primary' : 'btn-ghost'), text: label,
        onclick: () => { if (state.start.os !== o) {
            state.start.os = o;
            drawInstallGuide(slot, data, opts);
        } }
    })));
    // 1단계 — 명령 입력 창 열기. (여기서 말하는 '터미널'은 macOS 에 들어 있는 앱 이름이다. 제품의 AI 세션과는 다른 것.)
    const term = isWin
        ? installStep(1, '명령 입력 창(PowerShell) 열기', el('p', { class: 'step-p' }, '화면 왼쪽 아래 ', kbd('시작'), ' 버튼을 누르고 ', kbd('powershell'), ' 라고 입력 → 목록에서 ', el('b', { text: 'Windows PowerShell' }), ' 을 클릭하세요.'), el('p', { class: 'step-note', text: '파란색 글자 입력 창이 하나 뜹니다. 이게 명령을 붙여넣을 곳이에요.' }))
        : installStep(1, '명령 입력 창(터미널 앱) 열기', el('p', { class: 'step-p' }, '키보드에서 ', kbd('⌘'), ' + ', kbd('스페이스바'), ' 를 동시에 눌러 검색창을 띄우고, ', kbd('터미널'), ' 이라고 입력한 뒤 ', kbd('Enter'), ' 를 누르세요.'), el('p', { class: 'step-note', text: '글자만 있는 작은 창이 하나 뜹니다. macOS 에 기본으로 들어 있는 앱이고, 여기에 명령을 붙여넣게 됩니다.' }));
    // 2단계 — 설치 명령 붙여넣기 → **브라우저 승인**. #880 부터 토큰을 복붙하지 않는다(명령줄·프롬프트 어디에도).
    //  설치 중 브라우저 승인 창이 열리고, 승인하면 터미널이 로그인을 이어받는다.
    const run = installStep(2, '설치 명령 붙여넣고 승인하기', el('p', { class: 'step-p' }, '1단계에서 연 창을 클릭한 다음, 아래 명령을 복사해 붙여넣고(', isWin ? kbd('Ctrl') : kbd('⌘'), ' + ', kbd('V'), ') ', kbd('Enter'), ' 를 누르세요.'), cmdLine(installCmd(gw, os)), el('p', { class: 'step-note', text: '토큰을 다룰 필요가 없어요 — 그냥 붙여넣으면 됩니다. 도중에 이런 게 나와요:' }), el('ul', { class: 'step-ul' }, el('li', {}, el('b', { text: '라이블리 승인 창' }), ' 이 자동으로 열려요(회사 계정). ', '터미널에 표시된 ', el('b', { text: '코드가 같은지 확인' }), ' 하고 ', el('b', { text: '[승인]' }), ' 을 누르세요. ', el('span', { class: 'step-note-inline', text: '(안 열리면 터미널에 뜬 주소를 직접 여세요.)' })), el('li', {}, 'Claude Code 가 없으면 ', el('b', { text: '“지금 설치할까요?”' }), ' → ', kbd('Y'), ' ', kbd('Enter'), '.'), el('li', {}, '터미널로 돌아오면 ', el('b', { text: '“…로 로그인됩니다. 계속?”' }), ' 이 떠요 → 본인 계정이 맞으면 ', kbd('Y'), '.'), el('li', {}, el('b', { text: '“=== 끝! ===”' }), ' 이 보이면 설치가 끝난 거예요.')), el('p', { class: 'step-note' }, '※ ', el('b', { text: 'Claude Code(Anthropic 계정) 로그인' }), ' 창은 나중에 ', el('b', { text: '처음 claude 를 켤 때' }), ' 따로 떠요 — 위 라이블리 승인과는 다른 계정·다른 시점입니다.'));
    const verify = installStep(3, '잘 됐는지 확인하기', el('p', { class: 'step-p' }, '같은 창에 아래를 입력하고 ', kbd('Enter'), ' 를 누르세요.'), cmdLine('lively status'), el('p', { class: 'step-note' }, '게이트웨이 ', el('b', { text: '도달 OK' }), ' · 내 이름 · ', el('b', { text: 'MCP 등록 ✓' }), ' 가 보이면 성공이에요. ', '이제 어느 폴더에서든 ', el('code', { class: 'md-code', text: 'claude' }), ' 를 켜면 회사 맥락이 따라옵니다. ', '(자동 주입은 ', el('b', { text: '다음 세션부터' }), ' 적용됩니다.)'), el('p', { class: 'step-note' }, '뭔가 이상하면 ', el('code', { class: 'md-code', text: 'lively doctor' }), ' — 무엇이 잘못됐고 어떻게 고치는지 알려 줍니다.'));
    // 고급 · CI — 자동화(스크립트·프로비저닝)는 브라우저 승인 대신 토큰을 직접 쓴다(`lively login --token`).
    //  일반 사용자는 볼 일 없으니 접어 둔다(#880: mint 는 더 이상 기본 흐름이 아니다).
    const advanced = el('details', { class: 'install-maint' }, el('summary', { text: '＋ 고급: CI·자동화용 토큰 발급 (일반 설치엔 필요 없어요)' }), el('p', { class: 'admin-hint', text: '스크립트·서버처럼 브라우저를 못 여는 곳에서는 토큰을 직접 씁니다: lively login --token <토큰>. 아래에서 본인 토큰을 발급하세요(비밀번호처럼 취급 — 공유 금지).' }), tokenMintBox());
    const steps = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '설치 단계' }), el('div', { class: 'os-pick' }, el('span', { class: 'os-pick-label', text: '내 컴퓨터' }), osTabs)), isWin ? el('p', { class: 'admin-warn', text: '⚠ Windows 설치는 아직 검증이 충분치 않습니다. 막히면 관리자에게 알려주세요.' }) : null, el('div', { class: 'step-list' }, term, run, verify), advanced);
    // ── 3. 끝났어요 — 이제 뭘 하나 ──
    const next = el('div', { class: 'card install-next' }, el('div', { class: 'card-head' }, el('h2', { text: '끝났어요 — 이제 뭘 하나요' })), el('p', { class: 'guide-lead', text: '설치가 끝나면 평소처럼 Claude Code 를 켜서 일하면 됩니다. 어느 폴더에서 켜든 회사 공통 맥락·규칙이 자동으로 함께 들어가요. 매번 회사 사정을 설명하지 않아도 됩니다.' }), el('p', { class: 'admin-hint' }, '내 컴퓨터에서 켜든 웹에서 켜든 같은 회사 맥락을 씁니다 — 웹에서 열고 싶으면 ', el('a', { href: '#/dashboard', text: '[홈]' }), ' 의 「내 AI 세션」에서 [+ 새 세션]을 누르세요. 회사에 어떤 맥락이 쌓여 있는지는 ', el('a', { href: '#/knowledge', text: '[WIKI]' }), ' 에서 볼 수 있어요.'), el('p', { class: 'admin-hint' }, '예전에 쓰던 AI 환경(작업 메모·직접 만든 스킬 등)이 있다면 ', el('a', { href: '#/start/migrate', text: '[예전 환경 가져오기]' }), ' — 켜서 ', el('code', { class: 'md-code', text: '온보딩 도와줘' }), ' 라고 말하면(또는 ', el('code', { class: 'md-code', text: 'lively onboarding' }), ') AI 가 읽어서 정리를 도와줍니다. 원본은 건드리지 않아요.'), el('p', { class: 'admin-hint', style: 'margin-bottom:0' }, '설치 후 쓸 수 있는 ', el('code', { class: 'md-code', text: 'lively' }), ' 명령 · Claude/Codex 차이 · 문제 해결은 ', el('a', { href: '#/learn/docs/cli', text: '[AI 세션 명령어]' }), ' 에서 보세요.'));
    // ── 4. 유지보수(접힘) — 업데이트는 이제 자동이라 평소엔 볼 일이 없다(#858). 제거·강제갱신용. ──
    const staticBlock = (c) => el('div', { class: 'deploy-block' }, el('div', { class: 'deploy-head' }, el('h3', { text: c.title }), c.cmd !== '(준비 중)' ? copyButton(() => c.cmd, '복사') : null), el('p', { class: 'admin-hint', text: c.note }), el('pre', { class: 'admin-preview', text: c.cmd }));
    const auto = el('p', { class: 'admin-hint' }, el('b', { text: '업데이트는 자동입니다. ' }), 'Claude Code(또는 Codex)를 켤 때마다 라이블리가 최신인지 확인하고, 다르면 백그라운드로 받아 설치합니다 — ', el('b', { text: '다음에 켤 때부터' }), ' 적용돼요(작업 중인 세션은 방해하지 않습니다). 아래 명령은 ', el('b', { text: '자동 업데이트를 껐거나, 지금 당장 맞춰야 할 때' }), '만 쓰면 됩니다.');
    // 설치 후 쓸 수 있는 명령들 — 유지보수 패널을 열었다는 건 "뭔가 손봐야 한다"는 뜻이니 doctor 를 가장 먼저 보여준다.
    const cheats = el('div', { class: 'deploy-block' }, el('h3', { text: '알아 두면 좋은 명령' }), el('p', { class: 'admin-hint', text: '설치가 끝나면 터미널에서 `lively` 를 쓸 수 있어요.' }), el('div', { class: 'step-list' }, cmdLine('lively doctor'), el('p', { class: 'step-note', text: '뭐가 잘못됐는지 + 어떻게 고치는지 알려 줍니다. 문제가 생기면 이것부터.' }), cmdLine('lively status'), el('p', { class: 'step-note', text: '지금 설치 상태 · 버전 · MCP 등록 여부.' }), cmdLine('lively run 123'), el('p', { class: 'step-note', text: '프로젝트를 내 PC 에서 열기(프로젝트 번호). 프로젝트 화면의 [💻 내 PC에서 열기] 가 만들어 주는 명령과 같습니다.' })));
    const maint = el('details', { class: 'install-maint' }, el('summary', { text: '＋ 나중에 필요할 때: 명령어 · 업데이트 · 제거 (지금은 안 봐도 됩니다)' }), cheats, auto, ...deployCommands(gw, os).filter((c) => c.kind !== 'install').map(staticBlock));
    return [callout, needs, steps, next, maint];
}
// 번호 매긴 설치 단계 한 칸.
function installStep(n, title, ...body) {
    return el('div', { class: 'step' }, el('div', { class: 'step-num', 'aria-hidden': 'true', text: String(n) }), el('div', { class: 'step-body' }, el('div', { class: 'step-title', text: title }), ...body));
}
// 접속 토큰 셀프 발급 (#864) — 로그인된 본인이 [내 토큰 발급] 한 번으로 본인 토큰을 받는다.
//  종전(installSelfCmdBox)은 이 토큰을 **설치 명령줄에 구워** 건넸다 → 복붙하면 ~/.zsh_history 에 평문으로 영구히 남았다.
//  이제는 토큰만 건네고, 설치 명령(3단계)은 토큰 없는 정적 한 줄이다. 토큰은 CLI 의 가림 프롬프트에 붙여넣는다.
//  (그래서 이 함수는 OS 를 몰라도 된다 — 토큰은 mac/win 이 같다.)
function tokenMintBox() {
    const result = el('div', { class: 'install-cmd-slot' });
    // #632: admin/runtime 보유자만 — 관리 권한을 이 토큰에 실을지 opt-in(기본 off). 멤버 scope 가 상한(증폭 불가).
    //  (state.me.scopes = 현재 세션 유효 scope — admin.ts hasScope 와 동일 판정.)
    const canCp = !!(state.me && Array.isArray(state.me.scopes) && (state.me.scopes.includes('admin') || state.me.scopes.includes('runtime')));
    const cpChk = el('input', { type: 'checkbox', style: 'margin-right:6px;vertical-align:middle' });
    const cpLabel = canCp ? el('label', { class: 'caption', style: 'display:block;margin:6px 0;cursor:pointer' }, cpChk, el('span', { text: '관리 권한(admin/runtime) 포함 — 이 토큰으로 설치한 로컬 세션이 관리탭 기능(구성원·토큰·훅·DB소스)을 MCP로 직접 다룹니다. 변경은 감사에 AI로 남습니다.' })) : null;
    const go = el('button', { class: 'btn btn-primary btn-sm', text: '내 토큰 발급' });
    go.addEventListener('click', async () => {
        go.disabled = true;
        try {
            const r = await api('/api/ui/org/token/self', { method: 'POST', body: JSON.stringify({ includeControlPlane: canCp && cpChk.checked }) });
            result.replaceChildren(el('p', { class: 'install-ok', text: '✓ 토큰이 발급됐어요 — [토큰 복사]를 누른 뒤 3단계로 가세요.' }), el('div', { class: 'deploy-head' }, el('span', { class: 'mini-meta', text: '내 접속 토큰' }), copyButton(() => r.token, '토큰 복사')), el('pre', { class: 'admin-preview', text: r.token }), el('p', { class: 'admin-hint', text: '⚠ 지금 이 화면에서만 보여요 — 닫으면 다시 볼 수 없습니다(잃어버리면 다시 발급하면 됩니다).' }));
        }
        catch (e) {
            result.replaceChildren(el('p', { class: 'install-token-err', text: '발급 실패 — ' + e.message }));
        }
        go.disabled = false;
    });
    return el('div', {}, cpLabel, el('div', { class: 'install-minter' }, go), result);
}
// 복사 가능한 한 줄 명령(확인용 등 — 토큰 없는 짧은 명령).
function cmdLine(cmd) {
    return el('div', { class: 'cmd-line' }, el('code', { class: 'cmd-line-text', text: cmd }), copyButton(() => cmd, '복사'));
}
// 키캡(키보드 키·메뉴 항목 강조) — 비개발자용 시각 힌트.
function kbd(label) { return el('span', { class: 'kbd', text: label }); }
// 준비물 체크리스트.
function checklist(items) {
    const wrap = el('div', { class: 'install-checks' });
    for (const [k, v] of items) {
        wrap.append(el('div', { class: 'install-check' }, el('span', { class: 'check-mark', 'aria-hidden': 'true', text: '✓' }), el('div', { class: 'check-main' }, el('div', { class: 'check-k', text: k }), el('div', { class: 'check-v', text: v }))));
    }
    return wrap;
}
function skeleton(caption) {
    return el('div', {}, el('p', { class: 'loading-caption', text: caption + '…' }), el('div', { class: 'skel-stack' }, el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' })));
}
function skeletonRows(n) {
    const box = el('div', {});
    for (let i = 0; i < n; i++)
        box.append(el('div', { class: 'row' }, el('div', { class: 'skel', style: 'min-height:18px;border:none;background:var(--bg-tint)' })));
    return box;
}
// 모달 오버레이(저장/편집 폼) — admin 의 overlay() 와 같은 ESC/배경클릭 닫기. 셸 재사용.
function overlayBox(title, ...content) {
    const box = el('div', { class: 'ov-box' }, el('div', { class: 'ov-head' }, el('h3', { text: title }), el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })), ...content);
    const back = el('div', { class: 'ov-back' }, box);
    back.addEventListener('click', (e) => { if (e.target === back)
        back.remove(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
    } });
    document.body.append(back);
    return back;
}
// ── 온보딩 진행상황(#/onboarding) — SoT = GET /api/ui/org/onboarding (하네스 주입과 동일 소스, 드리프트 0). ──
function obProgress(pct) {
    return el('div', { style: 'height:8px;background:#ececec;border-radius:4px;overflow:hidden;margin:10px 0' }, el('div', { style: `height:100%;width:${pct}%;background:#3a9d6e;transition:width .3s` }));
}
// 시작하기(랜딩) 상단 배너 — 미완일 때만(완료면 null → 안 보임). 클릭 시 #/onboarding.
async function onboardingBanner() {
    try {
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return null;
        return el('a', { class: 'card', href: '#/onboarding', style: 'display:block;text-decoration:none;color:inherit' }, el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, el('strong', { text: `온보딩 진행 ${s.done}/${s.total} (${s.pct}%)` }), el('span', { class: 'accent', text: '진행상황 보기 →' })), obProgress(s.pct), el('p', { class: 'admin-hint', style: 'margin:0', text: '남은 단계를 채우면 AI 세션이 그만큼 더 풍부한 회사 맥락으로 시작합니다(재설치 불필요).' }));
    }
    catch {
        return null;
    }
}
// 전용 페이지 — 단계별 완료 여부 + 진행률. AI(세션 시작)도 같은 SoT 를 받는다는 점을 명시.
async function renderOnboarding(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, '온보딩 ', el('span', { class: 'accent', text: '진행상황' })), el('p', { class: 'sub', text: '이 인스턴스 셋업이 어디까지 됐는지 한눈에 봅니다. AI도 세션 시작 시 같은 진행상황(SoT)을 받아, 덜 된 단계를 사용자에게 안내합니다.' }));
    const slot = el('div', {});
    slot.append(skeleton('진행상황을 불러오는 중'));
    view.replaceChildren(head, slot);
    document.getElementById('view').focus?.();
    try {
        const s = await api('/api/ui/org/onboarding');
        const summary = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: `진행률 ${s.done}/${s.total} (${s.pct}%)` })), obProgress(s.pct), el('p', { class: 'admin-hint', style: 'margin:0', text: s.complete
                ? '✓ 기본 셋업 완료 — 세션에 실제 조직 맥락이 주입됩니다.'
                : '미완 단계를 채우면 다음 세션부터 AI가 그 맥락을 갖고 시작합니다(재설치 불필요 — 라이브 반영).' }));
        const steps = el('div', {});
        s.items.forEach((it, i) => {
            steps.append(el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;opacity:' + (it.done ? '0.65' : '1') }, el('div', { style: `flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;background:${it.done ? '#3a9d6e' : '#bbb'}`, text: it.done ? '✓' : String(i + 1) }), el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'font-weight:600' }, it.label, it.count !== undefined ? el('span', { class: 'admin-hint', text: ` · 현재 ${it.count}` }) : null), el('div', { class: 'admin-hint', style: 'margin:2px 0 0', text: it.how }), it.href ? el('a', { class: 'accent', href: it.href, text: it.done ? '보기 →' : '바로가기 →', style: 'display:inline-block;margin-top:6px;text-decoration:none' }) : null)));
        });
        slot.replaceChildren(summary, steps);
    }
    catch (e) {
        slot.replaceChildren(errorNote(e, '온보딩 진행상황을 불러오지 못했습니다'));
    }
}
export { checklist, openInstallModal, overlayBox, renderInstall, renderLearn, renderLearnDocs, renderLearnMenu, renderLearnTour, renderOnboarding, skeleton, skeletonRows, };
