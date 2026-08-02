// 수동 신원 바인딩 로더 — 조직콘텐츠 레포(lively-org)의 members/*.md frontmatter 가
// canonical person/신원 바인딩의 ground truth. 여기서 읽어 person + person_identity(origin='manual',
// state='confirmed') 로 upsert 한다. 변경이 실제로 있을 때만 person_identity_audit 기록.
//
// 의도적으로 yaml 의존성 없음(레포 zero-dep 컨벤션) — 고정 스키마 전용 fail-closed 미니 파서:
//   - 선두 <!-- --> 주석 1개(선택) 제거 후 첫 ---…--- 블록만 파싱
//   - `key: value` 스칼라, `identities:`/`bindings:` 류의 "객체 리스트", 2-스페이스 들여쓰기,
//     선택적 따옴표, 전체 줄 # 주석만 지원. 그 외 문법은 전부 throw(추측 금지 — 시끄럽게 실패).
//
// 시크릿 비노출: 이 파일은 AUTH_TOKENS_JSON 을 절대 읽지 않는다(이메일은 커밋된 members 파일에 있음).
//
// 사용:
//   - migrate-identities 가 트랜잭션 내에서 loadBindings(client) 호출
//   - 단독 CLI: node --env-file-if-exists=.env dist/items/load-bindings.js [--members-dir PATH]
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { initItemSchema } from "./store.js";
import { itemsPool } from "../db/client.js";

// ── 타입 ──
export interface BindingIdentity {
  system: string;
  instance?: string;
  external_id: string;
  email?: string;
  display_name?: string;
}
export interface BindingPerson {
  id: string;
  kind: "human" | "agent" | "system";
  display_name: string;
  identities: BindingIdentity[];
}
export interface BindingsTally {
  files: number;
  persons: number;
  personsUpserted: number;
  identitiesBound: number;
}

// ── fail-closed 미니 frontmatter 파서 (고정 스키마 전용) ──
type Node = string | Node[] | { [k: string]: Node };

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isSkippable = (line: string): boolean => !line.trim() || line.trim().startsWith("#");

function parseScalar(raw: string): string {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    v = v.slice(1, -1);
  }
  return v;
}

// 매핑 블록: 정확히 indent 위치의 `key: value` / `key:`(+하위 리스트) 만 허용.
function parseMapping(lines: string[], start: number, indent: number): { obj: Record<string, Node>; next: number } {
  const obj: Record<string, Node> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isSkippable(line)) { i++; continue; }
    const cur = indentOf(line);
    if (cur < indent) break; // 상위 블록으로 복귀
    if (cur > indent) throw new Error(`bindings 파서: 예상치 못한 들여쓰기 — "${line}"`);
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (!m) throw new Error(`bindings 파서: 매핑 키 형식 아님 — "${line}"`);
    const [, key, rest] = m;
    if (key in obj) throw new Error(`bindings 파서: 중복 키 "${key}"`);
    if (rest.trim()) {
      obj[key] = parseScalar(rest);
      i++;
      continue;
    }
    // 값 없는 키 → 하위는 반드시 "객체 리스트"(- 로 시작, 더 깊은 들여쓰기).
    i++;
    let j = i;
    while (j < lines.length && isSkippable(lines[j])) j++;
    if (j >= lines.length) throw new Error(`bindings 파서: "${key}:" 뒤 리스트 없음`);
    const childIndent = indentOf(lines[j]);
    if (childIndent <= indent || !lines[j].slice(childIndent).startsWith("- ")) {
      throw new Error(`bindings 파서: "${key}:" 뒤는 객체 리스트만 지원 — "${lines[j]}"`);
    }
    const { arr, next } = parseList(lines, j, childIndent);
    obj[key] = arr;
    i = next;
  }
  return { obj, next: i };
}

// 객체 리스트: 정확히 listIndent 위치의 `- key: value` 항목들.
function parseList(lines: string[], start: number, listIndent: number): { arr: Node[]; next: number } {
  const arr: Node[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isSkippable(line)) { i++; continue; }
    const cur = indentOf(line);
    if (cur < listIndent) break;
    if (cur !== listIndent || !line.slice(listIndent).startsWith("- ")) {
      throw new Error(`bindings 파서: 리스트 항목 형식 아님 — "${line}"`);
    }
    // "- " 를 2-스페이스로 치환해 항목 본문을 매핑으로 파싱(이후 키들은 listIndent+2).
    lines[i] = " ".repeat(listIndent + 2) + line.slice(listIndent + 2);
    const { obj, next } = parseMapping(lines, i, listIndent + 2);
    arr.push(obj);
    i = next;
  }
  return { arr, next: i };
}

// 파일 → frontmatter 객체(없으면 null). 선두 HTML 주석 1개 허용.
export function parseFrontmatter(text: string): Record<string, Node> | null {
  let body = text.replace(/^﻿/, "");
  body = body.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  if (!body.startsWith("---")) return null;
  const end = body.indexOf("\n---", 3);
  if (end === -1) throw new Error("bindings 파서: frontmatter 종료 '---' 없음");
  const block = body.slice(body.indexOf("\n") + 1, end);
  const lines = block.split("\n");
  const { obj, next } = parseMapping(lines, 0, 0);
  // 파싱이 중간에 멈췄으면(소화 못 한 줄) fail-closed.
  for (let k = next; k < lines.length; k++) {
    if (!isSkippable(lines[k])) throw new Error(`bindings 파서: 해석 불가 줄 — "${lines[k]}"`);
  }
  return obj;
}

// ── frontmatter → BindingPerson 검증(엄격 allowlist) ──
const PERSON_KEYS = new Set(["id", "kind", "display_name", "identities"]);
const IDENTITY_KEYS = new Set(["system", "instance", "external_id", "email", "display_name"]);
const KINDS = new Set(["human", "agent", "system"]);

function toPerson(raw: Node, src: string): BindingPerson {
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${src}: person 레코드가 객체가 아님`);
  for (const k of Object.keys(raw)) {
    if (!PERSON_KEYS.has(k)) throw new Error(`${src}: 알 수 없는 person 키 "${k}"`);
  }
  const id = raw.id, kind = raw.kind, dn = raw.display_name, ids = raw.identities;
  if (typeof id !== "string" || !id.trim()) throw new Error(`${src}: id 필수`);
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new Error(`${src}: kind 는 human|agent|system (받은 값: ${String(kind)})`);
  if (typeof dn !== "string" || !dn.trim()) throw new Error(`${src}: display_name 필수`);
  if (!Array.isArray(ids) || !ids.length) throw new Error(`${src}: identities 리스트 필수`);
  const identities: BindingIdentity[] = ids.map((entry, n) => {
    if (typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${src}: identities[${n}] 가 객체가 아님`);
    for (const k of Object.keys(entry)) {
      if (!IDENTITY_KEYS.has(k)) throw new Error(`${src}: 알 수 없는 identity 키 "${k}"`);
    }
    const sys = entry.system, ext = entry.external_id;
    if (typeof sys !== "string" || !sys.trim()) throw new Error(`${src}: identities[${n}].system 필수`);
    if (typeof ext !== "string" || !ext.trim()) throw new Error(`${src}: identities[${n}].external_id 필수`);
    return {
      system: sys.trim(),
      external_id: ext.trim(),
      instance: typeof entry.instance === "string" ? entry.instance.trim() : undefined,
      email: typeof entry.email === "string" ? entry.email.trim() : undefined,
      display_name: typeof entry.display_name === "string" ? entry.display_name.trim() : undefined,
    };
  });
  return { id: id.trim(), kind: kind as BindingPerson["kind"], display_name: dn.trim(), identities };
}

// ── 디렉토리 → BindingPerson[] ──
export function readBindingsDir(dir: string): { persons: BindingPerson[]; files: number } {
  const persons: BindingPerson[] = [];
  let files = 0;
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_template.md").sort();
  for (const f of entries) {
    const text = readFileSync(join(dir, f), "utf8");
    const fm = parseFrontmatter(text);
    if (fm === null) continue; // frontmatter 없는 멤버 파일(미바인딩) — 바인딩 의도 없음, skip
    files++;
    if (Array.isArray(fm.bindings)) {
      for (const b of fm.bindings) persons.push(toPerson(b, `${f} bindings[]`));
      const extra = Object.keys(fm).filter((k) => k !== "bindings");
      if (extra.length) throw new Error(`${f}: bindings 파일에 잉여 키 ${extra.join(",")}`);
    } else {
      persons.push(toPerson(fm, f));
    }
  }
  // 같은 (system, external_id) 가 두 person 에 묶이면 ground truth 모순 — 시끄럽게 실패.
  const seen = new Map<string, string>();
  for (const p of persons) {
    for (const idn of p.identities) {
      const key = `${idn.system}:${idn.external_id}`;
      const prev = seen.get(key);
      if (prev && prev !== p.id) throw new Error(`바인딩 모순: ${key} 가 ${prev} 와 ${p.id} 둘 다에 바인딩됨`);
      seen.set(key, p.id);
    }
  }
  return { persons, files };
}

function defaultMembersDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/items
  void here; // (기본 경로 하드코딩 제거 — 조직콘텐츠 레포명은 고객사마다 다름)
  return process.env.BINDINGS_DIR ?? ""; // 미설정이면 멤버 바인딩 없음(consumer existsSync 가드로 skip).
}

// ── upsert (호출자가 트랜잭션/클라이언트 소유) ──
export async function loadBindings(
  client: pg.PoolClient,
  membersDir = defaultMembersDir(),
): Promise<BindingsTally> {
  const { persons, files } = readBindingsDir(membersDir);
  let personsUpserted = 0;
  let identitiesBound = 0;
  for (const p of persons) {
    const pr = await client.query(
      `INSERT INTO person(id, display_name, kind) VALUES($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, kind=EXCLUDED.kind
         WHERE person.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR person.kind IS DISTINCT FROM EXCLUDED.kind
       RETURNING (xmax=0) AS inserted`,
      [p.id, p.display_name, p.kind],
    );
    if ((pr.rowCount ?? 0) > 0) {
      personsUpserted++;
      await client.query(
        `INSERT INTO person_identity_audit(action, person_id, detail, source)
         VALUES('person-upserted',$1,$2::jsonb,'bindings-loader')`,
        [p.id, JSON.stringify({ display_name: p.display_name, kind: p.kind, inserted: (pr.rows[0] as { inserted: boolean }).inserted })],
      );
    }
    for (const idn of p.identities) {
      const ir = await client.query(
        `INSERT INTO person_identity(person_id, system, instance, external_id, email, display_name, origin, state)
         VALUES($1,$2,$3,$4,$5,$6,'manual','confirmed')
         ON CONFLICT (system, external_id) DO UPDATE SET
           person_id = EXCLUDED.person_id,
           instance = COALESCE(EXCLUDED.instance, person_identity.instance),
           email = COALESCE(EXCLUDED.email, person_identity.email),
           display_name = COALESCE(EXCLUDED.display_name, person_identity.display_name),
           origin = 'manual', state = 'confirmed', updated_at = now()
         WHERE person_identity.person_id IS DISTINCT FROM EXCLUDED.person_id
            OR COALESCE(EXCLUDED.email, person_identity.email) IS DISTINCT FROM person_identity.email
            OR COALESCE(EXCLUDED.display_name, person_identity.display_name) IS DISTINCT FROM person_identity.display_name
            OR person_identity.origin <> 'manual'
            OR person_identity.state <> 'confirmed'
         RETURNING (xmax=0) AS inserted`,
        [p.id, idn.system, idn.instance ?? null, idn.external_id, idn.email ?? null, idn.display_name ?? null],
      );
      if ((ir.rowCount ?? 0) > 0) {
        identitiesBound++;
        await client.query(
          `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
           VALUES('identity-bound',$1,$2,$3,$4::jsonb,'bindings-loader')`,
          [p.id, idn.system, idn.external_id,
           JSON.stringify({ email: idn.email ?? null, inserted: (ir.rows[0] as { inserted: boolean }).inserted })],
        );
      }
    }
  }
  return { files, persons: persons.length, personsUpserted, identitiesBound };
}

// ── 단독 CLI 진입점 ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf("--members-dir");
  const dir = i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : defaultMembersDir();
  await initItemSchema();
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const tally = await loadBindings(client, dir);
    await client.query("COMMIT");
    console.log(JSON.stringify({ membersDir: dir, ...tally }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`bindings 로드 실패: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await itemsPool.end();
  }
}
