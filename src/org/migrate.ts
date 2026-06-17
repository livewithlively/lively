// lively-org(git 파일) → org-content DB **1회 마이그레이션**. 멱등(전부 upsert). ITEMS_DATABASE_URL 필요.
//   node --env-file-if-exists=.env dist/org/migrate.js [--org-dir <path>] [--dry-run]
// 기본 org-dir: dist/org 기준 ../../../lively-org (또는 LIVELY_ORG_DIR env).
// frontmatter 파싱은 load-bindings 의 검증된 미니 파서(parseFrontmatter)를 재사용 — 신원 계약과 동일.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initItemSchema } from "../items/store.js";
import { parseFrontmatter } from "../items/load-bindings.js";
import { initOrgSchema } from "./schema.js";
import {
  updateSection, updateOrgProfile, upsertMember, upsertMemory, type MemberIdentity,
} from "./store.js";

function defaultOrgDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/org
  return process.env.LIVELY_ORG_DIR ?? resolve(here, "../../../lively-org");
}

// frontmatter Node 안전 접근.
const asObj = (n: unknown): Record<string, unknown> =>
  n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>) : {};
const asArr = (n: unknown): unknown[] => (Array.isArray(n) ? n : []);
const asStr = (n: unknown): string => (typeof n === "string" ? n : "");

// frontmatter 블록 제거 → 본문(generate 의 strip 과 동일 규약).
function stripFrontmatter(text: string): string {
  let b = text.replace(/^﻿/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  if (b.startsWith("---")) {
    const end = b.indexOf("\n---", 3);
    if (end !== -1) b = b.slice(b.indexOf("\n", end + 1) + 1);
  }
  return b.trim();
}

function deriveOrgName(orgDir: string): string | null {
  try {
    const md = readFileSync(join(orgDir, "org/org-defaults.md"), "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const m = fm[1].match(/^\s*org-name\s*:\s*(.+?)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
    const body = md.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^---[\s\S]*?---\s*/, "");
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) return h1[1].replace(/\s*(공통\s*)?컨텍스트\s*$/, "").trim() || h1[1].trim();
  } catch { /* 폴백 null */ }
  return null;
}

export async function migrateOrgContent(orgDir: string, dry: boolean): Promise<string[]> {
  const log: string[] = [];
  const read = (p: string): string => readFileSync(join(orgDir, p), "utf8");
  const has = (p: string): boolean => existsSync(join(orgDir, p));
  if (!has("org")) throw new Error(`org-content 디렉토리가 아님(org/ 없음): ${orgDir}`);

  // ── 섹션 ──
  if (has("org/managed-policy.md")) {
    if (!dry) await updateSection("managed-policy", read("org/managed-policy.md"), "migrate", "migration");
    log.push("section: managed-policy");
  }
  if (has("org/org-defaults.md")) {
    if (!dry) await updateSection("org-defaults", read("org/org-defaults.md"), "migrate", "migration");
    log.push("section: org-defaults");
  }

  // ── 프로필(표시명·게이트웨이) ──
  const name = deriveOrgName(orgDir);
  const gatewayUrl = has("gateway-url") ? read("gateway-url").trim() : undefined;
  if (name || gatewayUrl) {
    if (!dry) await updateOrgProfile(
      { name: name ?? undefined, display_name: name ?? undefined, gateway_url: gatewayUrl },
      "migrate", "migration");
    log.push(`profile: name=${name ?? "-"} gateway=${gatewayUrl ?? "-"}`);
  }

  // ── 구성원(members/*.md frontmatter + 본문, _bindings.md 의 bindings[] 포함) ──
  if (has("members")) {
    for (const f of readdirSync(join(orgDir, "members")).filter((x) => x.endsWith(".md") && x !== "_template.md").sort()) {
      const text = read(join("members", f));
      const fm = parseFrontmatter(text);
      if (!fm) continue; // frontmatter 없는 멤버(미바인딩) → skip
      const body = stripFrontmatter(text);
      const fmObj = asObj(fm);
      const persons = Array.isArray(fmObj.bindings) ? fmObj.bindings : [fmObj];
      for (const pRaw of persons) {
        const p = asObj(pRaw);
        const id = asStr(p.id).trim();
        if (!id) continue;
        const identities: MemberIdentity[] = asArr(p.identities).map(asObj).map((e) => ({
          system: asStr(e.system).trim(),
          external_id: asStr(e.external_id).trim(),
          email: asStr(e.email).trim() || undefined,
          instance: asStr(e.instance).trim() || undefined,
          display_name: asStr(e.display_name).trim() || undefined,
        })).filter((e) => e.system && e.external_id);
        const kindRaw = asStr(p.kind) || "human";
        const kind = kindRaw === "agent" || kindRaw === "system" ? kindRaw : "human";
        if (!dry) await upsertMember({
          id, kind,
          display_name: asStr(p.display_name).trim() || id,
          email: identities.find((e) => e.email)?.email ?? null,
          identities,
          body_md: persons.length === 1 ? body : "", // _bindings.md(다중)는 본문 공유 안 함
          state: "active",
        }, "migrate", "migration");
        log.push(`member: ${id} (${kind}, 계정 ${identities.length})`);
      }
    }
  }

  // ── 메모리(memory/*.md → 단일 공유 풀. 전 메모리가 인덱스에 들어감 — in_index 분기 폐기) ──
  if (has("memory")) {
    for (const f of readdirSync(join(orgDir, "memory")).filter((x) => x.endsWith(".md") && x !== "MEMORY.md").sort()) {
      const memName = f.replace(/\.md$/, "");
      const text = read(join("memory", f));
      const h1 = text.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^---[\s\S]*?---\s*/, "").match(/^#\s+(.+?)\s*$/m);
      if (!dry) await upsertMemory({
        name: memName,
        title: h1 ? h1[1].trim() : memName,
        body_md: text,
      }, "migrate", "migration");
      log.push(`memory: ${memName}`);
    }
  }

  return log;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dry = process.argv.includes("--dry-run");
  const i = process.argv.indexOf("--org-dir");
  const orgDir = i > -1 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : defaultOrgDir();
  await initItemSchema();
  await initOrgSchema();
  const log = await migrateOrgContent(orgDir, dry);
  console.log(JSON.stringify({ orgDir, dryRun: dry, count: log.length, applied: log }, null, 2));
  process.exit(0);
}
