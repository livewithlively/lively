// 지식/위키 UI 표면(#1313 R57) — 전역 뷰 설정·항목 속성 오버라이드·댓글/반응. 전부 웹 전용(mcp:false)이라
//  에이전트 툴 표면을 늘리지 않는다. 문서 '내용'이 아니라 '보여주는 방식·대화'를 다루는 축이다.
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import { getKnowledgeViewConfig, setKnowledgeViewConfig } from "../../v6/knowledge-view-config-store.js";
import {
  postKnowledgeComment, getKnowledgeCommentFeed, toggleKnowledgeCommentReaction, knowledgeNameOfComment,
} from "../../v6/knowledge-comment-store.js";
import { setKnowledgePropsUi } from "../../v6/knowledge-store.js";
import { assertKnowledgeVisible, assertKnowledgeWritable } from "./shared.js";

// ════════ #592 지식/위키 UI — 전역 뷰 설정·속성 오버라이드·댓글·트리 이동(REST 계약 §2). ════════

// 전역 뷰 설정 조회 — { hidden_props } 만(계약 고정). 프론트가 카탈로그 전체 − hidden_props 로 기본 노출 계산.
export const knowledgeViewGet: Capability = {
  name: "knowledge_view_get",
  title: "지식 뷰 설정 조회",
  description: "지식 속성 패널의 전역 기본 숨김 키(hidden_props)를 반환한다. 항목 단위 오버라이드는 knowledge.props_ui(knowledge_get 응답).",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-view-config"], parse: () => ({}) }],
  },
  handler: async () => ({ hidden_props: (await getKnowledgeViewConfig()).hidden_props }),
};

// 전역 뷰 설정 저장 — 전체 배열 교체(부분 병합 아님 — 팝오버가 전체 상태를 들고 있다). 감사 org_content_audit.
const knowledgeViewSetInput = { hidden_props: z.array(z.string().min(1).max(64)).max(64) };
type KnowledgeViewSetInput = z.infer<z.ZodObject<typeof knowledgeViewSetInput>>;
export const knowledgeViewSet: Capability = {
  name: "knowledge_view_set",
  title: "지식 뷰 설정 저장",
  description: "지식 속성 패널의 전역 기본 숨김 키(hidden_props)를 저장한다(전체 교체·감사 기록). 웹 전용.",
  scope: "memory",
  input: knowledgeViewSetInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-view-config"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const v = b.hidden_props;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          throw new HttpError(400, "hidden_props 는 문자열 배열이어야 합니다");
        }
        if (v.length > 64) throw new HttpError(400, "hidden_props 는 최대 64키까지 허용됩니다");
        return { hidden_props: v };
      } }],
  },
  handler: async (input: KnowledgeViewSetInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { hidden_props: (await setKnowledgeViewConfig(input.hidden_props, writeCtx)).hidden_props };
  },
};

// 지식 댓글 반응 토글 — {emoji}. 갱신된 emoji별 집계 반환(task_comment_reaction_v6 동형).
const knowledgeCommentReactionInput = { id: z.number().int().positive(), emoji: z.string().min(1) };
type KnowledgeCommentReactionInput = z.infer<z.ZodObject<typeof knowledgeCommentReactionInput>>;
export const knowledgeCommentReaction: Capability = {
  name: "knowledge_comment_reaction",
  title: "지식 댓글 반응",
  description: "지식 댓글(knowledge_comment)에 이모지 반응을 토글한다. {emoji}. 웹 전용.",
  scope: "memory",
  input: knowledgeCommentReactionInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-comments/:id/reactions"],
      parse: (req) => {
        const id = Number(req.params?.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 형식이 잘못되었습니다");
        const e = String(((req.body ?? {}) as Record<string, unknown>).emoji ?? "").trim();
        if (!e) throw new HttpError(400, "emoji 가 필요합니다");
        return { id, emoji: e };
      } }],
  },
  handler: async (input: KnowledgeCommentReactionInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 공개범위(#1291) — 반응은 댓글 id 로만 들어온다. 그 댓글이 달린 문서를 볼 수 있어야 한다
    //  (안 보이는 문서에 반응을 남기면 그 문서 화면의 작성자에게 내 존재가 드러나고, 응답 집계도 새어 나간다).
    const viewer = ctx?.viewer ?? null;
    if (viewer !== null) {
      const name = await knowledgeNameOfComment(input.id);
      if (name !== undefined) await assertKnowledgeVisible(name, viewer);
    }
    return { reactions: await toggleKnowledgeCommentReaction(input.id, input.emoji, ctx?.actor ?? user?.userId ?? "") };
  },
};

// 항목 단위 속성 노출 오버라이드 — props_ui 부분 병합(키 null=제거). version·updated_at 불변(뷰 설정은 내용 아님).
//  observed(미러) 지식에도 허용 — props_ui 는 fields 밖 별도 컬럼이라 재싱크에 생존(#592 §0).
const knowledgePropsUiInput = {
  name: z.string().min(1).max(64),
  show: z.array(z.string().min(1).max(64)).max(64).nullable().optional(),
  hide: z.array(z.string().min(1).max(64)).max(64).nullable().optional(),
  full_width: z.boolean().nullable().optional(),
  // #657 페이지 꾸미기 — icon=이모지(짧은 문자열), cover=프리셋 키(grad:N|#hex) 또는 이미지 URL.
  icon: z.string().min(1).max(80).nullable().optional(),
  cover: z.string().min(1).max(500).nullable().optional(),
};
type KnowledgePropsUiInput = z.infer<z.ZodObject<typeof knowledgePropsUiInput>>;
export const knowledgePropsUi: Capability = {
  name: "knowledge_props_ui",
  title: "지식 속성 노출 설정",
  description: "지식 1건의 속성 노출 오버라이드(props_ui: show/hide/full_width)와 페이지 꾸미기(icon/cover, #657)를 부분 병합 저장한다(키에 null 을 주면 제거). 웹 전용.",
  scope: "memory",
  input: knowledgePropsUiInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/props-ui"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { name: String(req.params?.name ?? "") };
        // 부재(미전송)≠null(키 제거) 3상 구분 — 'in' 프로브로만 채운다(undefined 로 덮으면 스토어가 미변경 처리).
        for (const k of ["show", "hide"] as const) {
          if (!(k in b)) continue;
          const v = b[k];
          if (v === null) { out[k] = null; continue; }
          if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
            throw new HttpError(400, `${k} 는 문자열 배열(또는 null=제거)이어야 합니다`);
          }
          out[k] = (v as string[]).map((s) => s.trim()).filter(Boolean).slice(0, 64);
        }
        if ("full_width" in b) {
          if (b.full_width !== null && typeof b.full_width !== "boolean") {
            throw new HttpError(400, "full_width 는 boolean(또는 null=제거)이어야 합니다");
          }
          out.full_width = b.full_width;
        }
        // #657 icon/cover — 문자열(설정) 또는 null(제거). 길이 상한은 zod(max 80/500)가 최종 방어.
        for (const k of ["icon", "cover"] as const) {
          if (!(k in b)) continue;
          const v = b[k];
          if (v === null) { out[k] = null; continue; }
          if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${k} 는 문자열(또는 null=제거)이어야 합니다`);
          out[k] = v.trim();
        }
        return out;
      } }],
  },
  handler: async (input: KnowledgePropsUiInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { props_ui: await setKnowledgePropsUi(input.name, { show: input.show, hide: input.hide, full_width: input.full_width, icon: input.icon, cover: input.cover }, writeCtx) };
  },
};

// 지식 댓글 피드 조회 — 댓글+반응만(시스템 이벤트 병합 없음, getTaskFeed 와 다른 점). 웹 문서 하단 댓글 섹션 소비.
const knowledgeCommentsInput = { name: z.string().min(1).max(64) };
type KnowledgeCommentsInput = z.infer<z.ZodObject<typeof knowledgeCommentsInput>>;
export const knowledgeComments: Capability = {
  name: "knowledge_comments",
  title: "지식 댓글 피드",
  description: "지식 1건의 댓글 피드(댓글+이모지 반응, display_name 포함)를 반환한다. 웹 전용.",
  scope: "memory",
  input: knowledgeCommentsInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name/comments"],
      parse: (req) => ({ name: String(req.params?.name ?? "") }) }],
  },
  handler: async (input: KnowledgeCommentsInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeVisible(input.name, ctx?.viewer ?? null);   // 공개범위(#1291) — 댓글도 그 문서의 내용이다
    return { feed: await getKnowledgeCommentFeed(input.name, ctx?.actor ?? user?.userId ?? null) };
  },
};

// 지식 댓글 작성 — {text, parent_id?(1단계 스레드)}. 작성 후 갱신된 피드 반환(task_comment_v6 동형).
const knowledgeCommentPostInput = {
  name: z.string().min(1).max(64),
  text: z.string().min(1),
  parent_id: z.number().int().positive().nullable().optional(),
};
type KnowledgeCommentPostInput = z.infer<z.ZodObject<typeof knowledgeCommentPostInput>>;
export const knowledgeCommentPost: Capability = {
  name: "knowledge_comment_post",
  title: "지식 댓글 작성",
  description: "지식에 댓글을 단다(knowledge_comment). {text, parent_id?}. 작성 후 갱신된 피드 반환. 웹 전용.",
  scope: "memory",
  input: knowledgeCommentPostInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/comments"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "댓글 내용이 필요합니다");
        const pid = b.parent_id != null ? Number(b.parent_id) : null;
        if (pid != null && (!Number.isInteger(pid) || pid <= 0)) throw new HttpError(400, "parent_id 형식이 잘못되었습니다");
        return { name: String(req.params?.name ?? ""), text, parent_id: pid || null };
      } }],
  },
  handler: async (input: KnowledgeCommentPostInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { feed: await postKnowledgeComment(input.name, input.text, writeCtx, input.parent_id ?? null) };
  },
};

// 정적 REST 경로(/knowledge-view-config · /knowledge-comments/:id/reactions) — /knowledge/:name 계열보다 먼저.
export const wikiUiStaticCapabilities: Capability[] = [
  knowledgeViewGet, knowledgeViewSet, knowledgeCommentReaction,
];
// /knowledge/:name 하위(props-ui · comments).
export const wikiUiNamedCapabilities: Capability[] = [
  knowledgePropsUi, knowledgeComments, knowledgeCommentPost,
];
