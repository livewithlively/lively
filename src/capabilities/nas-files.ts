// NAS 파일명 검색 — 구성원 본인 FTP 계정으로 «어디에 무슨 파일이 있나»를 찾는다.
//  이 도구들은 본문을 돌려주지 않는다. 본문은 결과의 p 를 로컬 도구 lively_local_nas_pull 에 넘겨 그 기계의 ~/NAS사본
//  아래로(그 밖은 거부) 받은 뒤 AI 가 연다(nas-download-route.ts — 쿠키·Bearer 둘 다). download_url 은 사람이 브라우저로 받는 링크다.
//  경계·자격 설계는 net/nas/nas-access.ts · net/nas/nas-index.ts 머리주석.
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { logger } from "../log.js";
import { gatewayUrl } from "../gateway-url.js";
import { FtpError } from "../net/ftp/ftp-client.js";
import { parseListing, displayPath, encodeRawPath, decodeRawPath, isSafeRawPath, rawOfDisplayPath, childRawPath, parentRawPath } from "../net/ftp/ftp-list.js";
import { crawl, searchEntries, type NasEntry, type CrawlResult } from "../net/nas/nas-index.js";
import { connectNas, nasErrorReply, openNasSession, resolveNasAccess, nasIndexCache, nasIndexKey, nasDownloadPath, type NasServer } from "../net/nas/nas-access.js";

/** 첫 색인을 기다리는 최대 시간. 넘으면 «만드는 중»으로 답하고 색인은 뒤에서 계속 만든다(MCP 호출을 오래 붙잡지 않게). */
export const FIRST_INDEX_WAIT_MS = 20_000;

const BODY_NOTE = "파일 내용이 필요하면 항목(p·path·type·size)을 lively_local_nas_pull 의 targets 로 넘겨 ~/NAS사본 아래로 받은 뒤 연다. 프로젝트 공유 폴더에는 받지 않는다(다른 구성원도 본다). download_url 은 사람이 브라우저로 받는 링크다.";

// 소켓 오류 원문(사설 IP·포트)은 AI 세션으로 보내지 않는다 — 문구는 nasErrorReply 의 분류뿐이고, 원문은 로그에만 남긴다.
const toHttp = (e: unknown): HttpError => {
  if (e instanceof HttpError) return e;
  const r = nasErrorReply(e);
  return new HttpError(r.status, r.message);
};
function rethrow(e: unknown, memberId?: string): never {
  if (!(e instanceof HttpError) && !nasErrorReply(e).expected) logger.warn({ err: e, member: memberId }, "[nas] NAS 접속 실패");
  throw toHttp(e);
}

// 링크의 절대 주소 base 는 응답마다 한 번만 구한다(gatewayUrl 이 조직 프로필을 DB 에서 읽는다).
function toItem(e: Pick<NasEntry, "raw" | "path" | "type" | "size" | "mtime">, base: string | null) {
  return {
    path: e.path,
    type: e.type,
    size: e.size,
    mtime: e.mtime,
    p: encodeRawPath(e.raw),
    download_url: e.type === "file" ? (base ?? "") + nasDownloadPath(e.raw) : null,
  };
}

function indexInfo(r: CrawlResult, builtAt: number | null) {
  return {
    built_at: builtAt ? new Date(builtAt).toISOString() : null,
    dirs: r.dirs,
    entries: r.entries.length,
    failed_dirs: r.failedDirs,
    truncated: r.truncated,
  };
}

const findInput = {
  q: z.string().min(1).max(200).describe("찾을 낱말 — 공백으로 나누면 모두 든 것만(대소문자 무시, 폴더 경로까지 본다). 예: «약정서 SME»"),
  under: z.string().max(1024).optional().describe("이 폴더(사람이 읽는 경로) 아래만. 예: /SME금융"),
  type: z.enum(["file", "dir"]).optional().describe("file=파일만 · dir=폴더만"),
  limit: z.number().int().min(1).max(200).optional().describe("최대 건수(기본 50)"),
  refresh: z.boolean().optional().describe("true 면 색인을 새로 만든다(기본은 12시간 동안 재사용)"),
};

const nasFind: Capability = {
  name: "nas_find",
  title: "NAS 파일명 검색",
  description:
    "NAS(FTP)에서 파일·폴더를 이름으로 찾는다. 내 FTP 계정(me_credential_set kind=nas_ftp)으로 열 수 있는 폴더만 본다. " +
    "결과는 경로·크기·시각·p·내려받기 링크다. 내용을 보려면 p 를 lively_local_nas_pull 에 넘겨 로컬 폴더로 받은 뒤 연다(폴더 통째로도 된다). " +
    "첫 호출은 색인을 만드느라 «indexing» 으로 끝날 수 있으니 잠시 뒤 다시 부른다. 폴더 안을 바로 보려면 nas_list.",
  scope: "context",
  input: findInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/me/nas/find"], parse: (req) => ({
      q: req.query.q, under: req.query.under, type: req.query.type,
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      refresh: req.query.refresh === "true" || req.query.refresh === "1",
    }) }],
  },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = z.object(findInput).parse(input ?? {});
    const memberId = user.userId;
    const { server, login } = await resolveNasAccess(memberId).catch((e: unknown) => rethrow(e, memberId));
    const key = nasIndexKey(memberId, login.username, server);
    if (i.refresh || !nasIndexCache.isFresh(key)) {
      // 키를 만든 그 서버·계정으로 색인한다 — 사이에 설정이 바뀌어도 다른 서버의 색인이 이 키에 담기지 않게
      const building = nasIndexCache.build(key, async () => {
        try {
          const session = await connectNas(server, login);
          try {
            const r = await crawl((dir) => session.list(dir));
            logger.info({ member: memberId, dirs: r.dirs, entries: r.entries.length, failedDirs: r.failedDirs, truncated: r.truncated }, "[nas] 파일명 색인 완료");
            return r;
          } finally {
            await session.close();
          }
        } catch (e) {
          // 뒤에서 다시 만들다 실패하면 기다리는 호출이 없을 수 있다 — 원문은 여기서 로그로만 남긴다(상태엔 분류 문구만)
          if (!nasErrorReply(e).expected) logger.warn({ err: e, member: memberId }, "[nas] 파일명 색인 실패");
          throw e;
        }
      });
      const state = nasIndexCache.get(key);
      const waited = await Promise.race([
        building.then(() => "done" as const, () => "failed" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), FIRST_INDEX_WAIT_MS).unref()),
      ]);
      if (waited === "failed" && !state.result) throw toHttp(await building.catch((e: unknown) => e)); // 원문 로그는 위에서 남겼다
      if (waited === "timeout" && !state.result) {
        return { indexing: true, message: "NAS 파일명 색인을 만드는 중입니다(다른 사람 색인이 먼저 돌고 있으면 더 걸립니다). 몇 분 뒤 같은 검색을 다시 부르세요.", note: BODY_NOTE };
      }
    }
    const state = nasIndexCache.get(key);
    const r = state.result!;
    const found = searchEntries(r.entries, i.q, { under: i.under, type: i.type, limit: i.limit });
    const base = await gatewayUrl();
    return {
      total: found.total,
      items: found.items.map((e) => toItem(e, base)),
      // 다시 만들기가 실패하면 직전 색인으로 답하되 그 사실을 last_error 로 알린다(분류 문구 — nasIndexCache 가 원문을 담지 않는다)
      index: { ...indexInfo(r, state.builtAt), refreshing: !!state.building, last_error: state.error },
      note: BODY_NOTE,
    };
  },
};

const listInput = {
  p: z.string().max(4096).optional().describe("nas_find·nas_list 결과의 p 값(폴더). 이 값이 있으면 path 보다 우선"),
  path: z.string().max(1024).optional().describe("폴더 경로(사람이 읽는 꼴, UTF-8 이름만). 생략하면 맨 위 /"),
};

const nasList: Capability = {
  name: "nas_list",
  title: "NAS 폴더 목록",
  description:
    "NAS(FTP) 폴더 하나의 바로 아래 항목을 지금 서버에서 읽어 온다(색인 아님). 내 FTP 계정으로 열 수 있는 폴더만 된다. " +
    "결과는 이름·크기·시각·p·내려받기 링크다. 하위 폴더는 결과의 p 로 다시 부른다. 내용을 보려면 p 를 lively_local_nas_pull 에 넘긴다.",
  scope: "context",
  input: listInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/me/nas/list"], parse: (req) => ({ p: req.query.p, path: req.query.path }) }],
  },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = z.object(listInput).parse(input ?? {});
    const dir = rawTarget(i.p, i.path ?? "/");
    if (!dir) throw new HttpError(400, "폴더 경로가 올바르지 않습니다");
    let body: string;
    try {
      const { session } = await openNasSession(user.userId);
      try { body = await session.list(dir); } finally { await session.close(); }
    } catch (e) { rethrow(e, user.userId); }
    const join = (name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
    const entries = parseListing(body)
      .filter((e) => e.type === "file" || e.type === "dir")
      .map((e) => ({ raw: join(e.name), path: displayPath(join(e.name)), type: e.type as "file" | "dir", size: e.size, mtime: e.mtime }));
    const base = await gatewayUrl();
    return { path: displayPath(dir), items: entries.map((e) => toItem(e, base)), note: BODY_NOTE };
  },
};

// p(서버가 준 원본 경로) 가 있으면 그것, 없으면 사람이 읽는 경로(UTF-8). 끝 / 는 뗀다. 쓸 수 없는 경로면 null.
function rawTarget(p: string | undefined, path: string | undefined): string | null {
  let raw = p ? decodeRawPath(p) : path !== undefined ? rawOfDisplayPath(path) : null;
  if (raw && raw.length > 1) raw = raw.replace(/\/+$/, "");
  return raw && isSafeRawPath(raw) ? raw : null;
}

// 쓰기 실패의 서버 응답을 사람 말로. vsftpd 는 «없음»·«권한 없음»·«이름 불가»를 550·553 으로 섞어 준다(올리기 경로와 같은 403).
function rethrowWrite(e: unknown, memberId: string, op: string): never {
  if (e instanceof FtpError && (e.code === 550 || e.code === 553)) {
    const what = op === "delete" ? "대상이 없거나 파일이 아니거나(폴더는 rmdir) 내 FTP 계정에 그 작업 권한이 없습니다"
      : op === "rmdir" ? "폴더가 없거나 비어 있지 않거나 내 FTP 계정에 그 작업 권한이 없습니다"
      : "대상이 없거나 이미 있거나 내 FTP 계정에 그 작업 권한이 없습니다";
    throw new HttpError(403, what);
  }
  return rethrow(e, memberId);
}

export interface ManageInput { op: "mkdir" | "delete" | "rmdir" | "rename"; p?: string; path?: string; name?: string; to_dir?: string; to_dir_path?: string; to_name?: string; overwrite?: boolean }

/**
 * nas_manage 입력 → 다룰 원본 경로(raw)와 결과 경로(target). 거부할 입력이면 { error }.
 *  rename 에 새 이름이 없으면 원래 이름의 원본 바이트를 그대로 옮긴다 — 옛 EUC-KR 이름도 깨지지 않게.
 *  rename 은 overwrite(같은 이름 대상을 덮어도 되나)를 함께 싣는다. 다른 op 에 overwrite 를 주면 거부한다.
 */
export function planManage(i: ManageInput): { raw: string; target: string; overwrite?: boolean } | { error: string } {
  const raw = rawTarget(i.p, i.path);
  if (!raw) return { error: "대상 경로(p 또는 path)가 올바르지 않습니다" };
  if (i.overwrite !== undefined && i.op !== "rename") return { error: "overwrite 는 rename 에만 씁니다" };
  if (i.op === "mkdir") {
    const child = i.name ? childRawPath(raw, i.name) : null;
    return child ? { raw, target: child } : { error: "새 폴더 이름(name)이 올바르지 않습니다" };
  }
  if (raw === "/") return { error: "맨 위 폴더는 지우거나 옮길 수 없습니다" };
  if (i.op !== "rename") return { raw, target: raw };
  if (!i.to_dir && i.to_dir_path === undefined && !i.to_name) return { error: "rename 은 to_dir(또는 to_dir_path)이나 to_name 이 필요합니다" };
  const toParent = i.to_dir || i.to_dir_path !== undefined ? rawTarget(i.to_dir, i.to_dir_path) : parentRawPath(raw);
  if (!toParent) return { error: "옮길 폴더(to_dir)가 올바르지 않습니다" };
  const moved = i.to_name ? childRawPath(toParent, i.to_name) : `${toParent.replace(/\/+$/, "")}/${raw.slice(raw.lastIndexOf("/") + 1)}`;
  if (!moved || !isSafeRawPath(moved)) return { error: "새 이름(to_name)이 올바르지 않습니다" };
  if (moved === raw) return { error: "같은 자리로는 옮길 수 없습니다" };
  if (moved.startsWith(raw + "/")) return { error: "폴더를 자기 안으로는 옮길 수 없습니다" };
  return { raw, target: moved, overwrite: i.overwrite === true };
}

/**
 * RNTO 는 같은 이름 대상이 있으면 서버가 말없이 덮는다 — overwrite 가 아니면 먼저 SIZE 로 보고 있으면 옮기지 않는다(올리기와 같은 규칙).
 *  ⚠ SIZE 는 폴더면 null 이라 폴더 대상은 못 가른다. 그때는 서버가 판정한다(파일을 폴더 자리로·비지 않은 폴더 자리로 옮기기는 서버가 거부한다).
 */
export async function renameUnlessExists(
  ops: { size(raw: string): Promise<number | null>; rename(fromRaw: string, toRaw: string): Promise<void> },
  raw: string, target: string, overwrite: boolean,
): Promise<{ kind: "exists"; size: number } | { kind: "renamed"; overwritten: boolean }> {
  const existing = await ops.size(target);
  if (existing !== null && !overwrite) return { kind: "exists", size: existing };
  await ops.rename(raw, target);
  return { kind: "renamed", overwritten: existing !== null };
}

const manageInput = {
  op: z.enum(["mkdir", "delete", "rmdir", "rename"]).describe("mkdir=폴더 만들기 · delete=파일 지우기 · rmdir=빈 폴더 지우기 · rename=이름 바꾸기·옮기기"),
  p: z.string().max(4096).optional().describe("대상 — nas_find·nas_list 결과의 p. mkdir 이면 새 폴더를 만들 부모 폴더"),
  path: z.string().max(1024).optional().describe("p 대신 사람이 읽는 경로(UTF-8 이름만). p 가 있으면 p 가 우선"),
  name: z.string().max(255).optional().describe("mkdir 의 새 폴더 이름"),
  to_dir: z.string().max(4096).optional().describe("rename: 옮길 폴더의 p(생략하면 같은 폴더)"),
  to_dir_path: z.string().max(1024).optional().describe("rename: to_dir 대신 옮길 폴더 경로(사람이 읽는 꼴)"),
  to_name: z.string().max(255).optional().describe("rename: 새 이름(생략하면 그 이름 그대로 to_dir 로 옮긴다)"),
  overwrite: z.boolean().optional().describe("rename: 같은 이름 파일이 있으면 덮는다. 생략하면 덮지 않고 409 — 덮기 전에 사람에게 확인받는다"),
};

const nasManage: Capability = {
  name: "nas_manage",
  title: "NAS 파일·폴더 조작",
  description:
    "NAS(FTP)에서 폴더 만들기·파일 지우기·빈 폴더 지우기·이름 바꾸기/옮기기를 한다. 내 FTP 계정 권한 안에서만 된다. " +
    "rename 은 같은 이름 파일이 있으면 덮지 않고 409 를 돌려준다(덮으려면 overwrite:true). " +
    "되돌릴 수 없는 작업(delete·rmdir·overwrite rename)은 사람에게 대상을 확인받고 부른다. 파일 올리기는 lively_local_nas_push.",
  scope: "context",
  mutates: true,
  input: manageInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/nas/manage"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = z.object(manageInput).parse(input ?? {});
    const memberId = user.userId;
    const plan = planManage(i);
    if ("error" in plan) throw new HttpError(400, plan.error);
    const { raw, target } = plan;
    let username: string;
    let server: NasServer;
    let renamed: Awaited<ReturnType<typeof renameUnlessExists>> | null = null;
    try {
      const { session, username: u, server: sv } = await openNasSession(memberId);
      username = u;
      server = sv;
      try {
        if (i.op === "mkdir") await session.mkd(target);
        else if (i.op === "delete") await session.dele(raw);
        else if (i.op === "rmdir") await session.rmd(raw);
        else renamed = await renameUnlessExists(session, raw, target, plan.overwrite === true);
      } finally { await session.close(); }
    } catch (e) { rethrowWrite(e, memberId, i.op); }
    if (renamed?.kind === "exists") {
      throw new HttpError(409, "같은 이름의 파일이 있어 옮기지 않았습니다 — 덮으려면 사람에게 확인받고 overwrite:true 로 다시 부르세요",
        { body: { exists: true, size: renamed.size, path: displayPath(target), p: encodeRawPath(target) } });
    }
    nasIndexCache.markStale(nasIndexKey(memberId, username, server));
    logger.info({ member: memberId, ftpUser: username, op: i.op, ...(renamed ? { overwritten: renamed.overwritten } : {}) }, "[nas] 파일 조작");
    const shown = i.op === "delete" || i.op === "rmdir" ? raw : target;
    return {
      ok: true, op: i.op, path: displayPath(shown), p: encodeRawPath(shown),
      ...(i.op === "rename" ? { from: displayPath(raw), overwritten: renamed?.kind === "renamed" && renamed.overwritten } : {}),
    };
  },
};

export const nasFileCapabilities: Capability[] = [nasFind, nasList, nasManage];
