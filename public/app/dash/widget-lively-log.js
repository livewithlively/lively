// dash/widget-lively-log.ts — ⑧ 내 라이블리 사용 내역(#1570).
//  질문: "지금 이 답변이 라이블리 덕에 좋아진 건가?" — 라이블리의 기여는 모델 컨텍스트 안에서만 일어나서
//  화면에 흔적이 없고, 그래서 좋은 결과의 공은 전부 하네스가 가져간다. 이 위젯이 그 흔적을 되찾는 자리다.
//
//  ── 설계 원칙(이 위젯이 다른 통계 화면과 다른 이유) ──
//   ① **배지가 아니라 기록.** "라이블리가 도왔습니다"는 주장이고, "「X」를 21번 열어 근거로 썼다"는 검증
//      가능한 사실이다. 자화자찬은 신뢰를 깎으므로 문구는 전부 일어난 일만 말한다.
//   ② **숫자가 아니라 문장.** 관리탭 'MCP 호출 통계'(#318)는 같은 원천을 이미 쓰지만 툴별 호출 수라서
//      개인이 효용을 못 느낀다 — 이 프로젝트의 출발점이 그 사실이다. 그래서 여기 각 줄은 사건 하나다.
//   ③ **값이 없으면 그리지 않는다.** 빈 섹션은 "라이블리 별거 없네"를 증명한다. shell.ts 의 off 필드가
//      같은 이유로 존재한다(모두에게 값이 차지 않는 위젯을 기본 배치에 밀어 넣지 않는다).
//   ④ **세션 안 / 세션 밖을 가른다.** 세션 안의 작동은 하네스 공적과 구분되지 않지만, 내가 없는 동안
//      돌아간 수집·증류·분류는 100% 라이블리다 — 귀속 분쟁이 없고, 저사용자 화면에도 값이 찬다.
//  ⚠ '열람'은 knowledge_get(본문을 실제로 연 것)만 센다. 훅 자동회수(주입)는 REST 라 호출 로그에 안 남고,
//   남더라도 주입≠사용이라 세면 과대계상이 된다(실측: 회수 2건 전량 무관·미사용인 턴이 있었다).
//  ⚠ 기간 단위다. mcp_call_log 에 session_id 가 없어 '이 세션에서'로는 못 묶는다(#1570 후속).
import { api, el, errorNote, relTime, state } from '../core.js';
import { dashChips, dashCtl, dashEmpty } from './chrome.js';
const LVL_WINDOWS = [['24h', '24시간'], ['7d', '7일'], ['30d', '30일']];
// 숫자 천단위 — 문장 안에 섞이는 값이라 자릿수가 흔들리면 읽는 속도가 떨어진다.
function n(v) { return Number(v || 0).toLocaleString('ko-KR'); }
// 섹션 제목 — '내 할 일'의 버킷 머리(dash-task-gh)와 같은 프리미티브를 써서 위젯 간 문법을 맞춘다.
function lvlHead(label, note) {
    return el('div', { class: 'dash-task-gh' }, el('span', { text: label }), note ? el('span', { class: 'dash-task-gn', text: note }) : null);
}
// 한 사건 = 한 줄. 왼쪽에 사실(제목·주체), 오른쪽에 횟수/시각.
function lvlRow(main, right, title) {
    return el('div', { class: 'dash-row dash-lvl-row', title: title || '' }, main, right ? el('span', { class: 'dash-lvl-when', text: right }) : null);
}
async function fillLivelyLog(zone) {
    let win = '7d';
    // 사람 이름 — 다른 위젯(최신 알림)과 **같은 원천**(/api/ui/dash/people)을 쓴다. 실패해도 목록은 살리고
    //  id 를 그대로 보여준다(이름이 없다고 사건 자체를 숨기지는 않는다).
    const people = await api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []);
    const meId = (state.me && (state.me.userId || state.me.email)) || '';
    const nameOf = (pid) => {
        if (!pid)
            return '';
        const m = people.find((x) => x.author_person === pid);
        return (m && (m.nickname || m.display_name)) || pid;
    };
    const draw = async () => {
        let d;
        try {
            d = await api('/api/ui/me/lively-log?window=' + encodeURIComponent(win));
        }
        catch (e) {
            zone.body.replaceChildren(errorNote(e, '사용 내역을 불러오지 못했습니다'));
            return;
        }
        const s = d.summary || {};
        const bg = d.background || null;
        const reads = d.reads || [];
        const used = d.usedByOthers || [];
        const harnesses = d.harnesses || [];
        const dbRows = d.dbAccess || [];
        // 헤더 카운트 = 이 기간에 라이블리가 관여한 사건 수(지식 열람 + DB 조회 + 세션 밖 처리).
        const dbQueries = dbRows.reduce((a, r) => a + Number(r.queries || 0), 0);
        const bgWork = bg ? Number(bg.distilled || 0) + Number(bg.classified || 0) + Number(bg.sources_ingested || 0) : 0;
        const events = Number(s.knowledge_reads || 0) + dbQueries + bgWork;
        zone.countEl.textContent = String(events);
        dashChips(zone.chipsEl, LVL_WINDOWS, win, (k) => { win = k; draw(); });
        const box = el('div', { class: 'dash-lvl' });
        // ── 머리 한 줄 — 이 기간을 한 문장으로. 숫자가 아니라 "무슨 일이 있었나"로 읽히게 쓴다. ──
        const lead = [];
        if (s.knowledge_reads)
            lead.push(`조직 지식 ${n(s.knowledge_titles)}건을 근거로 썼어요`);
        if (s.knowledge_saved)
            lead.push(`지식 ${n(s.knowledge_saved)}건을 남겼어요`);
        if (!lead.length && s.calls)
            lead.push(`라이블리 도구를 ${n(s.calls)}번 썼어요`);
        if (lead.length)
            box.append(el('div', { class: 'dash-lvl-lead', text: lead.join(' · ') }));
        // ── ① 세션 안: 근거로 쓴 조직 지식 ── 라이블리 없이는 애초에 존재하지 않는 사건이다.
        if (reads.length) {
            box.append(lvlHead('내 답변의 근거가 된 조직 지식'));
            for (const r of reads) {
                // 저자는 **남이 남긴 것일 때만** 붙인다. 내 지식에 내 이름을 매 줄 반복하는 건 정보가 아니라 잡음이고,
                //  여기서 진짜 신호는 "내가 모르던 걸 동료가 남겨둔 덕에 썼다"이다(그 줄만 이름을 달아야 눈에 띈다).
                const other = r.author && r.author !== meId ? nameOf(r.author) : '';
                const main = el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-title', text: r.title || r.name }), other ? el('span', { class: 'dash-lvl-by', text: other + ' 저작' }) : null);
                box.append(lvlRow(main, r.reads > 1 ? `${r.reads}번` : relTime(r.last_at), r.name));
            }
        }
        // ── ② 세션 밖: 내가 남긴 지식이 남의 세션에서 쓰인 것 ──
        //  기록의 ROI 가 눈에 보이는 유일한 자리다(지금까지 기록은 비용만 보이고 수익이 안 보였다).
        //  혼자 쓰는 조직에선 항상 비어 있다 — 그때는 섹션째 그리지 않는다(원칙 ③).
        if (used.length) {
            box.append(lvlHead('내가 남긴 지식이 팀에서 쓰였어요'));
            for (const u of used) {
                const main = el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-title', text: u.title || u.name }), el('span', { class: 'dash-lvl-by', text: `${u.readers}명이` }));
                box.append(lvlRow(main, `${u.reads}번`, u.name));
            }
        }
        // ── ③ 세션 안: 조직 DB 직접 조회 ── 'AI 가 사내 DB 를 봤다'는 하네스 단독으로는 성립하지 않는다.
        if (dbRows.length) {
            box.append(lvlHead('조직 DB 를 직접 봤어요'));
            for (const r of dbRows) {
                const main = el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-title', text: r.source }), el('span', { class: 'dash-lvl-by', text: `${n(r.tables)}개 테이블 · ${n(r.rows_read)}행` }));
                box.append(lvlRow(main, `${n(r.queries)}번`));
            }
        }
        // ── ④ 세션 안: 하네스 넘나듦 ── 2종 이상일 때만. 하네스 중립은 조립 스택이 재현 못 하는 축이라
        //  "같은 맥락을 다른 도구에서 이어받았다"가 성립할 때만 의미가 있다.
        if (harnesses.length > 1) {
            box.append(lvlHead('같은 맥락을 여러 도구에서 이어받았어요'));
            const main = el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-title', text: harnesses.map((h) => h.harness).join(' · ') }));
            box.append(lvlRow(main, `${harnesses.length}곳`));
        }
        // ── ⑤ 세션 밖: 내가 없는 동안 ── 귀속 분쟁이 없는 축. 항목이 0 이면 그 줄을 빼고, 전부 0 이면 섹션째 뺀다.
        if (bg) {
            const bgAll = [
                ['자료를 새로 수집했어요', Number(bg.sources_ingested || 0)],
                ['자료를 지식으로 증류했어요', Number(bg.distilled || 0)],
                ['새 지식을 자동 분류했어요', Number(bg.classified || 0)],
            ];
            const bgLines = bgAll.filter((row) => row[1] > 0);
            if (bgLines.length) {
                box.append(lvlHead('내가 없는 동안', bg.last_run_at ? relTime(bg.last_run_at) : ''));
                for (const [label, v] of bgLines) {
                    box.append(lvlRow(el('span', { class: 'dash-lvl-main' }, el('span', { class: 'dash-lvl-title', text: label })), `${n(v)}건`));
                }
            }
        }
        if (!box.childElementCount) {
            zone.body.replaceChildren(dashEmpty('이 기간에는 라이블리가 관여한 기록이 없어요.'));
            return;
        }
        // 보관기간 밖은 지워져서 안 보인다 — 화면이 그 사실을 말해야 "왜 비었지"가 되지 않는다(#1082).
        if (d.retention_days) {
            box.append(el('div', { class: 'dash-lvl-foot', text: `호출 기록은 ${d.retention_days}일간 보관돼요` }));
        }
        zone.body.replaceChildren(box);
    };
    dashCtl(zone, { action: { href: '#/knowledge', title: '지식 탭으로' } });
    await draw();
}
export { fillLivelyLog };
