#!/usr/bin/env node
// 세션 머리줄 얼굴 줄 = 초대 명단 (#3870, 원준 2026-10-14 «초대명단이어야지»)
//  R1 초대받았지만 안 보는 사람도 줄에 선다(here=false)  R2 보는 사람은 here=true, 나 먼저
//  R3 소유자도 명단 — 안 보면 흐린 얼굴로  R4 명단에 없는데 보는 사람(관리자)도 빠지지 않는다
//  R5 중복 없음  R6 보는 사람이 앞(접을 때 살아 있는 얼굴이 남는다)  R7 이름은 보는 쪽 > 명부 > id
//  W1 배선 — session-chat 이 faceRoster 로 그리고 흐린 클래스를 붙인다 / 저장하면 명단을 바로 반영한다
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { faceRoster } = await import(pathToFileURL(join(root, "public/app/lib/face-roster.js")).href);
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok  " + name); };

t("R1 초대받았지만 안 보는 상민도 선다", () => {
  const r = faceRoster("wonjoon", ["sangmin"], [{ id: "wonjoon", name: "원준" }], "wonjoon");
  assert.deepEqual(r.map((f) => [f.id, f.here]), [["wonjoon", true], ["sangmin", false]]);
});
t("R2 보는 사람 here · 나 먼저", () => {
  const r = faceRoster("wonjoon", ["sangmin"], [{ id: "sangmin", name: "상민" }, { id: "wonjoon", name: "원준" }], "wonjoon");
  assert.deepEqual(r.map((f) => [f.id, f.here]), [["wonjoon", true], ["sangmin", true]]);
});
t("R3 소유자도 명단 — 안 보면 흐림", () => {
  const r = faceRoster("wonjoon", ["sangmin"], [{ id: "sangmin", name: "상민" }], "sangmin");
  assert.deepEqual(r.map((f) => [f.id, f.here]), [["sangmin", true], ["wonjoon", false]]);
});
t("R4 명단 밖 열람자도 남는다", () => {
  const r = faceRoster("wonjoon", [], [{ id: "admin", name: "관리자" }], "wonjoon");
  assert.deepEqual(r.map((f) => f.id), ["admin", "wonjoon"]);
});
t("R5 중복 없음", () => {
  const r = faceRoster("a", ["a", "b", "b"], [], "a");
  assert.deepEqual(r.map((f) => f.id), ["a", "b"]);
});
t("R6 보는 사람이 안 보는 사람 앞", () => {
  const r = faceRoster("a", ["b", "c"], [{ id: "c", name: "C" }], "x");
  assert.deepEqual(r.map((f) => f.id), ["c", "a", "b"]);
});
t("R7 이름 우선순위", () => {
  const r = faceRoster("a", ["b", "c"], [{ id: "b", name: "비" }], "x", (id) => (id === "c" ? "씨" : ""));
  assert.deepEqual(r.map((f) => f.name), ["비", "a", "씨"]);
});
t("W1 배선", () => {
  const s = readFileSync(join(root, "web/session-chat.ts"), "utf8");
  assert.match(s, /faceRoster\(sh\.owner, sh\.invites/);
  assert.match(s, /sc-face sc-face-off/);
  assert.match(s, /openSharePopover\(facesEl, sh, \(invites\)/);
  assert.match(readFileSync(join(root, "public/styles/36-chat.css"), "utf8"), /\.sc-face-off\s*\{\s*opacity/);
});
console.log(`\n${n}/${n} 통과`);
