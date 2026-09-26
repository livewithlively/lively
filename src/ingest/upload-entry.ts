// 올린 파일이 **어느 길로 들어왔나**(#4233): 자료 사이드바의 「올린 자료」 · 「AI가 만든 파일」을 가르는 값(source.fields.entry).
//
//  판정 = 요청에 형식이 맞는 `x-lively-session` 헤더가 있나. 이 헤더는 AI 세션 쪽 표면만 싣는다:
//   · 프로젝트 up-sync 훅(kit/hooks/examples/project-push.org-hook.mjs SCOPE_HDRS): 세션이 쓴 파일을 올린다
//   · 하네스 MCP 프록시 · lively CLI(LIVELY_SESSION_ID 가 있을 때)
//  브라우저 업로드(자료 앱 · 세션 입력칸 첨부 · 프로젝트 폴더 · 태스크 첨부 · 온보딩)는 이 헤더를 싣지 않는다
//   (web/projects/files-upload.ts authUploadProgress 는 Content-Type · Authorization 만 보낸다).
//  그래서 사람이 세션 입력칸에 붙인 파일은 세션 주소로 올라가도 'upload' 다: URL 경로의 세션 id 는 보지 않는다.
//  ⚠ 한계: AI 가 헤더 없이(curl 등) 올린 파일은 'upload' 로 적힌다. 세션 표시는 권한이 아니라 기록이므로 형식만 본다.
import { sessionFromHeaders } from "../org/auth/agent-identity.js";
import { ENTRY_GENERATED, ENTRY_UPLOAD } from "../v6/source-group.js";

export type UploadEntryKind = typeof ENTRY_UPLOAD | typeof ENTRY_GENERATED;
export interface UploadEntry { kind: UploadEntryKind; session?: string | null }

/** 사람이 올린 것: 헤더를 볼 수 없는 입구(세션 입력칸 첨부를 프로젝트로 옮길 때 등)가 명시로 쓴다. */
export const PERSON_UPLOAD: UploadEntry = { kind: ENTRY_UPLOAD };

type HeaderBag = Record<string, string | string[] | undefined> | undefined | null;

/** 요청 헤더 → 들어온 길. 헤더가 배열이면 첫 값을 본다(sessionFromHeaders 규약). */
export function uploadEntryOf(headers: HeaderBag): UploadEntry {
  const session = sessionFromHeaders(headers ?? undefined);
  return session ? { kind: ENTRY_GENERATED, session } : { kind: ENTRY_UPLOAD };
}

/** 다시 올릴 때: 처음 적힌 길을 지킨다(들어온 길은 한 번 정해진다). 값이 없는 옛 행만 이번 값을 받는다. */
export function keepEntry(existing: { entry?: unknown; entry_session?: unknown } | null | undefined, incoming: UploadEntry): UploadEntry {
  const k = existing?.entry;
  if (k === ENTRY_UPLOAD || k === ENTRY_GENERATED) {
    const s = typeof existing?.entry_session === "string" ? existing.entry_session : null;
    return { kind: k, ...(s ? { session: s } : {}) };
  }
  return incoming;
}

/** source.fields 에 싣는 모양. */
export function entryFields(e: UploadEntry): { entry: UploadEntryKind; entry_session?: string } {
  return { entry: e.kind, ...(e.kind === ENTRY_GENERATED && e.session ? { entry_session: e.session } : {}) };
}
