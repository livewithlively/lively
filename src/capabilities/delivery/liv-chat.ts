// delivery ▸ liv-chat — 리브 탭이 부르는 창구(#1631 · #4032). 리브는 **진짜 세션**이다(org/liv/session.ts).
//
//  ── 무엇이 바뀌었나(#4032, 상민님 결정 2026-09-16) ──
//  종전엔 리브 탭의 한 마디가 헤드리스 한 턴이었다(me_liv_turn → spawnTaskSession). 그 경로는 게이트웨이가 도는 기계의 tmux 를
//  직접 불러, 세션을 노드의 세션 컨테이너에 띄우는 매니지드에서는 한 번도 안 떴다(500 — 판이 sudo 에서 즉사, 다음 set-option 이
//  «no server running»). 이제 리브 탭은 그 사람의 리브 세션 하나를 찾아(없으면 첫 말로 연다) **그 세션 대화창**을 붙인다.
//  말 보내기·멈춤·되살리기·되그리기는 전부 세션 대화창(web/session-chat.ts)의 것을 그대로 쓴다 — 여기엔 좌표 두 개만 남는다.
//
//  ── mcp:false ──
//  이 문들은 **화면이 리브를 여는 자리**다. 리브가 자기를 다시 부르면 세션이 겹쳐 선다.
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";
import { LIV_PROMPT_MAX, currentLivSessionId, ensureLivSession } from "../../org/liv/session.js";

/** (순수) 첫 말 검사 — 비었으면 400, 상한을 넘으면 몇 자 넘었는지 말하는 400. 통과하면 다듬은 글. */
export function livFirstWords(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new HttpError(400, "할 말이 비어 있습니다");
  if (text.length > LIV_PROMPT_MAX) throw new HttpError(400, `한 번에 보낼 수 있는 글자 수를 넘었습니다(${text.length} > ${LIV_PROMPT_MAX})`);
  return text;
}

export const livChatCapabilities: Capability[] = [
  restRead("me_liv_session", "리브 세션 찾기",
    "이 사람이 이 워크스페이스에서 이어 가는 리브 세션 id(없으면 null). 세션이 복원돼 id 가 바뀌었으면 이어진 id 를 준다. " +
    "화면은 이 id 의 세션 대화창을 리브 탭에 붙인다.",
    [{ method: "GET", paths: ["/api/ui/me/liv/session"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      //  조회는 읽기만 한다(heal:false) — 옛 좌표 고쳐 적기는 첫 말·2턴 스윕이 한다.
      return { session_id: await currentLivSessionId(userId, { heal: false }) };
    }),

  restRead("me_liv_session_open", "리브에게 첫 말 걸기",
    "리브 세션이 없으면 이 말을 첫 지시로 세션을 연다(created:true — session 에 생성 응답 한 장). " +
    "이미 있으면 그 세션 id 만 돌려주고 말은 넣지 않는다(created:false) — 화면이 그 세션 대화창에서 보낸다.",
    [{ method: "POST", paths: ["/api/ui/me/liv/session"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const text = livFirstWords(input.text);
      try {
        return await ensureLivSession(user, text);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        //  세션을 못 연 이유를 사람에게 그대로 말한다 — 이 자리의 실패가 500 «internal_error» 로 뭉개져 원인을 못 찾은 것이 #4032 였다.
        throw new HttpError(503, `리브를 열지 못했습니다 — ${(e as Error)?.message ?? e}`, { cause: e });
      }
    },
    false,
    {
      // ⚠ text 에 zod .max() 를 두지 않는다 — 상한 초과는 핸들러가 "몇 자 넘었는지"를 말해 주는 게 낫다(#1442).
      text: z.string().describe("리브에게 할 첫 말"),
    }),

  restRead("me_liv_ask_dismiss", "물음 접어두기",
    "리브가 걸어 둔 물음(자격·객관식·올리기)을 **사람이 지금은 안 하겠다**고 접는다. " +
    "접은 사실을 declined 에도 남겨, 다음 대화의 리브가 같은 걸 곧바로 다시 묻지 않게 한다.",
    [{ method: "POST", paths: ["/api/ui/me/liv/ask-dismiss"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile, setLivSecretAsk, appendLivProfile } = await import("../../org/store.js");
      const cur = await getLivProfile(userId);
      const ask = cur.secret_ask ?? null;
      if (!ask) return { ask: null, dismissed: false };
      // 무엇을 접었는지 남긴다 — 안 남기면 다음 턴의 리브가 같은 걸 또 묻고, 그게 잔소리가 된다.
      // kind 별로 식별자가 다르다(객관식=key · 자격=field · 올리기=없음). 셋 다 같은 모양의 키로 접는다.
      const a = ask as unknown as { kind?: string; key?: string; field?: string };
      const key = `ask.${a.kind ?? "secret"}.${a.key ?? a.field ?? ""}`.replace(/\.$/, "");
      await appendLivProfile(userId, {
        declined: { at: new Date().toISOString(), key, why: "지금은 안 하겠다고 화면에서 접음" },
      });
      return { ask: null, dismissed: true, profile: await setLivSecretAsk(userId, null) };
    }),
];
