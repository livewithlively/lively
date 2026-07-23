// 미리보기 준비 — 작업 폴더(워크트리) 확보 + 빌드 실행 (#1036).
//  '띄우기' 한 번으로 끝나게 만드는 부분이다: 사람이 터미널을 열어 워크트리를 만들거나 빌드를 돌릴 필요가 없다.
//  ⚠ clone/worktree + 빌드는 수십 초~수 분이라 **요청 안에서 하면 안 된다**(#600 에서 동기 provision 이 프록시
//   타임아웃으로 504 를 낸 전례). 호출부(preview-envs.ensurePreviewEnv)가 status='preparing' 을 먼저 쓰고
//   이 함수들을 백그라운드로 돌린다.
import { spawn } from "node:child_process";
import { provisionProjectRepos } from "../project-provision.js";
import { createProjectFolder } from "../project-fs.js";
import { getProject, setProjectFolder } from "../v6/project-store.js";

const BUILD_TIMEOUT_MS = 900_000; // 15분 — 첫 빌드는 의존성 설치를 동반할 수 있다

// 작업 폴더(워크트리) 확보 — 프로젝트 폴더가 없으면 만들고, 레포를 clone→worktree 한다(멱등: 이미 있으면 그 경로).
//  provisionProjectRepos 를 그대로 재사용하므로 '내 컴퓨터에서 작업'·세션 provision 과 **같은 자리**에 수렴한다.
export async function ensureProjectWorktree(projectId: number, repo: string, memberId?: string | null): Promise<string> {
  const proj = await getProject(projectId);
  if (!proj) throw new Error(`프로젝트 #${projectId} 를 찾을 수 없습니다`);
  let folder = proj.folder;
  if (!folder) {
    folder = await createProjectFolder(projectId);
    await setProjectFolder(projectId, folder, { source: "web" }).catch(() => { /* 폴더 자체는 이미 만들어졌다 */ });
  }
  const provisioned = await provisionProjectRepos(projectId, folder, [{ name: repo, worktree: true }], { memberId: memberId ?? null });
  const mine = provisioned.find((r) => r.name === repo);
  if (!mine?.cwd) throw new Error(`‘${repo}’ 작업 폴더를 준비하지 못했습니다`);
  return mine.cwd;
}

// 빌드 실행 — 스택 프로필의 build_cmd(예: `npm run build:web`). 실패해도 throw 하지 않고 결과로 돌려준다
//  (호출부가 상태·안내문으로 바꿔 보여준다). 출력은 꼬리 2000자만 — 화면에 원문 로그를 쏟지 않기 위해.
export function runBuild(cwd: string, cmd: string, timeoutMs = BUILD_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false;
    const fin = (r: { ok: boolean; out: string }): void => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
      fin({ ok: false, out: (out + `\n(빌드가 ${Math.round(timeoutMs / 1000)}초를 넘겨 중단했습니다)`).slice(-2000) });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); fin({ ok: false, out: (out + "\n" + e.message).slice(-2000) }); });
    child.on("close", (code) => { clearTimeout(timer); fin({ ok: code === 0, out: out.slice(-2000) }); });
  });
}

// 빌드 실패 안내 — 로그 원문 대신 마지막 의미 있는 줄들만 추려 사람이 읽을 한 문장으로.
export function buildFailureHint(out: string): string {
  const lines = String(out || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(" / ");
  return tail ? `빌드에 실패했습니다 — ${tail.slice(0, 300)}` : "빌드에 실패했습니다";
}
