// delivery ▸ project-chat — 새 셸 프로젝트 화면의 **리브 대화**(#1757). 홈 리브(liv-chat.ts)와 같은 기계(헤드리스 한 턴 =
//  채팅 한 턴, 진행은 파일 tail)를 **프로젝트 폴더에서** 돌린다.
//
//  ── 홈 리브와 무엇이 같고 다른가 ──
//  같다: spawnTaskSession(승인 우회 없음 · 셸·파일·바깥 도구 없음 = livTurnArgs 의 거부 목록) · 진행 tail · 멈춤 · 되그리기 목차.
//  다르다: ① cwd 가 그 프로젝트의 공유 폴더 → 그 프로젝트의 CLAUDE.md/AGENTS.md 와 라이블리 맥락을 그대로 받는다.
//          ② 페르소나(프로젝트 도우미)는 시스템 프롬프트 조각(project-chat-prompt.ts)으로 — 사람 말·기록을 더럽히지 않는다.
//          ③ 대화는 (프로젝트 × 사람)마다 하나(v6/project-chat-store.ts) — 격리 OS 유저 아래 도는 세션이라 남이 이어받을 수 없다.
//          ④ 턴이 끝나면 그 박스 세션(exec $SHELL 로 남는 껍데기)을 바로 거둔다 — 위탁처럼 사후 검시가 필요 없고,
//             사이드바의 그 프로젝트 아래에 빈 셸 행이 쌓이면 안 된다.
//
//  ── 접근 ──
//  프로젝트를 볼 수 있는 사람(project_get_v6 와 같은 가시성 게이트)만. 남의 대화는 구조상 못 건드린다(member_id = 늘 본인).
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";
import { livTurnArgs } from "../../org/delivery/liv-turn.js";
import { projectChatPersona } from "../../org/delivery/project-chat-prompt.js";
import { getProject } from "../../v6/project-store.js";
import { appendProjectChatTurn, getProjectChat, startProjectChat } from "../../v6/project-chat-store.js";

/** 한 턴 프롬프트 상한 — 홈 리브(liv-chat.ts)와 같다. */
const TURN_MAX = 8000;
/** 턴 id 는 **우리가 만든 hex 뿐** — 사람이 준 값이 폴더 이름이 되면 그 자리가 곧 경로 이동이다. */
const TURN_ID_RE = /^t[0-9a-f]{16}$/;
const newTurnId = (): string => `t${crypto.randomBytes(8).toString("hex")}`;

const parseId = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "프로젝트 id 가 아닙니다");
  return n;
};

/** 프로젝트를 볼 수 있는가 — project_get_v6 와 같은 게이트. 비대상은 404(존재를 숨긴다). */
async function visibleProject(id: number, viewer: any): Promise<{ id: number; name: string; folder: string | null }> {
  const p = await getProject(id, viewer ?? null);
  if (!p) throw new HttpError(404, `프로젝트 #${id} 없음`);
  return { id: Number(p.id), name: String(p.name ?? ""), folder: (p as any).folder ? String((p as any).folder) : null };
}

/** 이 프로젝트 대화의 턴이 도는 자리(공유 루트 하위 프로젝트 폴더). folder 는 서버가 준 값만 믿는다 —
 *  없는 옛 프로젝트만 project/<id> 로 접는다(project-fs 관례. 완료 프로젝트는 legacy-project/ 로 옮겨지므로 값이 있으면 그 값). */
const projectSub = (p: { id: number; folder: string | null }): string => p.folder || `project/${p.id}`;

/** 그 턴의 작업 폴더(<프로젝트 폴더>/.lively-task/<turnId>). 숨김 폴더라 공유 폴더 목록·매니페스트엔 안 잡힌다. */
async function turnDir(user: LivelyUser, p: { id: number; folder: string | null }, turnId: string): Promise<string> {
  if (!TURN_ID_RE.test(turnId)) throw new HttpError(400, "턴 id 형식이 아닙니다");
  const { resolveRootPath, ensureMemberOsUser } = await import("../../terminal/profiles.js");
  const osUser = await ensureMemberOsUser(user).catch(() => null);
  const { abs } = await resolveRootPath(user, "shared", projectSub(p), osUser ?? null);
  return path.join(abs, ".lively-task", turnId);
}

export const projectChatCapabilities: Capability[] = [
  restRead("project_chat_turn", "프로젝트 화면에서 리브에게 말 걸기(한 턴)",
    "그 프로젝트의 리브 대화 한 턴을 시작한다(#1757). 프로젝트 폴더에서 헤드리스로 돌고 진행은 project_chat_turn_log 로 이어 읽는다. " +
    "첫 턴은 새 대화를 만들고 이후 턴은 이어받는다(restart:true 로 새로). 도구 경계는 홈 리브와 같다(셸·파일·바깥 없음, 라이블리 도구만).",
    [{ method: "POST", paths: ["/api/ui/v6/projects/:id/chat/turn"], parse: (req) => ({ ...(req.body ?? {}), id: parseId(req.params?.id) }) }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: any) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const p = await visibleProject(parseId(input.id), ctx?.viewer);
      const text = String(input.text ?? "").trim();
      if (!text) throw new HttpError(400, "할 말이 비어 있습니다");
      if (text.length > TURN_MAX) throw new HttpError(400, `한 번에 보낼 수 있는 글자 수를 넘었습니다(${text.length} > ${TURN_MAX})`);

      const restart = input.restart === true;
      const prev = restart ? null : await getProjectChat(p.id, userId);
      const sessionId = prev?.session_id ?? crypto.randomUUID();
      const resume = !!prev;

      const turnId = newTurnId();
      const { spawnTaskSession } = await import("../../node/tasks.js");
      const spawned = await spawnTaskSession({
        user, taskId: turnId, rootKey: "shared", subpath: projectSub(p),
        prompt: text, harness: "claude",
        extraFlags: livTurnArgs({ sessionId, resume }),
        bypassPermissions: false,   // ⚠ 홈 리브와 같은 안전선. 이 줄이 사라지면 사람 앞에서 승인 없이 돈다.
        systemPrompt: projectChatPersona({ id: p.id, name: p.name }),
        label: "리브 · 프로젝트 대화",
      });

      // 스폰이 성공한 뒤에 기억한다(실패한 턴의 세션 id 를 남기면 다음 턴이 없는 대화를 이어받으려 한다).
      const now = new Date().toISOString();
      if (!resume) await startProjectChat(p.id, userId, sessionId);
      await fsp.writeFile(path.join(spawned.taskDir, "session"), spawned.sessionId, "utf8").catch(() => { /* best-effort */ });
      await appendProjectChatTurn(p.id, userId, { id: turnId, text, at: now, sid: spawned.sessionId });
      return { turn_id: turnId, resumed: resume };
    },
    false,  // mcp:false — 화면이 리브를 부르는 문이다. 리브가 자기를 다시 부르면 턴이 겹쳐 돈다.
    {
      id: z.number().int().positive().describe("프로젝트 id"),
      text: z.string().describe("리브에게 할 말(한 턴)"),
      restart: z.boolean().optional().describe("true 면 이어가던 대화를 놓고 새로 시작한다"),
    }),

  restRead("project_chat_turn_log", "프로젝트 리브 턴 진행 읽기",
    "그 턴의 진행 스트림(JSONL)을 바이트 오프셋부터 이어 읽는다. done=true 면 끝난 것(exit 로 성패). 끝난 턴의 박스 세션은 여기서 거둔다.",
    [{ method: "GET", paths: ["/api/ui/v6/projects/:id/chat/turn/:tid"], parse: (req) => ({
      id: parseId(req.params?.id), tid: String(req.params?.tid ?? ""), from: req.query?.from ? Number(req.query.from) : 0,
    }) }],
    async (input: { id: number; tid: string; from: number }, user: LivelyUser, ctx?: any) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      const p = await visibleProject(input.id, ctx?.viewer);
      const dir = await turnDir(user, p, input.tid);
      const { tailTask, killTaskSession } = await import("../../node/tasks.js");
      const from = Number.isFinite(input.from) && input.from >= 0 ? Math.floor(input.from) : 0;
      const tail = await tailTask(dir, from);
      // 끝난 턴의 껍데기 세션(exec $SHELL)을 거둔다 — 파일이 정본이라 세션은 더 필요 없다. 멱등(이미 없으면 무시).
      //  Stop 훅의 중앙 기록 캡처는 하네스가 끝나는 순간(exit 파일보다 먼저) 이미 돌았다.
      if (tail.done) {
        const sid = (await fsp.readFile(path.join(dir, "session"), "utf8").catch(() => "")).trim();
        if (sid) await killTaskSession(sid).catch(() => { /* 이미 없음 */ });
      }
      return tail;
    },
    false,
    {
      id: z.number().int().positive().describe("프로젝트 id"),
      tid: z.string().describe("턴 id(project_chat_turn 이 준 값)"),
      from: z.number().optional().describe("이어 읽기 시작할 바이트 오프셋(기본 0)"),
    }),

  restRead("project_chat_turn_stop", "프로젝트 리브 턴 멈추기",
    "돌고 있는 턴을 멈춘다. 이미 끝난 턴이면 아무 일도 안 한다.",
    [{ method: "POST", paths: ["/api/ui/v6/projects/:id/chat/turn/:tid/stop"], parse: (req) => ({ id: parseId(req.params?.id), tid: String(req.params?.tid ?? "") }) }],
    async (input: { id: number; tid: string }, user: LivelyUser, ctx?: any) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const p = await visibleProject(input.id, ctx?.viewer);
      if (!TURN_ID_RE.test(input.tid)) throw new HttpError(400, "턴 id 형식이 아닙니다");
      // 세션 id 는 **본인 대화 목차에서만** 꺼낸다 — 남의 턴을 멈추는 길이 구조상 없다. 없으면 턴 폴더의 session 파일.
      const chat = await getProjectChat(p.id, userId);
      let sid = chat?.turns.find((t) => t.id === input.tid)?.sid ?? "";
      if (!sid) sid = (await fsp.readFile(path.join(await turnDir(user, p, input.tid), "session"), "utf8").catch(() => "")).trim();
      if (!sid) return { stopped: false, reason: "이 턴의 세션을 찾지 못했습니다 — 리브는 계속 일하고, 끝나면 화면이 풀립니다." };
      const { killTaskSession } = await import("../../node/tasks.js");
      await killTaskSession(sid).catch(() => { /* 이미 끝났다 — 멈추라는 뜻은 이미 이뤄졌다 */ });
      return { stopped: true };
    },
    false, { id: z.number().int().positive().describe("프로젝트 id"), tid: z.string().describe("멈출 턴 id") }),

  restRead("project_chat_get", "프로젝트 리브 대화(되그리기 목차)",
    "이 사람이 그 프로젝트에서 이어가고 있는 리브 대화와 턴 목록. 본문은 담지 않는다(각 턴의 진행을 project_chat_turn_log 로 읽어 그린다).",
    [{ method: "GET", paths: ["/api/ui/v6/projects/:id/chat"], parse: (req) => ({ id: parseId(req.params?.id) }) }],
    async (input: { id: number }, user: LivelyUser, ctx?: any) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const p = await visibleProject(input.id, ctx?.viewer);
      const chat = await getProjectChat(p.id, userId);
      return { chat: chat ? { session_id: chat.session_id, started_at: chat.started_at, turns: chat.turns.map((t) => ({ id: t.id, text: t.text, at: t.at })) } : null };
    },
    false, { id: z.number().int().positive().describe("프로젝트 id") }),
];
