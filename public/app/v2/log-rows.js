/** 이 행을 언제 마지막으로 봤나(ms). 모르면 0 — 가장 오래된 것으로 친다(아래 경계 규칙에 그대로 걸린다). */
export const logRowSeen = (r) => (r && r.last_seen ? Date.parse(String(r.last_seen)) : 0) || 0;
/**
 * 얕은 판을 깊은 캐시 **위에 얹는다**.
 *
 *  경계는 얕은 판에서 **가장 오래된 행의 시각**이다. 그 시각 이후는 얕은 판이 다 보고 온 구간이므로
 *  **얕은 판이 정본**이다 — 거기 없는 캐시 행은 지워진 것이니 뺀다. 그 이전은 얕은 판이 애초에 볼 수
 *  없는 자리라 캐시를 그대로 지킨다.
 *
 *  ⚠ 얕은 판이 **0건**이면 창 자체가 없다 — 그때 '전부 지워졌다'고 읽으면 목록이 통째로 사라진다.
 *   그건 이 고침이 없애려던 바로 그 그림이다. 0건이면 캐시를 그대로 돌려준다.
 */
export function mergeLogRows(deep, shallow) {
    const d = Array.isArray(deep) ? deep : [];
    const s = Array.isArray(shallow) ? shallow : [];
    if (!s.length)
        return d;
    const edge = s.reduce((m, r) => Math.min(m, logRowSeen(r)), Number.POSITIVE_INFINITY);
    const fresh = new Set(s.map((r) => String(r && r.session_id)));
    //  같은 id 는 얕은 판이 이긴다(fresh 검사) — 안 그러면 한 세션이 두 줄로 보인다.
    const kept = d.filter((r) => logRowSeen(r) < edge && !fresh.has(String(r && r.session_id)));
    return [...s, ...kept];
}
