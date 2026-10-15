import { strict as assert } from "node:assert";
import test from "node:test";
import {
  archiveComment, parseArchiveComment, guessArchiveOwner, identifyArchive, looksLikeColumnArchive, archivedAtOf,
  archiveSnapshotTable, isArchiveSnapshotTable, ARCHIVE_SNAPSHOT_PREFIX, ARCHIVE_UNKNOWN_APP, type ArchiveRecord,
} from "./archive-meta.js";
import { archivedTableName, columnArchiveName, physicalTableName } from "./store-ddl.js";
import { APP_ID_RE } from "./manifest.js";

// ── 보관 표의 주인 기록 · 이름 짐작 (#4733 앱 v2-19) — 사양 엣지 표 G1~G7 ──────────
//  이게 틀리면: 앱을 지울 때 다른 앱의 보관 표까지 지우거나(이름이 비슷한 앱 · 잘린 이름) · 기록이 망가진 보관 표 하나 때문에 목록이 깨진다.

const AT = new Date("2026-10-15T09:47:08.000Z");
const TS = "20261015094708";
/** 실제 이름 규칙(store-ddl columnArchiveName — 보관하는 코드가 쓰는 그 함수). */
const columnArchive = (physical: string, column: string): string => columnArchiveName(physical, column, AT);
const rec = (o: Partial<ArchiveRecord> = {}): ArchiveRecord =>
  ({ app_id: "crm-x", table: "deals", column: null, rows: 3, at: AT.toISOString(), reason: "install", ...o });

test("A 기록 — 적은 것을 그대로 읽는다(칸 · 통째 · 까닭)", () => {
  assert.deepEqual(parseArchiveComment(archiveComment(rec())), rec());
  assert.deepEqual(parseArchiveComment(archiveComment(rec({ column: "note", rows: 2, reason: "publish" }))), rec({ column: "note", rows: 2, reason: "publish" }));
});

test("G6 기록이 비었거나 망가졌으면 기록 없음(null) — 이름 짐작으로 넘어간다", () => {
  for (const c of [null, undefined, "", "그냥 설명", "lively-archive:", "lively-archive:{망가진", 'lively-archive:{"app_id":"","table":"x"}',
    'lively-archive:{"app_id":"  ","table":"x"}', 'lively-archive:{"table":"x"}', 'lively-archive:{"app_id":"a"}', 'lively-archive:null', 42]) {
    assert.equal(parseArchiveComment(c), null, String(c));
  }
  //  망가진 기록 + 짐작할 수 있는 이름 → guessed
  const id = identifyArchive(archivedTableName(physicalTableName("crm-x", "deals"), AT), "lively-archive:{망가진", ["tenant_id", "id", "title", "created_at"]);
  assert.equal(id.owner, "guessed");
  assert.equal(id.app_id, "crm-x");
});

test("G1 기록 없음 · 통째 보관 이름 → 앱 id(밑줄 → 하이픈) · 원래 표", () => {
  const name = archivedTableName(physicalTableName("crm-x", "deals"), AT);
  assert.equal(name, `crm_x__deals__${TS}`);
  assert.deepEqual(guessArchiveOwner(name), { app_id: "crm-x", rest: "deals", hashed: false });
  const id = identifyArchive(name, null, ["tenant_id", "id", "title", "created_at"]);
  assert.deepEqual([id.owner, id.app_id, id.kind, id.table, id.column], ["guessed", "crm-x", "table", "deals", null]);
  assert.equal(id.archived_at, AT.toISOString());
});

test("G1b 이름이 비슷한 두 앱(crm · crm-x)을 가른다 — 첫 `__` 앞이 앱이다", () => {
  assert.equal(guessArchiveOwner(archivedTableName(physicalTableName("crm", "x__deals"), AT))?.app_id, "crm");
  assert.equal(guessArchiveOwner(archivedTableName(physicalTableName("crm-x", "deals"), AT))?.app_id, "crm-x");
  assert.equal(guessArchiveOwner(columnArchive(physicalTableName("crm", "deals"), "x"))?.app_id, "crm");
});

test("G2 앱 부분이 잘린 이름(남은 앞부분에 `__` 없음) → 주인 모름", () => {
  const longId = "a".repeat(30) + "-" + "b".repeat(20);                 // 접두 51자 > 47 → 물리명이 앱 접두 안에서 잘린다
  const name = archivedTableName(`${longId.replace(/-/g, "_")}__t`, AT);  // physicalTableName 은 63자 상한이라 직접 만든다
  assert.equal(name.length, 63);
  assert.equal(guessArchiveOwner(name), null);
  assert.equal(identifyArchive(name, null, ["tenant_id", "id", "created_at"]).owner, "unknown");
});

test("G7 경계 — 63자로 잘렸어도 남은 앞부분에 `__` 가 있으면 앱 부분은 온전하다", () => {
  const name = archivedTableName(physicalTableName("crm", "a_very_long_table_name_that_goes_past_the_limit_x"), AT);
  assert.equal(name.length, 63);
  assert.equal(guessArchiveOwner(name)?.app_id, "crm");
});

test("G3 해시꼴 · 첫 `__` 가 24번째 — 앞 24자가 잘린 앱 접두일 수 있어 주인 모름", () => {
  const physical = physicalTableName("abcdefghijklmnopqrstuvwxyz-app", "items");   // 접두 30자 ≥ 24
  const name = columnArchive(physical, "a_rather_long_column_name");
  assert.match(name, /^[a-z0-9_]{24}__[0-9a-f]{8}__\d{14}$/);
  assert.equal(guessArchiveOwner(name), null);
  //  접두가 꼭 24자인 앱도 같은 꼴이라 가를 수 없다 — 모름 쪽으로 기운다
  const exact = columnArchive(physicalTableName("abcdefghijklmnopqrstuvwx", "items_with_long_name"), "another_long_column");
  assert.equal(guessArchiveOwner(exact), null);
});

test("G4 해시꼴이어도 앱 접두가 24자보다 짧으면 짐작한다(원래 표 · 칸은 비운다)", () => {
  const name = columnArchive(physicalTableName("crm", "a_table_name_long_enough_to_hash"), "some_column_name");
  assert.match(name, /^crm__[a-z0-9_]{19}__[0-9a-f]{8}__\d{14}$/);
  const g = guessArchiveOwner(name);
  assert.equal(g?.app_id, "crm");
  assert.equal(g?.hashed, true);
  const id = identifyArchive(name, null, ["tenant_id", "id", "value"]);
  assert.deepEqual([id.owner, id.app_id, id.kind, id.table, id.column], ["guessed", "crm", "column", null, null]);
  //  접두 22자 — 앞 24자 안에 구분자 `__` 가 온전히 들어 있다
  const p22 = "abcdefghijklmnopqrstuv";
  assert.equal(guessArchiveOwner(columnArchive(physicalTableName(p22, "items_with_a_long_name"), "long_column_name_x"))?.app_id, p22);
});

test("G3b 해시꼴 · 첫 `__` 가 23번째 — 접두가 꼭 23자인지, 더 긴 접두의 24번째가 하이픈인지 못 가른다 → 주인 모름(격리 리뷰 회귀)", () => {
  //  격리 리뷰 재현: 31자 앱(24번째 글자가 하이픈)의 칸 보관 표를 23자 앱 «aaaaaaaaaaaaaaaaaaaaaaa» 것으로 짐작했다.
  const long = columnArchive(physicalTableName("aaaaaaaaaaaaaaaaaaaaaaa-bbbbbbb", "items_with_long_name"), "x");
  assert.equal(long, "aaaaaaaaaaaaaaaaaaaaaaa___f49c88a6__20261015094708");
  assert.equal(guessArchiveOwner(long), null);
  //  접두가 꼭 23자인 앱도 같은 꼴이다 — 이름만으로는 가를 수 없어 모름 쪽으로 기운다
  const p23 = "abcdefghijklmnopqrstuvw";
  assert.equal(guessArchiveOwner(columnArchive(physicalTableName(p23, "items_with_a_long_name"), "long_column_name_x")), null);
});

test("G8 실제 이름 규칙으로 만든 이름 — 짐작은 모름(null)이거나 늘 진짜 앱이다(무작위 · 위험한 꼴 위주)", () => {
  //  짐작이 틀리면 앱을 지울 때 다른 앱의 보관 표를 지운다. 규칙 하나하나가 아니라 «짐작이 맞거나 모른다» 를 실제 이름으로 본다.
  let seed = 4733;
  const rnd = (): number => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (chars: string): string => chars[Math.floor(rnd() * chars.length)];
  const word = (n: number, chars: string): string => Array.from({ length: n }, () => pick(chars)).join("");
  const appIdOf = (len: number): string => {           // 하이픈은 연달아 오지 않고 끝에 오지 않는다 — 위험한 자리(22~25번째)에 자주 넣는다
    let id = pick("abcdefghijklmnopqrstuvwxyz0123456789");
    while (id.length < len) {
      const near = id.length >= 21 && id.length <= 25;
      id += id.length < len - 1 && !id.endsWith("-") && rnd() < (near ? 0.5 : 0.12) ? "-" : pick("abcdefghijklmnopqrstuvwxyz0123456789");
    }
    return id;
  };
  let wrong = 0, guessed = 0, total = 0;
  const samples: string[] = [];
  for (let k = 0; k < 60000; k++) {
    const app = appIdOf(2 + Math.floor(rnd() * 31));                 // APP_ID_RE — 2~32자
    const table = pick("abcdefghijklmnopqrstuvwxyz_") + word(Math.floor(rnd() * 30), "abcdefghijklmnopqrstuvwxyz0123456789__");
    let physical: string;
    try { physical = physicalTableName(app, table); } catch { continue; }   // 63자 넘거나 쓸 수 없는 id 는 표가 못 생긴다
    const name = rnd() < 0.5 ? archivedTableName(physical, AT) : columnArchive(physical, pick("abcdefghijklmnopqrstuvwxyz") + word(Math.floor(rnd() * 25), "abcdefghijklmnopqrstuvwxyz0123456789_"));
    total++;
    const g = guessArchiveOwner(name);
    if (!g) continue;
    guessed++;
    if (g.app_id !== app) { wrong++; if (samples.length < 5) samples.push(`${app} → ${g.app_id} (${name})`); }
  }
  assert.equal(wrong, 0, samples.join("\n"));
  assert.ok(total > 40000 && guessed > total * 0.5, `시험이 비어 있지 않다 — 만든 이름 ${total} · 짐작 ${guessed}`);
});

test("G5 이름 규칙 밖(시각 꼬리 없음 · 접두가 _ 로 시작/끝) → 주인 모름", () => {
  for (const n of ["crm__deals", "crm__deals__2026101509", "_crm__deals__" + TS, "__deals__" + TS, "x"]) {
    assert.equal(guessArchiveOwner(n), null, n);
  }
  //  표 이름은 _ 로 시작할 수 있다 — `crm___deals` 는 앱 crm 의 표 _deals(접두는 _ 로 끝나지 않으므로 첫 `__` 가 구분자)
  assert.deepEqual(guessArchiveOwner(archivedTableName(physicalTableName("crm", "_deals"), AT)), { app_id: "crm", rest: "_deals", hashed: false });
});

test("기록이 이름보다 이긴다 — 이름은 crm 인데 기록은 다른 앱", () => {
  const name = archivedTableName(physicalTableName("crm", "deals"), AT);
  const id = identifyArchive(name, archiveComment(rec({ app_id: "sales" })), ["tenant_id", "id", "title", "created_at"]);
  assert.deepEqual([id.owner, id.app_id, id.table, id.rows, id.reason], ["recorded", "sales", "deals", 3, "install"]);
});

test("종류 — 칸 보관 표는 (tenant_id, id, value) 꼴, 통째 보관은 앱 표 꼴", () => {
  assert.equal(looksLikeColumnArchive(["tenant_id", "id", "value"]), true);
  assert.equal(looksLikeColumnArchive(["tenant_id", "id", "value", "created_at"]), false);
  assert.equal(looksLikeColumnArchive([]), false);
});

test("주인 모름 백업의 app_id 는 어떤 앱 id 와도 겹치지 않는다", () => {
  assert.equal(APP_ID_RE.test(ARCHIVE_UNKNOWN_APP), false);
});

test("이름 꼬리의 시각 · 백업 묶음의 보관 표 이름", () => {
  assert.equal(archivedAtOf(`crm__deals__${TS}`), "2026-10-15T09:47:08.000Z");
  assert.equal(archivedAtOf("crm__deals"), null);
  assert.equal(archivedAtOf("crm__deals__20261399999999"), null);
  assert.equal(archiveSnapshotTable("crm__deals__" + TS), `${ARCHIVE_SNAPSHOT_PREFIX}crm__deals__${TS}`);
  assert.equal(isArchiveSnapshotTable(archiveSnapshotTable("x")), true);
  assert.equal(isArchiveSnapshotTable("deals"), false);
});
