// 상시 에이전트 세션 — org_managed_session(desired state) + keep-alive(ensure). 프로젝트 터미널 생성(createSession)
//  과 격리 워크스페이스(공유폴더 managed/<id>)를 그대로 재사용한다. 크론 'map_unmapped' 등이 이 세션을 타깃 삼아 주입.
//  account = 라이블리 계정/프로필(=클로드 로그인). 지금 맥미니 단일 프로필, 멀티프로필 대비 필드.
import { itemsPool } from "../db/client.js";
import { createSession, listSessions, reapCentralSession } from "../terminal/terminal-sessions.js";
// 배럴(terminal-sessions.js)이 아니라 모듈에서 직접 — 배럴은 #1313 R15 의 재수출 집합이 계약이라 새 심볼을 늘리지 않는다.
import { stampManagedMarker } from "../terminal/sessions.js";
import { isProjectSessionDir } from "../project/project-fs.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";

export interface ManagedSession {
  id: string; label: string | null; account: string | null; workspace_subpath: string | null;
  harness: string; flags: Record<string, unknown>; auto_approve: boolean; enabled: boolean;
  session_id: string | null; note: string | null; sort: number;
}

// 상시세션의 **실효 계정** — 미지정이면 시드 기본 'daon'. 스폰 주체(asUser)와 사용량 조인(usage-store 키)이
//  반드시 같은 값을 써야 한다: 스폰은 이 계정으로 LIVELY_TOKEN 을 굽고, 목록은 이 계정으로 getUsage 한다.
//  둘이 갈리면(예: 조인이 raw account=null 을 쓰면) 값이 스토어에 있어도 UI 가 영영 '미보고'(silent miss)다.
export function managedAccount(m: Pick<ManagedSession, "account">): string {
  return m.account || "daon";
}

// account → provision 주체 합성 LivelyUser. 단일프로필이면 account 가 곧 시드 계정(세션 id = box-<account>-…).
function asUser(account: string): LivelyUser {
  return { userId: account, email: "", scopes: ["items", "context", "memory", "admin", "runtime"] } as unknown as LivelyUser;
}

export async function listManagedSessions(): Promise<ManagedSession[]> {
  return (await itemsPool.query("SELECT * FROM org_managed_session ORDER BY sort, id")).rows;
}

export async function getManagedSession(id: string): Promise<ManagedSession | undefined> {
  return (await itemsPool.query("SELECT * FROM org_managed_session WHERE id=$1", [id])).rows[0];
}

export async function upsertManagedSession(m: Partial<ManagedSession> & { id: string }, actor?: string): Promise<ManagedSession> {
  const ex = await getManagedSession(m.id);
  const flagsJson = m.flags ? JSON.stringify(m.flags) : null;
  // #2170 ② — 등록 시점에 막는다. **DB 쓰기 경로가 여기 하나뿐**이라(MCP·REST·웹이 전부 이 함수를 탄다)
  //  가드를 capability 핸들러가 아니라 여기 둔다 — 라우트에 두면 새 호출부가 생길 때마다 빠뜨릴 자리가 늘어난다.
  //  ⚠ 미지정(undefined)은 null 그대로 넘긴다: 아래 UPDATE 의 COALESCE 가 '기존값 유지'로 읽는 관례다.
  const subpath = m.workspace_subpath === undefined ? null : normalizeManagedSubpath(m.workspace_subpath);
  if (!ex) {
    const r = await itemsPool.query(
      `INSERT INTO org_managed_session(id,label,account,workspace_subpath,harness,flags,auto_approve,enabled,note,created_by,updated_by)
       VALUES($1,$2,$3,$4,COALESCE($5,'claude'),COALESCE($6,'{}')::jsonb,COALESCE($7,true),COALESCE($8,true),$9,$10,$10) RETURNING *`,
      [m.id, m.label ?? null, m.account ?? null, subpath, m.harness ?? null,
       flagsJson, typeof m.auto_approve === "boolean" ? m.auto_approve : null,
       typeof m.enabled === "boolean" ? m.enabled : null, m.note ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_managed_session SET
       label=COALESCE($2,label), account=COALESCE($3,account), workspace_subpath=COALESCE($4,workspace_subpath),
       harness=COALESCE($5,harness), flags=COALESCE($6,flags), auto_approve=COALESCE($7,auto_approve),
       enabled=COALESCE($8,enabled), note=COALESCE($9,note), version=version+1, updated_at=now(), updated_by=$10
     WHERE id=$1 RETURNING *`,
    [m.id, m.label ?? null, m.account ?? null, subpath, m.harness ?? null,
     flagsJson, typeof m.auto_approve === "boolean" ? m.auto_approve : null,
     typeof m.enabled === "boolean" ? m.enabled : null, m.note ?? null, actor ?? null]);
  return r.rows[0];
}

export async function deleteManagedSession(id: string): Promise<{ deleted: boolean; id: string }> {
  const r = await itemsPool.query("DELETE FROM org_managed_session WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

/** 상시세션의 워크스페이스 하위경로 — 등록값이 없으면 관례상 `managed/<id>`. 고아 판정의 식별자다. */
export function managedSubpath(m: Pick<ManagedSession, "id" | "workspace_subpath">): string {
  return m.workspace_subpath || ("managed/" + m.id);
}

/**
 * 이 하위경로가 **프로젝트 폴더**인가(순수). `project/12` 와 `project/123` 을 접두로 헷갈리지 않게 세그먼트로 끊는다
 *  (session-create-guards.autoTrustWorkspace 와 같은 규율). 절대경로 판정은 project-fs.isProjectSessionDir 이 한다 —
 *  여기서는 아직 실제 폴더가 없을 수도 있는 **등록값**을 보는 것이라 문자열 좌표로 판정하는 게 맞다.
 */
export function isProjectSubpath(subpath: string): boolean {
  const seg = String(subpath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/").filter((x) => x !== "");
  return seg[0] === "project" || seg[0] === "legacy-project";
}

/**
 * 등록하려는 `workspace_subpath` 를 정규화하고 **프로젝트 폴더를 거절**한다(순수, #2170 가드레일 ②).
 *
 * 왜 경고가 아니라 차단인가: 이 값은 MCP·REST 로도 들어온다. 경고는 응답 본문에 묻혀 아무도 안 읽고,
 *  그 사이 keep-alive 는 2분마다 돈다 — 사람이 경고를 읽기 전에 이미 세션이 죽어 있다.
 *
 * 상시세션의 작업 자리로 프로젝트 폴더가 맞는 경우는 없다. 셋 다 어긋난다:
 *  ① 정리기 — `project/<id>` 를 등록하면 그 폴더의 세션이 정리 후보로 잡힌다(#2170 의 그 사고. 지금은
 *     표식이 한 겹 더 막지만, 막는 장치가 하나뿐인 상태로 두지 않는다).
 *  ② 가시성 — 프로젝트 폴더 세션은 로그인한 전원에게 보이고 누구나 입장·조작한다(#452, canSeeSession).
 *     무인 상시세션을 그 규칙 위에 올리면 아무나 그 에이전트의 자격·기록에 붙는다.
 *  ③ 첫 지시 — 프로젝트 id 없이 `project/**` 에서 열린 세션은 autoTrustWorkspace 가 false 라
 *     하네스 신뢰 대화상자에서 멈춘다(#1867) — 상시세션은 답할 사람이 없어 영영 안 뜬다.
 *
 * 반환값이 곧 저장값이다. 빈 값이면 null(→ 관례상 `managed/<id>`).
 */
export function normalizeManagedSubpath(raw: unknown): string | null {
  const sub = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!sub) return null;
  const seg = sub.split("/").filter((x) => x !== "");
  if (!seg.length) return null;
  if (seg.some((x) => x === "." || x === "..")) {
    throw new HttpError(400, "작업 폴더 경로에 '.' · '..' 은 쓸 수 없습니다");
  }
  if (isProjectSubpath(seg.join("/"))) {
    throw new HttpError(400,
      "프로젝트 폴더(project/… · legacy-project/…)는 상시세션의 작업 폴더로 쓸 수 없습니다 — " +
      "프로젝트 폴더 세션은 전원 공동 세션이라(#452) 상시세션의 정리·가시성·첫 지시 규칙과 맞지 않습니다. " +
      "비워서 managed/<id> 를 쓰거나 다른 하위 폴더를 지정하세요");
  }
  return seg.join("/");
}

/** 정리기가 보는 살아있는 세션 한 줄. `managed` = 그 세션에 박힌 상시세션 표식(@box_managed, #2170). */
export interface ManagedLiveSession { id: string; dir?: string; created?: number; owner?: string; managed?: string | null }

/**
 * 그 상시세션의 워크스페이스에 붙어 있는 살아있는 세션들을 **유지 1개 + 고아 N개**로 가른다(순수, #1675 ⑥ / #2170).
 *
 * 왜 필요(어니스트 2026-08-12 실측): 레지스트리에 `knowledge-classify` 가 **1건** 등록돼 있는데 실제 tmux 에는
 *  같은 라벨 세션이 **30개** 떠 있었다. 29개가 고아였고, claude 프로세스 29개 = 5.7GB 를 붙들고 있었다.
 *  `ensureAllManagedSessions` 가 2분마다 도는데 **옛 세션을 정리하지 않고 새로 만들기만 했기** 때문이다.
 *
 * ── 판정 기준: 경로가 아니라 **출처**다 (#2170, 상민님 지적 2026-08-27) ──────────────────────────
 * 종전 기준은 작업 폴더 문자열 suffix 하나였다(`dir.endsWith('/'+subpath)`). 그건 "이 세션이 그 폴더에 있다"만
 *  말할 뿐 **"이 세션을 정리기가 만들었다"** 를 말하지 않는다. 둘의 간격이 그대로 사고다:
 *   · 상시세션의 `workspace_subpath` 에 `project/<id>` 를 등록하는 순간, 그 프로젝트 폴더에서 일하던
 *     **다른 멤버들의 세션 전부**가 같은 suffix 로 잡힌다.
 *   · 프로젝트 폴더 세션은 소유자와 무관하게 전원에게 보이고(write-cap.ts canSeeSession), 회수(reapCentralSession)는
 *     소유자를 묻지 않는다(그냥 tmux kill). 즉 걸러 줄 자리가 뒤에 **하나도 없다.**
 *   · keep-alive 는 2분마다 돈다. 등록 한 번이면 그 폴더의 세션이 1개만 남고 전멸한다.
 *  그래서 이제 `@box_managed === managedId` 인 세션만 '내 것'이다. 표식은 정리기 자신이 생성 시 박는다.
 *  **표식 없는 세션은 어떤 폴더에 있든 절대 고아가 아니다** — 모르면 안 건드린다.
 *
 * 작업 폴더는 여전히 함께 본다(AND). 표식이 있어도 지금 워크스페이스가 아닌 자리에 있으면(= 사람이
 *  `workspace_subpath` 를 바꿨다) 걷지 않는다 — 그 세션에 쌓인 맥락을 정책 변경이 조용히 죽이면 안 된다.
 *  `endsWith('/'+sub)` 로 비교해 `managed/foo` 가 `managed/foo-2` 를 삼키지 않게 한다.
 *
 * 유지 대상 선택: 등록된 session_id 가 살아 있으면 **그것**(레지스트리가 권위). 없으면 **가장 오래된 것**을
 *  승격한다 — 오래 산 세션이 실제로 일해 온 쪽일 가능성이 높고, 갓 만들어진 중복을 남기면 그 세션의 맥락을 버린다.
 *
 * `unmarked` = 워크스페이스는 같은데 표식이 없는 세션. **절대 걷지 않지만 보고는 한다** — 표식 도입 이전에
 *  생긴 중복이 여기 잡힌다. #1675 리뷰의 교훈이 "30개가 떠 있는데 어느 화면에도 안 보였다" 였으므로,
 *  자동 정리에서 뺀 것을 침묵으로 처리하면 같은 실패를 반복한다(관리탭이 이 수를 보여준다).
 */
export function classifyManagedLive(o: {
  live: ManagedLiveSession[];
  /** 이 상시세션의 id — 세션에 박힌 @box_managed 와 이 값이 같아야 '내 것'이다. */
  managedId: string;
  subpath: string;
  registered: string | null;
}): { keep: string | null; orphans: string[]; unmarked: string[] } {
  const suffix = "/" + o.subpath.replace(/^\/+/, "").replace(/\/+$/, "");
  const here = o.live.filter((s) => typeof s.dir === "string" && s.dir.replace(/\/+$/, "").endsWith(suffix));
  // ⚠ managedId 가 비면 **아무도 내 것이 아니다**. 이 한 줄이 없으면 아래 `(s.managed || "") === o.managedId` 가
  //  빈 값끼리 일치해 **표식 없는 세션 전부가 내 것**이 된다 — 즉 이 이슈가 없애려던 그 사고를 정확히 재현한다.
  //  호출부(m.id)는 슬러그 검증을 지나오지만, 판정을 호출부의 선의에 맡기지 않는다.
  const mine = o.managedId ? here.filter((s) => (s.managed || "") === o.managedId) : [];
  const unmarked = here.filter((s) => !s.managed).map((s) => s.id);
  if (!mine.length) return { keep: null, orphans: [], unmarked };
  const registered = o.registered && mine.some((s) => s.id === o.registered) ? o.registered : null;
  const keep = registered ?? [...mine].sort((a, b) => (a.created ?? 0) - (b.created ?? 0))[0].id;
  return { keep, orphans: mine.filter((s) => s.id !== keep).map((s) => s.id), unmarked };
}

/**
 * 표식 이전에 만들어진 상시세션 **한 개**를 입양할지(= 표식을 찍고 계속 쓸지) 판정한다(순수, #2170 이행).
 *
 * 표식은 이번 판부터 생긴다. 그전 세션은 표식이 없어 정리기 눈에 '남의 것'이라, 아무 처리도 안 하면
 *  **살아 있는 상시세션 옆에 새 세션이 하나 더 뜬다**(그리고 옛것은 영영 안 걷힌다).
 *
 * 넓히지 않는다 — 입양은 "이 세션은 앞으로 걷어도 된다"는 선언이라, 잘못 찍으면 그게 곧 이 이슈의 사고다.
 *  그래서 조건을 **레지스트리가 가리키는 그 id 하나**로 못박는다:
 *   ① `registered` 와 id 가 같다 — 사람/서버가 "이게 그 상시세션이다"라고 이미 적어 둔 것(경로 우연이 아니다)
 *   ② 표식이 없다 — 이미 있으면 입양이 아니라 그냥 내 것이다(다른 상시세션 표식이면 남의 것 → 제외)
 *   ③ 워크스페이스가 지금 좌표와 같다
 *   ④ 소유자가 이 상시세션의 계정이다 — 계정이 다르면 사람이 연 세션이다
 *   ⑤ 프로젝트 폴더가 아니다 — 프로젝트 폴더 세션은 전원 공동 세션이라(#452) 정리기의 소유물일 수 없다.
 *      ②~⑤ 중 하나라도 어긋나면 입양하지 않는다(그 tick 은 새로 만든다 — 죽이지는 않는다).
 */
export function shouldAdoptLegacy(o: {
  live: ManagedLiveSession[];
  registered: string | null;
  subpath: string;
  account: string;
  isProjectDir: (dir: string) => boolean;
}): string | null {
  // ⚠ 계정이 비면 입양하지 않는다 — 아래 소유자 비교가 빈 값끼리 일치해 **소유자를 모르는 세션**을 통과시킨다.
  if (!o.registered || !o.account) return null;
  const s = o.live.find((x) => x.id === o.registered);
  if (!s || s.managed) return null;
  const dir = typeof s.dir === "string" ? s.dir.replace(/\/+$/, "") : "";
  const suffix = "/" + o.subpath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!dir.endsWith(suffix)) return null;
  if ((s.owner || "") !== o.account) return null;
  if (o.isProjectDir(dir)) return null;
  return s.id;
}

// 한 상시 세션의 tmux 세션 보장 — 살아있으면 재사용(+ 중복 정리), 없으면 격리 워크스페이스에 createSession 으로 재생성.
export async function ensureManagedSession(m: ManagedSession): Promise<{ id: string; session_id?: string; action: string; reaped?: number }> {
  if (!m.enabled) return { id: m.id, action: "disabled" };
  // #2170 — 등록 가드(normalizeManagedSubpath)는 **앞으로 들어올 값**만 막는다. 이미 저장돼 있던 행(구버전에서
  //  등록됐거나 SQL 로 직접 넣은 것)은 그 가드를 지나온 적이 없다 → 여기서 한 번 더 막는다. 프로젝트 폴더에
  //  무인 세션을 띄우는 것 자체가 틀렸으므로(가시성·첫 지시·정리 셋 다), 만들지 않고 시끄럽게 남긴다.
  if (isProjectSubpath(managedSubpath(m))) {
    logger.error({ managed: m.id, subpath: managedSubpath(m) }, "상시세션 작업 폴더가 프로젝트 폴더다 — 세션을 만들지 않는다(#2170). workspace_subpath 를 바꾸세요");
    //  session_id 를 돌려주지 않는다: 이 설정으로 등록된 session_id 는 **남의 프로젝트 세션일 수 있다**.
    //   크론 주입(resolveSessionTmux)이 그 id 를 받으면 사람의 세션에 프롬프트를 밀어 넣는다 — 조용히 틀리느니 실패한다.
    return { id: m.id, action: "invalid_subpath", reaped: 0 };
  }
  const user = asUser(managedAccount(m));
  // ⚠ **조회 실패를 빈 목록으로 삼키면 안 된다**(#1675 ⑥ 근본원인). 종전엔 `.catch(() => [])` 라
  //  tmux 가 잠깐 안 잡히는 것만으로 "살아있는 세션이 없다" → **새로 만든다** 가 됐다. 이 함수는 2분마다
  //  돌므로 그 오판 하나가 곧 세션 하나이고, 그렇게 30개까지 늘었다. 모르면 **아무것도 하지 않는다.**
  // 타입을 ManagedLiveSession 으로 못박는다 — 정리기는 dir 말고 **owner·managed(표식)** 도 읽는다(#2170).
  //  종전 좁은 인라인 타입으로 두면 그 두 필드가 '안 쓰는 값'으로 보여, 목록 응답을 줄이는 리팩토링 한 번에
  //  판정이 조용히 경로-only 로 되돌아간다.
  let live: ManagedLiveSession[];
  try {
    // strict — tmux 를 **못 본 것**은 예외로 받는다. 기본 모드는 그걸 빈 목록으로 돌려주는데,
    //  이 호출부는 "없으면 만든다"라서 그 오해가 곧 세션 하나다(2분마다 반복 → 30개).
    live = await listSessions(user, { strict: true });
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, managed: m.id }, "상시세션 목록 조회 실패 — 이번 tick 은 생성하지 않는다");
    return { id: m.id, session_id: m.session_id ?? undefined, action: "unknown", reaped: 0 };
  }

  // 이 상시세션이 **자기가 만든** 세션 전수 — 하나만 남기고 나머지는 걷는다(#2170: 판정 근거는 경로가 아니라 표식).
  const sub = managedSubpath(m);
  const { keep: marked, orphans, unmarked } = classifyManagedLive({ live, managedId: m.id, subpath: sub, registered: m.session_id });
  let reaped = 0;
  for (const id of orphans) {
    try { await reapCentralSession(id); reaped++; }
    catch (e) { logger.warn({ err: (e as Error)?.message, managed: m.id, session: id }, "상시세션 중복 정리 실패"); }
  }
  if (reaped) logger.warn({ managed: m.id, reaped, kept: marked }, "상시세션 고아 정리(#1675 ⑥)");
  // 표식 없이 같은 워크스페이스에 떠 있는 세션 — **걷지 않는다**(내가 만든 게 아니다). 다만 조용히 넘기지도 않는다:
  //  #1675 의 교훈이 "30개가 떠 있는데 어느 화면에도 안 보였다" 였다. 관리탭도 이 수를 unmarked_count 로 보여준다.
  //  ⚠ warn 이 아니라 info 다: 이 함수는 2분마다 돌아 warn 이면 하루 720줄이 쌓여 실제 오류를 가린다
  //   (노드 로그가 그렇게 하루 9천 줄로 묻힌 전례가 있다). 사람에게 보이는 자리는 관리탭 배지(unmarked_count)다.
  if (unmarked.length) logger.info({ managed: m.id, unmarked, subpath: sub }, "상시세션 워크스페이스에 표식 없는 세션이 있다 — 자동 정리 대상이 아니다(#2170)");

  // 이행(#2170) — 표식 도입 전에 만들어진 그 세션 하나는 입양하며 표식을 찍는다. 조건은 shouldAdoptLegacy 주석 참조.
  let keep = marked;
  if (!keep) {
    const adopt = shouldAdoptLegacy({ live, registered: m.session_id, subpath: sub, account: m.account || "daon", isProjectDir: isProjectSessionDir });
    if (adopt) {
      try {
        await stampManagedMarker(adopt, m.id);
        keep = adopt;
        logger.warn({ managed: m.id, session: adopt }, "표식 없는 기존 상시세션을 입양하고 표식을 찍었다(#2170 이행)");
      } catch (e) {
        // 못 찍었으면 입양하지 않는다 — 표식 없는 세션을 '내 것'으로 치면 다음 tick 이 근거 없이 걷게 된다.
        logger.warn({ err: (e as Error)?.message, managed: m.id, session: adopt }, "상시세션 표식 찍기 실패 — 입양하지 않는다");
      }
    }
  }

  if (keep) {
    // 레지스트리가 다른 id 를 가리키고 있었으면(또는 비어 있었으면) 지금 살아있는 것으로 맞춘다 —
    //  이 동기화가 없으면 다음 tick 이 같은 판단을 반복하며 계속 새로 만든다.
    if (m.session_id !== keep) {
      await itemsPool.query("UPDATE org_managed_session SET session_id=$1, updated_at=now() WHERE id=$2", [keep, m.id])
        .catch((e) => logger.warn({ err: (e as Error)?.message, managed: m.id }, "상시세션 session_id 동기화 실패"));
    }
    return { id: m.id, session_id: keep, action: m.session_id === keep ? "alive" : "adopted", reaped };
  }
  const created = await createSession(user, {
    label: m.label || m.id, rootKey: "shared", subpath: m.workspace_subpath || ("managed/" + m.id),
    harness: m.harness || "claude", flags: (m.flags || {}) as Record<string, unknown>, autoApprove: !!m.auto_approve,
    // #1059 E — 상시 세션은 desired-state DB 미러 skip: keep-alive(ensureAllManagedSessions)가 영속을 소유하므로
    //  restorable 로 이중화하면 재부팅 후 keep-alive 재생성과 사용자 수동복원이 충돌한다.
    // #2170 — 값이 boolean 이 아니라 **이 상시세션의 id** 다: createSession 이 그것을 @box_managed 로 세션에 박고,
    //  다음 tick 의 정리기가 그 표식으로 '내가 만든 세션'을 판정한다(경로 우연의 일치로 남의 세션을 죽이지 않게).
    managed: m.id,
    // #2162 — 위의 `managed`(**누구의 것인가** — 정리기용 신원)와 이건 **직교**다: kind 는 **무엇인가**(종류)를
    //  말한다. 종전 `managed: true` 가 그 둘을 한 불리언에 겹쳐 놓아 어느 쪽도 제대로 못 말했다.
    kind: "managed",
  });
  await itemsPool.query("UPDATE org_managed_session SET session_id=$1, updated_at=now() WHERE id=$2", [created.id, m.id]);
  return { id: m.id, session_id: created.id, action: "created" };
}

// keep-alive — enabled 상시 세션 전부 ensure(크론 ensure_managed_sessions 가 주기 호출). 등록 0이면 no-op.
export async function ensureAllManagedSessions(): Promise<Array<{ id: string; session_id?: string; action?: string; error?: string }>> {
  const rows = await listManagedSessions();
  const out: Array<{ id: string; session_id?: string; action?: string; error?: string }> = [];
  for (const m of rows) {
    if (!m.enabled) continue;
    try { out.push(await ensureManagedSession(m)); }
    catch (e) { out.push({ id: m.id, error: (e as Error)?.message ?? String(e) }); }
  }
  return out;
}
