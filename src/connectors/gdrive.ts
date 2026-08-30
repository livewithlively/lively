// Google Drive 커넥터 — Drive 파일을 canonical RawItem(type:'doc')으로 정규화한다.
// 소스: Google Drive API v3 (https://www.googleapis.com/drive/v3), fetch 전용(googleapis SDK 미도입 — 기존 원칙).
//   - GET /files             : 파일 나열(폴더/휴지통 제외, modifiedTime 내림차순, nextPageToken 페이지네이션).
//                              ⚠ 공유 드라이브 3종 세트(supportsAllDrives + includeItemsFromAllDrives + corpora=allDrives)
//                              를 모두 켜야 공유 드라이브 파일이 조용히 누락되지 않는다.
//   - GET /files/{id}/export : Google 네이티브(Docs/Sheets/Slides) → text/plain·text/csv 로 내보내 본문 추출.
//   - GET /files/{id}?alt=media : 비네이티브 텍스트(text/*·application/json) 및 Office Open XML(.docx/.pptx/.xlsx) 원본 다운로드.
//     · OOXML 은 zero-dep(zlib) 로 ZIP 을 풀어 텍스트 노드만 추출(한글 포함 신뢰성 있음, extractOoxml).
//   - PDF·이미지: 원본을 로컬 아티팩트(GDRIVE_ARTIFACT_DIR, 기본 ./data/drive-artifacts)로 저장하고 body 는 스텁(마커+path+url).
//     distill 세션이 path 를 Read(Claude 네이티브 PDF/이미지/스캔 파싱, 한글 정확)해 지식화 — 손파서 CID 누락 회피, CTO drive-absorb 동형.
//   - 그 외 바이너리(zip/video/audio 등)는 메타데이터만.
// 헤더: Authorization: Bearer <googleAccessToken("gdrive")> (google-auth.ts, OAuth2 refresh-token, access token 만료 자동 갱신).
// rate limit: 초과 시 429 + Retry-After(초). → 429 시 Retry-After 만큼 대기 후 재시도. 자발적 스로틀로 선제 회피.
// 단일 파일 처리 실패는 skip/continue — 전체 백필을 죽이지 않는다.
// ⚠ 증분 since / folders id 는 q 문자열에 보간되므로 STRICT 검증(인젝션 가드) — 형식 불일치면 해당 절을 생략한다.
import { Readable } from "node:stream";
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { googleAccessToken } from "./google-auth.js";
import { extractOoxml, printableRatio, ooxmlKindFromMime } from "./ooxml.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://www.googleapis.com/drive/v3";
const SYSTEM = "gdrive";
const INSTANCE_DEFAULT = "default"; // Drive 파일 id 는 전역 유일 → instance 는 default 고정(external_id 유일성은 file id 가 보장).
const PAGE_SIZE = 1000; // files.list 최대 페이지 크기
const MAX_PAGES = 20; // 페이지네이션 상한(무한 루프/폭주 방지) — 초과 시 truncation 경고
const REQ_INTERVAL_MS = 50; // 자발적 스로틀 — Drive 쿼터는 넉넉하나 100초창(per-user) 버스트 선제 회피
const MAX_RETRY = 5; // 429/일시 오류 재시도 횟수
const MAX_BODY_CHARS = 1_000_000; // 본문 저장 상한(~1MB) — 병적으로 큰 텍스트/export 로부터 메모리 보호
const MAX_BINARY_BYTES = 30_000_000; // OOXML 텍스트 추출용 바이너리 다운로드 상한(~30MB) — 메모리 보호(초과 시 메타만)
const BINARY_MARKER = "[BINARY]"; // 통합 distill 프롬프트가 이 마커를 감지해 source_artifact(source_id) 로 on-demand 페치(slack 과 공용 계약).

// distill 이 on-demand 로 페치해 볼 가치가 있는 바이너리(Claude Read 네이티브 파싱: PDF·이미지). 그 외(zip/video/audio 등)는
//  Read 로도 텍스트가 안 나오므로 [BINARY] 스텁조차 남기지 않고 메타만(페치해도 무의미).
function isVisionBinary(mime: string): boolean {
  return mime === "application/pdf" || mime.startsWith("image/");
}

// files.list fields — 우리가 실제로 읽는 필드만 요청(응답 최소화). ⚠ 여기 없는 필드는 응답에 안 온다.
//  size: [BINARY] 스텁의 판단 근거(distill 이 크기로 노이즈 선별) — Google 네이티브 문서엔 없을 수 있음(문자열, 바이트).
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,modifiedTime,trashed,owners(displayName,emailAddress),webViewLink,version,size,parents)";

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

// 업로드된 Office Open XML(.docx/.pptx/.xlsx) 판정·추출은 공용 유틸(./ooxml.js)로 위임 — slack 등과 공유.
//  결정적 텍스트(본문이 XML 유니코드)라 sync 시점에 뽑아 body_md 로 넣는다(검색가능·distill 이 fetch 없이 판단).

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
  size?: string; // 바이트(문자열, v3 int64). Google 네이티브 문서엔 부재.
  parents?: string[]; // 상위 폴더 id(보통 1개) — 채널(container_name)의 근거(#2416).
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

// Content-Length 선검사 — 헤더가 있고 cap 초과면 body 를 버퍼링(arrayBuffer)하기 전에 조기 거부(메모리 보호).
//  헤더 부재(청크 전송 등)면 통과 → 다운로드 후 바이트 캡이 최종 방어선. 초과 시 스트림 취소해 소켓 해제.
async function exceedsContentLength(res: Response, cap: number): Promise<boolean> {
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > cap) {
    await res.body?.cancel().catch(() => {});
    return true;
  }
  return false;
}

// [BINARY] 메타-only 스텁 — 커넥터는 바이너리를 저장하지 않는다(on-demand). distill 이 이 메타로 볼 가치를 판단하고,
//  가치 있으면 source_artifact(source_id) 로 게이트웨이가 원본을 신선하게 페치해 Read 한다(slack 등과 공용 계약).
//  ⚠ 마커/필드(filename·mime·size·url) 포맷은 통합 distill 프롬프트·slack 커넥터와의 계약 — 바꾸면 함께 갱신(gdrive.test 잠금).
export function buildBinaryStub(file: DriveFile): string {
  const url = file.webViewLink || `https://drive.google.com/file/d/${file.id}`;
  const parts = [
    `${BINARY_MARKER} filename=${file.name || file.id}`,
    `mime=${file.mimeType || "application/octet-stream"}`,
  ];
  if (file.size) parts.push(`size=${file.size}`);
  parts.push(`url=${url}`);
  const owner = file.owners?.[0]?.emailAddress;
  if (owner) parts.push(`owner=${owner}`);
  if (file.modifiedTime) parts.push(`modified=${file.modifiedTime}`);
  return parts.join(" ") + `\n바이너리 파일(내용 미추출). 볼 가치가 있으면 source_artifact(source_id)로 원본을 받아 판단하고, `
    + `노이즈(밈·UI캡처 등)면 fetch 없이 skip 하세요.`;
}

// 본문 추출 — mimeType 분기. 비대상/실패는 undefined 반환(메타데이터는 항상 보존).
//  결정적 텍스트(네이티브 export·text/*·OOXML)는 sync 시점에 body_md 로 추출. PDF/이미지는 [BINARY] 메타-스텁만
//  (다운로드·저장 X) → distill 이 source_artifact 로 on-demand 페치. 그 외 바이너리는 메타만(undefined).
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

  // 3) 업로드된 Office Open XML(.docx/.pptx/.xlsx) — 바이트 다운로드(transient) 후 공용 유틸로 텍스트 추출.
  //    본문이 XML 유니코드라 결정적·신뢰성 있음(한글 포함). ⚠ Claude Read 는 docx/xlsx 를 못 뽑으므로 이건
  //    on-demand 대상 아님(sync 추출이 정답). 파싱 실패/빈 결과/깨진 추출은 undefined 로 폴백(메타 보존).
  const ooxml = ooxmlKindFromMime(mime);
  if (ooxml) {
    const res = await driveFetch(`${API_BASE}/files/${id}?alt=media&supportsAllDrives=true`, "*/*");
    if (!res.ok) {
      await res.text().catch(() => "");
      console.warn(`gdrive: OOXML 다운로드 실패(본문 생략, 메타 보존) ${file.id} ${mime}: ${res.status}`);
      return undefined;
    }
    if (await exceedsContentLength(res, MAX_BINARY_BYTES)) {
      console.warn(`gdrive: OOXML 과대(Content-Length > ${MAX_BINARY_BYTES}) — 본문 생략, 메타 보존 ${file.id}`);
      return undefined;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BINARY_BYTES) {
      console.warn(`gdrive: OOXML 과대(${ab.byteLength}B > ${MAX_BINARY_BYTES}) — 본문 생략, 메타 보존 ${file.id}`);
      return undefined;
    }
    try {
      const text = extractOoxml(ooxml, Buffer.from(ab));
      // 빈 결과/깨진 추출(인쇄가능 비율 < 0.6)은 저장하지 않는다 — 잡음을 지식화 큐에 넣지 않음.
      if (!text || printableRatio(text) < 0.6) return undefined;
      return text.slice(0, MAX_BODY_CHARS);
    } catch (e) {
      console.warn(`gdrive: OOXML 추출 실패(본문 생략, 메타 보존) ${file.id} ${mime}: ${(e as Error).message}`);
      return undefined;
    }
  }

  // 4) PDF·이미지 — 다운로드/저장하지 않는다. [BINARY] 메타-스텁만 body 로 → distill 이 볼 가치 판단 후
  //    source_artifact(source_id) 로 on-demand 페치·Read(한글/스캔 정확). 저장 스파이크·노이즈 다운로드 회피.
  if (isVisionBinary(mime)) return buildBinaryStub(file);

  // 5) 그 외 바이너리(zip/video/audio/exe 등) — Read 로도 텍스트가 안 나오므로 스텁도 안 남기고 메타만.
  return undefined;
}

// ── on-demand 아티팩트 페치(SPI Connector.fetchArtifact) — distill 시점에 공용 source_artifact 도구가 호출. ──
//  원본 바이트를 스트림으로 반환(도구가 짧은 TTL 임시경로에 저장 → 세션 Read → GC). 저장·정책은 도구 책임, 여기선 페치만.
//  externalId = 소스 external_id 원문(gdrive 는 Drive file id 그대로). 삭제/이동/권한상실 = null(도구가 unavailable→skip).
//  ⚠ 크기 캡은 도구가 강제(size 힌트 + 스트리밍 abort) — 커넥터는 상한 미적용(대용량도 스트림으로 흘려보냄).
export async function gdriveFetchArtifact(
  externalId: string,
): Promise<{ stream: Readable; mime: string; filename?: string; size?: number } | null> {
  if (!DRIVE_ID.test(externalId)) return null; // 방어(도구가 임시파일명에 쓸 수 있음 — 심층방어)
  const id = encodeURIComponent(externalId);
  const res = await driveFetch(`${API_BASE}/files/${id}?alt=media&supportsAllDrives=true`, "*/*");
  if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; } // 삭제/이동 → unavailable
  if (!res.ok || !res.body) {
    await res.text().catch(() => "");
    console.warn(`gdrive: fetchArtifact 실패 ${externalId}: ${res.status}`);
    return null;
  }
  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const clen = Number(res.headers.get("content-length"));
  return {
    stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    mime,
    size: Number.isFinite(clen) && clen > 0 ? clen : undefined,
  };
}

// 폴더 id → 폴더명 (#2416). 파일마다 부르지 않고 **폴더당 1회**만 조회해 캐시한다(폴더 수는 파일 수보다 훨씬 적다).
//  실패·부재는 빈 문자열로 수렴 — 채널을 못 정했다고 파일 수집을 멈추지 않는다.
const folderNameCache = new Map<string, string>();
async function folderNameOf(id: string | undefined): Promise<string> {
  const fid = String(id ?? "").trim();
  if (!fid || !DRIVE_ID.test(fid)) return "";
  const hit = folderNameCache.get(fid);
  if (hit !== undefined) return hit;
  let name = "";
  try {
    const params = new URLSearchParams({ fields: "name", supportsAllDrives: "true" });
    const res = await driveFetch(`${API_BASE}/files/${encodeURIComponent(fid)}?${params.toString()}`, "application/json");
    if (res.ok) name = String(((await res.json()) as { name?: string })?.name ?? "").trim();
  } catch (e) {
    console.warn(`gdrive: 폴더명 조회 실패(채널 없이 진행) ${fid}: ${(e as Error).message}`);
  }
  folderNameCache.set(fid, name);   // 실패도 캐시 — 같은 폴더로 매번 재시도하지 않는다
  return name;
}

// ── 순수 변환(네트워크 X) — 단위 테스트 대상. 원본 file 메타(+미리 받아둔 body) → RawItem. ──
//  네트워크 의존(본문 추출)은 ctx.body 로 주입받아 순수하게 유지한다(notion.toRawItem 과 동형).
export function toRawItem(file: DriveFile, ctx: { body?: string; instance?: string; container?: string } = {}): RawItem {
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
    // 채널(#2416) = **상위 폴더 이름**. 사람이 드라이브를 나누는 단위가 폴더이고, 증류기 레인은 이 축으로만 좁힐 수 있다.
    //  ⚠ 파일명을 넣으면 안 된다 — 자료마다 값이 달라 '묶음'이 아니게 되고 채널이 파일 수만큼 생긴다.
    container_ref: file.parents?.[0],
    container_name: ctx.container?.trim() || undefined,
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
        const container = await folderNameOf(file.parents?.[0]);   // 채널(#2416) — 폴더당 1회 캐시
        yield toRawItem(file, { body, container });
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
  fetchArtifact: gdriveFetchArtifact, // on-demand PDF/이미지 원본 페치(공용 source_artifact 도구가 호출)
};
