// 세션이 만든 결과물을 자료로 (#5790) — 중앙 세션의 **턴이 끝날 때** 그 세션의 프로젝트 폴더를 훑어 등록한다.
//
// ── 왜 필요한가 ───────────────────────────────────────────────────────────────
//  원준 2026-11-24: «지금 우리 AI가 만들어낸 작업물의 결과가 자동으로 자료에 올라가는 상황인게 맞아? 아닌거같지 왜»
//  자료 등록은 업로드 마무리(finishUpload)에서만 일어난다. 세션이 어디서 도느냐에 따라 결과가 갈렸다:
//   · 노드(개인 PC) 세션 — project-push 훅이 턴마다 프로젝트 폴더 변경분을 PUT 한다 → finishUpload → 자료(«AI가 만든 파일»).
//   · 중앙 세션(매니지드 중앙 컴퓨터 · 자체 호스팅 박스) — 세션이 공유 저장소의 프로젝트 폴더에 **직접** 쓴다. 업로드가
//     없으니 자료도 없다. 파일 탭엔 보이는데 자료 검색·증류·AI 맥락에는 영영 안 잡혔다(#4064 9/17 실측도 같은 사실).
//  이 모듈이 중앙 세션 쪽 빈칸을 메운다. 판정·등록은 기존 것(classifyLocalPath · ingestLocalUpload)을 그대로 쓴다 —
//  노드 세션이 올린 파일과 같은 자료 행·같은 «AI가 만든 파일» 표시가 된다.
//
// ── 규칙 (pickSessionOutputs 가 표로 못박는다) ──────────────────────────────────
//  ① 대상 = 이 세션 프로젝트의 폴더 매니페스트(숨김·git 레포 서브트리 제외 — 동기화와 같은 규칙) 안의 파일 중
//     · 세션이 시작된 뒤(시작 시각 − 여유) 바뀌었고 — 그 전 파일은 이 세션의 결과물이 아니다(옛 파일을 한꺼번에 쏟지 않는다)
//     · 자료 형식 규칙(classifyLocalPath)이 받고
//     · **결과물로 보이고**(isOutputFile — 코드·임시·생성 안내 파일 제외. 사람에게 줄 문서·이미지·PDF·표가 대상)
//     · 크기 상한 이하이고
//     · 안쪽에 든 다른 프로젝트의 폴더가 아니고(#4688 — 그 파일은 그 프로젝트의 자료다)
//     · 그 상태(시각·크기)로 이미 자료에 있지 않은 것.
//  ② 사람이 자료에서 내린 행(superseded)은 파일이 그대로면 되살리지 않는다 — 비교는 행의 상태와 무관하게 시각·크기로만.
//     시각을 모르는 옛 행(매니지드에서 이 변경 전에 등록돼 occurred_at 이 빈 행)은 크기만 같으면 «이미 있다» 로 본다.
//     파일을 고쳐 시각·크기가 바뀌면 그건 새 결과물이라 다시 등록된다(ingestLocalUpload 가 되살린다 — 업로드와 같은 규약).
//     ⚠ 한계 — 행이 **없으면**(완전 삭제) 비교할 것이 없다. 화면의 «휴지통으로» 는 파일을 숨김 휴지통으로 옮기므로(매니페스트에서
//     빠진다) 되살아나지 않는다. 파일을 폴더에 남긴 채 행만 지우는 길(source_delete 직접 호출 · 세션 발자국 지우기의 일부)은
//     그 파일이 훑는 세션의 시작 뒤에 바뀐 것이면 다음 턴에 다시 등록된다 — «프로젝트 폴더의 결과물은 자료다» 가 이 모듈의 규칙이다.
//  ③ 읽기전용·인코그니토 세션은 하지 않는다(그 세션은 기록을 남기지 않기로 한 세션이다).
//     기록 범위(#1291 v2 write cap)가 좁혀진 세션은 리스트로 대상을 좁히지 않은 프로젝트에 등록하지 않는다 — 작업기록(activity_log)과
//     같은 판정(capBlocks). 승인 없이 넓게 기록하지 않는다는 가드레일이다.
//  ④ 한 번에 MAX_PER_SWEEP 개 — 남은 것은 다음 턴에 간다. 프로젝트마다 한 번에 하나(같은 폴더를 두 세션이 동시에 훑지 않게) ·
//     도는 동안 턴을 끝낸 세션들은 한 묶음으로 매니페스트를 **한 번만** 읽는다(병렬 에이전트 열 개가 한꺼번에 끝나도 폴더 훑기 한 번).
//  ⑤ 어떤 실패도 세션·보고를 막지 않는다(호출부는 void 로 부른다 · 여기선 전부 삼키고 로그만).
//  ⑥ «어느 세션이 만들었나» 는 시각 창으로 가린다(파일에 작성자 기록이 없다) — 같은 폴더에서 동시에 돈 다른 세션의 파일이 먼저
//     턴을 끝낸 세션 이름으로 붙을 수 있다. 들어온 길(«AI가 만든 파일»)은 맞고, 사람이 올린 파일은 이미 행이 있어 건드리지 않는다
//     (있는 행의 들어온 길은 keepEntry 가 지킨다).
import path from "node:path";
import { logger } from "../log.js";
import { classifyLocalPath, extOf, localExternalId, normalizeLocalRel, LOCAL_SYSTEM, LOCAL_INSTANCE } from "./local-file-core.js";
import { ENTRY_GENERATED } from "../v6/source-group.js";
import { tenantSlug } from "../terminal/catalog.js";
import type { Manifest, ManifestFile } from "../project/project-manifest.js";

/** 한 번에 등록할 상한 — 남은 것은 다음 턴. 큰 산출 묶음(이미지 수백 장)이 한 턴 보고를 오래 붙잡지 않게. */
export const MAX_PER_SWEEP = 50;
/** 이보다 큰 파일은 자동 등록하지 않는다(파일은 폴더에 그대로 있다 — 사람이 올리면 된다). */
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
/** 세션 시작 시각 여유 — 시계 차이·세션 행이 파일보다 늦게 적히는 틈 */
export const START_SKEW_MS = 2 * 60_000;
/** 같은 프로젝트를 다시 훑기까지 최소 간격 — 여러 세션이 같은 폴더에서 연달아 턴을 끝내도 매니페스트를 한 번씩만 */
export const MIN_INTERVAL_MS = 5_000;

// 결과물이 아닌 것 — 자료 형식 규칙은 받지만(코드도 텍스트다) 사람에게 줄 산출물로 보지 않는 것.
//  코드는 git 이 수렴시키고(레포 서브트리는 매니페스트가 이미 뺀다), 레포 밖 스크립트는 결과물을 만드는 도구다.
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "ipynb", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php",
  "swift", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "css", "scss", "less", "vue", "svelte", "dart", "r", "scala", "lua", "pl",
]);
// 임시·중간 산물 — 편집기·다운로드·빌드가 남기는 것.
const TEMP_EXT = new Set(["tmp", "temp", "bak", "swp", "swo", "part", "crdownload", "log", "pid", "out"]);
const TEMP_DIRS = new Set(["tmp", "temp", "cache", "venv", "site-packages", "dist-info", "egg-info"]);
// 라이블리가 만드는 프로젝트 안내 파일 — 세션 결과물이 아니다(프로젝트 폴더 맨 위에서만).
const GENERATED_TOP = new Set(["AGENTS.md", "CLAUDE.md"]);

/** 사람에게 줄 결과물로 보이는 파일인가(순수 · 표 O1~O7). 자료 형식 규칙(classifyLocalPath)을 먼저 통과해야 한다. */
export function isOutputFile(rel: string): boolean {
  const r = normalizeLocalRel(rel);
  const segs = r.split("/").filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  if (!name) return false;
  if (classifyLocalPath(r).kind === "skip") return false;                                   // O1 자료가 안 되는 형식·숨김·의존성 폴더
  if (segs.length === 1 && GENERATED_TOP.has(name)) return false;                          // O2 라이블리가 쓰는 안내 파일
  if (segs.slice(0, -1).some((s) => TEMP_DIRS.has(s.toLowerCase()))) return false;        // O3 임시·가상환경 폴더
  if (name.endsWith("~")) return false;                                                    // O4 편집기 백업
  const ext = extOf(name);
  if (TEMP_EXT.has(ext)) return false;                                                     // O5 임시·로그
  if (CODE_EXT.has(ext)) return false;                                                     // O6 코드·스크립트
  return true;                                                                             // O7 문서·이미지·PDF·표·데이터
}

/** 이미 자료에 있는 상태 — 같은 좌표 행의 파일 시각(ms)·크기. 모르면 null. */
export interface KnownOutput { mtime: number | null; bytes: number | null }

/** 그 행이 지금 파일과 같은 상태인가(순수 · P4·P5·P5'). 행이 모르는 값(null)은 비교하지 않는다 — 모르는 것 때문에 되살리거나
 *  매 턴 다시 읽지 않는다(옛 매니지드 행은 시각이 비어 있다 · 시각이 비면 «다르다» 로 읽어 매 턴 100MB 까지 다시 뽑던 길을 막는다). */
export function sameOutputState(k: KnownOutput | undefined, f: { mtime: number; size: number }): boolean {
  if (!k) return false;
  return (k.mtime == null || k.mtime === f.mtime) && (k.bytes == null || k.bytes === f.size);
}

/**
 * 이번 턴에 등록할 파일(순수 · 표 P1~P8). 최근 것부터 — 상한에 걸리면 가장 최근 결과물이 먼저 자료가 된다.
 *  @param known 상대경로 → 이미 있는 자료 행의 시각·크기(행이 지워졌어도 준다 — 규칙 ②)
 */
export function pickSessionOutputs(
  files: readonly ManifestFile[],
  known: ReadonlyMap<string, KnownOutput>,
  opts: { sinceMs: number; maxBytes?: number; limit?: number; skipDirs?: readonly string[] },
): string[] {
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const limit = opts.limit ?? MAX_PER_SWEEP;
  const skip = (opts.skipDirs ?? []).map((d) => normalizeLocalRel(d).replace(/\/+$/, "")).filter(Boolean);
  const out = files
    .filter((f) => Number.isFinite(f.mtime) && f.mtime >= opts.sinceMs)                       // P1 세션 시작 전 파일 제외
    .filter((f) => f.size >= 0 && f.size <= maxBytes)                                           // P2 너무 큰 파일 제외
    .filter((f) => isOutputFile(f.path))                                                        // P3 결과물만
    .filter((f) => { const r = normalizeLocalRel(f.path); return !skip.some((d) => r === d || r.startsWith(d + "/")); })   // P8 안쪽 프로젝트 폴더는 그 프로젝트 것
    .filter((f) => !sameOutputState(known.get(normalizeLocalRel(f.path)), f))                // P4 같은 상태로 이미 있다 · P5 바뀌었으면 다시
    .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));     // P6 최근 것부터(같으면 경로순)
  return out.slice(0, Math.max(0, limit)).map((f) => normalizeLocalRel(f.path));                // P7 상한
}

/** 턴 끝 보고에서 이 세션을 훑어야 하나(순수 · 표 S1~S6). folder = 그 프로젝트의 폴더(공유 루트 기준). */
export function sweepTarget(
  st: { project_id: number | null; root_key: string | null; subpath: string | null; read_only: boolean; incognito: boolean } | null | undefined,
  folder: string | null | undefined,
): boolean {
  if (!st || !(Number(st.project_id) > 0)) return false;                 // S1 프로젝트 세션이 아니다(개인 폴더 파일은 그 사람 것)
  if (st.read_only || st.incognito) return false;                        // S2 기록을 남기지 않는 세션
  if (st.root_key !== "shared") return false;                            // S3 공유 루트 밖에서 도는 세션
  const f = String(folder || "").replace(/^\/+|\/+$/g, "");
  const sub = String(st.subpath || "").replace(/^\/+|\/+$/g, "");
  if (!f) return false;                                                  // S4 폴더를 모른다
  return sub === f || sub.startsWith(f + "/");                           // S5 그 프로젝트 폴더(또는 그 안)에서 도는 세션 · S6 아니면 안 한다
}

/** 기록 범위가 이 등록을 막나(순수 · 표 W1~W4) — activity_log 의 판정과 같다: 좁혀진 세션(audience·private)이
 *  리스트로 대상을 좁히지 않은 프로젝트에 기록하는 것만 막는다(좁은 프로젝트에 다는 것은 넓히는 게 아니다). */
export function capBlocks(cap: string, projectIsOpen: boolean): boolean {
  return cap !== "open" && projectIsOpen;
}

// ── 실행(부수효과) ───────────────────────────────────────────────────────────────

export interface SweepSession {
  id: string; owner: string;
  project_id: number | null; root_key: string | null; subpath: string | null;
  read_only: boolean; incognito: boolean;
  created: number | null;   // epoch초
}
export interface SweepReport { scanned: number; picked: number; ingested: number; skipped: number; truncated: boolean }

const running = new Map<string, Promise<SweepReport | null>>();
const lastRun = new Map<string, number>();
/** 도는 동안 턴을 끝낸 세션들 — 세션마다 **제 정보로** 다시 훑는다(시작 시각·«이 세션이 만든 파일» 표시가 세션마다 다르다) */
const pending = new Map<string, Map<string, SweepSession>>();
const truncWarned = new Set<string>();

/** 시험 전용 — 대기 상태를 비운다 */
export function resetSessionOutputSweeps(): void { running.clear(); lastRun.clear(); pending.clear(); truncWarned.clear(); }

/** 한 묶음(같은 프로젝트에서 함께 턴을 끝낸 세션들)이 나눠 쓰는 것 — 폴더 매니페스트는 묶음마다 한 번만 읽는다(C6). */
export interface SweepShared { manifest?: Promise<Manifest>; nested?: Promise<string[]> }
export type SweepOnce = (st: SweepSession, now: () => number, shared: SweepShared) => Promise<SweepReport | null>;

/**
 * 중앙 세션의 턴이 끝났다 → 그 세션 프로젝트 폴더의 새 결과물을 자료로. **던지지 않는다**(호출부는 void).
 *  프로젝트마다 한 번에 하나(표 C1~C7) — 돌고 있으면 그 세션을 대기에 올리고 같은 약속을 돌려준다. 앞 훑기가 끝나면
 *  대기한 세션들을 한 묶음으로 — 매니페스트 한 번 · 세션마다 제 정보로 — 다시 훑는다(그 사이 생긴 파일을 놓치지 않게 · 같은 세션은 한 번만).
 *  @param once 시험 주입용 — 기본은 실제 훑기
 */
export function sweepSessionOutputs(st: SweepSession, now: () => number = Date.now, once: SweepOnce = sweepOnce): Promise<SweepReport | null> {
  if (!(Number(st.project_id) > 0) || st.read_only || st.incognito) return Promise.resolve(null);   // C5 값싼 앞문(DB 왕복 0)
  const key = `${tenantSlug() ?? ""}:${st.project_id}`;
  const cur = running.get(key);
  if (cur) {                                                                                             // C1 · C3
    let q = pending.get(key);
    if (!q) { q = new Map(); pending.set(key, q); }
    q.set(st.id, st);
    return cur;
  }
  const wait = Math.max(0, (lastRun.get(key) ?? 0) + MIN_INTERVAL_MS - now());
  const run = (async (): Promise<SweepReport | null> => {
    //  C7 첫 await 전에 동기로 던지면 finally 가 running.set 보다 먼저 돌아 «영원히 도는 중» 이 남는다 — 한 박자 미룬다.
    await (wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve());
    let rep: SweepReport | null = null;
    let batch: SweepSession[] = [st];
    try {
      while (batch.length) {
        const shared: SweepShared = {};
        for (const one of batch) {
          lastRun.set(key, now());
          rep = await Promise.resolve().then(() => once(one, now, shared)).catch((e: unknown) => {   // C4 한 세션의 실패가 대기열을 버리지 않는다
            logger.warn({ err: e, session: one.id, project: one.project_id }, "[session-outputs] 결과물 자료 등록 실패(비치명)");
            return null;
          });
        }
        const q = pending.get(key);
        pending.delete(key);
        batch = q ? [...q.values()] : [];
      }
    } finally {
      running.delete(key);                     // 마지막 대기열 확인과 여기 사이엔 await 이 없다 — 새 대기가 끼어들 틈이 없다
      pending.delete(key);
      if (lastRun.size > 1000) for (const [k, t] of lastRun) if (now() - t > MIN_INTERVAL_MS) lastRun.delete(k);
    }
    return rep;
  })();
  running.set(key, run);                       // C2 다른 프로젝트는 서로 막지 않는다(키가 다르다)
  return run;
}

async function sweepOnce(st: SweepSession, now: () => number, shared: SweepShared): Promise<SweepReport | null> {
  const [{ getProjectRow }, { projectStorage }] = await Promise.all([
    import("../v6/project-store.js"), import("../project/project-storage.js"),
  ]);
  const project = await getProjectRow(Number(st.project_id));
  if (!project || !sweepTarget(st, project.folder)) return null;
  const folder = String(project.folder);
  const store = await projectStorage(folder, { memberId: st.owner }, { id: project.id, name: project.name });
  const man = await (shared.manifest ??= store.manifest());
  if (man.truncated) {
    //  매니페스트 상한(파일 수)을 넘는 폴더 — 상한 밖 파일은 이 훑기가 못 본다. 프로세스마다 프로젝트당 한 번만 알린다.
    const tk = `${tenantSlug() ?? ""}:${project.id}`;
    if (!truncWarned.has(tk)) { truncWarned.add(tk); logger.warn({ project: project.id, files: man.files.length }, "[session-outputs] 폴더 파일이 매니페스트 상한을 넘어 일부 결과물을 못 볼 수 있다"); }
  }
  const sinceMs = (st.created ? st.created * 1000 : now()) - START_SKEW_MS;
  const none = (picked = 0): SweepReport => ({ scanned: man.files.length, picked, ingested: 0, skipped: 0, truncated: man.truncated });
  const fresh = man.files.filter((f) => f.mtime >= sinceMs && isOutputFile(f.path));
  if (!fresh.length) return none();
  const [known, skipDirs] = await Promise.all([
    knownOutputs(project.id, fresh.map((f) => f.path)),
    (shared.nested ??= nestedProjectDirs(folder)),
  ]);
  const picked = pickSessionOutputs(fresh, known, { sinceMs, skipDirs });
  if (!picked.length) return none();
  if (await capBlocksSession(st.id, project.id)) {
    logger.info({ session: st.id, project: project.id, picked: picked.length }, "[session-outputs] 세션 기록 범위가 좁아 공개 프로젝트에 자동 등록하지 않음");
    return none(picked.length);
  }

  const [{ ingestLocalUpload }, { getMember }] = await Promise.all([
    import("./local-file.js"), import("../org/store/members.js"),
  ]);
  const who = await getMember(st.owner).catch(() => null);
  let ingested = 0, skipped = 0;
  for (const rel of picked) {
    const r = await ingestLocalUpload({
      root: { kind: "project", id: project.id }, folder, base: store.base, abs: path.join(store.base, rel), osUser: store.osUser,
      uploader: { id: st.owner, name: who?.email ?? who?.display_name ?? null },
      channelFallback: project.name, entry: { kind: ENTRY_GENERATED, session: st.id },
    }).catch((e) => { logger.warn({ err: e, rel, project: project.id }, "[session-outputs] 파일 1건 등록 실패"); return null; });
    if (r?.ingested) ingested++; else skipped++;
  }
  if (ingested) logger.info({ session: st.id, project: project.id, ingested, skipped }, "[session-outputs] 세션 결과물을 자료로 등록");
  return { scanned: man.files.length, picked: picked.length, ingested, skipped, truncated: man.truncated };
}

/** 이 세션의 기록 범위가 이 프로젝트 등록을 막나 — activity_log(capabilities/activity.ts)와 같은 조회·판정. */
async function capBlocksSession(sessionId: string, projectId: number): Promise<boolean> {
  const [{ sessionWriteCap }, { hiddenProjects, PUBLIC_VIEWER }] = await Promise.all([
    import("../terminal/write-cap.js"), import("../v6/visibility.js"),
  ]);
  const cap = await sessionWriteCap(sessionId);
  if (cap === "open") return false;
  const hidden = await hiddenProjects(PUBLIC_VIEWER).catch(() => null);
  return capBlocks(cap, hidden ? !hidden.ids.has(projectId) : false);
}

/** 이 프로젝트 폴더 안에 든 **다른 프로젝트의 폴더**(이 폴더 기준 상대경로 · #4688) — 대개 빈 목록(프로젝트 폴더는 평평하다). */
async function nestedProjectDirs(folder: string): Promise<string[]> {
  const { projectFoldersUnder } = await import("../v6/shared-folder-store.js");
  const base = folder.replace(/^\/+|\/+$/g, "");
  return (await projectFoldersUnder(base)).map((f) => f.slice(base.length).replace(/^\/+/, "")).filter(Boolean);
}

/** 이 파일들의 자료 행 상태 — 행이 지워졌어도 돌려준다(규칙 ②). DB 는 여기서만 늦게 가져온다. */
async function knownOutputs(projectId: number, rels: string[]): Promise<Map<string, KnownOutput>> {
  const out = new Map<string, KnownOutput>();
  if (!rels.length) return out;
  const [{ itemsPool }, { normalizeExternalInstance }] = await Promise.all([
    import("../db/client.js"), import("../org/ingest/external-identity.js"),
  ]);
  const byId = new Map(rels.map((r) => [localExternalId({ kind: "project", id: projectId }, r), normalizeLocalRel(r)]));
  const got = await itemsPool.query(
    `SELECT external_id,
            floor(extract(epoch FROM occurred_at) * 1000)::bigint AS mtime,
            (fields->>'bytes')::bigint AS bytes
       FROM source
      WHERE external_system=$1 AND external_instance=$2 AND external_id = ANY($3::text[])`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), [...byId.keys()]]);
  for (const row of got.rows as Array<{ external_id: string; mtime: string | number | null; bytes: string | number | null }>) {
    const rel = byId.get(row.external_id);
    if (!rel) continue;
    out.set(rel, {
      mtime: row.mtime == null ? null : Number(row.mtime),
      bytes: row.bytes == null ? null : Number(row.bytes),
    });
  }
  return out;
}
