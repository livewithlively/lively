// 서명 주소 발급(#4673) — 판정을 지난 주소 하나에 짧은 수명 서명 주소를 만든다. 순수(deps 주입) — capabilities/files.ts file_url 이 부른다.
//  판정(files/file-access) → 쓰기 대상 확인 → 키 → 토큰 → url. 판정에 걸리면 토큰을 만들지 않는다(거절이 서명보다 먼저).
//  url 모양 `<게이트웨이>/api/files/s/<토큰>` 이 1단계 계약이다 — 2단계(#4674)에서 이 함수가 S3 게이트웨이 서명 주소를 내도
//   응답 칸(url · method · headers · expires_at)은 같다(앱 코드 무변경).
import { HttpError } from "../http-error.js";
import { formatAddress, type FileAddress } from "./address.js";
import { signFileUrlToken, FILE_URL_MAX_UPLOAD, type FileUrlMethod } from "./file-url-token.js";
import { authorizeFileAccess, assertWritableTarget, type FileAccessDeps, type FilePrincipal } from "./file-access.js";

export interface MintFileUrlInput {
  address: FileAddress;
  method: FileUrlMethod;
  /** 수명(초) — 부르는 쪽이 clampTtl 로 맞춘 값 */
  ttlSec: number;
  principal: FilePrincipal;
  /** 읽기전용 세션(#1007)이면 올리기 주소를 주지 않는다 */
  readOnly?: boolean;
}

export interface MintFileUrlDeps {
  access: FileAccessDeps;
  /** 서명 키(없으면 null → 503) */
  key(): Buffer | null;
  /** 이 요청의 워크스페이스 id(토큰에 굽는다) */
  tenantId(): string;
  /** 게이트웨이 공개 주소(없으면 null → 상대경로 url) */
  base(): Promise<string | null>;
  /** 셀프호스트 다중 워크스페이스면 주소에 실을 워크스페이스 슬러그(받는 쪽이 같은 워크스페이스로 연다). 아니면 null */
  workspaceSlug(): string | null;
  /** 지금(초) — 시험 주입 */
  now?(): number;
}

export interface MintedFileUrl {
  address: string;
  method: FileUrlMethod;
  url: string;
  headers: Record<string, string>;
  expires_at: string;
  expires_in: number;
  max_bytes?: number;
  note?: string;
}

export async function mintFileUrl(i: MintFileUrlInput, d: MintFileUrlDeps): Promise<MintedFileUrl> {
  if (i.method === "PUT" && i.readOnly) throw new HttpError(403, "읽기전용 세션 — 올리기 주소는 줄 수 없습니다(#1007)");
  await authorizeFileAccess(i.principal, i.address, i.method === "PUT" ? "write" : "read", d.access);
  if (i.method === "PUT") assertWritableTarget(i.address);
  const key = d.key();
  if (!key) throw new HttpError(503, "이 게이트웨이에 서명 키(CONNECTOR_SECRET_KEY)가 없어 서명 주소를 만들 수 없습니다 — 관리자에게 알려 주세요");
  const exp = (d.now ? d.now() : Math.floor(Date.now() / 1000)) + i.ttlSec;
  const token = signFileUrlToken({
    t: d.tenantId(), m: i.method, r: i.address.root, p: i.address.rel, s: i.principal.member,
    ...(i.principal.app ? { a: i.principal.app } : {}), e: exp,
  }, key);
  const base = await d.base();
  const slug = d.workspaceSlug();
  return {
    address: formatAddress(i.address), method: i.method,
    url: `${base ?? ""}/api/files/s/${token}${slug ? `?lvly_ws=${encodeURIComponent(slug)}` : ""}`,
    headers: {},
    expires_at: new Date(exp * 1000).toISOString(), expires_in: i.ttlSec,
    ...(i.method === "PUT" ? { max_bytes: FILE_URL_MAX_UPLOAD } : {}),
    ...(base ? {} : { note: "게이트웨이 공개 주소가 정해지지 않아 url 이 상대경로입니다 — 관리 ▸ 게이트웨이 주소를 설정하세요" }),
  };
}
