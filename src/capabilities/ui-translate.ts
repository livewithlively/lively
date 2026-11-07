// 화면 글 영어 보기(#5141) — 화면 토글이 보이는 한국어 글 묶음을 보내면 영어를 돌려준다. 흐름·판정은 ui-translate/translate.ts.
//  REST 만(POST /api/ui/translate) — AI 도구로 낼 까닭이 없다(AI 는 영어를 스스로 쓴다). 로그인한 사람의 화면만 부른다(앱 토큰은 거절).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { RateWindow } from "../apps/app-chat-send.js";

/** 사람마다 1분에 묶음 120번 — 화면은 작은 묶음(20줄 · 1,200자)을 한꺼번에 보내 빨리 붙인다. 묶음이 작아 고장 난 화면도 키를 크게 태우지는 못한다. */
const perMember = new RateWindow(120);

const uiTranslate: Capability = {
  name: "ui_translate",
  title: "화면 글 번역",
  description: "화면에 보이는 한국어 글 묶음을 영어로 바꿔 돌려준다(화면 영어 보기 토글 전용 · 저장된 데이터는 바꾸지 않는다). 워크스페이스 API 키로 작은 모델을 한 번 부르고, 같은 글은 메모리에서 답한다.",
  scope: null,
  input: {
    texts: z.array(z.string()).describe("번역할 글 — 화면에 보이는 그대로(한 번에 120개 · 글 하나 2,000자 · 합 24,000자까지)"),
    to: z.enum(["en"]).optional().describe("바꿀 말 — 지금은 en 하나"),
  },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/translate"], parse: (req) => ({ texts: (req.body ?? {}).texts, to: (req.body ?? {}).to }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (user.appId) throw new HttpError(403, "앱에서는 화면 번역을 부를 수 없습니다");
    const t = await import("../ui-translate/translate.js");
    const v = t.validateTexts(input.texts);
    if ("error" in v) throw new HttpError(400, v.error);
    if (!perMember.take(user.userId, Date.now())) throw new HttpError(429, "화면 번역을 너무 자주 불렀습니다 — 잠시 뒤 다시 시도하세요");
    try {
      return await t.translateTexts(v.texts, "en", await t.liveTranslateDeps());
    } catch (e) {
      if (e instanceof t.NoApiKeyError) throw new HttpError(501, e.message);
      throw e;
    }
  },
};

export const uiTranslateCapabilities: Capability[] = [uiTranslate];
