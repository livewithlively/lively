// 보관 표의 주인 기록 · 짐작(순수, #4733).
//
//  보관 표 = 앱 데이터를 말없이 잃지 않으려고 워크스페이스 스키마 옆 `<스키마>_archive` 로 옮겨 둔 표(store-schema):
//   · 선언에서 빠진 표에 데이터가 있으면 표를 통째로(#4224 cleanupDroppedTables) — `<물리명 앞 최대 47자>__<YYYYMMDDHHMMSS>`
//   · drop_columns 로 지운 칸에 값이 있으면 (tenant_id, id, value) 표로(#4483 syncColumns) — `<물리명>__<칸>__<시각>`,
//     47자를 넘으면 `<물리명 앞 24자>__<해시8>__<시각>`
//   물리명 = `<앱 접두>__<표>`, 앱 접두 = 앱 id 의 `-` 를 `_` 로(store-ddl physicalAppPrefix — 앱 id 엔 `_` 가 없고, 접두엔 `__` 가 없으며
//   `_` 로 끝나지 않는다).
//  이름은 잘리고 해시가 붙어 어느 앱 것인지 늘 가릴 수는 없다 → 보관할 때 표 설명(COMMENT ON TABLE)에 주인을 적는다. 설명은 표와 함께
//   다니고(옮기기 · 지우기) 표 소유자만 바꿀 수 있어 따로 등록 표를 두지 않는다. 기록이 없는 옛 보관 표는 이름으로 짐작하되,
//   앱 부분이 온전하다고 확실할 때만 낸다(다른 앱 것으로 짐작해 지우지 않게).

import { COLUMN_ARCHIVE_HEAD, COLUMN_ARCHIVE_HASH } from "./store-ddl.js";

/** 보관한 까닭 — 설치(저장 · 되돌리기 · 관리자 설치) 때인가, 공개하며 미룬 변경을 적용할 때인가. */
export type ArchiveReason = "install" | "publish";

export interface ArchiveRecord {
  app_id: string;
  /** 원래 표(선언 이름). */
  table: string;
  /** 지운 칸 — 표를 통째로 보관했으면 null. */
  column: string | null;
  /** 보관한 행 수(칸이면 값이 있던 행). */
  rows: number;
  /** 보관한 때(ISO). */
  at: string;
  reason: ArchiveReason;
}

const PREFIX = "lively-archive:";

/** 표 설명에 적을 글(접두 + JSON 한 줄). */
export function archiveComment(r: ArchiveRecord): string {
  return PREFIX + JSON.stringify({ v: 1, app_id: r.app_id, table: r.table, column: r.column, rows: r.rows, at: r.at, reason: r.reason });
}

/** 표 설명을 읽는다 — 우리 꼴이 아니거나 망가졌으면(빈 앱 id 포함) null(= 기록 없음 · 이름으로 짐작). */
export function parseArchiveComment(text: unknown): ArchiveRecord | null {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text.slice(PREFIX.length)) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object" || typeof o.app_id !== "string" || !o.app_id.trim() || typeof o.table !== "string") return null;
  const rows = Number(o.rows);
  return {
    app_id: o.app_id.trim(),
    table: o.table,
    column: typeof o.column === "string" && o.column ? o.column : null,
    rows: Number.isFinite(rows) && rows >= 0 ? Math.floor(rows) : 0,
    at: typeof o.at === "string" ? o.at : "",
    reason: o.reason === "publish" ? "publish" : "install",
  };
}

/**
 * 기록 없는 보관 표의 앱을 이름으로 짐작한다 — 확실할 때만(아니면 null = 주인 모름).
 *  시각 꼬리를 떼고 남은 앞부분(x)에서 첫 `__` 앞이 앱 접두다(접두엔 `__` 가 없으므로 첫 `__` 는 늘 앱과 표를 가르는 자리).
 *  · x 에 `__` 가 없다 → 물리명이 앱 접두 안에서 잘렸다 → 모름.
 *  · 해시꼴(`<물리명 앞 24자>__<hex8>`)이고 첫 `__` 가 23번째나 24번째 → 우리가 붙인 `__` 에 걸린 자리라 앱 접두가 잘렸는지 모른다 → 모름.
 *    24번째: 앞 24자가 접두 안에서 잘렸거나 접두가 꼭 24자. 23번째: 접두가 꼭 23자(앞 24자 끝 `_` 는 구분자)이거나, 더 긴 접두의
 *    24번째 글자가 `_`(하이픈)여서 붙인 `__` 와 이어진 것 — 이름만으로는 둘을 못 가른다(격리 리뷰 #4733 — 31자 앱을 23자 앱 것으로 짐작했다).
 *    22번째 이하면 그 `__` 는 앞 24자 안에 온전히 있는 구분자다(접두엔 `__` 가 없다).
 *  rest = 앱 접두 뒤(통째 보관이면 원래 표 이름 — 잘렸을 수 있다).
 */
const HASHED_HEAD = new RegExp(`^[a-z0-9_]{${COLUMN_ARCHIVE_HEAD}}__[0-9a-f]{${COLUMN_ARCHIVE_HASH}}$`);
export function guessArchiveOwner(name: string): { app_id: string; rest: string; hashed: boolean } | null {
  const m = /^(.+)__(\d{14})$/.exec(String(name));
  if (!m) return null;
  const x = m[1];
  const i = x.indexOf("__");
  if (i <= 0) return null;
  const hashed = x.length === COLUMN_ARCHIVE_HEAD + 2 + COLUMN_ARCHIVE_HASH && HASHED_HEAD.test(x);
  if (hashed && i >= COLUMN_ARCHIVE_HEAD - 1) return null;
  const prefix = x.slice(0, i);
  if (!/^[a-z0-9](?:[a-z0-9_]*[a-z0-9])?$/.test(prefix)) return null;
  return { app_id: prefix.replace(/_/g, "-"), rest: x.slice(i + 2), hashed };
}

/** 칸 보관 표의 칸 꼴 — (tenant_id, id, value). 통째로 보관한 표는 앱 표라 늘 created_at 까지 있다. */
export function looksLikeColumnArchive(columns: readonly string[]): boolean {
  return columns.length === 3 && columns.includes("tenant_id") && columns.includes("id") && columns.includes("value");
}

export type ArchiveOwnerBasis = "recorded" | "guessed" | "unknown";

export interface ArchiveIdentity {
  app_id: string | null;
  owner: ArchiveOwnerBasis;
  kind: "table" | "column";
  table: string | null;
  column: string | null;
  rows: number | null;
  archived_at: string | null;
  reason: ArchiveReason | null;
}

/** 보관 표 하나가 누구의 무엇인가 — 기록이 있으면 기록, 없으면 이름 짐작, 그것도 안 되면 주인 모름. */
export function identifyArchive(name: string, comment: unknown, columns: readonly string[]): ArchiveIdentity {
  const rec = parseArchiveComment(comment);
  if (rec) {
    return { app_id: rec.app_id, owner: "recorded", kind: rec.column ? "column" : "table", table: rec.table, column: rec.column,
      rows: rec.rows, archived_at: rec.at || null, reason: rec.reason };
  }
  const kind = looksLikeColumnArchive(columns) ? "column" : "table";
  const g = guessArchiveOwner(name);
  const at = archivedAtOf(name);
  if (!g) return { app_id: null, owner: "unknown", kind, table: null, column: null, rows: null, archived_at: at, reason: null };
  //  칸 보관 표는 «표__칸» 을 가를 수 없다(표 · 칸 이름에도 `__` 가 올 수 있다) — 원래 표 · 칸은 비워 둔다.
  return { app_id: g.app_id, owner: "guessed", kind, table: kind === "table" && !g.hashed ? g.rest : null, column: null,
    rows: null, archived_at: at, reason: null };
}

/** 이름 꼬리의 시각(UTC, 초) → ISO. 꼬리가 없으면 null. */
export function archivedAtOf(name: string): string | null {
  const m = /__(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(name));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** 주인 모름 보관 표를 백업에 담을 때의 app_id — 앱 id 에는 `~` 가 올 수 없어 어느 앱과도 겹치지 않고, app_data_snapshots 로 골라 볼 수 있다. */
export const ARCHIVE_UNKNOWN_APP = "~unknown";

/** 앱 데이터 백업(org_app_snapshot)에 보관 표를 담을 때의 표 이름 — 앱 표와 섞이지 않게 접두를 붙인다. 되살리기는 이것을 건너뛴다. */
export const ARCHIVE_SNAPSHOT_PREFIX = "archive:";
export const archiveSnapshotTable = (name: string): string => `${ARCHIVE_SNAPSHOT_PREFIX}${name}`;
export const isArchiveSnapshotTable = (table: string): boolean => String(table).startsWith(ARCHIVE_SNAPSHOT_PREFIX);
