// 링크 따라 읽기(#4213 T12 #4744) — 링크 표(collect_link) · 링크로 읽은 문서 저장 · 다음 판에 실을 링크 · 연결 제안. 판정은 link-plan.ts(순수).
//
//  ── 상태(기록할 때) ──
//   pending     — 읽을 수 있는 앱(노션 · 슬랙)이고 아직 안 읽었다. 그 사람의 그 앱 판에 실린다(PLANNED_LINKS_PER_RUN) — 실을지는 **실을 때**
//                 다시 가린다(pendingLinksFor: 아래 «공개범위» 로 넣을 수 없는 대상이면 싣지 않는다 — 조건이 풀리면 그때 실린다).
//                 쉬기 · 시도 상한은 줄이 아니라 그 사람의 그 대상 전체로 판정한다(다른 단위에서 새로 생긴 줄이 쉬는 대상을 다시 싣지 않게).
//   read        — 읽었다(링크로 읽은 문서를 그 문서의 단위에 넣었다).
//   unsupported — 수집 실행이 아직 못 읽는 앱(구글 드라이브 · 깃허브 …).
//   «연결돼 있나» 는 줄에 굳혀 두지 않는다 — 연결 제안(linkSuggestionsFor)이 부를 때마다 그 사람의 지금 커넥터로 잰다(연결하면 제안에서 빠진다).
//   읽었는데 결과가 오류 모양이면 tries·tried_at 을 올리고 LINK_RETRY_DAYS 동안 다시 싣지 않는다 · LINK_MAX_TRIES 번에서 멈춘다.
//  ── 공개범위(다온 판단, 상민님 확인 전) ──
//   · 링크로 읽은 문서는 **그 문서의 단위**에 넣는다(링크가 있던 단위가 아니다). 그 단위의 «모을지» 결정을 따른다 — 모으지 않기로 한 단위 ·
//     라이블리 수집기 경로 단위 · 남이 «나만» 으로 잡은 단위에는 넣지 않는다(읽은 사람을 구성원으로 더하지도 않는다).
//   · 검토 전(active 아님) 단위는 자료가 모두에게 보이게 될 때 넣지 않는다 — 공개범위가 «모두» 인 단위(서버 목록의 공개 채널 첫 제안) ·
//     공개범위를 끈 워크스페이스(무엇이든 모두에게 보인다). 그런 곳은 노션 페이지 단위도 새로 만들지 않는다(«수집 전 검토» 규칙).
//   · 노션 페이지는 단위가 없으면 만든다 — 종류 page(기본 «볼 수 있는 사람만») · 상태 candidate · 읽은 사람만 확인된 구성원.
//   · 슬랙은 그 채널이 이미 단위이고 읽은 사람이 구성원일 때만 넣는다(채널 종류를 몰라 단위를 만들지 않는다 — 공개 채널 기본값 «모두»).
//   · **보호 단위**(공개범위가 «모두» 가 아니고 · 메일함이 아니고 · 이미 모인 자료가 있는 단위)는 읽은 사람이 이미 확인된 구성원일 때만 넣는다 —
//     아니면 구성원으로 올리지도 저장하지도 않고 «보류»(held)로 센다(시도로 안 센다). 원문 캡처는 그 사람 홈에 있어 고쳐 쓸 수 있으므로, 링크
//     읽기 하나로 남의 비공개 단위에 모인 자료가 열리거나 가짜 글이 끼지 않게 — 확인 읽기(T11 #4743)의 판정(unit-proof guardedSql)을 그대로 쓴다.
//     그 사람의 구성원 행이 있으면 확인 대기(requestProof)를 건다 — 확인 읽기가 판정하고, 확인되면 다음 판에 실린다(행이 없으면 걸지 않는다 —
//     확인은 이미 있는 행만 올린다).
//   · 메일함 글 속 링크는 적지 않는다(알림·바깥 발신자의 링크가 계획 칸을 채우지 않게).
//   · 링크 주소는 이 표에만 둔다(조회 방화벽 — db/firewall.ts). 밖으로는 그 사람의 앱별 개수만 낸다.
//  ⚠ 한계(확인 읽기와 같다): 자료가 모이기 **전**의 단위 · 새 노션 페이지 단위는 그 사람 실행의 원문만으로 «확인된 구성원» 이 된다(지킬 자료가 없다).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { currentTenant } from "../tenant-context.js";
import { axisOn } from "../../v6/visibility-axes.js";
import { CLAUDE_COLLECT_APPS, type LinkedRead, type PlannedLink } from "./collect-plan.js";
import type { AppLink } from "./link-plan.js";
import { getUnit, recordUnitListing, storeUnitItems } from "./unit-store.js";
import { guardedSql, guardsByUnitId, requestProof } from "./unit-proof.js";

/** 오류 모양으로 끝난 링크를 다시 실을 때까지(일) · 그만 실을 시도 수. */
export const LINK_RETRY_DAYS = 7;
export const LINK_MAX_TRIES = 3;
/** 링크 줄을 남겨 두는 기간 — 마지막으로 본 뒤 이만큼 지나면 지운다(일). */
export const LINK_KEEP_DAYS = 180;

/** 링크를 따라 열 줄 아는 앱(수집 실행의 도구로 그 문서 하나를 연다). */
export const LINK_READABLE_APPS: ReadonlySet<string> = new Set(["notion", "slack"]);
/** 링크를 적지 않는 출처(단위의 앱) — 메일함. */
const LINK_SKIP_SOURCE_APPS: ReadonlySet<string> = new Set(["gmail"]);
/** 링크를 적지 않는 대상 앱 — 메일 주소는 그 사람 메일함 안의 것이라 남이 열 수 없다. */
const LINK_SKIP_APPS: ReadonlySet<string> = new Set(["gmail"]);
/** 앱 키 → claude.ai 커넥터 이름(소문자) — 연결 제안이 «이 사람이 연결했나» 를 잴 때. 모르는 앱은 연결 안 된 것으로 본다. */
export const CONNECTOR_NAME: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(CLAUDE_COLLECT_APPS).map(([k, v]) => [k, v.toLowerCase()])),
  gdrive: "google drive", github: "github", figma: "figma", linear: "linear", atlassian: "atlassian", asana: "asana",
  microsoft365: "microsoft 365", box: "box", canva: "canva", sentry: "sentry", hubspot: "hubspot", intercom: "intercom", airtable: "airtable",
  monday: "monday.com", webflow: "webflow", zendesk: "zendesk", dropbox: "dropbox", miro: "miro", clickup: "clickup",
};

/** 기록할 때의 상태 — 읽은 것 · 읽을 수 있는 앱 · 못 읽는 앱. */
export function linkState(app: string, read: boolean): "read" | "pending" | "unsupported" {
  if (read) return "read";
  return LINK_READABLE_APPS.has(app) ? "pending" : "unsupported";
}

/** 그 단위 자체를 가리키는 링크인가(같은 채널의 메시지 · 같은 페이지) — 그 단위 판이 어차피 읽는다. */
const pointsToItself = (u: { app: string; ref: string }, l: AppLink): boolean =>
  l.app === u.app && (l.app === "slack" ? l.channel === u.ref : l.ref === u.ref);

/** 워크스페이스마다 마지막 정리 시각 — 정리는 한 시간에 한 번. */
const lastPurge = new Map<string, number>();
async function purgeOldLinks(nowMs: number): Promise<void> {
  const k = currentTenant()?.id ?? "-";
  if (nowMs - (lastPurge.get(k) ?? 0) < 3600_000) return;
  lastPurge.set(k, nowMs);
  await itemsPool.query(`DELETE FROM collect_link WHERE last_seen_at < now() - make_interval(days => $1::int)`, [LINK_KEEP_DAYS])
    .catch((e) => logger.warn({ err: (e as Error)?.message }, "[collect-link] 오래된 링크 줄을 못 지웠다 — 다음에 다시"));
}

/**
 * 한 단위의 저장된 글에서 찾은 링크를 기록한다 — (앱 · 대상 · 링크가 나온 단위) 한 줄 · 또 보면 seen_count + 1 · 읽은 줄은 그대로 «읽음».
 *  done.readTargets = 이번 판에 링크로 읽어 넣은 대상(link-plan.linkKey 꼴) → 넣은 단위 — 그 줄은 바로 «읽음» 과 그 단위로 적는다.
 *  done.tried = 이번 판에 읽었지만 결과가 오류 모양이던 대상 — **새로 적는 줄만** 시도 1(이미 있던 줄은 storeLinkedReads 가 올렸다).
 *  메일함 단위의 글이면 아무것도 안 적는다. **던지지 않는다.**
 */
export async function recordLinks(member: string, unit: { id: number; app: string; ref: string }, links: readonly AppLink[],
  done: { readTargets?: ReadonlyMap<string, number>; tried?: ReadonlySet<string> } = {}, nowMs = Date.now()): Promise<{ recorded: number; skipped: number }> {
  if (LINK_SKIP_SOURCE_APPS.has(unit.app)) return { recorded: 0, skipped: links.length };
  const readTargets = done.readTargets ?? new Map<string, number>();
  const tried = done.tried ?? new Set<string>();
  const rows = links.filter((l) => !LINK_SKIP_APPS.has(l.app) && !pointsToItself(unit, l));
  if (!rows.length) return { recorded: 0, skipped: links.length };
  let recorded = 0;
  try {
    for (const l of rows) {
      const key = `${l.app}\u0001${l.ref}`;
      const threadKey = l.app === "slack" && l.thread ? `slack\u0001${l.channel}:${l.thread}` : null;
      const target = readTargets.get(key) ?? (threadKey ? readTargets.get(threadKey) : undefined);
      const triedNow = target == null && (tried.has(key) || (!!threadKey && tried.has(threadKey)));
      const state = linkState(l.app, target != null);
      await itemsPool.query(
        `INSERT INTO collect_link(app, ref, kind, url, channel, thread, from_unit_id, member_id, state, read_at, target_unit_id, tries, tried_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 = 'read' THEN now() END, $10, CASE WHEN $11 THEN 1 ELSE 0 END, CASE WHEN $11 THEN now() END)
         ON CONFLICT (app, ref, from_unit_id) DO UPDATE SET
           seen_count = collect_link.seen_count + 1, last_seen_at = now(), url = EXCLUDED.url,
           member_id = CASE WHEN collect_link.state = 'read' THEN collect_link.member_id ELSE EXCLUDED.member_id END,
           state = CASE WHEN collect_link.state = 'read' OR EXCLUDED.state = 'read' THEN 'read' ELSE EXCLUDED.state END,
           read_at = COALESCE(collect_link.read_at, EXCLUDED.read_at),
           target_unit_id = COALESCE(EXCLUDED.target_unit_id, collect_link.target_unit_id)`,
        [l.app, l.ref.slice(0, 500), l.kind, l.url.slice(0, 1000), l.channel ?? null, l.thread ?? null, unit.id, member, state, target ?? null, triedNow]);
      recorded++;
    }
    await purgeOldLinks(nowMs);
  } catch (e) {
    logger.warn({ unitId: unit.id, err: (e as Error)?.message }, "[collect-link] 링크를 못 적었다 — 다음 판이 다시 찾는다");
  }
  return { recorded, skipped: links.length - rows.length };
}

/**
 * 그 사람의 그 앱 판에 실을 링크 — 읽을 차례(pending · 쉬는 중 아님 · 시도 상한 전)이고 **넣을 수 있는 대상**만. 오래된 것부터 · 같은 대상은 한 번.
 *  넣을 수 없는 대상(머리말 «상태»)은 줄은 그대로 두고 싣지만 않는다 — 조건이 풀리면(채널이 단위가 되고 구성원이 되면 · 공개범위를 켜면) 실린다.
 */
export async function pendingLinksFor(member: string, apps: readonly string[], limit: number): Promise<PlannedLink[]> {
  const want = apps.filter((a) => LINK_READABLE_APPS.has(a));
  if (!want.length || limit <= 0) return [];
  try {
    const reviewedOnly = !(await axisOn("source"));   // 공개범위를 끈 워크스페이스 — 검토된(모으는 중인) 단위에만
    //  넣을 수 있는 대상만(머리말 «공개범위» — storeLinkedReads 와 같은 기준) · 쉬기 · 시도 상한은 그 사람의 그 대상 전체로.
    const r = await itemsPool.query(
      `SELECT id, app, ref, kind, channel, thread FROM (
         SELECT DISTINCT ON (l.app, l.ref) l.id, l.app, l.ref, l.kind, l.channel, l.thread, l.first_seen_at
           FROM collect_link l
          WHERE l.member_id = $1 AND l.state = 'pending' AND l.app = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM collect_link l2 WHERE l2.member_id = $1 AND l2.app = l.app AND l2.ref = l.ref
                             AND (l2.tries >= $3 OR l2.tried_at >= now() - make_interval(days => $4::int)))
            AND (
              (l.app = 'slack' AND EXISTS (
                 SELECT 1 FROM collect_unit u JOIN collect_unit_member m ON m.unit_id = u.id AND m.member_id = $1
                  WHERE u.app = 'slack' AND u.ref = l.channel AND u.state <> 'excluded' AND u.route = 'member_ai'
                    AND (u.visibility <> 'me' OR u.owner_member = $1)
                    AND (u.state = 'active' OR (NOT $5::boolean AND u.visibility <> 'all'))
                    AND NOT ${guardedSql("$1")}))
              OR (l.app = 'notion' AND NOT EXISTS (
                 SELECT 1 FROM collect_unit u
                  WHERE u.app = 'notion' AND u.ref = l.ref
                    AND (u.state = 'excluded' OR u.route <> 'member_ai' OR (u.visibility = 'me' AND u.owner_member IS DISTINCT FROM $1)
                         OR (u.state <> 'active' AND u.visibility = 'all') OR ${guardedSql("$1")}))
                 AND (NOT $5::boolean OR EXISTS (SELECT 1 FROM collect_unit u WHERE u.app = 'notion' AND u.ref = l.ref AND u.state = 'active')))
            )
          ORDER BY l.app, l.ref, l.first_seen_at
       ) x ORDER BY first_seen_at, id LIMIT $6`, [member, want, LINK_MAX_TRIES, LINK_RETRY_DAYS, reviewedOnly, limit]);
    return (r.rows as Array<{ id: number; app: string; ref: string; kind: string; channel: string | null; thread: string | null }>).map((x) => ({
      id: Number(x.id), app: x.app, ref: x.ref, kind: x.kind as PlannedLink["kind"],
      ...(x.channel ? { channel: x.channel } : {}), ...(x.thread ? { thread: x.thread, ts: x.ref.split(":")[1] } : {}),
    }));
  } catch (e) {
    logger.warn({ member, err: (e as Error)?.message }, "[collect-link] 실을 링크를 못 읽었다 — 링크 없이 띄운다");
    return [];
  }
}

/** 링크 읽음 표시 — 그 대상을 가리키는 그 사람의 줄 전부(어느 단위에서 봤든). 슬랙은 같은 스레드를 가리키는 메시지 링크도. */
async function markRead(member: string, r: Pick<LinkedRead, "app" | "ref" | "thread" | "link">, targetUnitId: number): Promise<void> {
  if (r.app === "notion") {
    await itemsPool.query(
      `UPDATE collect_link SET state = 'read', read_at = now(), target_unit_id = $3 WHERE app = 'notion' AND ref = $1 AND member_id = $2 AND state <> 'read'`,
      [r.ref, member, targetUnitId]);
  } else {
    await itemsPool.query(
      `UPDATE collect_link SET state = 'read', read_at = now(), target_unit_id = $4
        WHERE app = 'slack' AND member_id = $3 AND state <> 'read' AND (ref = $1 OR (channel = $2 AND thread = $5))`,
      [r.link.ref, r.ref, member, targetUnitId, r.thread ?? ""]);
  }
}

/** 결과가 오류 모양이던 대상 — 그 사람의 그 대상을 가리키는 (이미 있던) 줄의 시도 수를 올린다. */
async function markTried(member: string, r: Pick<LinkedRead, "app" | "ref" | "thread" | "link">): Promise<void> {
  if (r.app === "notion") {
    await itemsPool.query(`UPDATE collect_link SET tries = tries + 1, tried_at = now() WHERE app = 'notion' AND ref = $1 AND member_id = $2 AND state = 'pending'`, [r.ref, member]);
  } else {
    await itemsPool.query(
      `UPDATE collect_link SET tries = tries + 1, tried_at = now()
        WHERE app = 'slack' AND member_id = $3 AND state = 'pending' AND (ref = $1 OR (channel = $2 AND thread = $4))`, [r.link.ref, r.ref, member, r.thread ?? ""]);
  }
}

/** 그 대상의 단위(있으면) — 같은 instance 가 먼저. */
async function unitByCoord(app: string, ref: string, instance: string): Promise<{ id: number; instance: string } | null> {
  const r = await itemsPool.query(
    `SELECT id, instance FROM collect_unit WHERE app = $1 AND ref = $2 ORDER BY (instance = $3) DESC, id LIMIT 1`, [app, ref, instance]);
  return r.rows[0] ? { id: Number(r.rows[0].id), instance: String(r.rows[0].instance) } : null;
}

export interface LinkedStoreResult {
  read: number; stored: number; created: number;
  /** 남의 «나만» 단위라 넣지 않았다. */
  refused: number;
  /** 그 단위의 «모을지» 결정(모으지 않기로 함 · 수집기 경로 · 검토 전인데 모두에게 보이게 될 단위)이라 넣지 않았다. */
  skipped: number;
  /** 보호 단위인데 읽은 사람이 아직 확인된 구성원이 아니라 넣지 않았다(구성원으로 올리지도 않는다 — 확인되면 다음 판에). */
  held: number;
  /** 슬랙 — 그 채널이 단위가 아니거나 구성원이 아니라 넣지 않았다. */
  left: number;
  /** 결과가 오류 모양 · 저장 실패. */
  failed: number;
}

/** 넣은 링크 읽기의 열쇠(link-plan.linkKey 꼴) — 같은 판의 링크 기록이 그 줄을 바로 «읽음» 으로 적게. 슬랙은 스레드(부모) 열쇠도. */
function readKeysOf(r: LinkedRead): string[] {
  const keys = [`${r.link.app}\u0001${r.link.ref}`];
  if (r.app === "slack" && r.thread) keys.push(`slack\u0001${r.ref}:${r.thread}`);
  return keys;
}

/**
 * 링크로 읽은 문서를 **그 문서의 단위**에 넣는다(머리말 «공개범위»). 넣은 대상의 링크 줄은 «읽음». 결과가 오류 모양이면 시도 수를 올린다
 *  (정책으로 못 넣은 것은 시도로 세지 않는다 — 계획이 미리 거른다). **던지지 않는다.**
 */
export async function storeLinkedReads(member: string, reads: readonly LinkedRead[]):
  Promise<LinkedStoreResult & { readTargets: Map<string, number>; tried: Set<string> }> {
  const res: LinkedStoreResult & { readTargets: Map<string, number>; tried: Set<string> } = {
    read: reads.length, stored: 0, created: 0, refused: 0, skipped: 0, held: 0, left: 0, failed: 0, readTargets: new Map(), tried: new Set(),
  };
  const failedRead = async (r: LinkedRead) => {
    res.failed++;
    for (const k of readKeysOf(r)) res.tried.add(k);
    await markTried(member, r).catch(() => undefined);
  };
  let reviewedOnly: boolean | null = null;
  const axisOff = async () => (reviewedOnly ??= !(await axisOn("source")));
  for (const r of reads) {
    if (!r.ok || !r.items.length) { await failedRead(r); continue; }
    try {
      let unit = await unitByCoord(r.app, r.ref, r.instance);
      const u = unit ? await getUnit(unit.id) : null;
      if (u) {
        //  그 단위의 결정을 따른다 — 모으지 않기로 함 · 라이블리 수집기 경로 · 남의 «나만» · 검토 전인데 모두에게 보이게 될 단위.
        if (u.state === "excluded" || u.route !== "member_ai") { res.skipped++; continue; }
        if (u.visibility === "me" && u.owner_member !== member) { res.refused++; continue; }
        if (u.state !== "active" && (u.visibility === "all" || (await axisOff()))) { res.skipped++; continue; }
        const isMember = u.members.some((m) => m.member_id === member);
        if (r.app === "slack" && !isMember) { res.left++; continue; }
        //  보호 단위 — 이미 확인된 구성원만(구성원으로 올리지도 저장하지도 않는다). 구성원 행이 있으면 확인 대기를 건다.
        if ((await guardsByUnitId(member, [u.id])).get(u.id) === true) {
          res.held++;
          if (isMember) await requestProof(member, [u.id]).catch(() => 0);
          continue;
        }
      }
      if (r.app === "notion") {
        if (!u) {
          if (await axisOff()) { res.skipped++; continue; }
          //  읽은 사람이 그 페이지를 볼 수 있다는 증거(그 사람 실행의 원문)로 단위를 올린다 — 후보 · 기본 «볼 수 있는 사람만».
          const lr = await recordUnitListing({
            member, app: "notion", connector: CLAUDE_COLLECT_APPS.notion, instance: r.instance,
            items: [{ ref: r.ref, kind: r.kind === "database" ? "database" : "page", name: r.name ?? null }], verified: true,
          }, { actor: member, source: "collect-link" });
          res.created += lr.created;
          unit = await unitByCoord(r.app, r.ref, r.instance);
        } else if (!u.members.some((m) => m.member_id === member)) {
          //  있는 단위인데 이 사람이 구성원이 아니면 목록 증거로 더한다(읽었으니 볼 수 있다) — 공개범위는 그 단위의 것 그대로.
          await recordUnitListing({
            member, app: "notion", connector: CLAUDE_COLLECT_APPS.notion, instance: u.instance,
            items: [{ ref: r.ref, kind: u.kind, name: u.name ?? r.name ?? null }], verified: true,
          }, { actor: member, source: "collect-link" });
        }
      } else if (!u || !u.members.some((m) => m.member_id === member)) {
        res.left++;
        continue;
      }
      if (!unit) { res.failed++; continue; }
      const s = await storeUnitItems(unit.id, r.items, { member });
      //  저장 도중 공개범위가 «나만» 으로 바뀌었다(경합) — 넣지 않은 것으로 센다.
      if (s.refused > 0) { res.refused++; continue; }
      if (s.failed > 0) { res.failed++; continue; }
      res.stored += s.stored;
      for (const k of readKeysOf(r)) res.readTargets.set(k, unit.id);
      await markRead(member, r, unit.id);
    } catch (e) {
      const status = Number((e as { status?: unknown })?.status);
      if (status === 403) res.refused++;
      else { res.failed++; logger.warn({ app: r.app, err: (e as Error)?.message }, "[collect-link] 링크로 읽은 문서를 못 넣었다"); }
    }
  }
  return res;
}

/**
 * 연결 제안 — **부르는 사람의** 판에서 본 링크 가운데 그 사람이 지금 연결하지 않은 앱의 링크 수(서로 다른 대상)와 그 링크가 나온 단위 수.
 *  읽은 링크는 빼고, 연결은 부를 때마다 member_ai_connector 로 잰다(연결하면 빠진다). 주소는 내지 않는다. 못 읽으면 빈 목록.
 */
export async function linkSuggestionsFor(member: string): Promise<Array<{ app: string; links: number; units: number }>> {
  if (!member) return [];
  try {
    const names = Object.entries(CONNECTOR_NAME);
    const params: unknown[] = [member, names.map(([a]) => a), names.map(([, n]) => n)];
    const r = await itemsPool.query(
      `WITH names(app, name) AS (SELECT * FROM unnest($2::text[], $3::text[]))
       SELECT l.app, count(DISTINCT l.ref)::int AS links, count(DISTINCT l.from_unit_id)::int AS units
         FROM collect_link l LEFT JOIN names n ON n.app = l.app
        WHERE l.member_id = $1 AND l.state <> 'read'
          AND NOT EXISTS (SELECT 1 FROM member_ai_connector c
                           WHERE c.member_id = $1 AND c.provider = 'claude' AND c.status = 'connected' AND lower(c.app) = n.name)
        GROUP BY l.app ORDER BY links DESC, l.app LIMIT 50`, params);
    return (r.rows as Array<{ app: string; links: number; units: number }>).map((x) => ({ app: String(x.app), links: Number(x.links), units: Number(x.units) }));
  } catch { return []; }
}
