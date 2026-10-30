// REST 경로 가림 가드(#4226) — web.ts 는 restMounts() 순서대로 마운트하고 Express 는 **먼저 등록된 경로가 이긴다**.
//  그래서 앞에 `/api/ui/apps/:id` 가 있으면 뒤에 붙인 `/api/ui/apps/snapshots` 는 한 번도 불리지 않는다 — :id 가
//  "snapshots" 를 앱 id 로 받아 «앱 없음: snapshots» 를 돌려준다. 핸들러를 직접 부르는 시험으로는 안 보이고
//  매니지드 끝단에서야 드러났다(2026-09-30). 이 시험은 같은 메서드의 앞선 매개변수 경로가 뒤의 글자 그대로 경로를
//  삼키는지를 전부 훑는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { restMounts } from "./index.js";

/** Express 식 경로 짝짓기(순수) — `:x` 는 한 칸(슬래시 없는 빈 아닌 문자열)에 맞는다. `*`·정규식 경로는 다루지 않는다. */
export function pathShadows(pattern: string, literal: string): boolean {
  const a = pattern.split("/"), b = literal.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith(":") ? b[i].length > 0 : seg === b[i]));
}

test("pathShadows — 매개변수 칸은 아무 칸에나, 글자 칸은 같을 때만, 칸 수가 다르면 아님", () => {
  assert.equal(pathShadows("/api/ui/apps/:id", "/api/ui/apps/snapshots"), true);
  assert.equal(pathShadows("/api/ui/apps/:id", "/api/ui/apps/x/restore"), false);
  assert.equal(pathShadows("/api/ui/apps/:id/grant", "/api/ui/apps/save"), false);
  assert.equal(pathShadows("/api/ui/a/:x/b", "/api/ui/a/1/b"), true);
  assert.equal(pathShadows("/api/ui/a/:x/b", "/api/ui/a/1/c"), false);
});

test("앞서 마운트된 매개변수 경로가 뒤의 글자 그대로 경로를 가리지 않는다(같은 메서드)", () => {
  const flat: Array<{ idx: number; cap: string; method: string; path: string }> = [];
  restMounts().forEach(({ cap, mount }, idx) => {
    for (const p of mount.paths) flat.push({ idx, cap: cap.name, method: mount.method, path: p });
  });
  const shadowed: string[] = [];
  for (const early of flat) {
    if (!early.path.includes("/:")) continue;
    for (const late of flat) {
      if (late.idx <= early.idx || late.method !== early.method || late.path.includes("/:")) continue;
      if (pathShadows(early.path, late.path)) shadowed.push(`${late.method} ${late.path}(${late.cap}) ← 먼저 마운트된 ${early.path}(${early.cap}) 에 가려진다`);
    }
  }
  assert.deepEqual(shadowed, [], `가려진 경로:\n  ${shadowed.join("\n  ")}\n  → 경로를 바꾸거나(예: /api/ui/app-snapshots) 등록 순서를 앞당겨라`);
});
