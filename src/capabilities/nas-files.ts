// NAS 파일명 검색 — 구성원 본인 FTP 계정으로 «어디에 무슨 파일이 있나»만 찾는다.
//  본문은 이 도구들이 절대 읽지 않는다. 결과의 download_url 은 사람이 로그인한 브라우저에서만 열린다(nas-download-route.ts).
//  경계·자격 설계는 net/nas/nas-access.ts · net/nas/nas-index.ts 머리주석.
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { logger } from "../log.js";
import { gatewayUrl } from "../gateway-url.js";
import { parseListing, displayPath, encodeRawPath, decodeRawPath, isSafeRawPath } from "../net/ftp/ftp-list.js";
import { crawl, searchEntries, type NasEntry, type CrawlResult } from "../net/nas/nas-index.js";
import { connectNas, nasErrorReply, openNasSession, resolveNasAccess, nasIndexCache, nasIndexKey, nasDownloadPath } from "../net/nas/nas-access.js";

/** 첫 색인을 기다리는 최대 시간. 넘으면 «만드는 중»으로 답하고 색인은 뒤에서 계속 만든다(MCP 호출을 오래 붙잡지 않게). */
export const FIRST_INDEX_WAIT_MS = 20_000;

const BODY_NOTE = "파일 본문은 이 도구로 읽지 않습니다. download_url 은 사람이 라이블리에 로그인한 브라우저에서 열어 내려받습니다.";

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
    "결과는 경로·크기·시각과 내려받기 링크뿐이고 파일 본문은 읽지 않는다 — 링크는 사람에게 건네 브라우저에서 열게 한다. " +
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
    "결과는 이름·크기·시각과 내려받기 링크뿐이고 파일 본문은 읽지 않는다. 하위 폴더는 결과의 p 로 다시 부른다.",
  scope: "context",
  input: listInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/me/nas/list"], parse: (req) => ({ p: req.query.p, path: req.query.path }) }],
  },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = z.object(listInput).parse(input ?? {});
    let raw: string | null;
    if (i.p) raw = decodeRawPath(i.p);
    else {
      const path = (i.path ?? "/").trim() || "/";
      raw = Buffer.from(path.startsWith("/") ? path : `/${path}`, "utf8").toString("latin1");
    }
    if (raw && raw.length > 1) raw = raw.replace(/\/+$/, "");
    if (!raw || !isSafeRawPath(raw)) throw new HttpError(400, "폴더 경로가 올바르지 않습니다");
    const dir = raw;
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

export const nasFileCapabilities: Capability[] = [nasFind, nasList];
