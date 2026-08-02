// delivery ▸ workspace — 워크스페이스 사용량 조회 + 폴더 단위 일괄 분석/정리(#813 T3-2).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { listSessions } from "../../terminal/terminal-sessions.js";
// 워크스페이스 사용량(#813 T3-2 백스톱) — 프로젝트별로 얼마나 쌓였나. 회수 실행은 workspace_reclaim 이 한다.
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE, PROJECT_SUBDIR, LEGACY_SUBDIR, projectAbsPath } from "../../project/project-fs.js";
import { dirSizesFast, isInside, reposIn, planReclaim, applyReclaim, baseRepoOf } from "../../ops/workspace-reclaim.js";
import { itemsPool } from "../../db/client.js";
import { restOnly } from "./shared.js";

// 워크스페이스에서 **주소의 단위는 폴더다 — 프로젝트 id 가 아니다.**
//
//  ⚠ 이걸 id 로 잡으면 두 부류가 통째로 사라진다(#845 에서 실제로 겪음):
//   ① **이름 기반 폴더**(2026-06-25 이전 규칙): `project/라이블리 웹사이트 빌드-4` 처럼 폴더명이 **프로젝트 이름**이다.
//      dev 박스에 74개(136MB) 있고 그중 **12개는 지금도 살아있는 프로젝트**다. 폴더명이 숫자가 아니라는 이유로
//      DB 조회를 건너뛰면 **살아있는 프로젝트를 '고아'로 오분류**하고, id 로 주소를 잡는 API 는 아예 못 건드린다.
//   ② **고아 폴더**: 프로젝트를 지워도 폴더는 안 지워진다. id 로 DB 를 먼저 조회하는 API 는 404 로 죽는다.
//
//  → 폴더(`project/<x>` · `legacy-project/<x>`)를 그대로 받고, **프로젝트는 폴더로 역조회**한다(있으면 라벨, 없으면 고아).
//  경로 안전은 projectAbsPath 가 강제한다(범위 이탈·`..` 탈출 차단). 여기에 **한 세그먼트**만 허용을 더 건다.
const FOLDER_RE = new RegExp(`^(?:${PROJECT_SUBDIR}|${LEGACY_SUBDIR})/[^/\\\\]+$`);

interface FolderProject { id: number; name: string; status: string | null }

// 폴더 → 프로젝트. **한 방 쿼리**다 — 예전엔 폴더마다 getV6Project 를 불러 300번씩 왕복했다(관리탭이 느렸던 이유).
async function projectsByFolder(): Promise<Map<string, FolderProject>> {
  const r = await itemsPool.query<{ id: number; name: string; status: string | null; folder: string }>(
    "SELECT id, name, status, folder FROM project WHERE folder IS NOT NULL");
  const m = new Map<string, FolderProject>();
  for (const row of r.rows) m.set(row.folder.replace(/^[/\\]+/, ""), { id: row.id, name: row.name, status: row.status });
  return m;
}

// 회수 대상 폴더 목록을 받아 계획(또는 적용)한다. analyze/reclaim 이 같은 코드를 쓰므로 **본 것과 지우는 것이 갈리지 않는다.**
async function planOrApply(
  folders: string[], user: LivelyUser, opts: { apply: boolean; removeWorktree: boolean },
): Promise<{ projects: unknown[]; total_reclaimable_bytes: number; total_freed_bytes: number }> {
  if (!Array.isArray(folders) || !folders.length) throw new HttpError(400, "folders 가 필요합니다");
  if (folders.length > 40) throw new HttpError(400, "한 번에 최대 40개까지 — 나눠서 호출하세요(오래 걸리면 프록시가 끊습니다)");
  for (const f of folders) {
    if (typeof f !== "string" || !FOLDER_RE.test(f)) {
      throw new HttpError(400, `잘못된 folder: ${String(f)} — '${PROJECT_SUBDIR}/<이름>' 또는 '${LEGACY_SUBDIR}/<이름>' 한 단계만 허용됩니다`);
    }
  }

  // 활성 세션 조회 실패 시 **회수를 중단**한다 — '활성 없음'으로 낙관하면 빌드 중인 워크트리를 깨뜨린다.
  //  (분석[dry-run]은 아무것도 안 지우므로 빈 목록으로 계속해도 안전하다.)
  let activeSessionDirs: string[] = [];
  try {
    activeSessionDirs = (await listSessions(user)).map((s) => s.dir).filter(Boolean) as string[];
  } catch {
    if (opts.apply) throw new HttpError(503, "세션 목록을 확인할 수 없어 정리를 중단합니다(작업 중인 세션을 덮어쓸 위험)");
  }

  const pmap = await projectsByFolder();
  const projects: unknown[] = [];
  let totalReclaimable = 0;
  let totalFreed = 0;
  for (const folder of folders) {
    const dir = projectAbsPath(folder); // 범위 이탈이면 여기서 400
    const p = pmap.get(folder) ?? null;
    const label = { folder, project_id: p?.id ?? null, name: p?.name ?? folder.split("/").pop(), orphan: !p, dir };
    if (!await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false)) {
      projects.push({ ...label, skipped: "워크스페이스 폴더가 없습니다" });
      continue;
    }
    const repos = await reposIn(dir);
    if (!repos.length) { projects.push({ ...label, repos: 0, reclaimable_bytes: 0, freed_bytes: 0, results: [] }); continue; }

    const results = [];
    let reclaimable = 0;
    let freed = 0;
    for (const wt of repos) {
      const plan = await planReclaim(wt, { activeSessionDirs });
      const applied = opts.apply
        ? await applyReclaim(plan, { removeWorktree: opts.removeWorktree, repoRoot: await baseRepoOf(wt) })
        : null;
      reclaimable += plan.reclaimableBytes;
      freed += applied?.freedBytes ?? 0;
      results.push({
        worktree: wt,
        reclaimable_bytes: plan.reclaimableBytes,
        derived: plan.entries.filter((e) => e.kind === "derived").map((e) => ({ path: e.rel, bytes: e.bytes })),
        active_session: plan.active_session,
        worktree_removable: plan.worktree_check.removable,
        worktree_reason: plan.worktree_check.reason,
        applied,
      });
    }
    totalReclaimable += reclaimable;
    totalFreed += freed;
    projects.push({ ...label, repos: repos.length, reclaimable_bytes: reclaimable, freed_bytes: freed, results });
  }
  return { projects, total_reclaimable_bytes: totalReclaimable, total_freed_bytes: totalFreed };
}

const FOLDERS_IN = z.array(z.string().min(1).max(300)).min(1).max(40)
  .describe("워크스페이스 폴더 (예 'project/845'·'legacy-project/612'·'project/라이블리 웹사이트 빌드-4'). 최대 40개 — GET /api/ui/org/workspace 의 folder 값을 그대로 쓴다");

const workspaceBatchCapabilities = (): Capability[] => [
  restOnly("org_workspace_analyze", "워크스페이스 일괄 분석(dry-run)",
    "주어진 폴더들의 정리 가능량을 한 번에 계산한다 — **아무것도 지우지 않는다.** " +
    "**프로젝트 id 가 아니라 폴더**로 지정하므로, DB 에서 삭제된 고아 폴더와 이름 기반 옛 폴더도 다룬다(프로젝트별 REST 는 404 로 죽는다). " +
    "⚠ 한 번에 최대 40개 — 더 많으면 나눠서 호출한다(du 가 오래 걸리면 프록시가 끊는다). admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/workspace/analyze"], parse: (req) => ({ ...(req.body ?? {}) }) }],
    async (input: { folders: string[] }, user: LivelyUser) =>
      ({ dry_run: true, ...await planOrApply(input.folders, user, { apply: false, removeWorktree: false }) }),
    { folders: FOLDERS_IN }),

  restOnly("org_workspace_reclaim", "워크스페이스 일괄 정리(파생물 삭제)",
    "주어진 폴더들에서 **재생성 가능한 파생물만** 실제로 지운다(node_modules·build·target·.gradle…). " +
    "소스·커밋·.env·data/ 는 절대 지우지 않고, 활성 세션이 붙어 있으면 그 폴더는 건너뛴다. " +
    "remove_worktree=true 여도 **푸시 완료 + 더티 없음**인 워크트리만 제거한다(아니면 이유를 남기고 유지). " +
    "고아 폴더·이름 기반 옛 폴더도 정리한다. ⚠ 한 번에 최대 40개. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/workspace/reclaim"], parse: (req) => ({ ...(req.body ?? {}) }) }],
    async (input: { folders: string[]; remove_worktree?: boolean }, user: LivelyUser) =>
      ({ dry_run: false, ...await planOrApply(input.folders, user, { apply: true, removeWorktree: !!input.remove_worktree }) }),
    {
      folders: FOLDERS_IN,
      remove_worktree: z.boolean().optional().describe("워크트리까지 제거(푸시 완료·클린일 때만 — 아니면 유지하고 이유를 남긴다)"),
    }),
];

export const workspaceCapabilities: Capability[] = [
  // ── 워크스페이스 사용량(#813 T3-2) — **백스톱**. ──
  //  close-out 루틴(project-closeout 스킬)이 회수를 하지만 그건 best-effort 다: 에이전트가 스텝을 건너뛰거나,
  //  사람이 웹 UI 에서 바로 done 처리하거나, 프로젝트가 방치되면 아무도 안 치운다 — 그리고 **쌓이는 건 바로 그런 것들**이다.
  //  그래서 관리자가 '무엇이 얼마나 쌓였나'를 보고 **수동으로** 회수할 창구가 필요하다.
  //  ⚠ 무인 자동 삭제는 **없다**(설계 결정) — 이 화면은 보여주기만 하고, 지우는 건 사람이 버튼을 눌러야 한다.
  //  회수 실행은 기존 workspace_reclaim(POST /api/ui/v6/projects/:id/reclaim) 을 그대로 쓴다(안전선 재구현 금지).
  restOnly("org_workspace_status", "워크스페이스 사용량",
    "프로젝트별 워크스페이스 폴더 크기·마지막 사용·활성 세션 여부. 정리 가능량은 프로젝트별 dry-run(POST /api/ui/v6/projects/:id/reclaim)으로 확인한다. admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/workspace"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      // 진행 중(project/) + 완료 보관(legacy-project/) 둘 다 — done 처리는 폴더를 **이동**할 뿐 지우지 않는다.
      const roots = [
        { kind: "active", sub: PROJECT_SUBDIR, dir: path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR) },
        { kind: "archived", sub: LEGACY_SUBDIR, dir: path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR) },
      ];
      let sessionDirs: string[] = [];
      try { sessionDirs = (await listSessions(user)).map((s) => s.dir).filter(Boolean); } catch { /* 세션 조회 실패 → 활성표시만 비움 */ }

      interface WsItem {
        folder: string; project_id: number | null; name: string; status: string | null; kind: string;
        dir: string; bytes: number | null; last_used: number; active_session: boolean;
        repos: number; orphan: boolean;
      }
      // 후보 디렉터리를 먼저 모아 **du 를 한 번만** 부른다(프로젝트가 수백 개라 개별 호출하면 페이지가 몇 초 멈춘다).
      const found: { dir: string; name: string; sub: string; kind: string; mtimeMs: number }[] = [];
      for (const root of roots) {
        for (const name of await fsp.readdir(root.dir).catch(() => [] as string[])) {
          const dir = path.join(root.dir, name);
          const st = await fsp.stat(dir).catch(() => null);
          if (!st?.isDirectory()) continue;
          found.push({ dir, name, sub: root.sub, kind: root.kind, mtimeMs: st.mtimeMs });
        }
      }
      const sizes = await dirSizesFast(found.map((f) => f.dir));
      // ⚠ 프로젝트는 **폴더로** 역조회한다(id 로 하지 않는다). 폴더명이 숫자라는 보장이 없다 — 2026-06-25 이전
      //  규칙은 폴더명이 **프로젝트 이름**이고(dev 박스 74개), 그중 12개는 지금도 살아있다. 숫자만 조회하면
      //  그 12개를 '고아'로 오분류하고 목록에서 놓친다. 한 방 쿼리라 폴더마다 왕복하던 것보다 빠르기도 하다.
      const pmap = await projectsByFolder();

      const items: WsItem[] = [];
      for (const f of found) {
        const folder = `${f.sub}/${f.name}`;
        const project = pmap.get(folder) ?? null;
        items.push({
          folder, // ← 회수 API 의 주소. project_id 는 라벨일 뿐이다(없을 수도 있다).
          project_id: project?.id ?? null,
          name: project?.name ?? f.name,
          status: project?.status ?? null,
          kind: f.kind,
          dir: f.dir,
          bytes: sizes.get(f.dir) ?? null,
          last_used: Math.round(f.mtimeMs / 1000), // 마지막으로 무언가 쓰인 시각(오래된 것부터 정리 판단)
          active_session: sessionDirs.some((d) => isInside(d, f.dir)),
          // ⚠ 아래 두 필드가 없으면 UI 가 **회수할 게 없는 폴더에도 [분석] 버튼**을 달고, 누르면 에러가 난다(#845).
          //  실측(dev 박스): 308개 중 191개가 레포 없는 껍데기. 목록의 다수가 '눌러봐야 에러'였다.
          repos: (await reposIn(f.dir)).length, // 0 = 회수할 파생물이 없다(정상 — provision 안 한 프로젝트)
          orphan: !project, // DB 에 프로젝트가 없다(삭제됨) — 폴더만 남았다. 폴더 기준 API 만이 이걸 회수할 수 있다.
        });
      }
      items.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
      const total = items.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
      return { root: PROJECT_SHARED_BASE, total_bytes: total, projects: items };
    }),

  // ── 워크스페이스 일괄 분석·회수 (#845) ─────────────────────────────────────────────
  //
  //  왜 프로젝트별 REST(POST /v6/projects/:id/reclaim) 로 안 되나 — 두 가지 때문이다:
  //   ① **고아 폴더.** 프로젝트를 지워도 워크스페이스 폴더는 안 지워진다. 그 REST 는 DB 프로젝트를 먼저 조회해
  //      404 로 죽으므로 **영영 회수할 수 없는 사각지대**가 된다(dev 박스 실측: 고아 57개, 그중 8개가 워크트리 보유).
  //      여기(admin)는 **폴더를 기준**으로 풀기 때문에 고아도 다룬다. 고아는 프로젝트 멤버십을 물을 수 없으니
  //      **admin scope 가 유일하게 옳은 자리**다(restOnly = admin).
  //   ② **일괄.** 8GB 가 어디 있는지 알려고 123번 클릭할 수는 없다.
  //
  //  ⚠ **한 요청에 전부 넣지 마라.** du 가 수 GB 를 훑느라 수십 초가 걸리면 프록시가 504 로 끊는다(#600 에서 겪음).
  //   그래서 이 API 는 **호출자가 준 id 목록만** 처리하고, 웹 UI 가 청크로 끊어 부르며 진행률을 보여준다.
  //   서버에 잡 상태를 두지 않으므로 중단·재시도가 그냥 된다.
  //
  //  안전선은 프로젝트별 회수와 **완전히 동일**하다(같은 planReclaim/applyReclaim 을 쓴다):
  //   gitignored ∩ 알려진 파생물만 · .env·data/·소스 보호 · 심링크 미회수 · 활성 세션이면 거부 ·
  //   워크트리 제거는 **푸시 완료 + 더티 없음**일 때만. 일괄이라고 안전선을 낮추지 않는다.
  ...workspaceBatchCapabilities(),
];
