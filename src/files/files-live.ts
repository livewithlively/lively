// 파일 주소(#4673)의 살아 있는 배관 — 앱 저장소 · 이 사람이 보는 판 · 공유 폴더 공개범위 · 구성원 · 서명 키 · 게이트웨이 주소 · 업로드 마무리.
//  판정 규칙은 files/file-access.ts, 발급은 files/file-url.ts, 받는 곳은 files/signed-routes.ts 한 벌씩이고 여기는 그 셋에 꽂는 것뿐이다
//  (서명 주소를 줄 때와 쓸 때가 같은 배관을 탄다 — 시험은 같은 함수에 가짜 배관을 꽂는다).
import type { FileAccessDeps, FilePrincipal } from "./file-access.js";
import { readableAppFolders } from "./file-access.js";
import type { MintFileUrlDeps } from "./file-url.js";
import type { SignedRouteDeps } from "./signed-routes.js";
import { fileUrlKey } from "./file-url-token.js";
import { getApp, getAppsByIds, getActiveGrant, listActiveGrants } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { registryModeActive } from "../org/tenancy/state.js";
import { viewAppFor } from "../apps/app-view.js";
import { sharedFolderGate } from "../v6/shared-folder-store.js";
import { boundTenantId } from "../db/client.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";
import { gatewayUrl } from "../gateway-url.js";
import { tenantSlug } from "../terminal/catalog.js";
import { localRootForBrowse } from "../ingest/local-file.js";
import { finishUpload } from "../ingest/upload-finish.js";
import { logger } from "../log.js";

/** 이 요청의 워크스페이스 id — 서명 주소에 굽고(file_url) 받을 때 대조하는(files/signed-routes) 같은 자. 단일 테넌트는 고정 id. */
export function fileUrlTenantId(): string {
  return boundTenantId() ?? SINGLE_TENANT_ID;
}

export const liveFileAccessDeps: FileAccessDeps = {
  getApp,
  getGrant: getActiveGrant,
  viewFor: async (app, member, scopes) => (await viewAppFor(app, { userId: member, scopes: [...scopes] })).app,
  //  공유 폴더 공개범위 — 링크 · MCP · 탐색기와 같은 판정(sharedFolderGate). 판정 불가(DB 장애)면 던진다(fail-closed).
  sharedGate: (member) => sharedFolderGate(member),
};

/** 이 사람이 읽을 수 있는 앱 폴더(앱 id) — 홈 탐색기 root=apps 목록 한 번에 한 번. 동의한 앱만 읽는다(앱 전부를 훑지 않는다). */
export async function readableAppFoldersFor(p: FilePrincipal): Promise<Set<string>> {
  const grants = await listActiveGrants(p.member);
  if (!grants.length) return new Set();
  return readableAppFolders(p, await getAppsByIds(grants.map((g) => g.app_id)), grants);
}

export const liveMintDeps: MintFileUrlDeps = {
  access: liveFileAccessDeps,
  key: () => fileUrlKey(),
  tenantId: fileUrlTenantId,
  base: () => gatewayUrl(),
  //  셀프호스트 다중 워크스페이스(registry)만 — 받는 쪽의 테넌트 미들웨어가 lvly_ws 쿼리로 워크스페이스를 연다. 매니지드는 주소(Host)가 정한다.
  workspaceSlug: () => (registryModeActive() ? tenantSlug() : null),
};

export const liveSignedRouteDeps: SignedRouteDeps = {
  key: () => fileUrlKey(),
  tenantId: fileUrlTenantId,
  activeMember: async (id) => {
    const m = await getMember(id);
    if (!m || m.state !== "active" || !(await workspaceAccessAllowed(m.id))) return null;
    return { id: m.id, email: m.email ?? "", scopes: m.scopes };
  },
  access: liveFileAccessDeps,
  //  공유 · 프로젝트 파일 — 다른 업로드 입구와 같은 마무리(ingest/upload-finish). 공유 루트 아래 project/<id>/… 는 프로젝트 좌표로 접힌다.
  finishShared: async ({ user, base, abs, osUser, entry }) => {
    const coord = await localRootForBrowse("shared", user, base, abs)
      .catch((e) => { logger.warn({ err: e, abs }, "[file-url] 좌표 해석 실패"); return null; });
    const fin = await finishUpload({ coord, abs, osUser, uploader: { id: user.userId, name: user.email || null }, entry });
    return {
      ...(fin.size !== undefined ? { size: fin.size } : {}), ...(fin.mtime !== undefined ? { mtime: fin.mtime } : {}),
      ...(fin.ref ? { ref: fin.ref } : {}), ...(fin.source_id ? { source_id: fin.source_id } : {}), ...(fin.skipped ? { skipped: fin.skipped } : {}),
    };
  },
};
