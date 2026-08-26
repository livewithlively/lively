// v2/sse.ts — SSE(text/event-stream) 조각 파서 + 재연결 간격. **import 0 인 순수 모듈**이다.
//
// 그 성질이 계약이다: 컴파일 결과(public/app/v2/sse.js)를 node 가 그대로 불러 판정 표를 고정한다
//  (scripts/sidebar-live-sync.test.mjs). 여기에 DOM·fetch·모듈 상태를 들이는 순간 그 표가 죽는다 —
//  실제 연결·재시도·구독은 옆 모듈(v2/live-sync.ts)이 쥔다.
//
// ⚠ 같은 규칙이 데스크톱 앱에도 한 벌 더 있다(desktop/main/notify.mjs 의 parseSse·reconnectDelay).
//  합치지 않은 이유는 취향이 아니라 런타임이다 — desktop/ 은 tsc 빌드를 타지 않는 Electron main(.mjs)이라
//  이 컴파일 결과를 import 할 수 없다. 두 벌이 갈라지면 '앱은 받는데 화면은 못 받는' 어긋남이 나므로
//  프레임 규약을 고칠 땐 반드시 둘 다 본다(값도 일부러 같게 맞춰 두었다).
'use strict';
/**
 * 바이트 조각(문자열) → 이벤트. 프레임은 빈 줄로 끝나므로 **마지막 미완성 프레임은 버퍼에 남긴다**
 *  — 그걸 그냥 파싱하면 반쪽 JSON 을 만나 사건 하나를 조용히 잃는다.
 *  주석 프레임(`: ping` keepalive)과 이벤트명만 있는 프레임은 이벤트가 아니다.
 */
export function parseSse(buffer) {
    const parts = String(buffer || '').split('\n\n');
    const rest = parts.pop() ?? ''; // 마지막 조각은 아직 안 끝났다
    const events = [];
    for (const frame of parts) {
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data)
            continue;
        try {
            events.push(JSON.parse(data));
        }
        catch { /* 깨진 프레임 하나가 스트림을 끊지 않는다 */ }
    }
    return { events, rest };
}
/** 재연결 대기(ms) — 지수 백오프에 상한. 게이트웨이가 재시작 중일 때 초당 재접속으로 때리지 않는다. */
export function retryDelay(attempt) {
    const n = Math.max(0, Number(attempt) || 0);
    return Math.min(30_000, 1_000 * Math.pow(2, Math.min(n, 5))); // 1s 2 4 8 16 32→30s 상한
}
/**
 * 방금 끊긴 연결이 **백오프를 되돌려도 되는 연결이었나**.
 *
 * ⚠ 실측(#2041, 2026-08-26): 붙는 데 성공한 순간 재시도 횟수를 0 으로 되돌렸더니, 서버가 붙자마자
 *  끊는 상황에서 **20초에 19번** 재접속했다(연결 성공 → 즉시 종료 → 백오프 0 → 1초 뒤 또). 백오프가
 *  있는데도 없는 것과 같아진다. 그래서 '붙었나'가 아니라 **'붙어서 얼마나 살았나'**로 판정한다 —
 *  잠깐 살다 죽은 연결은 실패의 한 종류다.
 */
export function stableConnection(connectedMs) {
    return (Number(connectedMs) || 0) >= 10_000;
}
