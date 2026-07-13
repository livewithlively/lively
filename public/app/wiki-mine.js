// wiki-mine.ts — #764v4 대문의 '가공' 엔진. 지식 rows(제목·유형·시간)만으로 세 축을 캔다:
//  ① 일 스레드(mineThreads): 제목의 #NNN 태스크번호로 문서를 '진행된 일' 단위로 묶는다 — 코퍼스 실측상
//     제목의 39~69%(product)가 #NNN 을 포함해 자연 묶음축이 성립. 최근 움직인 스레드 = '지금 진행 중'.
//  ② 주제 그룹(mineThemes): 제목 토큰 빈도 그룹 — 실데이터 검증(V2): lifecycle 메타어 불용어 + 조사 strip +
//     min_size=max(3, 4%n) + substring 병합·매치 + 카테고리명 토큰 제외. 커버 60~75%, 나머지는 '그 외'.
//  ③ 사건 분류(mineEvents): 문서 전체를 스레드/정본 스택/단신으로 배타 분류 — 대문 '일의 흐름' 피드의 원자.
//     정본 스택 = #NNN 없는 동일 주제 중복본(stem 일치 ≥2건, 리서치 카테고리의 개정판 관례).
//  시간 규율(패널 심사의 유일한 공통 안전 규칙): updated_at 은 변별력이 없으므로(전부 최근 뭉침, 시스템 어림)
//     절대 시각은 **제목에서 파싱된 날짜가 있을 때만** 주장한다. 파싱 실패는 정렬에만 조용히 폴백.
//  전부 순수 함수(문서 배열 → 구조) — 서버 API 0, 대문 rows 1콜 재가공. 소비자: wiki-category.ts.
//  순환 import 금지: core 만 import.
// ── 토큰화 (실험 코드와 동일 로직 — python topic_experiment.py V2 의 JS 이식) ──
const TOKEN_RE = /[가-힣]+|[A-Za-z][A-Za-z0-9_.+-]*/g;
const ISSUE_RE = /#\d{2,5}\b/g;
const VER_RE = /\bv\d[\d.]*\b/g;
const DATE_RE = /\d{4}[-.]\d{1,2}([-.]\d{1,2})?/g;
const KO_RE = /^[가-힣]+$/;
// 조사 suffix(긴 것 먼저) — 남는 길이 ≥2 일 때만 1회 strip.
const JOSA = ['으로써', '으로서', '에서의', '으로', '에서', '부터', '까지', '와의', '과의', '에게', '한테',
    '의', '에', '를', '을', '은', '는', '와', '과', '로', '도', '만'];
// 불용어 2층 — 형식어 + '주제가 아니라 작업 상태'인 lifecycle 메타어(이 코퍼스 제목 관용구의 성패 요인).
const STOP_KO = new Set(['및', '대한', '위한', '관련', '기반', '후속', '우리', '기존', '전체', '완전', '단일', '자체',
    '이', '그', '수', '것', '후', '전', '시', '안', '못', '않', '된', '는', '들',
    '설계', '구현', '검증', '배포', '완료', '수정', '정리', '분석', '결정', '개편', '재설계', '개선',
    '문제', '원인', '근본원인', '방식', '방법', '현황', '전면', '확정', '적용', '제거', '폐기', '통합', '전환', '추가',
    '갭', '함정', '불변식', '실측', '진단', '출하', '기록', '모델', '구조', '설정', '지원', '실패', '오류', '버그',
    '가이드', '개요', '재구성', '재배치', '정합', '최신화', '일원화', '표준', '규약', '원칙', '아님', '금지', '없이', '없음', '있음']);
const STOP_EN = new Set(['the', 'of', 'for', 'and', 'to', 'in', 'a', 'an', 'vs', 'is', 'as', 'on', 'with', 'or', 'not',
    'done', 'p1', 'p2', 'p3', 'p4', 'p5']);
function tokenize(title) {
    const t = String(title || '').replace(ISSUE_RE, ' ').replace(VER_RE, ' ').replace(DATE_RE, ' ');
    const out = new Set();
    for (const m of (t.match(TOKEN_RE) || [])) {
        if (KO_RE.test(m)) {
            let w = m;
            for (const j of JOSA) {
                if (w.endsWith(j) && w.length - j.length >= 2) {
                    w = w.slice(0, w.length - j.length);
                    break;
                }
            }
            if (w.length >= 2 && !STOP_KO.has(w))
                out.add(w);
        }
        else {
            const w = m.toLowerCase().replace(/^[.\-_+]+|[.\-_+]+$/g, '');
            if (w.length >= 2 && !STOP_EN.has(w) && !/^[\d.]+$/.test(w))
                out.add(w);
        }
    }
    return out;
}
// ── ① 일 스레드 — #NNN 묶음. 같은 번호 2건↑ = 스레드. 문서가 여러 번호를 달면 각 스레드에 모두 속한다. ──
//  스레드 라벨 = 최신 문서 제목의 주제부(— 앞, 번호 제거) — 제목이 이미 요약이라는 실측(85% em-dash)을 그대로 쓴다.
function subjectOf(title) {
    const t = String(title || '').replace(ISSUE_RE, '').replace(/\(\s*[,·\s]*\)/g, '');
    const cut = t.split(/\s+[—–]\s+/)[0] || t;
    return cut.replace(/\s+/g, ' ').replace(/[([\s·,]+$/, '').trim();
}
function mineThreads(docs) {
    const buckets = new Map();
    for (const d of docs) {
        const nums = String(d.title || '').match(ISSUE_RE) || [];
        for (const n of new Set(nums)) {
            if (!buckets.has(n))
                buckets.set(n, []);
            buckets.get(n).push(d);
        }
    }
    const threads = [];
    for (const [id, members] of buckets) {
        if (members.length < 2)
            continue; // 단건 번호는 스레드가 아니라 그냥 문서
        // 최신 판정 = 제목 파싱 날짜 우선(시간 규율), 없으면 updated_at 날짜부. sorted[0] = 진짜 현재 상태.
        const keyOf = (d) => parseTitleDate(d.title, d.updated_at) || String(d.updated_at || '').slice(0, 10);
        const sorted = members.slice().sort((a, b) => keyOf(b).localeCompare(keyOf(a)));
        threads.push({
            id,
            label: subjectOf(sorted[0].title) || id,
            docs: sorted,
            last: sorted[0].updated_at || '',
            first: sorted[sorted.length - 1].updated_at || '',
            types: Array.from(new Set(sorted.map((d) => d.type).filter(Boolean))),
        });
    }
    threads.sort((a, b) => String(b.last).localeCompare(String(a.last)));
    // 스레드에 속한 문서 name 집합 — 호출부가 '스레드 밖 단건'을 알 수 있게.
    const threaded = new Set();
    for (const t of threads)
        for (const d of t.docs)
            threaded.add(d.name);
    threads.threadedNames = threaded;
    return threads;
}
// ── ② 주제 그룹 — 검증된 빈도 방식(V2). n<minDocs 면 빈 배열(소형 카테고리는 지도 무의미). ──
function mineThemes(docs, catName, opts = {}) {
    const n = docs.length;
    if (n < (opts.minDocs || 24))
        return [];
    const minSize = Math.max(3, Math.ceil(n * 0.04));
    const topN = opts.topN || 8;
    // 카테고리명 자체의 토큰은 시드 금지(시장·경쟁의 '경쟁' 퇴화 케이스).
    const catToks = tokenize(catName || '');
    const titles = docs.map((d) => String(d.title || ''));
    const docToks = titles.map((t) => tokenize(t));
    const df = new Map();
    docToks.forEach((toks, i) => {
        for (const w of toks) {
            if (catToks.has(w))
                continue;
            if (!df.has(w))
                df.set(w, new Set());
            df.get(w).add(i);
        }
    });
    let seeds = Array.from(df.entries()).filter(([, s]) => s.size >= minSize)
        .map(([w, s]) => ({ w, c: s.size }))
        .sort((a, b) => (b.c - a.c) || a.w.localeCompare(b.w));
    // 병합: 이미 채택된 짧은 시드의 substring 확장형은 흡수(웹터미널 ⊂ 터미널).
    const kept = [];
    for (const s of seeds) {
        let absorbed = false;
        for (const k of kept) {
            if (k.w !== s.w && (s.w.includes(k.w) || (s.w.startsWith(k.w) && /^[a-z0-9_.+-]+$/.test(s.w)))) {
                absorbed = true;
                break;
            }
        }
        if (!absorbed)
            kept.push(s);
    }
    seeds = kept;
    // 그룹핑: 한글 시드는 제목 substring 매치(합성어 포섭), 영문은 토큰 일치. 동일 멤버셋 dedupe.
    const groups = [];
    const seenSets = new Set();
    for (const s of seeds.slice(0, topN * 3)) {
        const members = KO_RE.test(s.w)
            ? titles.map((t, i) => (t.includes(s.w) ? i : -1)).filter((i) => i >= 0)
            : docToks.map((toks, i) => (toks.has(s.w) ? i : -1)).filter((i) => i >= 0);
        if (members.length < minSize)
            continue;
        const key = members.join(',');
        if (seenSets.has(key))
            continue;
        seenSets.add(key);
        groups.push({ label: s.w, docs: members.map((i) => docs[i]) });
        if (groups.length >= topN)
            break;
    }
    groups.sort((a, b) => b.docs.length - a.docs.length);
    const covered = new Set();
    for (const g of groups)
        for (const d of g.docs)
            covered.add(d.name);
    groups.coveredNames = covered;
    return groups;
}
// ── 제목 날짜 파서 — 보수적: 확실한 형태만 읽고, 애매하면 ''(파싱 실패 = 표기 생략, 오독보다 안전). ──
//  받는 형태: 2026-07-09 · 2026.7.9 · 7월 9일 (본문 어디든) / 7.9 · 7/9 (제목 꼬리 괄호 안에서만 —
//  "1.5배" 류 오독 방지). 여러 개면 마지막 매치(제목 꼬리 관례). ref = updated_at(연도 추정·연말 역산).
function parseTitleDate(title, ref) {
    const t = String(title || '');
    const refD = ref ? new Date(ref) : new Date();
    const refY = isNaN(refD.getTime()) ? new Date().getFullYear() : refD.getFullYear();
    let y = 0, mo = 0, d = 0;
    for (const m of t.matchAll(/\b(20\d{2})[-.](\d{1,2})[-.](\d{1,2})\b/g)) {
        y = +m[1];
        mo = +m[2];
        d = +m[3];
    }
    if (!y)
        for (const m of t.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)) {
            mo = +m[1];
            d = +m[2];
        }
    if (!mo) {
        const tail = t.match(/\(([^)]*)\)\s*$/); // 짧은 M.D 는 꼬리 괄호 메타 안에서만 신뢰
        //  뒤에 숫자·점·%·글자·한글이 붙으면 날짜가 아니라 단위(1.5배·3.2GB) — 오독 금지(파싱 실패가 안전).
        if (tail)
            for (const m of tail[1].matchAll(/(?:^|[\s·,])(\d{1,2})[./](\d{1,2})(?![\d.%가-힣A-Za-z])/g)) {
                mo = +m[1];
                d = +m[2];
            }
    }
    if (!mo || mo > 12 || !d || d > 31)
        return '';
    if (!y) {
        y = refY;
        // 연말↔연초 걸침만 역산: 파싱 월이 늦고(≥10월) ref 가 연초(≤3월)이며 45일 넘게 미래일 때만.
        //  (그 외 미래 날짜 — 예: 여름에 쓴 'Q3 마감 (8.30)' — 은 계획일 수 있어 올해로 둔다.)
        const cand = new Date(y, mo - 1, d);
        if (!isNaN(refD.getTime()) && cand.getTime() - refD.getTime() > 45 * 86400e3
            && mo >= 10 && (refD.getMonth() + 1) <= 3)
            y -= 1;
    }
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    return y + '-' + p2(mo) + '-' + p2(d);
}
// ── 주제 줄기(stem) — 개정판 관례(v2·최종·날짜·꼬리 괄호)를 벗긴 제목. 정본 스택의 그룹 키. ──
//  꼬리 괄호는 '개정 메타'(숫자·버전·날짜·최종/개정)일 때만 제거 — '(A안)/(B안)' 같은 병렬 대안은
//  살려 서로 다른 stem 이 되게 한다(과병합 = 살아있는 대안을 구판으로 오분류하는 것보다 미병합이 안전).
function topicStem(title) {
    return String(title || '')
        .replace(/\((?=[^)]*(?:\d|버전|ver|rev|최종|개정))[^)]*\)\s*$/i, '')
        .replace(ISSUE_RE, ' ')
        .replace(VER_RE, ' ')
        .replace(DATE_RE, ' ')
        .replace(/(\d{1,2})월\s*(\d{1,2})일/g, ' ')
        .replace(/(?:^|\s)(최종|final|rev\.?\s?\d*|개정\s?\d*판?)(?=\s|$)/gi, ' ')
        .replace(/\s+/g, ' ').trim()
        .replace(/[—–\-·,:\s]+$/, '').trim();
}
// ── 스레드 델타 — 공통 접두를 벗겨 각 문서를 '상태 델타 한 줄'로(포털 시안의 가공 핵심). ──
//  공통 접두(단어 경계 절단)가 6자 이상이면 라벨로 채택, 각 문서 = 접두를 벗긴 나머지.
//  아니면 라벨 = 최신 제목 주제부(subjectOf), 델타 = 각 제목의 'em-dash 뒤 상태부'(제목 관용구 재활용).
function threadParts(thread) {
    const docs = thread.docs;
    const titles = docs.map((x) => String(x.title || ''));
    const cleanTail = (s) => s.replace(/\([^)]*\)\s*$/, '') // 닫힌 꼬리 괄호
        .replace(/\s*\([^)]*$/, '') // 닫히지 않은 꼬리 괄호 조각(접두 절단 잔재)
        .replace(ISSUE_RE, ' ').replace(/\(\s*[·,\s]*\)/g, ' ').replace(/\s+/g, ' ')
        .trim().replace(/^[)—–\-·,:\s]+/, '').replace(/[(—–\-·,:\s]+$/, '').trim();
    let prefix = titles[0] || '';
    for (const t of titles) {
        let i = 0;
        while (i < prefix.length && i < t.length && prefix[i] === t[i])
            i++;
        prefix = prefix.slice(0, i);
        if (!prefix)
            break;
    }
    // 단어 경계 절단 — 마지막 공백/구분자까지만(어절 중간 절단 금지).
    const cutAt = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('—'), prefix.lastIndexOf('·'));
    if (cutAt > 0 && prefix.length < Math.min(...titles.map((t) => t.length)))
        prefix = prefix.slice(0, cutAt + 1);
    // 열린 괄호가 짝을 못 만나면(문서들이 꼬리 괄호 안 날짜만 다를 때) 그 앞에서 자른다 — 라벨에 '(' 매달림 방지.
    if ((prefix.match(/\(/g) || []).length > (prefix.match(/\)/g) || []).length) {
        prefix = prefix.slice(0, prefix.lastIndexOf('(')).replace(/[—–\-·,:\s]+$/, '');
    }
    const label0 = cleanTail(prefix);
    const usePrefix = label0.length >= 6;
    const label = usePrefix ? label0 : (thread.label || '');
    const kids = docs.map((doc, i) => {
        let delta = '';
        if (usePrefix)
            delta = cleanTail(titles[i].slice(prefix.length));
        if (!delta) {
            const parts = titles[i].split(/\s+[—–]\s+/);
            delta = cleanTail(parts.length > 1 ? parts.slice(1).join(' — ') : titles[i]);
        }
        if (!delta)
            delta = titles[i];
        return { doc, delta, date: parseTitleDate(titles[i], doc.updated_at) };
    });
    return { label, kids };
}
// ── ③ 사건 분류 — 문서 전체 → 스레드 / 정본 스택 / 단신(배타). '일의 흐름' 피드의 원자. ──
//  · 스레드: mineThreads 그대로(#NNN ≥2건). 최근성 = 파싱 날짜 max → 태스크번호(단조 증가 프록시) → updated_at.
//  · 정본: 스레드 밖 문서 중 topicStem 완전 일치 ≥2건(보수 모드 — 과병합보다 미병합이 안전). 최신본 = 정본.
//  · 단신: 나머지 1건 = 사건 1건.
//  live = 파싱된 제목 날짜가 14일 이내일 때만(updated_at 으로는 '지금'을 주장하지 않는다 — 전부 최근 뭉침).
function mineEvents(docs) {
    const now = Date.now();
    const isLive = (iso) => !!iso && (now - new Date(iso + 'T00:00:00').getTime()) <= 14 * 86400e3
        && (now - new Date(iso + 'T00:00:00').getTime()) >= -2 * 86400e3;
    const dateOf = (x) => parseTitleDate(x.title, x.updated_at);
    const threads = mineThreads(docs);
    const threaded = threads.threadedNames || new Set();
    const events = [];
    for (const t of threads) {
        const dates = t.docs.map(dateOf).filter(Boolean).sort();
        const parts = threadParts(t);
        events.push({
            kind: 'thread', id: t.id, label: parts.label || t.label, docs: t.docs, kids: parts.kids,
            types: t.types, dateMin: dates[0] || '', dateMax: dates[dates.length - 1] || '',
            live: isLive(dates[dates.length - 1] || ''),
            no: parseInt(t.id.slice(1), 10) || 0,
            sortKey: (dates[dates.length - 1] || String(t.last || '').slice(0, 10)),
        });
    }
    const rest = docs.filter((x) => !threaded.has(x.name));
    const stems = new Map();
    for (const x of rest) {
        const s = topicStem(x.title);
        if (s.length < 6)
            continue; // 짧은 줄기는 우연 일치 위험 — 접지 않는다
        if (!stems.has(s))
            stems.set(s, []);
        stems.get(s).push(x);
    }
    const canonNames = new Set();
    for (const [stem, members] of stems) {
        if (members.length < 2)
            continue;
        const sorted = members.slice().sort((a, b) => (dateOf(b) || String(b.updated_at || '').slice(0, 10))
            .localeCompare(dateOf(a) || String(a.updated_at || '').slice(0, 10)));
        for (const m of sorted)
            canonNames.add(m.name);
        const dm = dateOf(sorted[0]);
        events.push({
            kind: 'canon', label: stem, docs: sorted, dateMax: dm, live: isLive(dm),
            no: 0, sortKey: (dm || String(sorted[0].updated_at || '').slice(0, 10)),
        });
    }
    for (const x of rest) {
        if (canonNames.has(x.name))
            continue;
        const dm = dateOf(x);
        const noM = String(x.title || '').match(/#(\d{2,5})\b/);
        events.push({
            kind: 'brief', label: x.title || x.name, docs: [x], dateMax: dm, live: isLive(dm),
            no: noM ? parseInt(noM[1], 10) : 0,
            sortKey: (dm || String(x.updated_at || '').slice(0, 10)),
        });
    }
    events.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey))
        || (b.no - a.no)
        || String(b.docs[0].updated_at || '').localeCompare(String(a.docs[0].updated_at || '')));
    return events;
}
export { mineEvents, mineThemes, mineThreads, parseTitleDate, subjectOf, threadParts, topicStem };
