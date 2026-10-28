// lib/studio-rec.ts — 앱빌더가 이 브라우저에 두는 만들기 기록(app-studio STUDIO_KEY)의 **순수** 규칙(#4632 감사 1-8 · 1-9).
//  · trimRecs: 한도를 넘으면 다 만든 기록부터 덜어 낸다 — 진행 중인 앱의 기획 카드 · 적던 코멘트를 오래됐다고 먼저 지우지 않는다.
//  · mergeRec: 같은 앱을 두 탭에서 열어 둔 때, 저장하는 탭이 **바꾼 칸만** 자기 값으로 쓰고 나머지는 다른 탭이 저장한 값을 받는다.
//  시험: scripts/studio-rec.test.mjs
/** 기록 한도 — 새 앱 · 사본 · 고치기를 합쳐 이만큼(종전 12). */
export const REC_MAX = 40;

/** 오래된 것이 앞에 있는 기록 줄을 max 개로 줄인다. 다 만든 것(done)을 오래된 것부터 먼저 빼고, 그래도 넘으면 남은 것 중 오래된 것부터. */
export function trimRecs<T extends { done?: boolean }>(rs: readonly T[], max = REC_MAX): T[] {
  const out = rs.slice();
  let over = out.length - Math.max(0, max);
  for (let i = 0; i < out.length && over > 0;) { if (out[i].done) { out.splice(i, 1); over--; } else i++; }
  return over > 0 ? out.slice(over) : out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/**
 * cur(이 탭의 기록 — 고쳐 쓴다)에 stored(지금 저장돼 있는 것)를 합친다. base = 이 탭이 그 기록을 읽었을 때.
 *  이 탭이 안 바꾼 칸(cur === base)인데 저장된 값이 달라졌으면(다른 탭이 바꿨다) 저장된 값을 받는다. 두 탭이 같은 칸을 바꿨으면 이 탭(나중 저장)이 이긴다.
 *  다른 탭이 지운 칸은 이 탭도 지운다. skip 의 칸은 늘 이 탭 것(화면이 그 값을 쥐고 있어 바꿔 끼우면 갈라진다). 바꾼 칸의 이름을 돌려준다(받은 것).
 */
export function mergeRec(cur: Record<string, unknown>, base: Record<string, unknown>, stored: Record<string, unknown>, skip: readonly string[] = []): string[] {
  const took: string[] = [];
  const keys = new Set([...Object.keys(cur), ...Object.keys(stored), ...Object.keys(base)]);
  for (const k of keys) {
    if (skip.includes(k)) continue;
    if (!same(cur[k], base[k])) continue;          // 이 탭이 바꿨다
    if (same(stored[k], base[k])) continue;        // 다른 탭도 안 바꿨다
    if (stored[k] === undefined) delete cur[k]; else cur[k] = JSON.parse(JSON.stringify(stored[k]));
    took.push(k);
  }
  return took;
}
