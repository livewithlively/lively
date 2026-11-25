// 세션 요청 ▸ 파일 올리기(#1631 → #5713) — **로컬 폴더를 뒤지는 대신 사람이 끌어다 놓는다**.
//
//  종전 설계는 노드를 켜고 그 PC 를 훑는 것이었는데, 컴맹에게 설치·노드 등록을 시키는 값이 너무 크다. 파일 몇 개면 끝나는 일이면
//   끌어다 놓는 게 훨씬 간편하다(대표 판단). 올린 파일은 화면이 자료(source)로 저장하고(POST /api/ui/sources — 종전 그대로),
//   여기는 «무엇이 올라갔나» 만 받아 요청을 닫고 AI 에게 전한다.
//  종전(#1631)엔 리브 도구(me_liv_ask_upload)였고 올린 뒤에도 요청이 닫히지 않았다(접어야만 사라졌다). 이제 올리면 닫힌다.
import { z } from "zod";
import { HttpError } from "../../http-error.js";
import type { AskKind } from "../kinds.js";

export interface UploadAskPayload {
  at: string;
  kind: "upload";
  label: string;
  why?: string;
  /** 사람에게 보여줄 허용 형식 안내(실제 차단은 화면이 한다). */
  accept_hint?: string;
}

/** 화면이 보낸 «올린 것» 목록을 다듬는다 — 순수. 이름은 사람이 고른 파일 이름이라 길이만 자른다(내용은 이미 자료에 있다). */
export function uploadedFiles(input: Record<string, unknown>): Array<{ name: string; source_id?: number }> {
  const raw = Array.isArray(input.files) ? input.files : [];
  const files = raw.slice(0, 50).map((f) => {
    const r = (f ?? {}) as Record<string, unknown>;
    const name = String(r.name ?? "").trim().slice(0, 200);
    const sid = Number(r.source_id);
    return { name, ...(Number.isInteger(sid) && sid > 0 ? { source_id: sid } : {}) };
  }).filter((f) => f.name);
  if (!files.length) throw new HttpError(400, "올린 파일이 없습니다");
  return files;
}

/** 화면이 센 개수 — 음수 · 소수 · 글자는 0 으로, 상한 1000(말에 실리는 숫자라 터무니없는 값을 막는다). */
const countOf = (v: unknown): number => { const n = Number(v); return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 0; };

const uploadInput = {
  label: z.string().optional().describe("올리는 자리의 이름(예: 회의록 파일)."),
  why: z.string().optional().describe("왜 필요한지 한 줄."),
  accept_hint: z.string().optional().describe("어떤 파일을 올리면 되는지 한 줄."),
  cancel: z.boolean().optional().describe("true 면 이 세션에서 걸어 둔 올리기 요청을 내린다."),
};

export const uploadAskKind: AskKind = {
  kind: "upload",
  label: "파일 올리기",
  tool: {
    name: "session_ask_upload",
    title: "파일 올리기 요청",
    description:
      "이 세션 화면 오른쪽 «요청» 칸에 **파일 올리는 자리**를 띄운다. 사람이 올린 파일은 자료(source)로 저장되고, 무엇이 올라갔는지(이름 · 자료 id)가 이 세션에 한 마디로 들어온다 — " +
      "내용은 source_get 으로 읽는다. 로컬 터미널처럼 그 화면이 안 보이는 자리면 응답의 url 을 사람에게 준다 — 누르면 그 자리로 바로 간다. " +
      "⚠ 사람 컴퓨터의 폴더를 뒤지려 하지 마라 — 파일 몇 개면 이게 훨씬 간편하다. 글자 파일만 된다(문서 · 메모 · 마크다운 · CSV).",
    input: uploadInput,
  },
  aliases: [{ name: "me_liv_ask_upload", title: "파일 올리기 요청(옛 이름)", restPath: "/api/ui/me/liv-upload-ask" }],

  async open(input) {
    const p: UploadAskPayload = {
      at: new Date().toISOString(), kind: "upload",
      label: String(input.label ?? "").trim().slice(0, 80) || "파일 올리기",
      why: String(input.why ?? "").trim().slice(0, 300) || undefined,
      accept_hint: String(input.accept_hint ?? "").trim().slice(0, 120) || undefined,
    };
    return { payload: p as unknown as Record<string, unknown>, slot: `label:${p.label}` };
  },

  title: (p) => String(p.label ?? "파일 올리기"),

  async submit(_ask, input) {
    const files = uploadedFiles(input);
    const names = files.slice(0, 10).map((f) => (f.source_id ? `${f.name}(자료 ${f.source_id})` : f.name)).join(", ");
    //  못 올린 것(올리다 실패 · 글자 파일이 아니라 건너뜀)이 있으면 몇 개인지도 전한다 — 안 전하면 AI 는 사람이 고른 것이 다 올라온 줄 안다.
    const missed = countOf(input.failed) + countOf(input.skipped);
    return {
      result: { count: files.length, files, ...(missed ? { failed: countOf(input.failed), skipped: countOf(input.skipped) } : {}) },
      say: `파일 ${files.length}개 올렸어요: ${names}${files.length > 10 ? " …" : ""}${missed ? ` (고른 것 중 ${missed}개는 올리지 못했어요)` : ""}`,
    };
  },
};
