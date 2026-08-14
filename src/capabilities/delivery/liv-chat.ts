// delivery ▸ liv-chat — 리브와의 대화 한 턴(#1631 v1). 터미널을 걷어내고 말풍선으로 가기 위한 서버쪽.
//
//  ── 왜 위탁(delegate)에 안 얹었나 ──
//  기획은 "턴마다 위탁 태스크"를 권고했지만 org_task 는 **배치 계약**이다: 실패하면 자동 재시도(같은
//  부작용이 두 번 난다) · 가용 노드 없으면 no_capacity(사람이 말을 걸었는데 할 답이 아니다) · 타임아웃 1시간.
//  그래서 턴은 org_task 행을 만들지 않고 **spawnTaskSession 만** 직접 쓴다 — 워크스페이스 해석 · 멤버 OS
//  유저 격리 · tmux 감독 · 자격 리스는 그대로 얻고, 배치 의미만 안 탄다.
//  (노드 위탁은 나중에 "내 PC 에서 리브 돌리기"로 열린다. 그때 쓸 seam 은 이미 공용이다.)
//
//  ── 왜 개인 루트의 liv 폴더인가 ──
//  세션 시작 훅의 리브 게이트가 `basename(cwd) === "liv"` 다. 그 폴더에서 돌아야 리브가 리브가 되고,
//  웹터미널 리브 세션과 **같은 자리**라 두 표면이 한 대화로 보인다.
//
//  ── 안전 자세 ──
//  승인 우회를 쓰지 않는다. 경계는 `--disallowedTools`(liv-turn.ts 의 실측 참조)이고, 이 파일은 그 인자를
//  만들지 않는다 — livTurnArgs 하나만 부른다. 안전선이 한 자리에 있어야 약해질 때 눈에 띈다.
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";
import { livTurnArgs } from "../../org/delivery/liv-turn.js";

/** 한 턴 프롬프트 상한 — 사람이 채팅창에 치는 양이다(자료 본문은 올리기로 간다). */
const TURN_MAX = 8000;
/** 턴 id 는 **우리가 만든 hex 뿐**이다. 사람이 준 값이 폴더 이름이 되면 그 자리가 곧 경로 이동이다. */
const TURN_ID_RE = /^t[0-9a-f]{16}$/;

const newTurnId = (): string => `t${crypto.randomBytes(8).toString("hex")}`;

/** 이 사람의 리브 대화 폴더 안에서 그 턴의 작업 폴더. 남의 것은 구조상 가리킬 수 없다
 *  (루트가 principal 로 해석되고, 턴 id 는 화이트리스트 정규식을 통과한 hex 뿐이다). */
async function turnDir(user: LivelyUser, turnId: string): Promise<string> {
  if (!TURN_ID_RE.test(turnId)) throw new HttpError(400, "턴 id 형식이 아닙니다");
  const { resolveRootPath } = await import("../../terminal/profiles.js");
  const { ensureMemberOsUser } = await import("../../terminal/profiles.js");
  const osUser = await ensureMemberOsUser(user).catch(() => null);
  const { abs } = await resolveRootPath(user, "personal", "liv", osUser ?? null);
  return path.join(abs, ".lively-task", turnId);
}

export const livChatCapabilities: Capability[] = [
  restRead("me_liv_turn", "리브에게 말 걸기(한 턴)",
    "리브와의 대화 한 턴을 시작한다. 헤드리스로 돌고 진행은 me_liv_turn_log 로 이어 읽는다. " +
    "첫 턴은 새 대화를 만들고, 이후 턴은 같은 대화를 이어받는다(restart:true 로 새로 시작). " +
    "⚠ 리브는 승인 우회 없이 돈다 — 셸·파일·바깥 도구가 세션에 아예 없고 라이블리 도구만 있다.",
    [{ method: "POST", paths: ["/api/ui/me/liv/turn"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const text = String(input.text ?? "").trim();
      if (!text) throw new HttpError(400, "할 말이 비어 있습니다");
      if (text.length > TURN_MAX) throw new HttpError(400, `한 번에 보낼 수 있는 글자 수를 넘었습니다(${text.length} > ${TURN_MAX})`);

      const { getLivProfile, setLivChat } = await import("../../org/store.js");
      const prof = await getLivProfile(userId);
      // 이어갈 대화가 있으면 이어받고, 없거나 restart 면 새로 만든다.
      //  ⚠ 첫 턴과 이어가는 턴은 **주는 플래그가 다르다**(--session-id ↔ --resume). 이걸 뒤집으면
      //   "리브가 방금 한 말을 잊는다"(--resume 누락) 또는 "없는 대화를 이어받으려다 죽는다"가 된다.
      const restart = input.restart === true;
      const prev = restart ? null : (prof.chat ?? null);
      const sessionId = prev?.session_id ?? crypto.randomUUID();
      const resume = !!prev;

      const turnId = newTurnId();
      const { spawnTaskSession } = await import("../../node/tasks.js");
      await spawnTaskSession({
        user, taskId: turnId, rootKey: "personal", subpath: "liv",
        prompt: text, harness: "claude",
        extraFlags: livTurnArgs({ sessionId, resume }),
        bypassPermissions: false,   // ⚠ 리브의 안전선. 이 줄이 사라지면 사람 앞에서 승인 없이 돈다.
      });

      // 스폰이 성공한 뒤에 기억한다 — 실패한 턴의 세션 id 를 남기면 다음 턴이 없는 대화를 이어받으려 한다.
      if (!resume) await setLivChat(userId, { session_id: sessionId, started_at: new Date().toISOString() });
      return { turn_id: turnId, resumed: resume };
    },
    false,  // mcp:false — 이건 **화면이 리브를 부르는 문**이다. 리브가 자기를 다시 부르면 턴이 겹쳐 돈다.
    {
      // ⚠ text 에 zod .max() 를 두지 않는다 — 상한 초과는 핸들러가 "몇 자 넘었는지"를 말해 주는 게 낫다.
      //  스키마에서 튕기면 SDK 가 핸들러 앞에서 거절해 사람은 이유 없는 실패만 본다(#1442 의 취지).
      text: z.string().describe("리브에게 할 말(한 턴)"),
      restart: z.boolean().optional().describe("true 면 이어가던 대화를 놓고 새로 시작한다"),
    }),

  restRead("me_liv_turn_log", "리브 턴 진행 읽기",
    "그 턴의 진행 스트림(JSONL)을 바이트 오프셋부터 이어 읽는다. done=true 면 끝난 것이고 exit 로 성패를 안다. " +
    "화면은 이 청크를 말풍선·액션카드로 그린다(원문은 버리지 않고 접는다 — 펼치면 '진짜 했다'의 증거다).",
    [{ method: "GET", paths: ["/api/ui/me/liv/turn/:id"], parse: (req) => ({
      id: String(req.params?.id ?? ""), from: req.query?.from ? Number(req.query.from) : 0,
    }) }],
    async (input: { id: string; from: number }, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      const dir = await turnDir(user, input.id);
      const { tailTask } = await import("../../node/tasks.js");
      const from = Number.isFinite(input.from) && input.from >= 0 ? Math.floor(input.from) : 0;
      return await tailTask(dir, from);
    },
    false,  // mcp:false — 화면이 자기가 띄운 턴을 따라 읽는 문이다.
    {
      id: z.string().describe("턴 id(me_liv_turn 이 준 값)"),
      from: z.number().optional().describe("이어 읽기 시작할 바이트 오프셋(기본 0)"),
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

  restRead("me_liv_chat_reset", "리브와 새 대화 시작",
    "지금 이어가던 대화를 놓는다. 다음 턴이 첫 턴이 된다(이전 대화 기록은 지우지 않는다 — 이어받기만 끊는다).",
    [{ method: "POST", paths: ["/api/ui/me/liv/chat-reset"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { setLivChat } = await import("../../org/store.js");
      return { profile: await setLivChat(userId, null) };
    }),
];
