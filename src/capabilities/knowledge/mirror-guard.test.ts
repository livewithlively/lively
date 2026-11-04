// 미러 쓰기 가드 — 사양 기반·구현 블라인드 시험 (사양 §7, src/capabilities/knowledge/mirror-guard.ts). DB 불요(순수 함수).
// 실행: npm run build && node dist/capabilities/knowledge/mirror-guard.test.js
//
// 잠그는 행위(§7 — 외부 원본을 읽기 전용으로 미러한 지식의 본문·제목 쓰기를 막는다):
//  1. row 가 없거나 external_system 이 없음/빈 문자열/공백뿐이면 null(허용).
//  2. external_system 이 있으면 사람이 읽을 거절 사유(문자열) — 사유에 그 external_system 값이 들어 있다.
//  3. external_url 이 있으면 사유에 그 주소가 들어 있다(원본에서 고치라는 안내).
//  4. what=title 이면 사유가 «제목» 을, what=save 면 «본문» 을 말한다.
//  (문구 자체는 잠그지 않는다 — 위 네 가지 포함 여부만 본다.)
import assert from "node:assert/strict";
import test from "node:test";
import { denyMirrorContentWrite } from "./mirror-guard.js";

const WHATS = ["save", "title"] as const;
const URL_A = "https://git.example.com/pm/wiki/-/blob/main/Card/a.md";

test("§7.1 row 가 없으면 허용(null)", () => {
  for (const what of WHATS) {
    assert.equal(denyMirrorContentWrite(null, what), null, `§7.1 row=null, what=${what}`);
    assert.equal(denyMirrorContentWrite(undefined, what), null, `§7.1 row=undefined, what=${what}`);
  }
});

test("§7.1 external_system 이 없음·빈 문자열·공백뿐이면 허용(null)", () => {
  for (const what of WHATS) {
    assert.equal(denyMirrorContentWrite({}, what), null, `§7.1 external_system 키 없음, what=${what}`);
    assert.equal(denyMirrorContentWrite({ external_system: null }, what), null, `§7.1 external_system=null, what=${what}`);
    assert.equal(denyMirrorContentWrite({ external_system: undefined }, what), null, `§7.1 external_system=undefined, what=${what}`);
    assert.equal(denyMirrorContentWrite({ external_system: "" }, what), null, `§7.1 external_system="", what=${what}`);
    assert.equal(denyMirrorContentWrite({ external_system: "   " }, what), null, `§7.1 external_system 공백뿐, what=${what}`);
    assert.equal(denyMirrorContentWrite({ external_system: null, external_url: URL_A }, what), null,
      `§7.1 external_url 만 있고 external_system 이 없으면 허용, what=${what}`);
  }
});

test("§7.2 external_system 이 있으면 그 값이 든 거절 사유(문자열)", () => {
  for (const what of WHATS) {
    for (const system of ["domain-wiki", "notion"]) {
      const r = denyMirrorContentWrite({ external_system: system }, what);
      assert.equal(typeof r, "string", `§7.2 ${system}/${what}: 거절 사유는 문자열`);
      assert.ok(r !== null && r.trim().length > 0, `§7.2 ${system}/${what}: 비지 않은 사유`);
      assert.ok(r?.includes(system), `§7.2 ${system}/${what}: 사유에 external_system 값이 들어 있다 → ${r}`);
    }
    const withNullUrl = denyMirrorContentWrite({ external_system: "notion", external_url: null }, what);
    assert.ok(withNullUrl?.includes("notion"), `§7.2 external_url=null 이어도 거절, what=${what} → ${withNullUrl}`);
  }
});

test("§7.3 external_url 이 있으면 사유에 그 주소가 들어 있다", () => {
  for (const what of WHATS) {
    const r = denyMirrorContentWrite({ external_system: "domain-wiki", external_url: URL_A }, what);
    assert.ok(r?.includes(URL_A), `§7.3 사유에 원본 주소, what=${what} → ${r}`);
    assert.ok(r?.includes("domain-wiki"), `§7.2+§7.3 주소가 있어도 external_system 값은 들어 있다, what=${what} → ${r}`);
  }
});

test("§7.4 what=title 이면 «제목», what=save 면 «본문» 을 말한다", () => {
  for (const row of [{ external_system: "domain-wiki", external_url: URL_A }, { external_system: "notion" }]) {
    const t = denyMirrorContentWrite(row, "title");
    const s = denyMirrorContentWrite(row, "save");
    assert.ok(t?.includes("제목"), `§7.4 what=title → 사유가 «제목» 을 말한다: ${t}`);
    assert.ok(s?.includes("본문"), `§7.4 what=save → 사유가 «본문» 을 말한다: ${s}`);
  }
});
