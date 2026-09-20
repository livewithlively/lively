// v6 휴지통 capability — 삭제됨 조회 + 복원(공통 경로). 삭제는 엔티티별(knowledge_delete·category_delete·
//  project_delete_v6)이 담당하고, 여기는 그것들이 남긴 감사 스냅샷을 한곳에서 보여주고 되돌린다.
//  scope='memory'(공유 평면). 복원은 ⚠ 사람(웹)만 — 에이전트(MCP)는 403(파괴/되돌리기는 사람 큐레이션).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listDeleted, getDeleteSnapshot, purgeDeleted, isDeletedNow, previewOf, TRASH_ENTITIES, type DeletedRow, type TrashEntity } from "../v6/trash-store.js";
import { auditOrgContent } from "../v6/content-audit.js";
import { restoreSource } from "../v6/source-store.js";
import { restoreKnowledge } from "../v6/knowledge-store.js";
import { restoreProject } from "../v6/project-store.js";
import { restoreCategory } from "../v6/category-store.js";
import { visibleListIds, type Viewer } from "../v6/visibility.js";
import { isAdmin } from "./principal.js";

const ENTITIES = TRASH_ENTITIES;   // knowledge · project · category · source(#3778) — 목록·복원·미리보기·파기가 같은 집합을 본다
const entityOf = (raw: unknown, allowed: readonly string[] = ENTITIES): string => {
  const entity = String(raw ?? "");
  if (!allowed.includes(entity)) throw new HttpError(400, `entity 는 ${allowed.join("|")}`);
  return entity;
};

// 삭제 스냅샷의 공개범위 판정 — 지식은 스냅샷의 visibility 로, 프로젝트는 스냅샷의 list_id 로.
//  ⚠ 인자를 `any[]` 로 두지 마라 — 처음 이 게이트는 스토어가 돌려주지 않는 필드(`before`·`entity_key`)를
//  읽어 **전체가 no-op** 이었다(모든 판정이 undefined 로 떨어져 전부 통과). `DeletedRow[]` 로 받으면
//  같은 실수가 컴파일 에러가 된다.
async function filterVisibleDeleted(entries: DeletedRow[], viewer: Viewer): Promise<DeletedRow[]> {
  if (viewer === null || !entries?.length) return entries;
  const visIds = await visibleListIds(viewer);
  const out: DeletedRow[] = [];
  for (const e of entries) {
    if (e.entity === "knowledge" || e.entity === "source") {
      // 삭제된 지식·자료는 본체 행이 없어 canSee* 가 판정할 근거를 잃는다 → 스냅샷의 visibility 로 본다(grant 는 CASCADE 로 이미 없다).
      if (e.visibility === "members") continue;
      out.push(e); continue;
    }
    if (e.entity === "project") {
      if (e.list_id != null && visIds && !visIds.has(e.list_id)) continue;
      out.push(e); continue;
    }
    out.push(e);   // 카테고리 — 조직 공용 분류축이라 종전대로(콘텐츠 본문이 아니다)
  }
  return out;
}

// 복원 게이트 — 목록(filterVisibleDeleted)과 **같은 근거**를 쓴다. 목록에서 숨긴 것을 복원으로 꺼낼 수
//  있으면 그 숨김은 장식이다. 여기선 스냅샷 전문을 이미 손에 들고 있으므로 그걸 그대로 본다.
async function canRestore(before: Record<string, unknown>, entity: string, viewer: Viewer): Promise<boolean> {
  if (viewer === null) return true;   // 특권(내부·긴급 열람)
  if (entity === "knowledge" || entity === "source") return before.visibility !== "members";
  if (entity === "project") {
    const listId = before.list_id == null ? null : Number(before.list_id);
    if (listId == null) return true;
    const visIds = await visibleListIds(viewer);
    return !visIds || visIds.has(listId);
  }
  return true;   // 카테고리 — 조직 공용 분류축
}

const deletedList: Capability = {
  name: "deleted_list",
  title: "삭제됨(휴지통)",
  description:
    "삭제된 항목(지식/프로젝트/카테고리/자료)을 최신 삭제순으로 조회한다 — 감사로그(org_content_audit) 기반으로 " +
    "각 항목의 마지막 작업이 'delete' 인 것만(이후 복원/재생성된 건 제외). entity 로 한 종류만 볼 수 있다. 복원은 content_restore.",
  scope: "memory",
  input: {
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 최신 삭제 N건 너머 옛 항목 순회(#709)"),
    entity: z.enum(ENTITIES).optional().describe("이 종류만(knowledge|project|category|source). 생략하면 전부"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/deleted"],
      parse: (req) => ({
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
        entity: req.query?.entity ? entityOf(req.query.entity) : undefined,
      }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const entries = await listDeleted(input.limit, input.offset, (input.entity as TrashEntity | undefined) ?? null);
    // 휴지통 항목은 **삭제 시점의 전문 스냅샷**(before)을 그대로 들고 있다(#1291) — 잠긴 리스트의 프로젝트나
    //  대상 제한 지식이 여기로 새면, 지우기만 하면 누구나 읽을 수 있게 된다.
    //  스냅샷만으로 공개범위를 판정할 수 없는 항목(카테고리 등 컨테이너가 없는 것)은 **비특권에게 숨긴다** —
    //  근거가 없을 땐 닫는 쪽이 안전하다. admin(특권)은 종전대로 전부 본다(복원은 관리 행위다).
    // v2: admin 도 우회하지 않는다. 다만 휴지통은 '무엇이 지워졌나'를 아는 게 운영의 핵심이라
    //  admin 에겐 **행은 보이되 스냅샷 본문을 지운 형태**로 준다(메타만). 내용이 필요하면 긴급 열람.
    const visible = await filterVisibleDeleted(entries, ctx?.viewer ?? null);
    if (!isAdmin(user)) return { entries: visible };
    const shownKeys = new Set(visible.map((e) => `${e.entity}:${e.key}`));
    const withMeta = entries.map((e) => shownKeys.has(`${e.entity}:${e.key}`)
      ? e
      : { ...e, locked: true, note: "공개범위 제한 — 복원·열람은 긴급 열람으로만" });
    return { entries: withMeta };
  },
};

const contentRestore: Capability = {
  name: "content_restore",
  title: "삭제 복원",
  description:
    "삭제된 항목을 감사 스냅샷(마지막 delete 의 before)으로 재적재한다. entity=knowledge|project|category|source, " +
    "key=name(지식)|id(프로젝트/카테고리/자료). 본문/메타는 삭제 시점 그대로 복구되고, 복원 사실은 감사 op='restore' 로 남는다. " +
    "⚠ 자식·연결(카테고리/프로젝트/활동 링크 등)은 삭제 시 cascade 됐으므로 복원되지 않는다(본체만). " +
    "⚠ 사람(웹)만 — 에이전트(MCP)는 403. 카테고리 복원은 context 권한이 필요하다.",
  scope: "memory",
  input: { entity: z.enum(ENTITIES), key: z.string().min(1) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/deleted/restore"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const entity = entityOf(b.entity);
        const key = String(b.key ?? "").trim();
        if (!key) throw new HttpError(400, "key 가 필요합니다");
        return { entity, key };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    // 비가역 큐레이션 — 에이전트(MCP) 금지. deny pattern 은 domain_delete 와 동형.
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "복원은 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(큐레이션)");
    }
    // 카테고리는 context scope 자원 — memory 만으론 복원 불가(엔티티별 권한 정합).
    if (input.entity === "category" && !((user?.scopes ?? []) as string[]).includes("context")) {
      throw new HttpError(403, "카테고리 복원은 context 권한이 필요합니다");
    }
    const before = await getDeleteSnapshot(input.entity, input.key);
    if (!before) throw new HttpError(404, `복원할 삭제 스냅샷이 없습니다(entity=${input.entity}, key=${input.key})`);
    // #1291 — **삭제는 잠금을 푸는 문이 아니다.** 게이트가 없으면 "지우고 되살리기"가 세탁 경로가 된다:
    //  잠긴 지식을 복원하면 응답에 body_md 가 실려 오고, grant 테이블은 CASCADE 로 이미 비었으므로
    //  복원된 행은 DDL 기본값(open)으로 되살아난다. 목록에서 안 보이는 것을 복원할 수는 없어야 한다.
    if (!(await canRestore(before, input.entity, ctx?.viewer ?? null))) {
      throw new HttpError(404, `복원할 삭제 스냅샷이 없습니다(entity=${input.entity}, key=${input.key})`);
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    let item: unknown;
    if (input.entity === "knowledge") item = await restoreKnowledge(before, writeCtx);
    else if (input.entity === "project") item = await restoreProject(before, writeCtx);
    else if (input.entity === "source") item = await restoreSource(before, writeCtx);
    else item = await restoreCategory(before, writeCtx);
    return { restored: true, entity: input.entity, key: input.key, item };
  },
};

// ── 미리보기(#3778) — 휴지통에서 «지우기 전에 내용을 본다»(지식 읽기 칸·자료 본문 머리). ──
//  복원과 **같은 게이트**를 지난다: 볼 수 없는 것은 되살릴 수도, 읽을 수도 없다. 목록(deleted_list)이 본문을 안 싣는 이유(#1291)가
//  여기서 뒤집히지 않게 — 한 건씩, 게이트 뒤에서만, 상한을 두고 준다. 화면 전용(MCP 비노출): 에이전트가 지운 글을 훑는 길을 열지 않는다.
const contentSnapshot: Capability = {
  name: "content_snapshot",
  title: "삭제 항목 미리보기",
  description: "휴지통(삭제됨) 항목 한 건의 제목·본문 머리를 돌려준다(복원과 같은 공개범위 게이트). 화면 전용.",
  scope: "memory",
  input: { entity: z.enum(ENTITIES), key: z.string().min(1) },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/deleted/snapshot"],
      parse: (req) => {
        const key = String(req.query?.key ?? "").trim();
        if (!key) throw new HttpError(400, "key 가 필요합니다");
        return { entity: entityOf(req.query?.entity), key };
      } }],
  },
  handler: async (input: any, _user: any, ctx: any) => {
    //  이중 잠금 — MCP 표면엔 세우지 않지만(mcp:false), 복원·파기와 같은 문을 핸들러에도 건다(한쪽이 풀려도 다른 쪽이 막는다).
    if (ctx?.source === "mcp") throw new HttpError(403, "삭제 항목 미리보기는 사람(웹)만 가능합니다");
    const before = await getDeleteSnapshot(input.entity, input.key);
    if (!before || !(await canRestore(before, input.entity, ctx?.viewer ?? null)) || !(await isDeletedNow(input.entity, input.key))) {
      throw new HttpError(404, `휴지통에 없는 항목입니다(entity=${input.entity}, key=${input.key})`);
    }
    return { preview: previewOf(input.entity, input.key, before) };
  },
};

// ── 완전 삭제(파기, #3778 ← #1851 에서 한 번 만들었다가 되돌린 것) — 휴지통 항목의 본문 스냅샷을 비운다(행은 남는다). 되돌릴 수 없다. ──
//  권한은 **복원할 수 있는 사람만**(canRestore 와 같은 근거 — 볼 수 없는 것을 지울 수도 없어야 한다). 에이전트(MCP) 금지. admin 특권 없음.
//  ⚠ 자식(프로젝트의 태스크 등)은 삭제 때 CASCADE 로 스냅샷 없이 사라졌으므로 여기서 비울 것이 없다(#1850 F3 — 남은 결함).
//  카테고리는 대상이 아니다 — 조직 공용 분류축의 파기는 이 화면의 일이 아니다.
const PURGE_ENTITIES = ["knowledge", "project", "source"] as const;
const contentPurge: Capability = {
  name: "content_purge",
  title: "삭제 항목 완전 삭제(파기)",
  description:
    "휴지통(삭제됨)에 있는 지식/프로젝트/자료의 감사 스냅샷 본문을 비워 되돌릴 수 없게 한다(행은 남아 '누가 언제 파기했나'만 남는다). " +
    "entity=knowledge|project|source, key=name(지식)|id(프로젝트·자료). 지금 삭제 상태가 아니면 409. ⚠ 사람(웹)만 — 에이전트(MCP)는 403.",
  scope: "memory",
  input: { entity: z.enum(PURGE_ENTITIES), key: z.string().min(1) },
  expose: {
    mcp: false,   // 화면 전용 — 파기 도구를 에이전트 표면에 세우지 않는다(핸들러의 403 은 REST 를 mcp 채널로 부르는 경우의 이중 잠금)
    rest: [{ method: "POST", paths: ["/api/ui/deleted/purge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const key = String(b.key ?? "").trim();
        if (!key) throw new HttpError(400, "key 가 필요합니다");
        return { entity: entityOf(b.entity, PURGE_ENTITIES), key };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (ctx?.source === "mcp") throw new HttpError(403, "완전 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다");
    const before = await getDeleteSnapshot(input.entity, input.key);
    if (!before || !(await canRestore(before, input.entity, ctx?.viewer ?? null))) {
      throw new HttpError(404, `휴지통에 없는 항목입니다(entity=${input.entity}, key=${input.key})`);
    }
    if (!(await isDeletedNow(input.entity, input.key))) throw new HttpError(409, "지금 삭제 상태가 아닙니다 — 살아 있는 항목은 먼저 지워야 완전히 지울 수 있어요");
    const scrubbed = await purgeDeleted(input.entity, input.key);
    await auditOrgContent(input.entity, input.key, "purge", null, { scrubbed_rows: scrubbed },
      { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });
    return { purged: true, entity: input.entity, key: input.key, scrubbed_rows: scrubbed };
  },
};

export const trashCapabilities: Capability[] = [deletedList, contentRestore, contentSnapshot, contentPurge];
