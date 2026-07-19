// identity — draftAssetId(#990) 검증: charset-safe(한글 멤버 id 포함) · per-member 유일 · 하이픈 모호성 없음 · 총길이 ≤64.
//  실행: node dist/org/identity.test.js  (npm test 체인에 포함, asset-visibility 옆)
import { draftAssetId, assertAssetId, STRICT_SLUG } from "./identity.js";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const bad = (n: string, why: string) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n: string, cond: boolean, why = "") => (cond ? ok(n) : bad(n, why));

// ① 한글 멤버 id 도 400 없이 유효한 자산 id 를 만든다 — 원래 블로커: raw 연결이 STRICT_SLUG(ASCII)에 걸렸다.
{
  let id = "";
  try { id = draftAssetId("윤상민", "pr-writer"); } catch (e) { bad("① 한글 멤버 id", (e as Error).message); }
  check("① 한글 멤버 id → 유효 자산 id(draft-…-pr-writer)",
    !!id && STRICT_SLUG.test(id) && id.startsWith("draft-") && id.endsWith("-pr-writer"), id);
}
// ② 결정적 — 같은 (멤버, slug) → 같은 id (초안 갱신이 같은 행에 걸려야 한다).
check("② 결정적", draftAssetId("yoon", "x") === draftAssetId("yoon", "x"), "비결정적");
// ③ per-member 네임스페이스 분리 — 다른 멤버는 같은 slug 라도 다른 id(남의 초안·조직자산 못 덮음의 근거).
check("③ 멤버별 네임스페이스 분리", draftAssetId("yoon", "dup") !== draftAssetId("jang", "dup"), "멤버간 충돌");
// ④ 하이픈 구분자 모호성 제거 — raw 연결이면 'yo'+'on-x' 와 'yo-on'+'x' 가 같은 id 였다(리뷰 N2). 해시라 다르다.
check("④ 하이픈 구분자 모호성 없음", draftAssetId("yo", "on-x") !== draftAssetId("yo-on", "x"), "구분자 모호성 충돌");
// ⑤ 총길이 ≤64(assertAssetId 통과) — 긴 멤버 id + 최대 40자 slug 에서도. draft-(6)+해시(10)+-(1)+slug(≤40)=≤57.
{
  const maxSlug = "a" + "b".repeat(39); // 40자
  let id = "";
  try { id = draftAssetId("some-very-long-member-id-abcdefghijklmnop", maxSlug); } catch (e) { bad("⑤ 총길이", (e as Error).message); }
  check("⑤ 긴 멤버 id + 40자 slug 도 유효(≤64)", !!id && id === assertAssetId(id) && id.length <= 64, `len=${id.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
