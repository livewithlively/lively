// 은퇴한 빌트인 앱 회수 판정(#4554) — 「안녕 앱」(hello)을 제품에서 뺐다.
//
//  패키지 폴더를 지우는 것만으로는 이미 설치된 워크스페이스에 앱이 남는다(시더는 있는 폴더만 돌고, 제거 verb 는 builtin 을 막는다).
//  그래서 시더가 은퇴 목록의 앱을 회수한다. 이 시험은 «무엇을 지우고 무엇을 안 지우나» 의 엣지 표다.
//  실제 회수(앱 행 · 조인 · 전개물)는 실DB 스모크 scripts/apps-install.itest.mjs 가 잰다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { RETIRED_BUILTIN_APPS, shouldRetireBuiltin } from "./seed.js";

const none = new Set<string>();
const builtin = { source: { kind: "builtin" } };

test("[R1] 은퇴 목록에 있고 · 패키지 폴더에 없고 · builtin 으로 설치돼 있으면 회수한다", () => {
  assert.equal(shouldRetireBuiltin("hello", none, builtin), true);
});

test("[R2] 은퇴 목록에 없는 빌트인 앱은 패키지 폴더에 없어도 회수하지 않는다", () => {
  //  폴더가 통째로 빠진 배포(seed-shipped.test.ts 가 막는 사고)에서 빌트인 앱 전부를 지우면 안 된다.
  for (const id of ["inbox", "sources", "browser", "ai-session"]) assert.equal(shouldRetireBuiltin(id, none, builtin), false, id);
});

test("[R3] 패키지 폴더에 아직 있는 앱은 은퇴 목록에 있어도 회수하지 않는다", () => {
  assert.equal(shouldRetireBuiltin("hello", new Set(["hello"]), builtin), false);
});

test("[R4] 설치돼 있지 않으면 회수할 것이 없다", () => {
  assert.equal(shouldRetireBuiltin("hello", none, null), false);
  assert.equal(shouldRetireBuiltin("hello", none, undefined), false);
});

test("[R5] 워크스페이스가 같은 id 로 직접 깐 앱(builtin 아님)은 회수하지 않는다", () => {
  for (const source of [{ kind: "inline" }, { kind: "git" }, { kind: "path" }, {}, null, undefined, "builtin"]) {
    assert.equal(shouldRetireBuiltin("hello", none, { source }), false, JSON.stringify(source));
  }
});

test("[R6] 은퇴 목록이 비면 아무것도 회수하지 않는다", () => {
  assert.equal(shouldRetireBuiltin("hello", none, builtin, []), false);
});

test("[W1] 은퇴 목록에 hello 가 있고, 은퇴한 앱의 패키지는 제품 폴더에 없다", () => {
  assert.ok(RETIRED_BUILTIN_APPS.includes("hello"));
  const shipped = readdirSync("apps/builtin");
  assert.ok(shipped.length > 0, "배선 — 제품 폴더를 실제로 읽었다");
  for (const id of RETIRED_BUILTIN_APPS) {
    assert.ok(!shipped.includes(id), `apps/builtin/${id} 가 남아 있다 — 시더가 심고 지우기를 되풀이하지는 않지만(R3), 은퇴가 영영 일어나지 않는다`);
  }
  assert.ok(existsSync("scripts/fixtures/apps/hello/lively-app.json"), "hello 패키지는 시험 픽스처로 남는다(실DB 스모크가 쓴다)");
});
