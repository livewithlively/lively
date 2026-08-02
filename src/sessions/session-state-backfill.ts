// desired-state 백필 (#1059 F 후속) — tmux 에 살아 있는데 org_session_state 레코드가 **없는** 세션에
//  그 미러를 만들어 준다. E(v0.1.196) 배포 **전에** 생성된 세션들이 여기 해당한다.
//
// 왜 필요한가(고객사 A 실측 2026-07-28):
//  · reaper 의 안전 불변식 ④는 "레코드 있는 세션만 회수"다(회수 = 반드시 복원 가능해야 하므로). 그래서 레코드가
//    없는 구세션은 **회수 면역**이 되는데, 정작 메모리를 먹는 건 그 오래된 세션들이다(라이브 38건 중 19건).
//    → F 를 켜도 압박이 안 풀리고 earlyoom 이 **일하는 세션**을 죽인다.
//  · 더 나쁜 건, 레코드가 없으면 earlyoom·재부팅으로 죽었을 때 **restorable 로도 안 뜨고 그냥 사라진다**.
//  즉 백필은 회수 가능성과 복원 가능성을 동시에 준다 — 사용자 자산을 없애는 게 아니라 지키는 쪽이다.
//
// 한계(정직하게): tmux 메타에 없는 두 필드는 복구 경로가 없어 기본값으로 둔다 —
//  `read_only`·`incognito`. 그 모드로 만들어졌던 구세션은 복원 시 **일반 모드로** 열린다. 앞으로 만들어지는
//  세션은 createSession 이 정확히 기록하므로 이 손실은 백필 대상(구세션)에 한정된다.
//  `project_src` 도 tmux 에서 안 읽고 있어 v6 로 가정한다(대다수) — org 프로젝트 세션이면 프로젝트 링크만 어긋난다.
import path from "node:path";
import { logger } from "../log.js";
import { ROOTS, listSessionsRaw, resolveRootPath, type SessionInfo } from "../terminal/terminal-sessions.js";
import type { LivelyUser } from "../context.js";
import { listAllSessionStates, upsertSessionState } from "./session-state.js";
import { listManagedSessions } from "./managed-sessions.js";

export interface RootBase { key: string; base: string }
export interface BackfillResult { scanned: number; added: string[]; skipped: { hasState: number; managed: number; noRoot: number; failed: number } }

// dir 이 어느 허용 루트 아래인가 — 복원 좌표(rootKey·subpath)를 역산한다.
//  ⚠ **긴 base 우선**으로 훑어야 한다(한 루트가 다른 루트의 하위일 때 짧은 쪽이 먼저 걸리면 subpath 가 어긋난다).
//  경계는 `base` 자신 또는 `base + '/'` 로만 인정 — `/srv/lively/shared-old` 가 `/srv/lively/shared` 로 잡히면
//  복원 시 전혀 다른 폴더에서 세션이 열린다.
export function splitByBases(dir: string, bases: RootBase[]): { rootKey: string; subpath: string } | null {
  const d = path.resolve(String(dir || ""));
  if (!d || d === "/") return null;
  for (const b of [...bases].sort((x, y) => y.base.length - x.base.length)) {
    const base = path.resolve(b.base);
    if (d === base) return { rootKey: b.key, subpath: "" };
    if (d.startsWith(base + path.sep)) return { rootKey: b.key, subpath: d.slice(base.length + 1) };
  }
  return null;
}

// 이 소유자 기준 루트 base 목록. perUser(개인 폴더)·격리(box_<member> 홈)까지 resolveRootPath 가 처리하므로
//  정방향 산출을 그대로 역대조에 쓴다(경로 규칙을 여기서 다시 쓰면 두 곳이 갈라진다).
async function basesFor(owner: string, resolve = resolveRootPath): Promise<RootBase[]> {
  const out: RootBase[] = [];
  for (const r of ROOTS) {
    try {
      const { base } = await resolve({ userId: owner } as LivelyUser, r.key, "", undefined);
      out.push({ key: r.key, base });
    } catch { /* 이 루트는 이 소유자에게 해소 불가 — 건너뜀 */ }
  }
  return out;
}

export async function backfillSessionStates(deps?: {
  listLive?: () => Promise<SessionInfo[]>;
  listStates?: () => Promise<Array<{ id: string }>>;
  listManaged?: () => Promise<Array<{ session_id: string | null }>>;
  resolveRoot?: typeof resolveRootPath;
  upsert?: typeof upsertSessionState;
}): Promise<BackfillResult> {
  const listLive = deps?.listLive ?? listSessionsRaw;
  const listStates = deps?.listStates ?? listAllSessionStates;
  const listManaged = deps?.listManaged ?? listManagedSessions;
  const resolve = deps?.resolveRoot ?? resolveRootPath;
  const upsert = deps?.upsert ?? upsertSessionState;

  const [live, states, managed] = await Promise.all([listLive(), listStates(), listManaged()]);
  const have = new Set(states.map((s) => s.id));
  const managedIds = new Set(managed.map((m) => m.session_id).filter((x): x is string => !!x));
  const skipped = { hasState: 0, managed: 0, noRoot: 0, failed: 0 };
  const added: string[] = [];
  const baseCache = new Map<string, RootBase[]>();   // tick 단위 캐시 — 같은 소유자의 세션이 여러 개다

  for (const s of live) {
    if (have.has(s.id)) { skipped.hasState++; continue; }
    // managed(상시) 세션은 keep-alive 가 영속을 소유한다 — 미러를 만들면 재생성과 수동복원이 충돌한다(E 설계).
    if (managedIds.has(s.id)) { skipped.managed++; continue; }
    if (!s.owner) { skipped.failed++; continue; }
    let bases = baseCache.get(s.owner);
    if (!bases) { bases = await basesFor(s.owner, resolve); baseCache.set(s.owner, bases); }
    const split = splitByBases(s.dir, bases);
    // 허용 루트 밖에서 도는 세션(예: 게이트웨이 홈 하위 임의 경로)은 복원 좌표를 만들 수 없다 → 손대지 않는다.
    //  레코드를 억지로 만들면 회수는 되는데 복원이 실패한다 = 불변식 ④("회수 ⊆ 복원가능")가 깨진다.
    if (!split) { skipped.noRoot++; continue; }
    try {
      await upsert({
        id: s.id, owner: s.owner, label: s.label || null, harness: s.harness || "claude", dir: s.dir || null,
        root_key: split.rootKey, subpath: split.subpath, flags: s.flags || {}, auto_approve: !!s.autoApprove,
        invites: s.invites || [], project_id: s.projectId || null, project_src: s.projectId ? "v6" : null,
        read_only: false, incognito: false,           // ⚠ tmux 에 없는 필드 — 위 '한계' 주석 참고
        created: s.created || null, last_busy: s.lastActive ?? null,
      });
      added.push(s.id);
    } catch (e) {
      skipped.failed++;
      logger.warn({ err: e, id: s.id }, "session-state 백필 실패(계속)");
    }
  }
  if (added.length || skipped.noRoot || skipped.failed) {
    logger.info({ scanned: live.length, added: added.length, skipped }, "session-state 백필: 레코드 없는 라이브 세션에 desired-state 생성(회수·복원 가능해짐)");
  }
  return { scanned: live.length, added, skipped };
}
