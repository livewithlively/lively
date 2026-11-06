// 관리자 임시 비밀번호 고르기(순수) — 관리자가 정한 것은 그대로 쓰고 응답에 다시 싣지 않는다 · 안 주면 자동 발급(1회 반환) · 모양이 틀리면 400.
import assert from "node:assert/strict";
import { chooseTempPassword, TEMP_PASSWORD_MAX, TEMP_PASSWORD_MIN } from "./temp-password.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const gen = (): string => "AUTO-GENERATED-1";
const status = (fn: () => unknown): number | null => { try { fn(); return null; } catch (e) { return (e as { status?: number }).status ?? -1; } };

t("TP1 안 주면(없음 · null · 빈 글) 자동 발급 — 응답에 1회 싣는다", () => {
  for (const g of [undefined, null, ""]) assert.deepEqual(chooseTempPassword(g, gen), { password: "AUTO-GENERATED-1", echo: true });
});

t("TP2 관리자가 정한 임시 비번 — 그대로 저장하고 응답에 다시 싣지 않는다", () => {
  assert.deepEqual(chooseTempPassword("temp-pass-예시1!", gen), { password: "temp-pass-예시1!", echo: false });
  assert.equal(chooseTempPassword("x".repeat(TEMP_PASSWORD_MIN), gen).echo, false, "하한 정확히는 받는다");
  assert.equal(chooseTempPassword("x".repeat(TEMP_PASSWORD_MAX), gen).echo, false, "상한 정확히는 받는다");
});

t("TP3 모양이 틀리면 400 — 짧음 · 김 · 글 아님 · 제어 문자", () => {
  for (const bad of ["x".repeat(TEMP_PASSWORD_MIN - 1), "x".repeat(TEMP_PASSWORD_MAX + 1), 12345678, ["abcdefgh"], { p: "abcdefgh" }, "abc\u0000defgh", "tab\tinside1", "줄\n바꿈있는비번"]) {
    assert.equal(status(() => chooseTempPassword(bad, gen)), 400, JSON.stringify(bad));
  }
});

console.log(`temp-password: ${pass} ok`);
