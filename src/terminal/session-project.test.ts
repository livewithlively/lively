// 세션 프로젝트 적용은 tmux 호환 캐시만 갱신하고 파일시스템/cwd를 건드리지 않는다는 계약.
import assert from "node:assert/strict";
import { applySessionProject, type SessionProjectRuntime } from "./session-project.js";
import type { LivelyUser } from "../context.js";

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };
const user = { userId: "yoon" } as LivelyUser;

function runtime(owner = "yoon"): { port: SessionProjectRuntime; writes: string[][]; quiet: string[][] } {
  const writes: string[][] = [], quiet: string[][] = [];
  return {
    writes, quiet,
    port: {
      getOpt: async () => owner,
      tmux: async (args) => { writes.push(args); },
      tmuxQuiet: async (args) => { quiet.push(args); },
    },
  };
}

{
  const r = runtime();
  const out = await applySessionProject(user, "box-yoon-12345678", { projectId: 12, folder: "project/12", src: "v6" }, r.port);
  assert.equal(out.projectId, 12);
  assert.deepEqual(r.writes, [
    ["set-option", "-t", "box-yoon-12345678", "@box_project", "12"],
    ["set-option", "-t", "box-yoon-12345678", "@box_project_src", "v6"],
  ]);
  assert.deepEqual({ linked: out.linked, projectDir: out.projectDir, sessionDir: out.sessionDir }, { linked: false, projectDir: null, sessionDir: false });
  ok("프로젝트 지정 → tmux 표시만 갱신하고 파일 표현 없음");
}

{
  const r = runtime();
  const out = await applySessionProject(user, "box-yoon-12345678", null, r.port);
  assert.equal(out.projectId, null);
  assert.deepEqual(r.quiet, [
    ["set-option", "-t", "box-yoon-12345678", "-u", "@box_project"],
    ["set-option", "-t", "box-yoon-12345678", "-u", "@box_project_src"],
  ]);
  ok("소속 해제 → tmux 표시 해제만 수행");
}

{
  const r = runtime("other");
  await assert.rejects(
    () => applySessionProject(user, "box-yoon-12345678", { projectId: 12, folder: "project/12" }, r.port),
    /본인 세션이 아닙니다/,
  );
  assert.equal(r.writes.length + r.quiet.length, 0);
  ok("남의 세션 → 적용 전 거부");
}

console.log(`\n${pass} passed`);
