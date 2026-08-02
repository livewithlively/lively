// 박스 레포 provision 보안 가드 단위 체크 — 레포명/경로봉쇄/브랜치 검증이 git·DB 호출 전에 거부하는지.
//  (clone/worktree 실거동은 박스 통합검증으로 확인 — 여기선 네트워크·DB 없는 입력검증 불변식만.)
// 실행: npm run build && node dist/project/project-provision.test.js
import assert from "node:assert/strict";
import { provisionProjectRepos } from "./project-provision.js";

const FOLDER = "project/__unittest";
let pass = 0;
const reject = async (name: string, specs: { name: string; path?: string; worktree?: boolean; branch?: string }[]): Promise<void> => {
  await assert.rejects(() => provisionProjectRepos(1, FOLDER, specs), (e: unknown) => e instanceof Error);
  pass++; console.log(`ok  ${name}`);
};

// ── 레포명: 경로 컴포넌트라 슬래시·.. 금지 ──
await reject("레포명 슬래시 거부", [{ name: "a/b" }]);
await reject("레포명 .. 거부", [{ name: ".." }]);
await reject("레포명 빈값 거부", [{ name: "" }]);
await reject("레포명 백슬래시 거부", [{ name: "a\\b" }]);

// ── 경로 봉쇄: workspace 밖 거부 ──
await reject("workspace 밖 절대경로 거부", [{ name: "x", path: "/etc" }]);
await reject("workspace 밖 .. 탈출 거부", [{ name: "x", path: "/Users/lively/.openclaw/workspace/../secret" }]);

// ── 브랜치명 형식(주입·특수문자 방지) ──
await reject("브랜치 공백 거부", [{ name: "x", path: "/Users/lively/.openclaw/workspace/repos/x", worktree: true, branch: "bad branch" }]);
await reject("브랜치 선두특수 거부", [{ name: "x", path: "/Users/lively/.openclaw/workspace/repos/x", worktree: true, branch: "-evil" }]);
await reject("브랜치 세미콜론(주입시도) 거부", [{ name: "x", path: "/Users/lively/.openclaw/workspace/repos/x", worktree: true, branch: "a;rm -rf" }]);

console.log(`\n${pass} passed`);
