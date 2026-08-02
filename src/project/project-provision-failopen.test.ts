// #1155 서버측 fail-open — "박스·노드에서도 레포를 못 받았다고 세션을 막지 않는다 + 실패를 세션이 읽는 자리에 남긴다".
//   실행: npm run build && node dist/project/project-provision-failopen.test.js
//   DB·네트워크 불요 — 로컬 bare 레포(file://)와 '레지스트리에 없는 이름'으로 성공/실패를 만든다.
//   ⚠ 구현 재진술 금지 — 관찰 가능한 결과만 단언한다: throw 여부 · 반환값 · 마커 파일 · **kit 훅이 그 마커로 만든 통지**.
//
// 사양 엣지:
//   S1 failOpen 미지정 + 환경 실패 → 종전대로 throw(프리뷰 등 '코드 없으면 무의미'한 호출자 무회귀)
//   S2 failOpen + 부분 실패 → throw 없음 · 성공분은 provisioned · 실패분은 failed
//   S3 실패가 마커 repos_failed 에 기록된다(work.mjs 와 같은 키·스키마)
//   S4 **크로스 검증** — 서버가 쓴 마커를 kit 세션 프리로드 훅이 읽어 통지를 만든다(훅 재사용의 증명)
//   S5 다음 준비가 성공하면 repos_failed 는 사라지고, 남의 키(provisioned 외 미지 키)는 보존된다
//   S6 입력 검증(레포명·브랜치 형식)은 failOpen 이어도 throw — 환경 문제가 아니라 호출자 버그
//   S7 실패 사유별 복구 안내가 갈린다(미등록 vs 그 외)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// PROJECT_SHARED_BASE 는 import 시점에 env 를 읽는다 — 먼저 세팅(실제 워크스페이스를 건드리지 않기 위해).
delete process.env.ITEMS_DATABASE_URL;   // DB 미설정 = 레지스트리 조회 불가(노드 조건)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "prov-failopen-"));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { provisionProjectRepos } = await import("./project-provision.js");
// 로컬 실행(work.mjs)이 쓰는 통지 훅 — 서버가 쓴 마커를 **같은 함수**가 읽는지 확인하려고 그대로 가져온다.
//  경로를 string 변수로 두는 이유: kit 훅은 타입 선언 없는 .mjs 라 리터럴 지정자면 tsc 가 TS7016 을 낸다.
//  런타임 해석만 필요하고(dist/ 기준 상대경로 동일), 쓰는 시그니처는 아래 캐스트로 못 박는다.
const preloadHook: string = "../../kit/hooks/session-preload.mjs";
const { repoStatusNotice } = await import(preloadHook) as { repoStatusNotice: (cwd: string) => string | null };

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const git = (args: string[], cwd?: string): void => {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
};
const PID = 115500;
const FOLDER = `project/${PID}`;
const projDir = path.join(ROOT, "project", String(PID));
const markerFile = path.join(projDir, ".lively", "project.json");
const marker = (): Record<string, unknown> => JSON.parse(fs.readFileSync(markerFile, "utf8"));

try {
  // 원격 흉내 — 커밋 하나 든 bare 레포(file:// 로 clone, 네트워크·자격 불요).
  const srcWork = path.join(ROOT, "src-work");
  fs.mkdirSync(srcWork, { recursive: true });
  git(["init", "-q", "-b", "main", srcWork]);
  fs.writeFileSync(path.join(srcWork, "README.md"), "hello\n");
  git(["add", "-A"], srcWork);
  git(["commit", "-q", "-m", "init"], srcWork);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", srcWork, bare]);
  const GOOD = { name: "good-repo", worktree: true, inject: { gitUrl: "file://" + bare, secret: null } };
  const BAD = { name: "ghost-repo", worktree: true };   // inject 없음 + DB 없음 = 레지스트리에서 못 찾음(환경 실패)

  // ── S1 — failOpen 을 안 주면 종전대로 던진다 ──
  {
    await assert.rejects(
      () => provisionProjectRepos(PID, FOLDER, [BAD], { clone: true, memberId: null }),
      (e: unknown) => e instanceof Error,
      "failOpen 없이는 환경 실패가 throw 여야 한다(프리뷰 등 무회귀)",
    );
    ok("S1 failOpen 미지정 → 종전대로 throw");
  }

  // ── S2·S3 — failOpen 이면 부분 실패로 계속 가고, 실패는 마커에 남는다 ──
  {
    const r = await provisionProjectRepos(PID, FOLDER, [BAD, GOOD], { clone: true, memberId: null, failOpen: true });
    assert.equal(r.provisioned.length, 1, "성공한 레포는 준비돼야 한다(부분 실패가 전체를 죽이지 않음)");
    assert.equal(r.provisioned[0].name, "good-repo");
    assert.ok(fs.existsSync(path.join(projDir, "good-repo", "README.md")), "성공 레포의 워크트리에 코드가 없다");
    assert.equal(r.failed.length, 1, "실패한 레포는 failed 로 보고돼야 한다");
    assert.equal(r.failed[0].name, "ghost-repo");
    assert.ok(r.failed[0].reason, "실패 사유가 비었다");
    assert.ok(r.failed[0].hint, "복구 안내가 비었다");
    assert.equal(r.failed[0].expect, path.join(projDir, "ghost-repo"), "준비됐어야 할 자리가 기록돼야 한다(복구 판정 근거)");
    ok("S2 failOpen — 성공은 준비되고 실패만 보고된다");

    const m = marker();
    const mf = m.repos_failed as { name: string; expect: string; reason: string; hint: string }[];
    assert.ok(Array.isArray(mf) && mf.length === 1 && mf[0].name === "ghost-repo", "마커 repos_failed 기록 누락");
    assert.ok(Array.isArray(m.provisioned) && (m.provisioned as { name: string }[]).some((x) => x.name === "good-repo"), "성공분 provisioned 기록 누락");
    ok("S3 실패가 마커(repos_failed)에 기록된다");

    // ── S4 크로스 검증 — 로컬(work.mjs) 경로용 훅이 서버가 쓴 마커를 그대로 읽는다 ──
    const notice = repoStatusNotice(projDir);
    assert.ok(notice && notice.includes("ghost-repo"), "세션 프리로드 훅이 서버 마커의 실패를 못 읽었다");
    assert.ok(notice.includes(mf[0].hint), "통지에 복구 안내가 실리지 않았다");
    assert.ok(/clone 하지 마세요/.test(notice), "임의 clone 금지 지시가 통지에 없다");
    assert.ok(!notice.includes("good-repo"), "성공한 레포까지 경고에 섞였다");
    ok("S4 크로스 검증 — kit 세션 프리로드 훅이 서버 마커를 그대로 읽어 통지한다");
  }

  // ── S5 — 다음 준비가 성공하면 경고는 사라지고, 다른 writer 의 키는 보존된다 ──
  {
    const m0 = marker();
    m0.sync = "pull";                       // 로컬 work.mjs 가 쓰는 키(우리가 지우면 안 되는 남의 키)
    fs.writeFileSync(markerFile, JSON.stringify(m0, null, 2));
    const r = await provisionProjectRepos(PID, FOLDER, [GOOD], { clone: true, memberId: null, failOpen: true });
    assert.equal(r.failed.length, 0);
    const m = marker();
    assert.ok(!("repos_failed" in m), "성공했는데 낡은 실패 기록이 남았다");
    assert.equal(m.sync, "pull", "다른 writer 의 마커 키를 지웠다");
    assert.equal(repoStatusNotice(projDir), null, "복구된 뒤에도 통지가 뜬다");
    ok("S5 성공하면 경고 소멸 + 남의 마커 키 보존");
  }

  // ── S6 — 입력 검증은 failOpen 이어도 던진다(환경 문제가 아니라 호출자 버그) ──
  {
    await assert.rejects(
      () => provisionProjectRepos(PID, FOLDER, [{ name: "a/b" }], { failOpen: true }),
      (e: unknown) => e instanceof Error,
      "레포명 형식 오류는 failOpen 이어도 throw 여야 한다",
    );
    await assert.rejects(
      () => provisionProjectRepos(PID, FOLDER, [{ name: "x", worktree: true, branch: "bad branch" }], { failOpen: true }),
      (e: unknown) => e instanceof Error,
      "브랜치명 형식 오류는 failOpen 이어도 throw 여야 한다",
    );
    ok("S6 입력 검증은 failOpen 과 무관하게 거부");
  }

  // ── S7 — 사유별로 복구 안내가 갈린다 ──
  {
    const r = await provisionProjectRepos(PID, FOLDER, [BAD], { clone: true, memberId: null, failOpen: true });
    assert.match(r.failed[0].hint ?? "", /레포\(git\) 관리/, "미등록 실패엔 레포 등록 안내가 나와야 한다");
    assert.match(r.failed[0].hint ?? "", /lively repo worktree/, "복구 명령이 안내에 없다");
    ok("S7 사유 분류 — 미등록이면 레포 등록 경로를 가리킨다");
  }

  console.log(`\n${pass} passed`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
