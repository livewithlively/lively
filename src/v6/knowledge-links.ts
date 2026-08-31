// v6 knowledge 링크(#1313 R21 — knowledge-store 에서 분리) — 지식↔지식 엣지(knowledge_link)·본문 [[위키링크]]
//  물질화·지식↔자료 인용(knowledge_source)·그래프뷰 데이터.
//  분리 이유: 엣지 수렴(스윕·재작성)은 CRUD 와 트랜잭션 경계·멱등 규율이 달라 한 파일에 있을 이유가 없었다.
//  공개 표면은 그대로 — knowledge-store.ts 가 이 모듈을 재수출하므로 기존 호출부는 무수정.
//  ⚠ 방향: knowledge-store → 이 모듈(재수출 + upsert 경로의 materializeWikiLinksBestEffort). 되import 금지(순환).
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { type WriteCtx } from "./content-audit.js";
import { extractWikiLinkTargets } from "./wikilink.js";   // #907 본문 [[…]] → 자동 엣지(문법층은 순수 함수로 분리)
import { visibleListIds, type Viewer } from "./visibility.js";
import { knowledgeVisSql, knowledgeVisWhere, slugify, auditKnowledge } from "./knowledge-common.js";
import { inheritSourceVisibility, type InheritResult } from "./source-vis-policy.js";
import { logger } from "../log.js";

// ════════ #290 지식↔지식 링크(knowledge_link) — 빠진 1급 프리미티브. 단방향 1행 저장 + 역방향 쿼리로 백링크(MediaWiki/Obsidian 모델). ════════
//  relation=related(대칭)|refines|contradicts|depends_on. FK 가 양 끝 지식 존재를 보장(없으면 INSERT 거부 → capability 에서 클린 에러).
//  origin(#907): 'user'=사람·에이전트가 명시 · 'wikilink'=본문 [[…]] 파생 · 'connector:<sys>'=커넥터 물질화.
//   UI·해제 가드가 '이 엣지를 여기서 떼도 되나'를 판단해야 해서 조회에 싣는다(파생 엣지는 본문이 SoT다).
export interface KnowledgeLinkRow { name: string; relation: string; title: string | null; origin: string }
export async function linkKnowledge(fromName: string, toName: string, relation = "related", ctx?: WriteCtx): Promise<void> {
  if (fromName === toName) throw new Error("자기 자신과 링크할 수 없습니다");
  await itemsPool.query(
    `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
     VALUES($1,$2,$3,'user',now(),now())
     ON CONFLICT (tenant_id, from_name, to_name, relation) DO UPDATE SET updated_at=now(), origin='user'`,
    [fromName, toName, relation]); // 커넥터 물질화 행과 충돌 시 origin 을 user 로 승격 — 다음 싱크의 재작성 DELETE 에서 보호(#551)
  await auditKnowledge(fromName, "link_knowledge", null, { to_name: toName, relation }, ctx);
}
export async function unlinkKnowledge(fromName: string, toName: string, relation: string, ctx?: WriteCtx): Promise<void> {
  // #907 본문 파생 엣지는 여기서 못 뗀다 — 본문이 SoT라 지워봐야 다음 저장·스윕이 되살린다(“지웠는데 살아나”).
  //  진짜 해제 방법(본문에서 [[…]] 제거)을 알려주는 게 조용히 되살아나는 것보다 정직하다. 사람·에이전트 공통 가드.
  //  ⚠ 문구의 '허용' 은 load-bearing — rest-util wrap() 이 이 토큰으로 400 을 매핑한다(없으면 500 +
  //   메시지가 'internal_error' 로 치환돼 이 안내가 통째로 사라진다). assertTreeParent·moveKnowledge 와 같은 idiom.
  const auto = await one(itemsPool,
    `SELECT 1 AS x FROM knowledge_link WHERE from_name=$1 AND to_name=$2 AND relation=$3 AND origin='wikilink'`,
    [fromName, toName, relation]);
  if (auto) {
    throw new Error(
      `'${fromName}' 본문의 [[${toName}]] 에서 자동 생성된 연결이라 여기서 해제가 허용되지 않습니다 — 본문에서 [[${toName}]] 를 지우면 연결도 사라집니다(관계를 바꾸려면 knowledge_link 로 명시하세요).`);
  }
  await itemsPool.query(`DELETE FROM knowledge_link WHERE from_name=$1 AND to_name=$2 AND relation=$3`, [fromName, toName, relation]);
  await auditKnowledge(fromName, "unlink_knowledge", { to_name: toName, relation }, null, ctx);
}
// 양방향 — outgoing(이 지식이 가리키는) + incoming(이 지식을 가리키는 = 백링크). 비활성 지식은 제외.
// viewer(#1291) — 이웃 지식의 **제목**이 그대로 실려 나가는 자리다. 특히 incoming(백링크)은 남이 건 엣지라,
//  대상 제한 문서가 공개 문서를 가리키면 그 제목이 공개 문서 화면에 뜬다. 안 보이는 이웃은 행 자체를 뺀다.
export async function listKnowledgeLinks(name: string, viewer?: Viewer): Promise<{ outgoing: KnowledgeLinkRow[]; incoming: KnowledgeLinkRow[] }> {
  const visSql = viewer === undefined || viewer === null ? "" : ` AND ${knowledgeVisSql(2, await visibleListIds(viewer))}`;   // $1=name, $2=viewer
  const visArgs = viewer === undefined || viewer === null ? [] : [viewer];
  const outgoing = await q(itemsPool,
    `SELECT l.to_name AS name, l.relation, l.origin, k.title FROM knowledge_link l JOIN knowledge k ON k.name=l.to_name
     WHERE l.from_name=$1 AND k.lifecycle='active'${visSql} ORDER BY l.relation, k.updated_at DESC`, [name, ...visArgs]);
  const incoming = await q(itemsPool,
    `SELECT l.from_name AS name, l.relation, l.origin, k.title FROM knowledge_link l JOIN knowledge k ON k.name=l.from_name
     WHERE l.to_name=$1 AND k.lifecycle='active'${visSql} ORDER BY l.relation, k.updated_at DESC`, [name, ...visArgs]);
  return { outgoing, incoming };
}
// ════════ #907 본문 [[위키링크]] → 자동 엣지(origin='wikilink'). **본문이 SoT**. ════════
//  왜: [[…]] 를 본문에 적어도 엣지가 안 생겼다 — knowledge_link 를 따로 부르지 않으면 백링크·그래프뷰·recall
//   그래프에서 관계가 통째로 유실된다(#869 마무리 중 실측으로 드러남). 착수 시점 실측: 활성 지식 본문의
//   위키링크 939건 중 엣지가 있던 건 136건뿐 — 약 770건이 텍스트로만 존재했다.
//  규율은 커넥터 물질화(#551 materializeNotionLinks)와 동형 — **자기 origin 엣지만** 지우고 본문에서 다시 만든다:
//   · origin='wikilink' = 본문 파생(파생 상태) → 본문에서 [[x]] 를 빼면 다음 저장에 엣지도 사라진다(완전 동기화).
//   · origin='user'(knowledge_link) = 사람·에이전트가 명시한 엣지 → 불가침. 같은 쌍을 수동 링크하면 linkKnowledge 가
//     origin 을 'user' 로 승격시켜 이 재작성 DELETE 에서 빠진다 — 관계 타입 지정도 그 경로다.
//  relation 은 전부 'related' — Obsidian 문법에 타입 관계가 없다(wikilink.ts 헤더 · https://obsidian.md/help/links).
export interface WikiLinkResult { linked: string[]; unmatched: string[] }

/** raw 대상 → 실제 knowledge.name 해소. **exact 우선 → slugify 폴백**(이 순서가 load-bearing):
 *   · slugify 는 strip→slice(64) 순서라 64자에서 잘린 이름은 '-' 로 끝날 수 있다(실재 2건). 재슬러그화하면
 *     그 꼬리 '-' 가 떨어져 **정확히 쓴 링크가 오히려 미매칭**된다.
 *   · 대소문자만 다른 동명 지식이 실재한다(2026-06-11-PM툴… / …-pm툴…, 같은 제목·둘 다 active). 먼저 정규화하면
 *     작성자가 지목한 문서가 아닌 쪽에 붙는다 — exact 가 있으면 그게 작성자의 의도다.
 *  자기 자신은 버린다(knowledge_link_noself_chk 가 거부한다). existing 은 lifecycle 무관 전체 name —
 *  FK 는 존재만 요구하고, pending 대상을 '없음'으로 경고하면 거짓 경고가 된다(승인되면 그대로 유효한 링크다). */
export function resolveWikiLinkTargets(fromName: string, targets: string[], existing: ReadonlySet<string>): WikiLinkResult {
  const linked: string[] = [], unmatched: string[] = [];
  for (const raw of targets) {
    const slug = slugify(raw);
    const hit = existing.has(raw) ? raw : (existing.has(slug) ? slug : null);
    if (!hit) { if (!unmatched.includes(raw)) unmatched.push(raw); continue; }
    if (hit === fromName) continue;                       // 자기 참조 — 엣지 불가(CHECK). 조용히 버린다(오류 아님).
    if (!linked.includes(hit)) linked.push(hit);          // raw 와 slug 가 같은 문서로 접히면 1건으로(knowledge_link_uq)
  }
  return { linked, unmatched };
}

/** origin='wikilink' 엣지 재작성 — from_name 것만 지우고 본문 해소분을 다시 넣는다(멱등·수렴형).
 *  ON CONFLICT DO NOTHING = 같은 쌍의 'user' 엣지가 있으면 그대로 존중(사람 링크 불가침 — #551 idiom). */
async function rewriteWikiLinkEdges(fromName: string, toNames: string[]): Promise<void> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE from_name=$1 AND origin='wikilink'`, [fromName]);
    if (toNames.length) {
      await client.query(
        `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
         SELECT $1, t, 'related', 'wikilink', now(), now() FROM unnest($2::text[]) AS t
         ON CONFLICT (tenant_id, from_name, to_name, relation) DO NOTHING`,
        [fromName, toNames]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 한 지식의 본문 → origin='wikilink' 엣지 수렴. 미매칭 name 은 경고로 돌려준다(저장은 막지 않는다 — #907 목표2). */
export async function materializeWikiLinks(name: string, bodyMd: string): Promise<WikiLinkResult> {
  const targets = extractWikiLinkTargets(bodyMd ?? "");
  // exact·slug 후보를 한 번에 조회(문서당 쿼리 1회). 링크가 없어도 재작성은 돈다 — 본문에서 지운 엣지를 떼야 하니까.
  const cands = [...new Set(targets.flatMap((t) => [t, slugify(t)]))];
  const rows = cands.length ? await q(itemsPool, `SELECT name FROM knowledge WHERE name = ANY($1)`, [cands]) : [];
  const res = resolveWikiLinkTargets(name, targets, new Set(rows.map((r) => String((r as { name: string }).name))));
  await rewriteWikiLinkEdges(name, res.linked);
  return res;
}

/** upsert 경로용 — 실패해도 저장을 되돌리지 않는다(행은 이미 커밋됐다. 스윕이 수렴시킨다).
 *  embedKnowledgeBestEffort 와 같은 급의 파생 상태 갱신이다. */
export async function materializeWikiLinksBestEffort(name: string, bodyMd: string): Promise<WikiLinkResult | undefined> {
  try {
    return await materializeWikiLinks(name, bodyMd);
  } catch (e) {
    console.warn(`[wikilink] '${name}' 자동 엣지 실패(best-effort, 스윕으로 보강): ${(e as Error)?.message}`);
    return undefined;
  }
}

/** #907 백필·유지보수 스윕 — 전 지식 본문의 [[…]] 를 전수 재계산해 origin='wikilink' 엣지를 수렴시킨다.
 *  materializeNotionLinks 와 같은 수렴형(매번 전체 재작성 → 재실행·부분실행 안전):
 *   · 붕 뜬 링크의 대상이 나중에 생기면 다음 스윕이 자동으로 엣지를 만든다(그래서 유지보수 잡이 필요하다).
 *   · 단건 경로와 달리 name 집합을 한 번만 읽어 메모리에서 해소한다(문서당 쿼리 0). */
export async function sweepWikiLinks(): Promise<{ docs: number; scanned: number; edges: number; dangling: { name: string; targets: string[] }[] }> {
  const all = await q(itemsPool, `SELECT name, body_md FROM knowledge`);
  const existing = new Set(all.map((r) => String((r as { name: string }).name)));
  const froms: string[] = [], tos: string[] = [];
  const dangling: { name: string; targets: string[] }[] = [];
  let docs = 0;
  for (const row of all) {
    const name = String((row as { name: string }).name);
    const targets = extractWikiLinkTargets(String((row as { body_md?: string }).body_md ?? ""));
    if (!targets.length) continue;
    docs++;
    const { linked, unmatched } = resolveWikiLinkTargets(name, targets, existing);
    for (const to of linked) { froms.push(name); tos.push(to); }
    if (unmatched.length) dangling.push({ name, targets: unmatched });
  }
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE origin='wikilink'`);
    if (froms.length) {
      await client.query(
        `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
         SELECT f, t, 'related', 'wikilink', now(), now() FROM unnest($1::text[], $2::text[]) AS x(f, t)
         ON CONFLICT (tenant_id, from_name, to_name, relation) DO NOTHING`,
        [froms, tos]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { docs, scanned: all.length, edges: froms.length, dangling };
}

/**
 * 이 자료에서 **이미 파생된** 지식 목록(#1631) — 중복 증류 판정의 재료. 실패는 빈 배열(모름은 경고 없음).
 */
export async function derivedPeersOf(sourceId: number): Promise<Array<{ name: string; relation: string }>> {
  try {
    const r = await itemsPool.query(
      `SELECT ks.name, ks.relation FROM knowledge_source ks
        JOIN knowledge k ON k.name = ks.name AND k.lifecycle = 'active'
       WHERE ks.source_id = $1`, [sourceId]);
    return r.rows.map((x) => ({ name: String(x.name), relation: String(x.relation) }));
  } catch { return []; }
}

// 지식→자료 인용(knowledge_source). relation=derived_from(증류)|cites(참조).
export async function linkKnowledgeSource(name: string, sourceId: number, relation = "derived_from", ctx?: WriteCtx): Promise<(InheritResult & { dupNote?: string | null }) | { dupNote: string | null } | null> {
  //  ⚠ 알림은 **반환값**으로 준다 — 모듈 전역에 담으면 동시 호출(배치 병렬)에서 남의 알림을 집어 온다.
  let dupNote: string | null = null;
  //  #1631 — 이 자료에서 파생된 지식이 이미 있으면 **막지 않고 알린다**(증류 세션이 그 자리에서 합칠 수 있게).
  //   실측: 같은 파일이 3초 간격으로 지식 2건이 됐다(슬러그만 다름). 중복 방지가 전적으로 모델 자율이라
  //   건너뛰면 그대로 통과한다. 한 자료에서 여러 지식이 나오는 정당한 경우가 있어 **거절은 하지 않는다.**
  if (relation === "derived_from") {
    const { checkDerivedDup } = await import("../org/distill/derived-dup.js");
    const notice = checkDerivedDup(await derivedPeersOf(sourceId), name);
    if (notice.duplicate) {
      logger.warn({ name, sourceId, siblings: notice.siblings }, "[distill] 한 자료에서 지식이 여러 개 파생됐다 — 중복일 수 있다(#1631)");
      dupNote = notice.note;
    }
  }
  await itemsPool.query(
    `INSERT INTO knowledge_source(name, source_id, relation, created_at)
     VALUES($1,$2,$3,now()) ON CONFLICT (name, source_id, relation) DO NOTHING`,
    [name, sourceId, relation]);
  await auditKnowledge(name, "link_source", null, { source_id: sourceId, relation }, ctx);
  // 증류물은 원본의 공개범위를 물려받는다(#1291 v4) — 'cites'(단순 참조)는 제외한다: 인용했다는 이유로
  //  참조한 쪽까지 잠그면 공개 지식이 링크 하나로 잠기는 사고가 난다. 파생(derived_from)만 내용이 흘러든다.
  if (relation !== "derived_from") return null;
  const inherited = await inheritSourceVisibility(name, sourceId, ctx)
    .catch((e) => { logger.warn({ name, sourceId, err: (e as Error)?.message }, "[source-vis] 상속 실패"); return null; });
  return inherited ? { ...inherited, dupNote } : { dupNote };
}
export async function unlinkKnowledgeSource(name: string, sourceId: number, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM knowledge_source WHERE name=$1 AND source_id=$2 AND relation=$3`, [name, sourceId, relation]);
  await auditKnowledge(name, "unlink_source", { source_id: sourceId, relation }, null, ctx);
}

// #290 그래프뷰 데이터 — 활성 지식 노드(+단일 카테고리·type) + 모든 지식↔지식 엣지. UI 전용(REST). cap 으로 과대그래프 방지.
//  단일 카테고리 정책이라 노드당 카테고리 1개(LIMIT 1 은 이행기 다중 잔존 대비 안전장치).
//  viewer(#1291): 노드만 걸러도 충분하다 — 엣지는 아래에서 **노드 집합과 교차**시켜 남기므로(inGraph),
//   비가시 문서로 향하는 엣지는 자동으로 사라진다(그 이름이 그래프에 실리지 않는다).
export async function knowledgeGraphData(limit = 500, viewer?: Viewer): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
  const params: unknown[] = [Math.min(limit, 2000)];
  const vis = await knowledgeVisWhere(viewer, params);
  const nodes = await q(itemsPool,
    `SELECT k.name, k.title, k.type, k.injection, k.provenance,
            cat.key AS category, cat.name AS category_name, cat.space AS space
     FROM knowledge k
     LEFT JOIN LATERAL (
       SELECT c.key, c.name, c.space FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
       WHERE kc.name=k.name AND kc.state<>'rejected' ORDER BY kc.created_at LIMIT 1
     ) cat ON true
     WHERE k.lifecycle='active' AND ${vis} ORDER BY k.updated_at DESC LIMIT $1`, params);
  const edges = await q(itemsPool, `SELECT from_name, to_name, relation FROM knowledge_link`);
  // #551 페이지 트리 위계 엣지(parent_name) — relation='child'(자식→부모). 아틀라스가 트리+링크를 함께 표현.
  const hierarchy = await q(itemsPool,
    `SELECT k.name AS from_name, k.parent_name AS to_name, 'child' AS relation
     FROM knowledge k JOIN knowledge p ON p.name = k.parent_name
     WHERE k.lifecycle='active' AND p.lifecycle='active'`);
  // 엣지를 노드 캡과 조인 — 캡 밖 노드로의 유령 엣지 제거 + 대량 미러에서 응답 비대 방지(#551 리뷰).
  const inGraph = new Set(nodes.map((n) => String((n as { name?: unknown }).name)));
  const scoped = [...edges, ...hierarchy].filter(
    (e) => inGraph.has(String((e as { from_name?: unknown }).from_name)) && inGraph.has(String((e as { to_name?: unknown }).to_name)));
  return { nodes, edges: scoped };
}
