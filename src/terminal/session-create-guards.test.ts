// 세션 생성 가드(#1780 v2 §7-1) — 사양 H1: node + appId 는 400, 그 외는 통과(무회귀).
import { strict as assert } from "node:assert";
import test from "node:test";
import { assertAppSessionPlacement } from "./session-create-guards.js";
import { HttpError } from "../http-error.js";

test("node + appId → 400 (relay 전에 거절)", () => {
  assert.throws(
    () => assertAppSessionPlacement({ appId: "browser" }, "node-1"),
    (e: unknown) => e instanceof HttpError && e.status === 400 && /노드/.test(e.message),
  );
});

test("node + appId 미지정/undefined → 통과(무회귀)", () => {
  assert.doesNotThrow(() => assertAppSessionPlacement({}, "node-1"));
  assert.doesNotThrow(() => assertAppSessionPlacement({ appId: undefined }, "node-1"));
});

test("node 없음 + appId → 통과(중앙 앱 세션, 무회귀)", () => {
  assert.doesNotThrow(() => assertAppSessionPlacement({ appId: "browser" }, ""));
});
