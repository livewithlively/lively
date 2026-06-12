// File-diff → code_unit aggregation (PURE; no DB, no side effects) — refresh.ts 에서 분리.
// refresh()(트랜잭션 DB apply 루프)와 관심사가 다르고 단독 유닛테스트 가능해 파일을 나눈다.
// git diff speaks FILE paths (backend/src/campaigns/campaigns.service.ts) but our
// code_units are COARSE/module-level (backend/src/campaigns). Feeding file-level
// changes straight into refresh() would (a) turn each new file into a spurious
// file-level code_unit and (b) never aggregate a directory move (a cluster of file
// renames) into the single module rename it really is. This is the input-
// normalization layer: it maps file changes onto the EXISTING code_unit
// granularity BEFORE refresh() applies them. It NEVER touches the DB — refresh()'s
// engine (rename-following by row identity, soft-delete, invariant of zero writes
// to the mapping table) is reused unchanged.
//
//   fileChanges = [{status, from?, to?, path?, score?}]  (same shape as refresh)
//   unitPaths   = active code_unit paths for the repo
//   → { unitChanges, summary }
//     unitChanges = unit-level [{status:'R',from,to,score} | {status:'A',path}]
//                   (deduped) — fed straight into refresh()'s apply loop.
//     summary     = { module_renames, new_dirs, noop_in_existing, noop_delete,
//                     ambiguous_moves: [{from, to, votes, reason}] }
export function aggregateFileChanges(fileChanges: unknown, unitPaths: unknown): { unitChanges: any[]; summary: any } {
  const changes: any[] = Array.isArray(fileChanges) ? fileChanges : [];
  // Existing units, longest-first so ownerOf picks the most specific (longest) unit.
  const units = (Array.isArray(unitPaths) ? unitPaths : []).filter((u): u is string => typeof u === "string" && u !== "");
  const unitSet = new Set(units);
  const unitsByLen = [...units].sort((a, b) => b.length - a.length);

  // ownerOf(p) = the LONGEST unit U where p === U OR p startsWith U + '/'.
  // Segment-boundary safe: the trailing '/' means 'backend/src/campaigns' does NOT
  // own 'backend/src/campaigns-v2/x.ts'. null if no unit owns p.
  const ownerOf = (p: unknown): string | null => {
    if (typeof p !== "string" || p === "") return null;
    for (const u of unitsByLen) {
      if (p === u || p.startsWith(u + "/")) return u;
    }
    return null;
  };

  // parentDir(p) = immediate parent directory, or null for a top-level file.
  const parentDir = (p: string): string | null => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? null : p.slice(0, i);
  };

  const summary: any = { module_renames: 0, new_dirs: 0, noop_in_existing: 0, noop_delete: 0, ambiguous_moves: [] };

  // Per-owner-unit rename votes: uf → { Q → {count, minScore} }.
  const votes = new Map<string, Map<string, { count: number; minScore: number | null }>>();
  // Files whose 'to' must fall through to ADD handling (renames not consumed as a
  // unit rename, and renames whose 'from' has no owner). 'from' of a consumed/ambig
  // rename is a no-op (the unit either renamed wholesale or stays put).
  const addCandidates: string[] = [];

  const recordVote = (uf: string, Q: string, score: unknown) => {
    if (!votes.has(uf)) votes.set(uf, new Map());
    const m = votes.get(uf)!;
    const cur = m.get(Q) ?? { count: 0, minScore: null };
    cur.count++;
    const s = score == null ? null : Number(score);
    if (s != null && Number.isFinite(s)) cur.minScore = cur.minScore == null ? s : Math.min(cur.minScore, s);
    m.set(Q, cur);
  };

  // Pass 1 — bucket renames into votes; queue non-owned 'to' paths for ADD.
  // We hold every rename's 'to' aside until we know which owners actually rename;
  // a 'to' under a renamed owner is consumed, otherwise it falls through to ADD.
  const renameTos: { uf: string; Q: string; to: string }[] = []; // renames that voted (resolved in pass 2)
  for (const c of changes) {
    if (!c || typeof c !== "object") continue;
    const status = (c.status ?? "").toUpperCase();
    if (status !== "R") continue;
    const from = c.from, to = c.to;
    if (!from || !to) continue;
    const uf = ownerOf(from);
    if (!uf) {
      // 'from' belongs to no existing unit → treat the rename as an add of 'to'
      // (mirrors refresh()'s own "from not found → A(to)" fallback, but resolved
      // at unit granularity).
      addCandidates.push(to);
      continue;
    }
    // from === uf + '/' + suffix. Strip that SAME suffix from 'to' to get Q.
    const suffix = from === uf ? "" : from.slice(uf.length + 1);
    let Q: string | null = null;
    if (suffix === "") {
      // The owner path itself was renamed as a file (rare for a module unit); the
      // whole 'to' is the candidate new owner location.
      Q = to;
    } else if (to === suffix || to.endsWith("/" + suffix)) {
      // 'to' shares the same trailing suffix → Q = 'to' with that suffix stripped.
      Q = to === suffix ? "" : to.slice(0, to.length - suffix.length - 1);
    } else {
      // 'to' does not share the suffix (file renamed AND moved): can't fold into a
      // clean directory move → fall through to ADD of 'to'.
      addCandidates.push(to);
      continue;
    }
    if (Q && Q !== uf) {
      recordVote(uf, Q, c.score);
      renameTos.push({ uf, Q, to });
    } else {
      // Q empty (moved to repo root) or Q === uf (no real move) → 'to' is an add.
      addCandidates.push(to);
    }
  }

  // Pass 2 — resolve each owner's votes into a UNIT rename or an ambiguous flag.
  const renamedOwners = new Map<string, string>(); // uf → Q (owner units that actually rename)
  const unitChanges: any[] = [];
  const emittedRename = new Set<string>(); // dedup 'from|to'
  for (const [uf, qmap] of votes) {
    // Dominant Q = the destination with the most votes (ties → first by insertion).
    let bestQ: string | null = null, best: { count: number; minScore: number | null } | null = null;
    for (const [Q, info] of qmap) {
      if (best == null || info.count > best.count) { bestQ = Q; best = info; }
    }
    const totalVotes = [...qmap.values()].reduce((s, v) => s + v.count, 0);
    const split = qmap.size > 1; // votes split across multiple destinations
    const qExists = unitSet.has(bestQ!); // Q is already an existing unit
    if (!qExists && !split && best!.count >= 2) {
      // Clean directory move: ≥2 files agree on a NEW location → rename the UNIT.
      // refresh() will UPDATE the same code_unit row (carries the confirmed mapping).
      const key = uf + "|" + bestQ;
      if (!emittedRename.has(key)) {
        unitChanges.push({ status: "R", from: uf, to: bestQ, score: best!.minScore });
        emittedRename.add(key);
        summary.module_renames++;
      }
      renamedOwners.set(uf, bestQ!);
    } else {
      // Do NOT rename a whole module off a stray/ambiguous signal. Surface it:
      // the file 'to's fall through to ADD, the 'from's are no-ops.
      let reason;
      if (qExists) reason = "dominant target is an existing unit";
      else if (split) reason = "rename votes split across destinations";
      else reason = "only 1 file voted (below ≥2 threshold)";
      summary.ambiguous_moves.push({ from: uf, to: bestQ, votes: totalVotes, reason });
    }
  }

  // Any rename 'to' whose owner did NOT rename wholesale falls through to ADD.
  for (const rt of renameTos) {
    if (renamedOwners.get(rt.uf) === rt.Q) continue; // consumed by the unit rename
    addCandidates.push(rt.to);
  }

  // Pass 3 — ADDS (explicit A + the rename 'to's above). A path already inside an
  // existing unit is a no-op (module present). Otherwise it's an orphan new file
  // grouped into a candidate new-unit directory.
  const orphanDirs = new Set<string>();
  const renamedTargets = new Set(renamedOwners.values()); // unit-rename destinations (Q)
  const handleAdd = (path: string | undefined) => {
    if (!path) return;
    const uo = ownerOf(path);
    if (uo) { summary.noop_in_existing++; return; } // module already present
    const dir = parentDir(path);
    const cand = dir ?? path; // top-level file → use the file path itself as candidate
    if (unitSet.has(cand)) { summary.noop_in_existing++; return; } // dir IS an existing unit
    // A moved file's parent dir may equal a just-renamed module's new path Q — that's the
    // rename TARGET, not a new unit. The unit rename (emitted before adds) already created
    // the active row, so skip it (don't over-count new_dirs; removes hidden ordering dep).
    if (renamedTargets.has(cand)) return;
    orphanDirs.add(cand);
  };

  for (const c of changes) {
    if (!c || typeof c !== "object") continue;
    const status = (c.status ?? "").toUpperCase();
    if (status === "A") handleAdd(c.path ?? c.to);
    else if (status === "D") {
      // NO-OP at unit level: a module persists while other files remain. We can't
      // cheaply prove the module is now empty, so never auto-remove it from file
      // deletes (conservative/safe). Module removal stays a human/explicit action.
      summary.noop_delete++;
    }
    // M (modify) → NO-OP (content re-eval is the LLM pass).
  }
  for (const path of addCandidates) handleAdd(path);

  // Emit one A{path:candidateDir} per distinct orphan dir (deduped, conservative —
  // flagged as a candidate; human/LLM refines granularity later).
  for (const dir of orphanDirs) {
    unitChanges.push({ status: "A", path: dir });
    summary.new_dirs++;
  }

  return { unitChanges, summary };
}
