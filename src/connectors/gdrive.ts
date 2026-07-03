// Google Drive 커넥터 — Drive 파일을 canonical RawItem(type:'doc')으로 정규화한다.
// 소스: Google Drive API v3 (https://www.googleapis.com/drive/v3), fetch 전용(googleapis SDK 미도입 — 기존 원칙).
//   - GET /files             : 파일 나열(폴더/휴지통 제외, modifiedTime 내림차순, nextPageToken 페이지네이션).
//                              ⚠ 공유 드라이브 3종 세트(supportsAllDrives + includeItemsFromAllDrives + corpora=allDrives)
//                              를 모두 켜야 공유 드라이브 파일이 조용히 누락되지 않는다.
//   - GET /files/{id}/export : Google 네이티브(Docs/Sheets/Slides) → text/plain·text/csv 로 내보내 본문 추출.
//   - GET /files/{id}?alt=media : 비네이티브 텍스트(text/*·application/json) 원본 다운로드.
//   - 바이너리(pdf/이미지/오피스 blob)는 바이트를 받지 않고 메타데이터만 — 텍스트 추출은 후속 단계.
// 헤더: Authorization: Bearer <googleAccessToken("gdrive")> (google-auth.ts, OAuth2 refresh-token, access token 만료 자동 갱신).
// rate limit: 초과 시 429 + Retry-After(초). → 429 시 Retry-After 만큼 대기 후 재시도. 자발적 스로틀로 선제 회피.
// 단일 파일 처리 실패는 skip/continue — 전체 백필을 죽이지 않는다.
// ⚠ 증분 since / folders id 는 q 문자열에 보간되므로 STRICT 검증(인젝션 가드) — 형식 불일치면 해당 절을 생략한다.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { googleAccessToken } from "./google-auth.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://www.googleapis.com/drive/v3";
const SYSTEM = "gdrive";
const INSTANCE_DEFAULT = "default"; // Drive 파일 id 는 전역 유일 → instance 는 default 고정(external_id 유일성은 file id 가 보장).
const PAGE_SIZE = 1000; // files.list 최대 페이지 크기
const MAX_PAGES = 20; // 페이지네이션 상한(무한 루프/폭주 방지) — 초과 시 truncation 경고
const REQ_INTERVAL_MS = 50; // 자발적 스로틀 — Drive 쿼터는 넉넉하나 100초창(per-user) 버스트 선제 회피
const MAX_RETRY = 5; // 429/일시 오류 재시도 횟수
const MAX_BODY_CHARS = 1_000_000; // 본문 저장 상한(~1MB) — 병적으로 큰 텍스트/export 로부터 메모리 보호

// files.list fields — 우리가 실제로 읽는 필드만 요청(응답 최소화). ⚠ 여기 없는 필드는 응답에 안 온다.
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,modifiedTime,trashed,owners(displayName,emailAddress),webViewLink,version)";

// RFC3339(= q 에 안전 보간 가능한 형태). 따옴표·공백 등 인젝션 문자를 원천 배제.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Drive 파일/폴더 id 허용 문자(따옴표 등 배제 — folders config 보간 가드).
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

// Google 네이티브 mimeType → export 대상 텍스트 mimeType. 매핑 없으면(드로잉/폼 등) 본문 추출 생략(메타만).
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// ── Drive API 타입(부분) — 실제 읽는 필드만 좁게 선언. 나머지는 raw 로 보존. ──
interface DriveOwner {
  displayName?: string;
  emailAddress?: string;
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string; // RFC3339
  trashed?: boolean;
  owners?: DriveOwner[]; // ⚠ 공유 드라이브 파일엔 owners 가 부재할 수 있음
  webViewLink?: string;
  version?: string; // v3 는 int64 를 문자열로 표현
  [k: string]: unknown;
}

interface DriveListResponse {
  nextPageToken?: string;
  files?: DriveFile[];
}

// ── 작은 유틸 ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// since 가 q 에 보간해도 안전한 RFC3339 인지 STRICT 판정(형식 + 실제 파싱 가능성).
export function isRfc3339(s: string | undefined): s is string {
  return typeof s === "string" && RFC3339.test(s) && Number.isFinite(Date.parse(s));
}

// 폴더 스코핑(config GDRIVE_FOLDERS=쉼표구분 폴더 id). 설정 시 이 폴더들의 직속 파일만.
//  id 는 q 에 보간되므로 허용 문자만 통과(인젝션 가드) — 형식 이상치는 경고 후 드랍.
async function getFolderIds(): Promise<string[]> {
  const raw = (await resolveConnectorConfig(SYSTEM)).folders?.trim();
  if (!raw) return [];
  const all = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ok = all.filter((id) => DRIVE_ID.test(id));
  if (ok.length !== all.length) {
    const bad = all.filter((id) => !DRIVE_ID.test(id)).join(", ");
    console.warn(`gdrive: 형식이 올바르지 않은 folder id 를 무시합니다: ${bad}`);
  }
  return ok;
}

// files.list q 절 조립(순수). since/folderIds 는 여기서도 재검증해 인젝션을 원천 차단한다(방어적 이중 가드).
//  - 폴더/휴지통 제외는 항상. since 유효할 때만 modifiedTime 절(증분). folderIds 있을 때만 parents 절(OR).
export function buildFilesQuery(opts: { since?: string; folderIds?: string[] } = {}): string {
  const clauses = [
    "mimeType != 'application/vnd.google-apps.folder'", // 폴더 자체는 제외(파일만)
    "trashed = false", // 휴지통 제외
  ];
  if (isRfc3339(opts.since)) clauses.push(`modifiedTime > '${opts.since}'`); // 증분
  const folders = (opts.folderIds ?? []).filter((id) => DRIVE_ID.test(id));
  if (folders.length) {
    clauses.push(`(${folders.map((id) => `'${id}' in parents`).join(" or ")})`);
  }
  return clauses.join(" and ");
}

// ── HTTP 호출(Bearer 인증 + rate limit 존중 + 자발적 스로틀). Response 그대로 반환 → 호출자가 ok 판정. ──
//  토큰은 매 시도마다 googleAccessToken 에서 획득(만료 60s 여유 캐시 + 자동 재발급) — 1시간 넘는 백필도 만료 없이 통과.
let lastReqAt = 0;

async function driveFetch(url: string, accept = "application/json"): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    // 자발적 스로틀: 직전 요청과 최소 간격 유지(선제 rate limit 회피).
    const wait = lastReqAt + REQ_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();

    const token = await googleAccessToken(SYSTEM);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept } });

    // rate limit: 429 → Retry-After(초) 만큼 대기 후 재시도.
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : REQ_INTERVAL_MS * (attempt + 2);
      await res.text().catch(() => "");
      if (attempt < MAX_RETRY) {
        await sleep(delay);
        continue;
      }
      throw new Error(`gdrive 429 rate_limited (재시도 소진): ${url}`);
    }

    // 일시적 서버 오류(5xx)는 백오프 후 재시도. 재시도 소진 시엔 res(5xx) 를 그대로 반환 → 호출자 판정.
    if (res.status >= 500 && attempt < MAX_RETRY) {
      await res.text().catch(() => "");
      await sleep(REQ_INTERVAL_MS * (attempt + 2));
      continue;
    }

    return res;
  }
  // 위 루프에서 반드시 return/throw 되지만 타입 만족용 가드.
  throw new Error(`gdrive 요청 실패(예상치 못한 종료): ${url}`);
}

// files.list 한 페이지. list 실패는 페이지 전체를 못 얻는 것이므로 throw(백필 중단·상위 재시도 대상).
async function listFilesPage(url: string): Promise<DriveListResponse> {
  const res = await driveFetch(url, "application/json");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gdrive files.list ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as DriveListResponse;
}

// 본문 추출 — mimeType 분기. 비대상/실패는 undefined 반환(메타데이터는 항상 보존).
async function fetchBodyText(file: DriveFile): Promise<string | undefined> {
  const mime = file.mimeType ?? "";
  const id = encodeURIComponent(file.id);

  // 1) Google 네이티브(Docs/Sheets/Slides) → export 로 텍스트화. 폴더는 q 에서 제외되지만 방어적으로 스킵.
  if (mime.startsWith("application/vnd.google-apps")) {
    const out = EXPORT_MIME[mime];
    if (!out) return undefined; // 폴더/드로잉/폼 등 텍스트 export 비대상 → 메타만
    // supportsAllDrives: 공유 드라이브의 네이티브 문서도 export 되도록(없으면 404 가능) — list 트라이펙타와 정합.
    const p = new URLSearchParams({ mimeType: out, supportsAllDrives: "true" });
    const res = await driveFetch(`${API_BASE}/files/${id}/export?${p.toString()}`, out);
    // ⚠ Docs export 는 서버측 10MB 상한 등으로 실패 가능 → 본문만 비우고 메타는 보존.
    if (!res.ok) {
      await res.text().catch(() => "");
      console.warn(`gdrive: export 실패(본문 생략, 메타 보존) ${file.id} ${mime}→${out}: ${res.status}`);
      return undefined;
    }
    const text = await res.text();
    return text ? text.slice(0, MAX_BODY_CHARS) : undefined;
  }

  // 2) 비네이티브 텍스트(text/*·application/json) → 원본 다운로드(alt=media).
  //    ⚠ 요청 fields 에 size 가 없어 사전 크기 판정 불가 → 다운로드 후 MAX_BODY_CHARS 로 절단(저장 보호).
  if (mime.startsWith("text/") || mime === "application/json") {
    const res = await driveFetch(`${API_BASE}/files/${id}?alt=media&supportsAllDrives=true`, "*/*");
    if (!res.ok) {
      await res.text().catch(() => "");
      console.warn(`gdrive: 다운로드 실패(본문 생략, 메타 보존) ${file.id} ${mime}: ${res.status}`);
      return undefined;
    }
    const text = await res.text();
    return text ? text.slice(0, MAX_BODY_CHARS) : undefined;
  }

  // 3) 바이너리(pdf/이미지/오피스 blob 등) — 바이트 미다운로드, 메타만 유지.
  //    TODO(후속): 바이너리 텍스트 추출 파이프라인(OCR/파서) 도입 시 여기에서 body 채운다.
  return undefined;
}

// ── 순수 변환(네트워크 X) — 단위 테스트 대상. 원본 file 메타(+미리 받아둔 body) → RawItem. ──
//  네트워크 의존(본문 추출)은 ctx.body 로 주입받아 순수하게 유지한다(notion.toRawItem 과 동형).
export function toRawItem(file: DriveFile, ctx: { body?: string; instance?: string } = {}): RawItem {
  const instance = ctx.instance || INSTANCE_DEFAULT;
  const owner = file.owners?.[0]; // ⚠ 공유 드라이브 파일은 owners 부재 → actor 없음

  return {
    type: "doc", // Drive 파일 → doc
    provenance: {
      category: "collab_tool",
      system: SYSTEM,
      instance,
      external_id: file.id, // Drive 파일 id 는 전역 유일·안정
      external_url: file.webViewLink || `https://drive.google.com/file/d/${file.id}`, // 딥링크(webViewLink 부재 시 합성)
    },
    actor: owner
      ? {
          external_id: owner.emailAddress,
          display_name: owner.displayName,
          email: owner.emailAddress,
        }
      : undefined,
    title: file.name || undefined,
    body: ctx.body || undefined,
    occurred_at: file.modifiedTime, // 이미 RFC3339
    updated_at: file.modifiedTime,
    fields: {
      mimeType: file.mimeType,
      trashed: file.trashed ?? false,
      version: file.version,
    },
    raw: file, // 원본 보존
  };
}

// ── 백필: files.list 로 파일을 페이지네이션하며 각 파일 본문 채워 RawItem yield. ──
async function* backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
  // 증분: since 는 q 에 보간되므로 STRICT 검증. 형식 불일치면 경고 후 절 생략(전체 백필로 폴백 — 인젝션 차단 우선).
  let since: string | undefined;
  if (opts?.since) {
    if (isRfc3339(opts.since)) since = opts.since;
    else console.warn(`gdrive: since 가 RFC3339 형식이 아니라 증분 필터를 생략합니다(전체 백필): ${JSON.stringify(opts.since)}`);
  }
  const folderIds = await getFolderIds();
  const q = buildFilesQuery({ since, folderIds });

  let pageToken: string | undefined;
  let page = 0;
  do {
    const params = new URLSearchParams({
      q,
      orderBy: "modifiedTime desc",
      fields: LIST_FIELDS,
      pageSize: String(PAGE_SIZE),
      // ⚠ 공유 드라이브 트라이펙타 — 셋 중 하나라도 빠지면 공유 드라이브 파일이 조용히 누락된다.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await listFilesPage(`${API_BASE}/files?${params.toString()}`);

    for (const file of data.files ?? []) {
      if (!file.id) continue; // id 없는 이례적 레코드 방어
      try {
        const body = await fetchBodyText(file);
        yield toRawItem(file, { body });
      } catch (e) {
        // 단일 파일 처리 실패는 skip/continue — 전체 백필을 죽이지 않는다.
        console.warn(`gdrive: 파일 처리 실패(skip) ${file.id}: ${(e as Error).message}`);
        continue;
      }
    }

    pageToken = data.nextPageToken || undefined;
    page++;
    if (pageToken && page >= MAX_PAGES) {
      console.warn(
        `gdrive: 페이지 상한(${MAX_PAGES}) 도달 — 이후 파일이 잘렸을 수 있습니다(truncation). 폴더 스코핑/증분 since 로 범위를 좁히세요.`,
      );
      break;
    }
  } while (pageToken); // nextPageToken 없을 때까지
}

export const gdriveConnector: Connector = {
  name: "gdrive",
  backfill,
};
