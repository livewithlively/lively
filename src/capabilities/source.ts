// v6 source(자료) capability — #290. raw 입력층(회의 전사록·이메일·슬랙·외부 미러). knowledge(지식)와 분리.
//  ★별도 테이블이라 recall(knowledge_search)에 안 섞인다. 정제하면 knowledge_save 로 지식을 만들고 source_link_knowledge 로 인용.
//  scope='memory'(조직 지식과 동일 축). 전부 expose.mcp:true(자동등록) + REST(웹 자료 탭 /api/ui/sources).
import { z } from "zod";
import { HttpError, clampPage } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { listSources, countSources, getSource, upsertSource, deleteSource, listUndistilledSources, listSourceTree, canSeeSource } from "../v6/source-store.js";
import { linkKnowledgeSource, unlinkKnowledgeSource } from "../v6/knowledge-store.js";
import { canSeeKnowledge, type Viewer } from "../v6/visibility.js";
// #1442 소프트캡 — 짧은 메타 필드의 길이 초과가 원문(body_md) 전체를 튕기지 않게 한다.
import { SOFT_CAPS, applySoftCaps, softCapHint } from "./soft-cap.js";

// 공개범위(#1291) — 안 보이는 자료는 고칠 수도, 지울 수도, 원본을 받을 수도 없다. 문구는 없는 자료와 동일(존재 은닉).
//  지식(assertKnowledgeWritable)과 같은 규율: id 를 아는 것만으로 비가시 본문을 덮어쓰거나 파일로 빼내지 못하게.
async function assertSourceVisible(id: unknown, viewer: Viewer): Promise<void> {
  if (viewer === null || id == null) return;
  if (!(await canSeeSource(Number(id), viewer))) throw new HttpError(404, `자료 #${Number(id)} 없음`);
}

export const SOURCE_KINDS = ["transcript", "minutes", "email", "slack", "discord", "notion_doc", "clickup_doc", "drive_file", "local_file", "figma_comment", "github_issue", "gitlab_issue", "linear_issue", "other"] as const;

const sourceListInput = {
  kind: z.enum(SOURCE_KINDS).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
  q: z.string().optional(),
  system: z.string().optional().describe("출처(#2423) — external_system('slack'·'github'·'local'·'discord'·'linear'·'figma'…) 또는 'authored'(사람이 직접 적어 둔 것)"),
  container: z.string().optional().describe("그 출처 안의 자리 — 슬랙 채널·깃허브 저장소·내 컴퓨터 최상위 폴더(fields.container_name)"),
  author: z.string().optional().describe("쓴 사람·올린 사람(fields.author_name)"),
  root: z.enum(["personal", "project"]).optional().describe("올린 자리(fields.root) — personal=개인 폴더 · project=프로젝트 폴더 (#2423)"),
  linked: z.boolean().optional().describe("true=지식이 붙은 자료만 / false=아직 안 붙은 것만"),
  limit: z.number().int().min(1).max(500).optional().describe("페이지 크기(1~500, 기본 100) — 구 100 하드캡 해제(#709)"),
  offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 상한 너머 전량 순회(#709)"),
};
type SourceListInput = z.infer<z.ZodObject<typeof sourceListInput>>;
const sourceList: Capability = {
  name: "source_list",
  title: "자료 목록",
  description:
    "자료(raw 입력 — 회의 전사록·이메일·슬랙·외부 미러)를 kind/provenance/q 로 조회. 지식(knowledge)과 별도 테이블이라 recall(knowledge_search)에 안 섞인다. 본문은 미포함(목록은 얕게). limit(≤500, 기본 100)·offset 으로 페이지네이션 — 응답에 total·has_more 포함(#709).",
  scope: "memory",
  input: sourceListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          kind: query.kind ? String(query.kind) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          q: query.q ? String(query.q) : undefined,
          system: query.system ? String(query.system) : undefined,
          container: query.container ? String(query.container) : undefined,
          author: query.author ? String(query.author) : undefined,
          root: query.root === "personal" || query.root === "project" ? String(query.root) : undefined,
          //  linked 는 3상태다(붙은 것만·안 붙은 것만·안 가림) — 문자열 'true'/'false' 만 뜻을 갖고 나머지는 미지정.
          linked: query.linked === undefined ? undefined : String(query.linked) === "true",
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
      } }],
  },
  // #709 limit/offset 페이지네이션 + total/has_more. 구 100 하드캡(parse 가 limit 미배선)을 해제.
  handler: async (input: SourceListInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const { limit, offset } = clampPage(input, 100, 500);
    const viewer = ctx?.viewer ?? null;   // 공개범위(#1291) — 목록·총계 같은 뷰어(has_more 정합)
    const [entries, total] = await Promise.all([
      listSources({ ...input, limit, offset }, viewer),
      countSources(input, viewer),
    ]);
    return { entries, total, limit, offset, has_more: offset + entries.length < total };
  },
};

const sourceGetInput = { id: z.number().int().positive() };
type SourceGetInput = z.infer<z.ZodObject<typeof sourceGetInput>>;
const sourceGet: Capability = {
  name: "source_get",
  title: "자료 상세",
  description: "자료 1건(전문) + 이 자료에서 파생된 지식(knowledge_source 역방향).",
  scope: "memory",
  input: sourceGetInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources/:id"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: SourceGetInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    // 안 보이는 자료면 getSource 가 undefined → 없는 자료와 같은 문구(존재 은닉).
    const source = await getSource(input.id, ctx?.viewer ?? null);
    if (!source) throw new Error(`자료 #${input.id} 없음`);
    return { source };
  },
};

// #1442 소프트캡 — name·title 에 zod .max() 를 두지 않는다(SDK 가 핸들러 앞에서 검증해 body_md 200,000자까지
//  함께 튕기고, 그 실패는 mcp_call_log 에도 안 남는다). 상한은 describe 로 광고하고 조정은 핸들러가 한다.
const CAPS = SOFT_CAPS.source_save;
const sourceSaveInput = {
  id: z.number().int().positive().optional(),
  name: z.string().optional().describe(`자료 이름(슬러그) — 없으면 자동 생성. ${softCapHint(CAPS.name)}`),
  kind: z.enum(SOURCE_KINDS).optional(),
  title: z.string().optional().describe(`표시 제목 — 한 줄 라벨(원문 전체는 body_md 에). ${softCapHint(CAPS.title)}`),
  body_md: z.string().max(200000).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
  occurred_at: z.string().optional().describe("발생 시각(ISO) — 회의·메일 시각"),
};
type SourceSaveInput = z.infer<z.ZodObject<typeof sourceSaveInput>>;
const sourceSave: Capability = {
  name: "source_save",
  title: "자료 저장",
  description:
    "자료(raw)를 저장/수정한다(id 주면 수정). kind=transcript|minutes|email|slack|notion_doc|clickup_doc|other. provenance=authored(우리 캡처)|observed(외부 미러). " +
    "정제해서 지식을 만들려면 knowledge_save 로 지식을 쓰고 source_link_knowledge 로 이 자료를 인용(derived_from) 잇는다. " +
    "**길이 상한(#1442): name·title(64·200자)을 넘겨도 이 호출은 실패하지 않는다** — 서버가 그 필드만 자르고 원문(body_md)은 그대로 저장한 뒤 응답 capped 로 알린다. 원문을 다시 실어 재시도하지 마라.",
  scope: "memory",
  input: sourceSaveInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: b.id ? Number(b.id) : undefined,
          name: b.name ? String(b.name) : undefined,
          kind: b.kind ? String(b.kind) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md: b.body_md != null ? String(b.body_md) : undefined,
          provenance: b.provenance ? String(b.provenance) : undefined,
          occurred_at: b.occurred_at ? String(b.occurred_at) : undefined,
        };
      } }],
  },
  handler: async (input: SourceSaveInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // #1442 짧은 메타 필드 조정 — store 에 넘기기 전에. 조정 보고(capped)는 응답에 실어 호출자가 알게 한다.
    const capped = applySoftCaps("source_save", input, CAPS);
    // 공개범위(#1291) — 기존 자료를 고치는 경우만 막는다(신규 저장은 그대로). 지식 저장과 같은 규율.
    if (input.id) await assertSourceVisible(input.id, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { source: await upsertSource(input, writeCtx), ...capped };
  },
};

const sourceLinkKnowledgeInput = {
  name: z.string().min(1).max(64).describe("지식 이름"),
  source_id: z.number().int().positive(),
  relation: z.enum(["derived_from", "cites"]).default("derived_from"),
  unlink: z.boolean().optional(),
};
type SourceLinkKnowledgeInput = z.infer<z.ZodObject<typeof sourceLinkKnowledgeInput>>;
const sourceLinkKnowledge: Capability = {
  name: "source_link_knowledge",
  title: "자료↔지식 인용",
  description: "지식이 어느 자료에서 파생됐는지 잇는다(derived_from=증류 | cites=참조). 또는 unlink=true 로 해제. 카파시 source→wiki citation.",
  scope: "memory",
  input: sourceLinkKnowledgeInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources/:id/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name(지식 이름)이 필요합니다");
        return {
          name, source_id: Number(req.params?.id),
          relation: b.relation ? String(b.relation) : "derived_from",
          unlink: b.unlink === true,
        };
      } }],
  },
  handler: async (input: SourceLinkKnowledgeInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 인용은 **양 끝**을 본다 — 한쪽만 보면 안 보이는 자료/지식에 인용을 꽂아 두고 상대 화면의 목록에서
    //  그 제목을 읽는 우회로가 열린다(knowledge_link 의 양끝 판정과 동형).
    const viewer = ctx?.viewer ?? null;
    await assertSourceVisible(input.source_id, viewer);
    if (viewer !== null && input.name && !(await canSeeKnowledge(String(input.name), viewer))) {
      throw new HttpError(404, `지식 '${input.name}' 없음`);
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledgeSource(input.name, input.source_id, input.relation, writeCtx); return { unlinked: true }; }
    const r = await linkKnowledgeSource(input.name, input.source_id, input.relation, writeCtx);
    //  #1631 — 이 자료에서 파생된 지식이 이미 있으면 그 사실을 **응답에 실어** 알린다(막지는 않는다).
    //   증류 세션이 그 자리에서 «합칠까 그대로 둘까» 를 정할 수 있어야 중복이 조용히 쌓이지 않는다.
    const dupNote = (r as { dupNote?: string | null } | null)?.dupNote ?? null;
    return dupNote ? { linked: true, warning: dupNote } : { linked: true };
  },
};

const sourceDeleteInput = { id: z.number().int().positive() };
type SourceDeleteInput = z.infer<z.ZodObject<typeof sourceDeleteInput>>;
const sourceDelete: Capability = {
  name: "source_delete",
  title: "자료 삭제",
  description: "자료를 삭제한다(감사 스냅샷 보존, knowledge_source 인용은 CASCADE 정리·지식은 생존). ⚠ 사람(웹)만 — 에이전트(MCP)는 403.",
  scope: "memory",
  input: sourceDeleteInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources/:id/delete"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: SourceDeleteInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (ctx?.source === "mcp") throw new HttpError(403, "자료 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다");
    await assertSourceVisible(input.id, ctx?.viewer ?? null);   // 공개범위(#1291) — 안 보이는 자료는 지울 수도 없다
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const before = await deleteSource(input.id, writeCtx);
    return { deleted: true, id: input.id, title: (before as any)?.title ?? null };
  },
};

// distill 대상 — 아직 지식으로 증류 안 된 자료(knowledge_source 링크 없는 것). distill 세션이 지식화 대상 조회(#541).
const sourceUndistilledInput = { limit: z.number().int().positive().max(500).optional() };
type SourceUndistilledInput = z.infer<z.ZodObject<typeof sourceUndistilledInput>>;
const sourceUndistilled: Capability = {
  name: "source_undistilled",
  title: "미증류 자료 목록",
  description:
    "아직 지식으로 증류되지 않은 자료(knowledge_source 링크가 없는 것)를 최근순으로 조회한다 — distill 세션이 지식화 대상을 가져올 때 쓴다. 본문 미포함(source_get 으로 전문). 지식화(source_link_knowledge)하면 다음 조회에서 빠진다.",
  scope: "memory",
  input: sourceUndistilledInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources/undistilled"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return { limit: query.limit ? Number(query.limit) : undefined };
      } }],
  },
  handler: async (input: SourceUndistilledInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ entries: await listUndistilledSources(input.limit, ctx?.viewer ?? null) }),
};

// 바이너리 자료([BINARY] 스텁 — PDF·이미지 등)의 원본을 on-demand 로 임시경로에 받아 돌려준다(#541). distill 세션이
//  Read(Claude 네이티브 PDF·이미지 파싱)해 내용 확보. 커넥터가 sync 시 전량 저장(eager)하지 않아 스토리지 절약 —
//  distill 이 볼 가치 있다고 판단한 것만 이 도구로 페치. 삭제/이동/미지원이면 에러(→ 그 자료 skip).
const sourceArtifactInput = { source_id: z.number().int().positive() };
type SourceArtifactInput = z.infer<z.ZodObject<typeof sourceArtifactInput>>;
const sourceArtifact: Capability = {
  name: "source_artifact",
  mutates: false, // 읽기전용(#1007): MCP전용 읽기 — 자료 원본을 임시경로에 받아 경로 반환(스토어 쓰기 없음). 파생 신호 부재라 명시.
  title: "자료 원본(on-demand)",
  description:
    "바이너리 자료([BINARY] 스텁 — PDF·이미지 등)의 원본을 커넥터에서 on-demand 로 내려받아 짧은 TTL 임시경로에 저장하고 그 경로를 돌려준다({path,mime,bytes,expires_at}). distill 세션이 이 경로를 Read(Claude 가 PDF·이미지를 네이티브 파싱, 한글까지)해 실제 내용을 확보한다. 원본이 삭제/이동/권한상실이면 unavailable 에러(→ 그 자료 skip). 저장은 transient(수 시간 GC) — 커넥터 무관 공용(slack/gdrive/…).",
  scope: "memory",
  input: sourceArtifactInput,
  expose: { mcp: true, rest: false }, // MCP 전용 — 서버-로컬 경로 반환(같은 호스트의 distill 세션이 Read).
  handler: async (input: SourceArtifactInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    // 공개범위(#1291) — 여기가 **원본 바이트가 디스크로 나가는** 자리다(세션이 그 경로를 Read 한다).
    //  목록·상세를 막아도 이 경로가 열려 있으면 id 만 알면 원본을 통째로 빼낼 수 있다.
    await assertSourceVisible(input.source_id, ctx?.viewer ?? null);
    const { materializeSourceArtifact } = await import("../v6/source-artifact.js");
    return await materializeSourceArtifact(input.source_id);
  },
};

// 출처 나무(#2423) — 자료 앱 왼쪽 나무 한 벌. 가지 = 출처 × 그 안의 자리(채널·폴더·저장소).
const sourceTree: Capability = {
  name: "source_tree",
  mutates: false,
  title: "자료 출처 나무",
  description:
    "자료를 «어디서 왔나» 로 접은 집계 — 출처(external_system, 'authored'=사람이 적어 둔 것) × 그 안의 자리(채널·폴더·저장소)마다 " +
    "자료 수·지식이 붙은 수·마지막으로 들어온 때. 자료 앱의 왼쪽 나무가 이 한 번의 조회로 선다. 공개범위가 걸린 자료는 건수에도 안 잡힌다.",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources/tree"], parse: () => ({}) }],
  },
  handler: async (_input: unknown, _user: LivelyUser, ctx?: CapabilityCtx) => ({ nodes: await listSourceTree(ctx?.viewer ?? null) }),
};

// ⚠ REST 순서: sourceUndistilled(/sources/undistilled)·sourceTree(/sources/tree) 는 sourceGet(/sources/:id) 보다
//  **먼저** 마운트되어야 그 이름이 :id 로 먹히지 않는다(구체 경로 우선). sourceGet(/sources/:id)·sourceList(/sources) 는
//  세그먼트 수로 구분. POST 들(/sources, /sources/:id/knowledge, /sources/:id/delete)도 상호 구분.
export const sourceCapabilities: Capability[] = [
  sourceList, sourceUndistilled, sourceTree, sourceGet, sourceSave, sourceLinkKnowledge, sourceDelete, sourceArtifact,
];
