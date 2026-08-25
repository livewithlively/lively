// v2/quick-session.ts — 홈 입력창에서 세션을 연다.
// 프로젝트가 정해졌으면 생성 요청 자체가 그 프로젝트의 canonical workspace에서 시작하고, 아니면 개인 workspace 루트에서 시작한다.
//   · initialPrompt — 서버가 하네스 입력창이 뜬 뒤 넣는다(session-first-prompt.ts). 화면은 낙관적으로 그 턴을 먼저 그린다.
//  자동 승인은 클래식 '새 AI 세션' 폼이 기억해 둔 마지막 값을 그대로 쓴다(같은 localStorage 키 — v2/run-picker.ts
//  runPrefs). 제공자(하네스)·모델·추론강도는 홈 입력창의 세 칸이 정해 넘긴다(#1758) — 안 넘기면 그 기억이 기본이다.
import { api, toast } from '../core.js';
import { runPrefs } from './run-picker.js';
import { rememberCreated } from './created-cache.js';
/** 이 화면이 만든 세션의 첫 지시 — 세션 화면이 마운트될 때 꺼내 낙관적으로 그린다(서버가 실제 주입). */
const firstPrompts = new Map();
export function takeFirstPrompt(sessionId) {
    const t = firstPrompts.get(sessionId) ?? null;
    firstPrompts.delete(sessionId);
    return t;
}
// 이름은 **서버가 짓는다**(#1808, src/terminal/session-name.ts) — initialPrompt 를 넘기면 그 값으로 label 이 정해진다.
//  종전엔 여기서 앞 27자를 잘라 label 로 같이 보냈는데, 그 규칙이 클라와 서버 두 곳에 있으면 반드시 갈라진다.
let creating = false;
export function isCreatingQuickSession() { return creating; }
/**
 * 세션을 **만들기만** 한다 — 생성 전문 캐시(created-cache)·첫 지시 낙관 렌더 등록·프로젝트 붙이기까지.
 *  화면을 어디로 옮길지는 **호출자가** 정한다: 홈(openQuickSession)은 주소를 그 세션으로 옮기고,
 *  프로젝트 셸의 새 세션 자리(v2/panes-parts.ts)는 셸을 살린 채 그 칸만 갈아 끼운다.
 *  ⚠ 이 세 가지(캐시·낙관 렌더·프로젝트 붙이기)를 생성처마다 따로 하면 반드시 한 곳이 빠진다 —
 *   실제로 프로젝트 쪽 생성에는 캐시가 빠져 있어 방금 만든 세션이 "찾을 수 없어요"로 떨어졌다(원준 2026-08-20 신고:
 *   "엔터 친 다음에 클로드 미러링이 새로고침 안 하면 안 나온다"). 그래서 생성은 여기 한 곳만 남긴다.
 *  @returns 만든 세션 id, 실패면 null(이유는 toast 로 이미 말했다).
 */
export async function spawnSession(text, opts) {
    const t = String(text || '').trim();
    if (!t || creating)
        return null;
    creating = true;
    try {
        const p = runPrefs();
        const run = opts && opts.run;
        const harness = run?.harness || (p.harness && p.harness !== 'shell' ? p.harness : 'claude');
        const flags = run ? run.flags : (p.flags && typeof p.flags === 'object' ? p.flags : {});
        // 실행 노드(#1744) — '' = 중앙 컴퓨터(기본, 필드 생략). 노드면 그 PC 에서 세션이 뜨고 첫 지시는 노드가 로컬로 넣는다
        //  (server createSession 이 노드에선 injectFirstPrompt 로, DB 아웃박스 대신). 노드가 없거나 안 고른 경우 run.node 는 ''.
        const node = run ? run.node : '';
        const pid = opts && opts.projectId ? Number(opts.projectId) : 0;
        const endpoint = pid > 0 ? `/api/ui/v6/projects/${pid}/sessions` : '/api/ui/terminal/sessions';
        const out = await api(endpoint, {
            method: 'POST',
            body: JSON.stringify({
                harness, flags,
                autoApprove: !!p.autoApprove, initialPrompt: t,
                ...(pid > 0 ? {} : { rootKey: 'personal' }),
                ...(node ? { node } : {}),
            }),
        });
        const id = out && out.session && out.session.id ? String(out.session.id) : '';
        if (!id)
            throw new Error('세션 id 를 받지 못했습니다');
        rememberCreated(out.session); // 노드 세션은 목록 반영이 한 박자 늦다 — 라우트가 이 전문으로 먼저 그린다(created-cache 머리말)
        firstPrompts.set(id, t);
        return { id, session: out.session };
    }
    catch (e) {
        toast('세션을 열지 못했습니다 — ' + (e && e.message ? e.message : e), true);
        return null;
    }
    finally {
        creating = false;
    }
}
/**
 * 세션을 열고 그 화면으로 간다. 실패하면 toast 로 이유를 말하고 false(입력은 호출자가 돌려준다).
 *  opts.projectId — 홈 런처가 고른 행선지. 프로젝트 세션 API 한 번으로 cwd와 DB 소속을 함께 확정한다.
 *  opts.run — 입력창 옆 세 칸(제공자·모델·추론강도)이 고른 값(#1758). 없으면 저장된 직전 설정 그대로 연다.
 */
export async function openQuickSession(text, opts) {
    const made = await spawnSession(text, opts);
    if (!made)
        return false;
    location.hash = '#/s/' + encodeURIComponent(made.id);
    return true;
}
/**
 * 프로젝트 화면의 [새 세션](#1757) — 첫 지시 없이 이 프로젝트에 붙은 세션을 열고 그 화면으로 간다(지시는 거기서 친다).
 *  cwd 는 해당 노드의 프로젝트 canonical workspace다.
 *  실패하면 toast 로 이유를 말하고 false.
 */
export async function openProjectSession(projectId, projectName) {
    if (creating || !(projectId > 0))
        return false;
    creating = true;
    try {
        const p = runPrefs();
        const harness = p.harness && p.harness !== 'shell' ? p.harness : 'claude';
        const out = await api('/api/ui/v6/projects/' + encodeURIComponent(String(projectId)) + '/sessions', {
            method: 'POST',
            // ⚠ label 을 넘기지 않는다(#1808) — 여기에 프로젝트명을 박으면 그 프로젝트의 세션이 전부 같은 이름이 된다
            //  (실측 2026-08-20: 그 경로로 프로젝트 세션 147건 중 104건이 이름이 프로젝트명 그대로였다). 이름은 서버가
            //  **처음 시킨 말**로 짓는다 — 여기선 지시를 세션 화면에서 치므로 중앙 기록이 첫 발화를 알아내는 순간 붙는다
            //  (src/terminal/session-name.ts · src/sessions/session-autoname.ts).
            body: JSON.stringify({ harness, flags: p.flags && typeof p.flags === 'object' ? p.flags : {}, autoApprove: !!p.autoApprove }),
        });
        const id = out && out.session && out.session.id ? String(out.session.id) : '';
        if (!id)
            throw new Error('세션 id 를 받지 못했습니다');
        location.hash = '#/s/' + encodeURIComponent(id);
        return true;
    }
    catch (e) {
        toast('세션을 열지 못했습니다 — ' + (e && e.message ? e.message : e), true);
        return false;
    }
    finally {
        creating = false;
    }
}
