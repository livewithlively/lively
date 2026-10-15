// app_save {dir} · app_pull {dir} 의 «어느 폴더인가» 판정(#4481 앱 v2-2) — 요청한 사람의 **자기 세션**이 속한 프로젝트의 공유 폴더 안만.
//
//  세 겹을 매번 본다: ① 요청이 말한 세션(x-lively-session)이 이 사람의 세션 ② 그 세션이 프로젝트에 붙어 있음 ③ 이 사람이 그 프로젝트를 볼 수 있음.
//   그다음 경로: 상대경로는 프로젝트 폴더 기준, 절대경로는 프로젝트 폴더 안이어야 한다(세션 안에서 보이는 경로를 그대로 줘도 된다).
//   `..`·폴더 밖은 400, 심링크로 밖을 가리키는 자리는 저장소 관문(confined)이 막는다.
//  파일 op 는 프로젝트 저장소(project-storage)가 고르는 자리 — 매니지드는 그 사람의 멤버 경계(테넌트 파일 op 중계), 자가호스팅은 게이트웨이 로컬.
import path from "node:path";
import { HttpError } from "./rest-util.js";
import type { DirAccess } from "../apps/app-bundle-source.js";
import { sessionOwnerOf } from "../apps/session-apps.js";

export async function sessionDirAccess(ctx: { session?: string } | undefined, member: string, dir: unknown): Promise<{ acc: DirAccess; shown: string; projectId: number }> {
  const raw = String(dir ?? "").trim();
  if (!raw) throw new HttpError(400, "dir 가 비었습니다 — 앱 폴더(lively-app.json 이 있는 곳)를 프로젝트 폴더 기준 경로로 주세요");
  if (raw.length > 1024 || raw.includes("\0") || raw.includes("\\")) throw new HttpError(400, "dir 경로가 틀렸습니다");
  const sid = String(ctx?.session ?? "").trim();
  if (!sid) throw new HttpError(400, "dir 는 세션 안에서만 쓸 수 있습니다(어느 세션의 폴더인지 알 수 없습니다) — 세션의 AI 가 부르거나 files 로 올리세요");
  const owner = await sessionOwnerOf(sid).catch(() => null);
  if (!owner || owner !== member) throw new HttpError(403, "dir 는 자기 세션의 프로젝트 폴더에서만 쓸 수 있습니다");
  const { latestProjectForSession } = await import("../v6/project-session-store.js");
  const project = await latestProjectForSession(sid);
  if (!project) throw new HttpError(400, "이 세션은 프로젝트에 붙어 있지 않아 폴더를 읽을 수 없습니다 — 프로젝트 세션에서 만들거나 files 로 올리세요");
  const { canSeeProjectRow, effectiveViewer } = await import("../v6/visibility.js");
  const viewer = await effectiveViewer(member);
  if (viewer !== null && !(await canSeeProjectRow(project.id, viewer))) throw new HttpError(403, "이 프로젝트를 볼 수 없습니다");
  const { projectStorage } = await import("../project/project-storage.js");
  const store = await projectStorage(project.folder, { memberId: member }, null);
  const base = path.resolve(store.base);
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  if (abs === base) throw new HttpError(400, "프로젝트 폴더 전체는 앱 폴더로 쓸 수 없습니다 — 그 아래 앱 폴더를 주세요");
  if (!abs.startsWith(base + path.sep)) {
    throw new HttpError(400, `dir 는 이 세션의 프로젝트 폴더 안이어야 합니다(${base}) — 프로젝트 폴더 기준 상대경로로 주세요`);
  }
  if (!(await store.confined(abs))) throw new HttpError(400, "dir 가 허용 경로를 벗어났습니다(심링크로 폴더 밖을 가리킵니다)");
  return { acc: { base: abs, osUser: store.osUser }, shown: path.relative(base, abs) || ".", projectId: project.id };
}
