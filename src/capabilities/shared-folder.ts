// 공유폴더 공개범위 capability(#1291 v2 · 트랙 C) — 공유 워크스페이스 폴더 1개의 열람 대상 조회·설정.
//  REST /api/ui/terminal/browse/acl (폴더 브라우저의 '공개범위' 모달) + MCP(같은 handler).
//  ⚠ 왜 MCP 에도 여는가: 이 프로젝트의 제1원칙이 "사람과 그 사람의 AI 에 **동시에** 같은 권한"이다(원문 R1).
//   리스트·스페이스의 공개범위도 MCP 로 열려 있고(project_list_update_v6·project_folder_update_v6), 게이트가
//   '지금 그 폴더가 보이는 사람'으로 동일하므로 표면을 갈라 둘 이유가 없다.
//
//  집행(안 보이는 폴더를 목록·다운로드·업로드에서 막는 것)은 여기가 아니라 파일 라우트(terminal-files.ts)가 한다 —
//  술어는 v6/shared-folder-store.ts 한 곳에만 있고 두 표면이 그걸 공유한다.
import { z } from "zod";
import { activeMemberIdsAmong } from "../org/store/members.js";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  getSharedFolderAcl, setSharedFolderAcl, listSharedFolderAcls,
  normalizeSharedPath, isProjectManagedPath, pathAudience,
} from "../v6/shared-folder-store.js";

// 공유 루트만 대상 — 'personal' 루트는 멤버별로 갈린 폴더라 잠글 대상 자체가 없다.
const SHARED_ROOT_KEY = "shared";
function parseRoot(v: unknown): string {
  const root = String(v ?? SHARED_ROOT_KEY).trim() || SHARED_ROOT_KEY;
  if (root !== SHARED_ROOT_KEY) throw new HttpError(400, "공유 워크스페이스 폴더만 공개범위를 설정할 수 있습니다");
  return root;
}
function parsePath(v: unknown): string {
  const p = normalizeSharedPath(String(v ?? ""));
  if (!p) throw new HttpError(400, "대상 폴더 경로가 필요합니다");
  if (p.length > 1024) throw new HttpError(400, "경로가 너무 깁니다");
  return p;
}

/**
 * 설정 권한 = **지금 그 폴더가 보이는 사람**.
 *  이게 없으면 남의 잠긴 폴더를 대상만 갈아 끼워 통째로 뺏을 수 있다(리스트에서 잡았던 '잠금 탈취'와 같은 구멍 —
 *  lists-v6.assertListVisible 참고). 거부는 404 로 통일한다(403 은 존재를 누설한다).
 */
async function assertPathVisible(path: string, ctx: any): Promise<void> {
  const viewer = ctx?.viewer ?? null;
  if (viewer === null) return;                       // 내부 시스템 경로(특권)
  if (!(await pathAudience(path, viewer))) throw new HttpError(404, "경로를 찾을 수 없습니다");
}

/**
 * 대상(audience) 검증 — lists-v6.assertGrantSubjectsValid 와 **같은 규칙**을 쓴다(화면마다 규칙이 다르면 안 된다).
 *  ①실재하지 않는 id(오타)로 잠그면 아무도 못 보는 폴더가 된다 ②빈 대상도 마찬가지 ③잠그는 사람이 스스로 빠지면
 *  자기가 만든 걸 자기가 못 열고, 되돌릴 방법은 관리자의 긴급 열람뿐이다.
 */
async function assertGrantSubjectsValid(members: string[], visibility: string, ctx: any): Promise<void> {
  if (visibility !== "members") return;
  const ids = [...new Set((members || []).map((m) => String(m).trim()).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, "공개 대상을 한 명 이상 지정하세요 — 비우면 관리자 외에는 아무도 볼 수 없습니다");
  const found = await activeMemberIdsAmong(ids);
  const missing = ids.filter((m) => !found.includes(m));
  if (missing.length) throw new HttpError(400, `구성원이 아닌 대상입니다: ${missing.join(", ")}`);
  const me = ctx?.viewer ?? null;
  if (me !== null && !ids.includes(String(me))) {
    throw new HttpError(400, "본인을 대상에서 빼면 이 폴더를 다시 열 수 없습니다 — 본인을 포함해 주세요(관리자는 예외)");
  }
}

const sharedFolderAclGet: Capability = {
  name: "shared_folder_acl_get",
  title: "공유폴더 공개범위 조회",
  description: "공유 워크스페이스 폴더 1개의 공개범위(open|members)·대상 명단·상위 폴더에서 상속된 잠금을 돌려준다. path 를 생략하면 이 사람에게 보이는 잠긴 폴더 목록만 준다(브라우저 🔒 배지용).",
  scope: "memory",
  mutates: false,
  input: { root: z.string().optional(), path: z.string().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/terminal/browse/acl"],
      parse: (req) => ({ root: parseRoot(req.query?.root), path: String(req.query?.path ?? "") }) }],
  },
  handler: async (input: any, _user: any, ctx: any) => {
    const viewer = ctx?.viewer ?? null;
    // path 없음 = 목록 모드(잠긴 폴더 전체). 브라우저가 배지를 그리기 위한 것이라 보이는 것만 준다.
    if (!String(input.path ?? "").trim()) return { acls: await listSharedFolderAcls(viewer) };
    const path = parsePath(input.path);
    await assertPathVisible(path, ctx);
    const acl = await getSharedFolderAcl(path);
    // settable — 프로젝트 폴더는 그 프로젝트의 공개범위를 그대로 따르므로 여기선 못 고친다(두 곳에서 잠그면
    //  어느 쪽이 이겼는지 아무도 모른다). 프론트는 이걸로 폼을 잠그고 안내 문구를 띄운다.
    return { ...acl, settable: !acl.project_managed };
  },
};

const sharedFolderAclSet: Capability = {
  name: "shared_folder_acl_set",
  title: "공유폴더 공개범위 설정",
  description: "공유 워크스페이스 폴더 1개의 공개범위와 대상을 통째로 교체한다. visibility='members' 면 members 에 지정한 구성원만 그 폴더와 하위 전체(파일 목록·다운로드·업로드)를 볼 수 있다. 상위 폴더가 잠겨 있으면 하위는 더 좁힐 수만 있고 넓힐 수 없다. project/<id> 하위는 프로젝트 공개범위를 상속하므로 설정할 수 없다.",
  scope: "memory",
  input: {
    root: z.string().optional(),
    path: z.string().min(1),
    visibility: z.enum(["open", "members"]),
    members: z.array(z.string()).max(500).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/browse/acl"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          root: parseRoot(req.query?.root ?? b.root),
          path: parsePath(req.query?.path ?? b.path),
          visibility: String(b.visibility) === "members" ? "members" : "open",
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : [],
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const path = parsePath(input.path);
    if (isProjectManagedPath(path)) {
      throw new HttpError(400, "프로젝트 폴더는 해당 프로젝트의 공개범위를 그대로 따릅니다 — 프로젝트에서 설정하세요");
    }
    await assertPathVisible(path, ctx);
    const members = input.visibility === "members" ? (input.members ?? []) : [];
    await assertGrantSubjectsValid(members, input.visibility, ctx);
    const acl = await setSharedFolderAcl(path, input.visibility, members,
      { actor: ctx?.actor ?? user?.userId ?? null });
    return { ...acl, settable: true };
  },
};

export const sharedFolderCapabilities: Capability[] = [sharedFolderAclGet, sharedFolderAclSet];
