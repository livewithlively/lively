// 세션 프로젝트 적용은 tmux 호환 캐시만 갱신하고 파일시스템/cwd를 건드리지 않는다는 계약(#1867).
//  + 프로젝트 폴더 경로 헬퍼(projectDirPath·projectDirOnThisHost — #1850 완전삭제가 rm -rf 하는 자리) — 존재 판정은 별도 함수.
//  ⚠ 프로젝트 폴더 판정은 PROJECT_SHARED_BASE(TERMINAL_ROOT_SHARED) 기준이라, import 전에 env 를 샌드박스로 돌린다.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LivelyUser } from "../context.js";

const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-sp-"));
const SHARED = path.join(SANDBOX, "workspace");
await fsp.mkdir(path.join(SHARED, "project", "12"), { recursive: true });
process.env.TERMINAL_ROOT_SHARED = SHARED;
const { applySessionProject, projectDirPath, projectDirOnThisHost } = await import("./session-project.js");
type SessionProjectRuntime = NonNullable<Parameters<typeof applySessionProject>[3]>;

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

try {
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

  {
    // #1850 — 완전삭제가 rm -rf 하는 경로: 실재하는 폴더만 준다. 경로 계산(projectDirPath)은 존재와 무관하고, 워크스페이스 밖은 둘 다 null.
    const P12 = path.join(SHARED, "project", "12");
    assert.equal(projectDirOnThisHost("project/12"), P12, "실재하면 경로");
    assert.equal(projectDirOnThisHost("project/9999"), null, "없으면 null — 삭제 경로가 유령 폴더를 만지지 않는다");
    assert.equal(projectDirPath("project/9999"), path.join(SHARED, "project", "9999"), "경로 계산은 존재와 무관");
    assert.equal(projectDirPath("../escape/9"), null, "워크스페이스 밖은 둘 다 null");
    assert.equal(projectDirOnThisHost("../escape/9"), null);
    assert.equal(projectDirPath(""), null, "빈 folder 는 null(루트를 가리키지 않는다)");
    ok("projectDirOnThisHost 는 실재하는 폴더만 · projectDirPath 는 경로만 · 밖·빈값은 null");
  }
} finally {
  await fsp.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} passed`);
