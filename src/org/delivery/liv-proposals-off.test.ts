// #1631 — 리브의 제안 카드(«지금 n가지가 걸립니다» · [제가 해 드릴게요])를 사람에게 내보내지 않는다
//  (원준 2026-09-14: «이렇게 제안하는거 일단 꺼줘. 사용자한테 제안하지 않게.»).
//
//  카드는 서버 창구 하나(me_liv_home = GET /api/ui/me/liv, REST 전용)로만 나가고, 사람에게는 리브 탭(#/liv)이 그린다.
//  그래서 끄는 자리도 거기 한 곳이다: 판정(livFindings)은 그대로 계산하고, 내보내는 findings·total 만 스위치
//  (LIV_PROPOSALS_ON)로 비운다. 화면은 빈 목록이면 조용한 첫 화면(부탁할 수 있는 말 — 누르면 입력칸에만 담긴다)을 그린다.
//
//  창구는 DB·노드·온보딩 조회를 엮어 유닛으로 못 돌린다 — 구조를 소스에서 못박는다(레포 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FINDINGS = readFileSync("src/org/delivery/liv-findings.ts", "utf8");
const CAP = readFileSync("src/capabilities/delivery/liv.ts", "utf8");
// 설명 주석에 걸린 거짓 판정을 피한다(#3870 함정) — 줄 주석을 걷고 본다.
const code = (s: string): string => s.replace(/^[ \t]*\/\/.*$/gm, "");

test("★★ 제안 카드 스위치가 꺼져 있다 — 다시 켜는 것은 이 시험을 함께 고치는 결정이다", () => {
  assert.match(code(FINDINGS), /export const LIV_PROPOSALS_ON = false;/,
    "★ LIV_PROPOSALS_ON 스위치가 없거나 켜져 있다 — 사람에게 제안 카드가 나간다");
});

test("★★ me_liv_home 은 스위치가 꺼져 있으면 카드를 내보내지 않는다 — findings 는 빈 목록, total 은 0", () => {
  const c = code(CAP);
  assert.match(c, /import \{[^}]*\bLIV_PROPOSALS_ON\b[^}]*\} from "\.\.\/\.\.\/org\/delivery\/liv-findings\.js";/,
    "창구가 스위치를 읽지 않는다");
  assert.match(c, /findings: LIV_PROPOSALS_ON \? livTopFindings\(findings, TOP\) : \[\],/,
    "★ findings 가 스위치와 무관하게 나간다");
  assert.match(c, /total: LIV_PROPOSALS_ON \? findings\.length : 0,/,
    "★ total 이 스위치와 무관하게 나간다(개수만 남아도 사람은 그걸 본다)");
  // 스위치를 거치지 않고 카드를 싣는 다른 자리가 없다.
  assert.equal((c.match(/livTopFindings\(/g) ?? []).length, 1, "livTopFindings 를 스위치 밖에서 또 부른다");
});
