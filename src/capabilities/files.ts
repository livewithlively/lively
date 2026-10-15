// 파일 주소 도구(#4673) — 주소 하나로 파일을 주고받고, 세션 안 경로와 주소를 서로 바꾼다.
//  · file_url     — 주소 → 짧은 수명 서명 주소(GET 받기 · PUT 올리기). 앱 서버(Lambda) · 앱 화면 · 세션 AI 가 같은 길을 쓴다.
//  · file_address — 세션 안 경로(또는 링크 · 자료 좌표 · 첨부 표시) → 주소 · 링크.
//  · file_path    — 주소 → 이 세션 안 경로(이 세션에서 파일로 안 보이면 까닭과 다음 할 일).
//  판정은 files/file-access.ts(권한표 #4671 ③), 주소 · 변환 규칙은 files/address.ts, 서명은 files/file-url-token.ts 한 벌씩이다.
//  세션 안 `lively file address|path|url` 은 이 REST 를 부르는 얇은 겉이다(kit/cli/lively.mjs).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { gatewayUrl } from "../gateway-url.js";
import {
  parseAddress, parseAddressInput, formatAddress, addressLinkHash, AddressError,
  sessionPathToAddress, addressToSessionPath, type FileAddress, type SessionView,
} from "../files/address.js";
import { clampTtl, type FileUrlMethod } from "../files/file-url-token.js";
import type { FilePrincipal } from "../files/file-access.js";
import { mintFileUrl } from "../files/file-url.js";
import { liveMintDeps, fileUrlTenantId } from "../files/files-live.js";

/** 서명 주소 발급 빈도 — (구성원, 앱) 마다 분당. 화면이 그림 수십 장을 한꺼번에 받는 일을 막지 않을 만큼 넉넉하게. */
export const FILE_URL_PER_MINUTE = 300;
const rate = new RateWindow(FILE_URL_PER_MINUTE);

const principalOf = (user: LivelyUser): FilePrincipal => ({ member: user.userId, scopes: user.scopes ?? [], app: user.appId ?? null });

/** 사람에게 줄 링크(#1436 · 웹 «자료 보기» 화면은 #4672). base 를 못 정하면 해시만. */
async function humanLink(a: FileAddress): Promise<string> {
  const base = await gatewayUrl();
  return (base ? `${base}/ui/` : "") + addressLinkHash(a);
}

/** «파일을 가리키는 글자»(주소 · 링크 · 자료 좌표 · 첨부 표시) → 주소. 자료 좌표 `project:<id>/…` 는 그 프로젝트 폴더로 편다(안 보이면 404). */
async function resolveAddressInput(raw: unknown, user: LivelyUser): Promise<FileAddress> {
  let inp: ReturnType<typeof parseAddressInput>;
  try { inp = parseAddressInput(raw); }
  catch (e) { throw new HttpError(400, e instanceof AddressError ? e.message : "주소가 올바르지 않습니다"); }
  if (inp.kind === "personal") throw new HttpError(400, "개인 폴더는 주소가 없습니다 — 남에게 건넬 수 없는 자리라서입니다");
  if (inp.kind === "address") return inp.address;
  const { getProjectRow } = await import("../v6/project-store.js");
  const { canSeeProjectRow, effectiveViewer } = await import("../v6/visibility.js");
  const row = await getProjectRow(inp.projectId);
  const viewer = await effectiveViewer(user.userId);
  if (!row?.folder || !(viewer === null || (await canSeeProjectRow(inp.projectId, viewer)))) throw new HttpError(404, "경로를 찾을 수 없습니다");
  try { return parseAddress(`shared/${row.folder}/${inp.rel}`); }
  catch (e) { throw new HttpError(400, e instanceof AddressError ? e.message : "주소가 올바르지 않습니다"); }
}

/**
 * 세션 → 변환에 쓰는 모습(files/address SessionView). 그 세션의 참가자(연 사람 · 초대받은 사람)만 — 아니면 404/403.
 *  자리(place): 사람 컴퓨터 노드면 node · 세션 컨테이너가 있는 배포(매니지드)면 container · 그 밖(셀프호스트)은 host.
 *  자리 기준 경로는 세션을 만들 때와 같은 함수(resolveRootPath · 그 세션 주인 · 그 세션의 uid)로 구한다 — 두 곳이 갈리지 않게.
 */
async function sessionViewOf(sessionId: string, user: LivelyUser): Promise<SessionView> {
  const { sessionOwnerOf, sessionCanEnter, listAttachedApps } = await import("../apps/session-apps.js");
  const owner0 = await sessionOwnerOf(sessionId);
  if (!owner0) throw new HttpError(404, `세션을 찾을 수 없습니다: ${sessionId}`);
  if (owner0 !== user.userId && !(await sessionCanEnter(sessionId, user.userId).catch(() => false))) {
    throw new HttpError(403, "이 세션에 들어갈 수 있는 사람(연 사람 · 초대받은 사람)만 그 세션의 경로를 바꿀 수 있습니다");
  }
  const { getSessionState } = await import("../sessions/session-state.js");
  const st = await getSessionState(sessionId);
  if (!st) throw new HttpError(404, "세션을 찾을 수 없습니다");
  const { isSelfNode, isSessionHostNode } = await import("../node/registry.js");
  const { sessionExecConfigured } = await import("../terminal/session-exec.js");
  const node = String(st.node_id ?? "").trim();
  const place: SessionView["place"] = node && !isSelfNode(node) && !isSessionHostNode(node) ? "node" : sessionExecConfigured() ? "container" : "host";
  const attachedApps = (await listAttachedApps(sessionId).catch(() => [])).map((r) => r.app_id);
  const dir = String(st.dir ?? "");
  if (place === "node") {
    const { latestProjectForSession } = await import("../v6/project-session-store.js");
    const proj = await latestProjectForSession(sessionId).catch(() => null);
    return { place, dir, projectId: proj?.id ?? st.project_id ?? null, attachedApps };
  }
  const { resolveRootPath, sessionOsUser } = await import("../terminal/profiles.js");
  const owner = { userId: st.owner, email: "", scopes: [], projects: [] } as unknown as LivelyUser;
  const osUser = await sessionOsUser(sessionId);
  //  컨테이너엔 앱 폴더 자리가 붙지 않는다(앱은 붙인 세션의 `.lively/apps/<앱>` 으로만 보인다 — #4684). 셀프호스트는 같은 파일 시스템이라 셋 다.
  const keys = place === "host" ? (["shared", "personal", "apps"] as const) : (["shared", "personal"] as const);
  const bases: NonNullable<SessionView["bases"]> = {};
  for (const key of keys) {
    try { bases[key] = (await resolveRootPath(owner, key, "", osUser)).base; } catch { /* 이 배포엔 그 자리가 없다 */ }
  }
  return { place, dir, bases, attachedApps };
}

const needSession = (ctx?: CapabilityCtx): string => {
  if (!ctx?.session) throw new HttpError(400, "세션 안 경로는 세션에서만 바꿀 수 있습니다 — 세션 안 AI(MCP)나 세션 안 `lively file` 에서 부르세요");
  return ctx.session;
};

/** 경로처럼 보이나(절대경로 · 윈도우 드라이브). 아니면 주소 · 링크 · 자료 좌표로 읽는다. */
const looksLikePath = (s: string): boolean => s.trim().startsWith("/") || /^[A-Za-z]:[\\/]/.test(s.trim());

// ── file_url ─────────────────────────────────────────────────────────────────────────────
const fileUrlInput = {
  address: z.string().min(1).max(2048).describe("파일 주소 — `shared/project/<번호>/<경로>` · `shared/<경로>` · `apps/<앱>/<경로>`. 링크(#/f?root=…) · 자료 좌표(project:<번호>/<경로>) · 첨부 표시([lively:…])도 받는다"),
  method: z.enum(["GET", "PUT"]).optional().describe("GET(기본) = 받기 · PUT = 올리기(통째 덮어쓰기 · 위 폴더 자동 생성)"),
  expires_in: z.number().int().optional().describe("수명(초) — 기본 900(15분) · 최대 3600"),
};
type FileUrlInput = z.infer<z.ZodObject<typeof fileUrlInput>>;

const fileUrl: Capability = {
  name: "file_url",
  title: "파일 서명 주소 받기",
  description: "주소 하나로 파일을 받고(GET) 올리는(PUT) 짧은 수명 서명 주소(기본 15분)를 준다 — 돌려준 url 에 쿠키 · 토큰 없이 그 method 로 요청하면 된다(curl -o / curl -T). "
    + "판정: 사람과 그 사람의 AI 는 공유 폴더(shared/…)를 탐색기와 같은 공개범위로 받고 올린다 · 앱 폴더(apps/<앱>/…)는 그 앱에 동의한 사람이 받기만 한다 · "
    + "앱(앱 화면 · 앱 서버 · 앱 세션)은 제 앱 폴더만 받고 올린다(매니페스트 permissions.app_folder + 그 사람의 동의). 주소는 그 사이에 권한이 바뀌면 바로 막힌다. "
    + "올린 공유 폴더 파일은 다른 업로드처럼 자료로 등록된다(앱 폴더 파일은 자료가 되지 않는다). 세션 안 경로 ↔ 주소는 file_address · file_path.",
  scope: null,
  //  주소를 «주는» 것만으로는 스토어가 안 바뀐다 — 받기 주소는 읽기전용 세션에서도 준다. 올리기 주소는 핸들러가 읽기전용이면 막는다.
  mutates: false,
  input: fileUrlInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/files/url"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { address: b.address, method: b.method, expires_in: b.expires_in };
      } }],
  },
  handler: async (input: FileUrlInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const method: FileUrlMethod = input.method === "PUT" ? "PUT" : "GET";
    const address = await resolveAddressInput(input.address, user);
    const p = principalOf(user);
    if (!rate.take(`${fileUrlTenantId()}\0${p.member}\0${p.app ?? "-"}`, Date.now())) {
      throw new HttpError(429, `서명 주소를 너무 자주 받고 있습니다(분당 ${FILE_URL_PER_MINUTE}개)`);
    }
    //  readOnly 는 «읽기전용 세션이라고 적혀 온 때만» 참 — 앱 화면 다리(app-tool-call)는 이 칸을 싣지 않는다(앱 화면의 올리기가 막히지 않게).
    //   읽기전용 머리글이 실린 REST · MCP 는 어댑터가 ctx.readOnly 를 채운다.
    const minted = await mintFileUrl({ address, method, ttlSec: clampTtl(input.expires_in), principal: p, readOnly: ctx?.readOnly === true }, liveMintDeps);
    return { ...minted, link: await humanLink(parseAddress(minted.address)) };   // 서명한 주소(올리기는 NFC 이름)로 — 저장되는 그 파일의 링크
  },
};

// ── file_address ─────────────────────────────────────────────────────────────────────────
const fileAddressInput = {
  path: z.string().min(1).max(4096).describe("세션 안 절대경로(예: /work/shared/project/4670/a.md). 링크 · 자료 좌표 · 첨부 표시도 받는다(그때는 세션이 없어도 된다)"),
};
type FileAddressInput = z.infer<z.ZodObject<typeof fileAddressInput>>;

const fileAddress: Capability = {
  name: "file_address",
  title: "세션 안 경로 → 파일 주소",
  description: "세션 안 경로를 파일 주소(shared/… · apps/<앱>/…)와 사람에게 줄 링크로 바꾼다. 매니지드는 `/work/` 를 떼면 주소이고, 세션에 붙인 앱 폴더 "
    + "`<작업 폴더>/.lively/apps/<앱>/x` 는 `apps/<앱>/x` 다. 개인 폴더 · 숨김(점으로 시작) 자리는 주소가 없다(까닭을 준다). 링크(#/f?…) · 자료 좌표(project:<번호>/<경로>) · "
    + "첨부 표시([lively:…])를 넣으면 같은 주소로 맞춰 준다.",
  scope: null,
  input: fileAddressInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/files/address"],
      parse: (req) => ({ path: (req.query as Record<string, unknown>).path }) }],
  },
  handler: async (input: FileAddressInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const raw = String(input.path ?? "");
    if (!looksLikePath(raw)) {
      const address = await resolveAddressInput(raw, user);
      return { input: raw, address: formatAddress(address), link: await humanLink(address) };
    }
    const session = needSession(ctx);
    const view = await sessionViewOf(session, user);
    const r = sessionPathToAddress(view, raw);
    if (!r.address) return { input: raw, session, address: null, reason: r.reason };
    return { input: raw, session, address: formatAddress(r.address), link: await humanLink(r.address) };
  },
};

// ── file_path ────────────────────────────────────────────────────────────────────────────
const filePathInput = {
  address: z.string().min(1).max(2048).describe("파일 주소(shared/… · apps/<앱>/…) · 링크 · 자료 좌표 · 첨부 표시"),
};
type FilePathInput = z.infer<z.ZodObject<typeof filePathInput>>;

const filePath: Capability = {
  name: "file_path",
  title: "파일 주소 → 이 세션 안 경로",
  description: "파일 주소를 이 세션에서 열 수 있는 경로로 바꾼다. 매니지드 세션엔 작업 폴더만 붙어 있어 그 밖의 주소는 «이 세션엔 없다»(까닭과 함께 — 그때는 file_url 로 받는다). "
    + "앱 폴더(apps/<앱>/…)는 그 앱이 이 세션에 붙어 있으면 `<작업 폴더>/.lively/apps/<앱>/…` 다. 파일을 열지 않고 글자만 바꾼다(세션 셸이 보는 범위 그대로).",
  scope: null,
  input: filePathInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/files/path"],
      parse: (req) => ({ address: (req.query as Record<string, unknown>).address }) }],
  },
  handler: async (input: FilePathInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const address = await resolveAddressInput(input.address, user);
    //  판정은 권한표의 «세션 셸» 줄이다(#4671 ③) — 셸은 작업 폴더 아래(세션을 열 때 #4687 이 판정)와 그 세션에 붙은 앱 폴더(붙이기 = 주인 + 동의 ·
    //   초대받은 사람도 본다)를 본다. 그 규칙은 변환(addressToSessionPath)이 그대로 진다 — 웹 · MCP 줄(그 사람의 동의)을 여기 걸면 붙은 앱 폴더를
    //   보는 초대받은 사람에게 «없다» 고 답하게 된다. 파일은 열지 않는다(존재 여부를 알려 주지 않는다).
    const session = needSession(ctx);
    const view = await sessionViewOf(session, user);
    const r = addressToSessionPath(view, address);
    return r.path !== null
      ? { address: formatAddress(address), session, path: r.path }
      : { address: formatAddress(address), session, path: null, reason: r.reason };
  },
};

export const fileCapabilities: Capability[] = [fileUrl, fileAddress, filePath];
