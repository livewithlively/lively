// 내보낼 때 보여 주는 안내 — 대상자를 제한한 지식은 받는 쪽에서 공개로 들어간다는 것을 **내보내는 쪽에서** 알린다(상민님 2026-11-09).
//  실행: npx tsx --test src/transfer/export-notes.test.ts   (사양: #5458 spec 표 E)
//
//  ── 엣지 표 ──────────────────────────────────────────────────────────────
//   E1  대상자 제한 지식 n>0      → «받는 쪽에서는 공개로 들어갑니다» 안내(수 포함)
//   E2  모든 수가 0              → 안내 없음
//   E3  대상자 제한 자료 n>0      → 자료도 «받는 쪽에서는 공개로 들어갑니다» 안내
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportNotes } from "./export.js";

const zero = { restricted: 0, restricted_sources: 0, pinned: 0, observed: 0, uncategorized: 0, missing: [] as string[], body_bytes: 1000 };

test("E1 대상자를 제한한 지식이 있으면 공개로 들어간다고 수와 함께 알린다", () => {
  const notes = exportNotes({ ...zero, restricted: 3 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /3건/);
  assert.match(notes[0], /공개로 들어갑니다/);
});

test("E2 알릴 것이 없으면 안내가 없다", () => {
  assert.deepEqual(exportNotes(zero), []);
});

test("E3 대상자를 제한한 자료가 있으면 자료도 공개로 들어간다고 알린다", () => {
  const notes = exportNotes({ ...zero, restricted_sources: 2 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /자료 2건/);
  assert.match(notes[0], /공개로 들어갑니다/);
});
