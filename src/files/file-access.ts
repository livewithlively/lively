// 파일 주소의 권한 판정(#4673) — 누가(사람 · 사람의 AI · 앱) 어떤 주소를 읽거나 쓸 수 있나. 판정은 순수(deps 주입) · 살아 있는 의존은 liveFileAccessDeps.
//
// ── 권한표(#4671 ③ 확정 — 지식 file-address-scheme-design-4670 §10 · 상민님 2026-10-15 «추천안으로») ─────────────────
//  | 누가 · 어떤 길로                                       | shared/…                                   | apps/<앱>/…                                 |
//  | 사람 · 사람의 AI(쿠키 · 구성원 토큰)                   | 탐색기 판정 그대로(sharedFolderGate) 읽기·쓰기 | 그 앱에 동의한 구성원이 **읽기만**            |
//  | 앱 주체(앱 화면 다리 · 앱 서버 토큰+신원 · 앱 세션 토큰) | 없음(프로젝트 파일 읽기는 lively.files 그대로)  | **제 앱 폴더만** 읽기·쓰기(선언 app_folder + 동의) |
//  · 웹(사람)에서 앱 폴더에 직접 쓰는 길은 두지 않는다 — 앱 폴더는 그 앱이 쓴다. 세션 셸은 그 앱이 붙은 세션의 `.lively/apps/<앱>/` 로 쓴다(#4684).
//  · 앱 자체 주체(사람 없는 자동화, 앱 v2-12)는 아직 없다 — 앱 주체는 늘 «그 구성원 ∩ 그 사람의 앱 동의» 다.
//  · 관리자도 우회하지 않는다(v2 정책 — 링크 · MCP 의 sharedFolderGate 와 같은 자세). 앱 폴더도 관리자라서 열리지 않는다.
//
// ── 같은 판정을 두 번 탄다 ───────────────────────────────────────────────────────────────────
//  ① 서명 주소를 줄 때(capabilities/files.ts file_url) ② 그 주소를 쓸 때(files/signed-routes.ts). ② 가 다시 보는 까닭: 주소의 수명
//   (최대 60분) 동안 동의 철회 · 앱 끄기 · 공개범위 변경 · 구성원 비활성이 생길 수 있다 — 서명은 «누가 · 어디를 · 언제까지» 의 증명일 뿐이다.
import { HttpError } from "../http-error.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import { canSeeApp } from "../apps/visibility.js";
import { needsRegrant, toolAllowed } from "../apps/grant.js";
import { FILE_URL_TOOL } from "../apps/manifest.js";
import { appOfAddress, formatAddress, type FileAddress } from "./address.js";

export type FileOp = "read" | "write";

/** 판정 주체. app 이 있으면 앱 주체(그 구성원 ∩ 그 앱 동의), 없으면 사람(과 그 사람의 AI). */
export interface FilePrincipal { member: string; scopes: readonly string[]; app?: string | null }

export interface FileAccessDeps {
  getApp(appId: string): Promise<OrgApp | null>;
  /** #4667 이 사람이 보는 판(공개 앱에 남의 초안이 있으면 공개 판의 선언). 없으면 설치된 상태 그대로. */
  viewFor?(app: OrgApp, member: string, scopes: readonly string[]): Promise<OrgApp>;
  getGrant(appId: string, member: string): Promise<AppGrantRow | null>;
  /** 이 사람의 공유 자리 판정기(sharedFolderGate) — 공유 자리 기준 상대경로를 볼 수 있나. 판정 불가면 던진다(fail-closed). */
  sharedGate(member: string): Promise<{ ok(rel: string): boolean }>;
}

/** 매니페스트가 앱 폴더(permissions.app_folder)를 선언했나 — 권한표의 «앱 선언». 도구 이름(file_url)만 적은 것은 선언이 아니다. */
export function declaresAppFolder(manifest: unknown): boolean {
  return (manifest as { permissions?: { app_folder?: unknown } } | null)?.permissions?.app_folder === true;
}

/**
 * 같은 이름의 유니코드 꼴들(그대로 · NFC · NFD). 판정은 이 꼴 **전부**에 건다 — 잠금 경로는 한 꼴로 적혀 있는데, 파일 시스템에 따라
 *  다른 꼴의 이름이 같은 폴더로 열리고(정규화를 무시하는 파일 시스템) 새로 만드는 이름은 NFC 로 맞춰지기 때문이다(#1278b).
 */
export function unicodeForms(rel: string): string[] {
  return [...new Set([rel, rel.normalize("NFC"), rel.normalize("NFD")])];
}

const notFound = (): HttpError => new HttpError(404, "경로를 찾을 수 없습니다");

/** 매니페스트가 선언한 도구 전부(tools + ext_tools) — app-tool-call.ts 의 needsRegrant 입력과 같은 모양. */
function declaredTools(app: OrgApp): string[] {
  const p = (app.manifest as { permissions?: { tools?: unknown; ext_tools?: unknown } } | null)?.permissions;
  return [...(Array.isArray(p?.tools) ? p.tools : []), ...(Array.isArray(p?.ext_tools) ? p.ext_tools : [])].map(String);
}

/** 앱이 있고 · 이 사람에게 보이고 · 쓸 수 있는 상태인가 — 없거나 안 보이면 404(존재 은닉), 꺼졌으면 409. */
async function usableApp(appId: string, p: FilePrincipal, deps: FileAccessDeps): Promise<OrgApp> {
  const installed = await deps.getApp(appId);
  if (!installed || !canSeeApp(installed, { userId: p.member, scopes: p.scopes })) throw notFound();
  if (installed.status !== "active" || !installed.enabled) throw new HttpError(409, `앱 '${appId}' 이(가) 꺼져 있어 앱 폴더를 쓸 수 없습니다`);
  return deps.viewFor ? deps.viewFor(installed, p.member, p.scopes) : installed;
}

/**
 * 이 주체가 이 주소를 읽거나(read) 쓸(write) 수 있나 — 안 되면 HttpError(404 존재 은닉 · 403 까닭 · 409 앱 꺼짐).
 *  주소가 파일인지 폴더인지는 여기서 보지 않는다(파일 시스템을 보는 쪽 몫). write 의 «파일 경로여야 한다» 는 assertWritableTarget.
 */
export async function authorizeFileAccess(p: FilePrincipal, a: FileAddress, op: FileOp, deps: FileAccessDeps): Promise<void> {
  if (!p.member) throw new HttpError(401, "인증이 필요합니다");
  const app = appOfAddress(a);

  // ── 앱 주체 — 제 앱 폴더만 ────────────────────────────────────────────────────────────
  if (p.app) {
    if (a.root !== "apps" || !app || app.app !== p.app) {
      throw new HttpError(403, `앱은 제 앱 폴더(apps/${p.app}/…)만 다룰 수 있습니다 — ${formatAddress(a)} 은(는) 그 밖입니다`);
    }
    const view = await usableApp(p.app, p, deps);
    const declared = declaredTools(view);
    if (!declaresAppFolder(view.manifest) || !toolAllowed(declared, FILE_URL_TOOL)) {
      throw new HttpError(403, `앱 '${p.app}' 은(는) 앱 폴더(permissions.app_folder)를 선언하지 않았습니다 — 매니페스트에 "app_folder": true 를 적고 다시 저장하세요`);
    }
    const grant = await deps.getGrant(p.app, p.member);
    if (!grant) throw new HttpError(403, `앱 '${p.app}' 사용 동의(grant)가 없습니다`);
    if (needsRegrant(grant.tools, declared, FILE_URL_TOOL) || !toolAllowed(grant.tools, FILE_URL_TOOL)) {
      throw new HttpError(403, `앱 '${p.app}' 의 사용 동의가 예전 범위라 앱 폴더를 쓸 수 없습니다 — 다시 동의(grant)하면 됩니다`);
    }
    return;
  }

  // ── 사람 · 사람의 AI ───────────────────────────────────────────────────────────────────
  if (a.root === "shared") {
    const gate = await deps.sharedGate(p.member);
    if (!unicodeForms(a.rel).every((form) => gate.ok(form))) throw notFound();
    return;
  }
  //  앱 폴더: 그 앱에 동의한 구성원만 · 읽기만. 맨 위(`apps`)는 목록 자리라 읽기는 통과(목록은 부르는 쪽이 동의한 앱만 남긴다).
  if (op === "write") throw new HttpError(403, "앱 폴더는 그 앱이 씁니다 — 사람과 AI 는 보고 내려받기만 할 수 있습니다(세션에서는 앱을 붙여 .lively/apps/<앱>/ 에서 고칩니다)");
  if (!app) return;
  await usableApp(app.app, p, deps);
  if (!(await deps.getGrant(app.app, p.member))) {
    throw new HttpError(403, `앱 '${app.app}' 에 동의하지 않아 그 앱 폴더를 볼 수 없습니다 — 앱을 열어 동의하면 볼 수 있습니다`);
  }
}

/** 쓰기(PUT) 대상은 파일 경로여야 한다 — 자리 자신 · 앱 폴더 자신은 안 된다. 순수. */
export function assertWritableTarget(a: FileAddress): void {
  const app = appOfAddress(a);
  if (a.root === "shared" ? !a.rel : !app || !app.rest) {
    throw new HttpError(400, `${formatAddress(a)} 은(는) 파일 경로가 아닙니다 — 올릴 파일 이름까지 적어 주세요`);
  }
}

/**
 * 홈 탐색기 root=apps 목록용 — 이 사람이 읽을 수 있는 앱 폴더(앱 id) 집합. 앱이 보이고 · 쓸 수 있는 상태이고 · 동의가 있는 것만.
 *  목록 한 번에 한 번 만든다(항목마다 DB 를 때리지 않게 — sharedFolderGate 와 같은 자세).
 */
export function readableAppFolders(p: FilePrincipal, apps: readonly OrgApp[], grants: readonly AppGrantRow[]): Set<string> {
  const granted = new Set(grants.filter((g) => !g.revoked_at).map((g) => g.app_id));
  const out = new Set<string>();
  for (const app of apps) {
    if (!granted.has(app.id) || app.status !== "active" || !app.enabled) continue;
    if (!canSeeApp(app, { userId: p.member, scopes: p.scopes })) continue;
    out.add(app.id);
  }
  return out;
}
