// 붙은 앱 한 줄(describeAttached) — #4595 사양 표 D1~D4.
//  훅(session-apps-inject)이 읽는 재료가 여기서 나온다: 지침이 있으면 그대로, 없으면 null. 틀리면 훅이 테이블 이름만
//  보고 앱의 목적을 짐작하던 옛 상태로 조용히 돌아간다(아무 오류 없이) — 그래서 null 과 글을 가르는 행이 전부 있다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { describeAttached } from "./session-apps.js";
import type { OrgApp } from "../org/store/apps.js";
import type { SessionAppRow } from "../apps/session-apps.js";

const row: SessionAppRow = { session_id: "box-x", app_id: "deck-edit", member_id: "wonjoon", attached_at: "2026-10-07T00:00:00Z" };

function app(manifest: Record<string, unknown>, extra: Partial<OrgApp> = {}): OrgApp {
  return {
    id: "deck-edit", title: "장표 수정", version: "1.0.0", manifest, source: { kind: "builtin" }, content_hash: null,
    status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null,
    edit_mode: "all", edit_members: [], builtin_version: null, current_version_no: null, ...extra,
  };
}

test("D1 지침 있는 앱 → instructions 그대로 · reinject_every 그대로 · version · source_kind", () => {
  const d = describeAttached(row, app({ agent: { instructions: "HTML 을 만들면 올린다", reinject_every: 12 } }));
  assert.equal(d.instructions, "HTML 을 만들면 올린다");
  assert.equal(d.reinject_every, 12);
  assert.equal(d.version, "1.0.0");
  assert.equal(d.source_kind, "builtin");
  assert.equal(d.overrides_builtin, false);
});

test("D2 지침 없는 앱 → instructions null · reinject_every null · 종전 필드(has_ui·tables)는 그대로", () => {
  const d = describeAttached(row, app({ ui: { pages: [{ key: "main", title: "M" }] }, data: { tables: [{ name: "notes", columns: [{ name: "body" }] }] } }));
  assert.equal(d.instructions, null);
  assert.equal(d.reinject_every, null);
  assert.equal(d.has_ui, true);
  assert.deepEqual(d.tables, [{ name: "notes", columns: [{ name: "body" }] }]);
  assert.deepEqual(d.pages, [{ key: "main", title: "M" }]);
});

test("D3 공백 지침은 없는 것 · 앱이 없으면(제거됨) null 들 · usable false", () => {
  const blank = describeAttached(row, app({ agent: { instructions: "   ", reinject_every: 7 } }));
  assert.equal(blank.instructions, null);
  assert.equal(blank.reinject_every, null, "지침이 없으면 주기도 없다(훅이 기본 주기를 쓴다)");
  const d = describeAttached(row, null);
  assert.equal(d.instructions, null);
  assert.equal(d.version, null);
  assert.equal(d.source_kind, null);
  assert.equal(d.overrides_builtin, false);
  assert.equal(d.usable, false);
  assert.equal(d.title, "deck-edit");
});

test("D4 워크스페이스 판으로 덮어쓴 빌트인 → overrides_builtin true · source_kind inline (#4600 재료)", () => {
  const d = describeAttached(row, app({}, { source: { kind: "inline", overrides_builtin: true }, version: "1.0.1" }));
  assert.equal(d.overrides_builtin, true);
  assert.equal(d.source_kind, "inline");
  assert.equal(d.version, "1.0.1");
});
