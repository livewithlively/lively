// 세션 요청 ▸ 객관식(#1631 → #5713) — **사람은 고르기만, 답은 저절로 구조화**.
//
//  실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("지금까지 어디에 쌓고 계셨나요?"). 없는 말을 지어내야 해서 어렵고,
//   답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다.
//  ⚠ `key` 는 통계의 축이다(org_liv_answers) — 주면 그 답이 구성원 답 집계에 쌓인다. 문구를 다듬어도 key 는 바꾸지 마라(집계가 갈라진다).
//   key 를 안 주면 집계에 남기지 않는다 — 일하다 한 번 묻는 것(«A 안 / B 안?»)까지 통계에 쌓으면 축이 흐려진다.
//  종전(#1631)엔 리브 도구(me_liv_ask_choice · me_liv_answer)였다. 어느 세션이든 쓰게 풀면서(#5713) 이리로 옮겼다.
import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../http-error.js";
import { logger } from "../../log.js";
import type { AskKind } from "../kinds.js";

export interface ChoiceAskPayload {
  at: string;
  kind: "choice";
  /** 통계 축(선택) — 있으면 답이 구성원 답 집계에 쌓인다. */
  key?: string;
  question: string;
  why?: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  multi?: boolean;
  allow_other?: boolean;
}

const SLUG = /^[a-z0-9_.-]+$/;

/** 입력 검증 → payload. 순수(시각만 읽는다) — 거절은 HttpError 400. */
export function choiceAskPayload(input: Record<string, unknown>): ChoiceAskPayload {
  const key = String(input.key ?? "").trim().slice(0, 60);
  const question = String(input.question ?? "").trim().slice(0, 300);
  if (key && !SLUG.test(key)) throw new HttpError(400, "key 는 소문자·숫자·_.- 만 씁니다(통계 축이라 안정적이어야 합니다)");
  if (!question) throw new HttpError(400, "question 이 필요합니다");
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = raw.slice(0, 12).map((o) => {
    const r = (o ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? "").trim().slice(0, 40);
    const label = String(r.label ?? "").trim().slice(0, 80);
    if (!SLUG.test(id) || !label) throw new HttpError(400, "각 선택지에는 id(소문자 슬러그)와 label 이 필요합니다");
    const hint = String(r.hint ?? "").trim().slice(0, 120);
    return hint ? { id, label, hint } : { id, label };
  });
  if (options.length < 2) throw new HttpError(400, "선택지는 2개 이상이어야 합니다");
  if (new Set(options.map((o) => o.id)).size !== options.length) throw new HttpError(400, "선택지 id 가 중복입니다");
  return {
    at: new Date().toISOString(), kind: "choice", ...(key ? { key } : {}), question,
    why: String(input.why ?? "").trim().slice(0, 300) || undefined,
    options, multi: input.multi === true, allow_other: input.allow_other === true,
  };
}

/**
 * 화면이 보낸 답을 저장된 질문에 대어 본다 — 순수. ⚠ 무엇을 골랐는지는 **저장된 선택지 안에서만** 인정한다(브라우저가 임의 값을
 *  넣어 집계를 오염시키지 못하게). 목록 밖은 other(자유입력)로만 들어온다.
 */
export function choiceAnswer(p: ChoiceAskPayload, input: Record<string, unknown>): { choices: string[]; labels: string[]; other?: string } {
  const valid = new Set(p.options.map((o) => o.id));
  const picked = [...new Set((Array.isArray(input.choices) ? input.choices : []).map(String).filter((c) => valid.has(c)))];
  const other = p.allow_other ? String(input.other ?? "").trim().slice(0, 200) : "";
  if (!picked.length && !other) throw new HttpError(400, "하나 이상 고르거나 직접 적어 주세요");
  if (!p.multi && picked.length > 1) throw new HttpError(400, "이 질문은 하나만 고를 수 있습니다");
  //  단일 선택은 답이 하나다 — 선택지와 직접 적은 것이 같이 오면 무엇이 답인지 알 수 없다.
  if (!p.multi && picked.length && other) throw new HttpError(400, "이 질문은 하나만 고를 수 있습니다");
  const labels = p.options.filter((o) => picked.includes(o.id)).map((o) => o.label);
  return { choices: picked, labels, ...(other ? { other } : {}) };
}

/** 구성원 답 집계에 쌓는 이음매(시험이 바꿔 끼운다) — 실제 구현은 리브 프로필의 answers(org/store appendLivAnswer). */
export const choiceDeps = {
  appendAnswer: async (userId: string, answer: { at: string; key: string; question: string; choices: string[]; other?: string; by: "self" }): Promise<void> => {
    const { appendLivAnswer } = await import("../../org/store.js");
    await appendLivAnswer(userId, answer);
  },
};

const choiceInput = {
  key: z.string().optional().describe("통계 축이 되는 안정된 key(예: context_sources) — 주면 답이 구성원 답 집계에 쌓인다. 일하다 한 번 묻는 것이면 생략한다."),
  question: z.string().optional().describe("사람에게 보일 질문 한 줄."),
  why: z.string().optional().describe("왜 묻는지 한 줄."),
  options: z.array(z.object({ id: z.string(), label: z.string(), hint: z.string().optional() })).optional()
    .describe("선택지 2~12개. id 는 소문자 슬러그(집계 값), label 은 사람 말."),
  multi: z.boolean().optional().describe("복수 선택 허용(쓰는 도구를 다 고르기 등)."),
  allow_other: z.boolean().optional().describe("'그 외' 자유입력 허용 — 목록에 없는 것을 놓치지 않는다."),
  cancel: z.boolean().optional().describe("true 면 이 세션에서 걸어 둔 객관식 질문을 내린다."),
};

export const choiceAskKind: AskKind = {
  kind: "choice",
  label: "고르기",
  tool: {
    name: "session_ask_choice",
    title: "객관식으로 묻기",
    description:
      "이 세션 화면 오른쪽 «요청» 칸에 **고르는 질문**을 띄운다. 사람이 고르면 그 답이 이 세션에 한 마디로 들어온다(안 들어오는 자리면 session_ask_status 로 읽는다). " +
      "로컬 터미널처럼 그 화면이 안 보이는 자리면 응답의 url 을 사람에게 준다 — 누르면 그 질문으로 바로 간다. " +
      "⚠ 사람에게 자유서술을 시키지 마라 — 없는 말을 지어내는 건 어렵다. 선택지를 주는 게 기본이다. " +
      "목록에 없을 수 있으면 allow_other 로 탈출구를 열어라. " +
      //  #5058 원준님 2026-10-27 — «현재 Codex 로그인을 암호화 금고에 연결할까요? 자동 정리 작업이 무인으로 실행되려면
      //   codex_auth_json 자격이 필요합니다» 가 떴다. 처음 온 사람은 무엇을 고르는지도, 그게 중요한지도 모른다.
      "⚠ question·why·label·hint 는 **개발을 모르는 사람이 읽는 말**로 쓴다. 내부 이름(도구·자격 kind·필드 이름 — 예: codex_auth_json)과 " +
      "전문용어(금고·자격·무인·헤드리스·증류·하네스·토큰·스코프)를 쓰지 말고, 고르면 **그 사람에게 무엇이 달라지는지**를 말한다. " +
      "예: «현재 Codex 로그인을 금고에 연결할까요?» 가 아니라 «화면을 닫아 두셔도 모은 자료를 계속 정리해 둘까요?» · why «지금 로그인한 ChatGPT 계정으로 정리합니다. " +
      "로그인 정보는 잠긴 보관함에 암호로 바꿔 둡니다.» · 선택지 «네, 계속 정리해 주세요»(hint «권장 — 끄면 제가 이 대화에 있을 때만 정리합니다») / «아니요, 지금은 됐어요». " +
      //  #5062 — «첫 서랍 ‘운영·인프라’를 이 정의로 만들까요?» 가 떴다. 앞 맥락이 있어야 뜻이 서는 말도 같은 병이다.
      "질문은 이 대화를 처음 보는 사람이 그것만 보고 알아들어야 한다 — 무엇을 정하는지·왜 지금 묻는지·고르면 각각 무슨 일이 생기는지. " +
      "«서랍»·«레인»·«배치» 같은 화면에 없는 말, «첫 ○○»·«이 정의로»·«다시 실행» 처럼 앞 맥락이 있어야 뜻이 서는 말을 쓰지 마라.",
    input: choiceInput,
  },
  aliases: [{ name: "me_liv_ask_choice", title: "객관식으로 묻기(옛 이름)", restPath: "/api/ui/me/liv-choice-ask" }],

  async open(input) {
    const p = choiceAskPayload(input);
    //  같은 key(없으면 같은 질문)를 다시 물으면 앞 질문을 내리고 갈아 끼운다.
    const slot = p.key ? `key:${p.key}` : `q:${crypto.createHash("sha256").update(p.question).digest("hex").slice(0, 16)}`;
    return { payload: p as unknown as Record<string, unknown>, slot };
  },

  title: (p) => String(p.question ?? "고르기"),

  async submit(ask, input, who) {
    const p = ask.payload as unknown as ChoiceAskPayload;
    const a = choiceAnswer(p, input);
    if (p.key) {
      // 통계 축이 있는 질문 — 구성원 답 집계(org_liv_answers)에 쌓는다. 같은 key 는 최신 하나로 갈린다(appendLivAnswer).
      //  ⚠ 집계는 곁가지다 — 답의 정본은 이 요청의 result 다. 집계 쓰기가 실패해도(구성원 행이 없는 토큰 등) 답은 받는다:
      //   여기서 던지면 사람은 고른 것이 «오류» 로 돌아오고 요청이 열린 채 남아 AI 가 계속 기다린다.
      try {
        await choiceDeps.appendAnswer(who.userId, {
          at: new Date().toISOString(), key: p.key, question: p.question,
          choices: a.choices, ...(a.other ? { other: a.other } : {}), by: "self",
        });
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, member: who.userId, key: p.key }, "객관식 답을 구성원 답 집계에 쌓지 못함(비치명 — 답은 요청에 남는다)");
      }
    }
    const said = [...a.labels, ...(a.other ? [a.other] : [])].join(", ");
    return {
      result: { ...(p.key ? { key: p.key } : {}), choices: a.choices, labels: a.labels, ...(a.other ? { other: a.other } : {}) },
      // 사람이 다시 타이핑하지 않아도 대화가 이어지게 — 무엇을 물었고 무엇을 골랐는지 그대로 말해 준다.
      say: `«${p.question}» — ${said}`,
    };
  },
};
