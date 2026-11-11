// domain-wiki 커넥터 — 로컬 git 마크다운 미러(team_wiki: 조직 도메인 지식) → 지식(observed) 인입.
//  (프로젝트 #696) 원본 repo `git@git.example.com:acme-dev/domain-wiki.git` 의 `content/**/*.md` 를 읽어,
//  링크를 내부 `#/k/<name>` 로 정규화(domain-wiki-md.ts)한 뒤 RawItem(type:"doc") 으로 흘린다.
//  퍼시스턴스는 downstream(ingestItems → mirrorExternalToV6 → mirrorKnowledgeByNameV6) 이 담당 —
//  임베딩은 쓰기루프 밖(백필)이라 대량 인입에도 게이트웨이가 안 막힌다(#669).
//
//  식별자: 지식 name = external_id = 파일 basename 슬러그(wikiSlug). 최초 수동이관이 이 규칙으로 name 을
//  부여했고, 이후 name 키 upsert(mirrorKnowledgeByNameV6)가 기존 행을 그대로 갱신·신규만 추가한다.
//  repo 는 read-only 미러(alice 커밋마다 덮어써짐)라 우리 쪽 재싱크 덮어쓰기도 안전(사용자 승인).
//
//  증분 없음: 매 실행 전체 워킹트리를 읽는다(로컬 파일 177개, 저렴) — last_synced_at 기반 아카이브 스윕
//  (sweepDomainWikiArchived, run-sync)이 삭제된 파일을 아카이브로 전파하려면 전량 관측이 필요하다.
//
//  경로 식별 모드(id_mode=path): 위 «basename 슬러그 = name» 은 파일명이 전역 유니크한 작은 위키에서만 성립한다.
//  제품 문서 레포(실측: 한 레포 .md 4,078개 중 1,216개가 이름을 나눠 쓰거나 슬러그가 빈다)에서는 서로 덮어쓴다.
//  이 모드는 레포 상대경로를 external_id 로 쓰고 외부 좌표 upsert(mirrorKnowledgeV6)로 보낸다 — 같은 이름의 다른
//  지식(사람이 쓴 것 포함)을 덮지 않는다. 이름은 domain-wiki-md.wikiPathName(경로 해시). 슬러그 모드(기본)는 그대로다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Connector, BackfillOpts, PostSyncCtx, PostSyncResult } from "./types.js";
import type { RawItem } from "../items/store.js";
import { itemsPool } from "../db/client.js";
import { sweepDomainWikiArchived } from "../v6/connector-mirror.js";
import { logger } from "../log.js";
import { resolveConnectorConfig, boundCollector } from "./config.js";
import { hasCategoryRules, ruleCategoryOnly } from "../v6/mirror/output-rules.js";
import {
  normalizeWikiLinks, parseFrontmatter, wikiSlug,
  wikiPathName, firstHeading, buildPathLinkTargets, normalizeWikiLinksByPath, type PathLinkTargets,
  maskSensitive, parseMaskKinds, unknownMaskWords, type MaskKind,
} from "./domain-wiki-md.js";
import { GlobSet, inScope, parseGlobList, toPosixRel } from "./path-glob.js";

const execFileP = promisify(execFile);
const SYSTEM = "domain-wiki";
const INSTANCE_DEFAULT = "domain-wiki";
const CONTENT_DEFAULT = "content";

interface DwConfig {
  repoPath: string | null;
  contentSubdir: string;
  gitPull: boolean;
  baseUrl: string;
  instance: string;
  /** slug(기본 · 파일명 슬러그가 이름) | path(레포 상대경로가 정체성). */
  idMode: "slug" | "path";
  /** 범위 — 비면 전부. content 기준 상대경로에 맞춘다. */
  include: string[];
  exclude: string[];
  /** 쓰기 전에 가릴 민감정보 종류(비면 안 가린다)와 남길 이메일 도메인. */
  mask: Set<MaskKind>;
  maskKeepEmailDomains: string[];
}

async function loadConfig(): Promise<DwConfig> {
  const c = await resolveConnectorConfig(SYSTEM);
  const unknownMask = unknownMaskWords(c.mask);
  if (unknownMask.length) console.warn(`${SYSTEM}: mask 에 모르는 낱말(${unknownMask.join(", ")}) — 네 종류 전부를 가린다(phone,email,bizno,rrn,all 중에서 고른다).`);
  return {
    repoPath: c.repo_path?.trim() || null,
    contentSubdir: c.content_subdir?.trim() || CONTENT_DEFAULT,
    gitPull: (c.git_pull ?? "").trim().toLowerCase() === "true",
    //  기본값을 씌우지 않는다 — 예시 도메인이 근거 링크로 새는 것을 막는다(위 toRawItem 주석).
    baseUrl: (c.base_url?.trim() || "").replace(/\/+$/, ""),
    instance: c.instance?.trim() || INSTANCE_DEFAULT,
    idMode: (c.id_mode ?? "").trim().toLowerCase() === "path" ? "path" : "slug",
    include: parseGlobList(c.include),
    exclude: parseGlobList(c.exclude),
    mask: parseMaskKinds(c.mask),
    maskKeepEmailDomains: String(c.mask_keep_email_domains ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
  };
}

/** 범위 거르기(include/exclude) — 순수. 미리보기와 실제 인입이 같은 판정을 쓰도록 export. */
export function selectMarkdown(rels: readonly string[], include: readonly string[], exclude: readonly string[]): string[] {
  if (!include.length && !exclude.length) return [...rels];
  const inc = new GlobSet(include), exc = new GlobSet(exclude);
  return rels.filter((r) => inScope(r, inc, exc));
}

/** content 루트 아래 *.md 상대경로(content 기준) 전량. 심볼릭·.git 등은 walk 하지 않는다.
 *  export 이유(#1881 G9): 위키 레포 다리가 "이 레포에 md 가 몇 개인가"를 미리 세어 사람에게 보여준다 —
 *  스캔 규칙이 두 벌이 되면 미리보기와 실제 인입이 어긋나므로 같은 함수를 쓴다. */
export function listMarkdown(contentRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;               // .git 등 숨김 제외
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(path.relative(contentRoot, full));
    }
  };
  walk(contentRoot);
  return out.sort();
}

/** 기존 notion 미러 지식 name 집합 — 노션 URL 링크(A)를 내부 `#/k/notion-…` 로 해소할 때 타깃 후보. */
async function notionTargetNames(): Promise<Set<string>> {
  try {
    const r = await itemsPool.query(
      `SELECT name FROM knowledge WHERE external_system='notion' AND lifecycle <> 'superseded'`);
    return new Set(r.rows.map((x: { name: string }) => x.name));
  } catch { return new Set(); }  // 노션 미러 없음/조회 실패 → 노션 링크는 외부 URL 로 유지(graceful)
}

/** 순수 변환(FS/네트워크 X, 단위테스트 대상): 파일 좌표 + 원문 + 타깃셋 → RawItem. */
export function toRawItem(
  args: { relpath: string; raw: string; mtime?: string; instance: string; baseUrl: string },
  knownTargets: Set<string>,
): RawItem {
  const { relpath, raw, mtime, instance, baseUrl } = args;
  const slug = wikiSlug(path.basename(relpath, ".md"));
  const { title, body } = parseFrontmatter(raw);
  const normalized = normalizeWikiLinks(body, knownTargets);
  // code_sot/source_sot 프론트매터 값 보존(fields) — 코드-대조·출처 추적용(본문엔 안 넣음).
  const fmCodeSot = raw.match(/^code_sot:\s*(.+)$/m)?.[1]?.trim();
  const fmSourceSot = raw.match(/^source_sot:\s*(.+)$/m)?.[1]?.trim();
  return {
    type: "doc",
    provenance: {
      category: "collab_tool",
      system: SYSTEM,
      instance,
      external_id: slug,                                   // = 지식 name (파일 basename 슬러그, 전역 유니크)
      //  base_url 이 없으면 **링크를 만들지 않는다**(#1881 G9). 종전엔 예시 상수(git.example.com/acme-dev)가
      //   기본값이라, 그 값을 지정하지 않은 배포는 근거 칩이 **남의 도메인**으로 향했다 — 없는 링크보다 나쁘다.
      external_url: baseUrl ? `${baseUrl}/${relpath.split(path.sep).join("/")}` : undefined,
    },
    title: title || slug,
    body: normalized || undefined,
    occurred_at: mtime,
    updated_at: mtime,
    fields: {
      domain_wiki: { relpath: relpath.split(path.sep).join("/"), code_sot: fmCodeSot, source_sot: fmSourceSot },
    },
  };
}

/** `git log --format=%x01%cI --name-only` 출력 → 경로별 **마지막** 커밋 시각(ISO). 순수(단위테스트 대상).
 *  git log 는 새 커밋부터 내보내므로 경로를 처음 만난 커밋이 그 파일의 마지막 커밋이다.
 *  core.quotePath=false 여도 따옴표 · 제어문자가 든 경로는 C 따옴표로 나온다 — 풀어서 쓴다(못 풀면 그 경로는 건너뛴다). */
export function parseGitLogTimes(out: string): Map<string, string> {
  const times = new Map<string, string>();
  let at: string | null = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("\x01")) { at = line.slice(1).trim() || null; continue; }
    if (!at) continue;
    const p = line.startsWith('"') ? unquoteGitPath(line) : line;
    if (p && !times.has(p.normalize("NFC"))) times.set(p.normalize("NFC"), at);
  }
  return times;
}

/** git 의 C 따옴표 경로("a\\tb.md" · 8진수 UTF-8 바이트) → 원래 경로. 형식이 깨졌으면 null. */
function unquoteGitPath(q: string): string | null {
  if (q.length < 2 || !q.endsWith('"')) return null;
  const body = q.slice(1, -1);
  const bytes: number[] = [];
  const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      //  코드 포인트 단위로 — 보충 평면 글자(이모지 등)를 UTF-16 반쪽씩 인코딩하면 깨진다.
      const ch = String.fromCodePoint(body.codePointAt(i)!);
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      i += ch.length - 1;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) return null;
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    if (!(n in ESC)) return null;
    bytes.push(ESC[n]); i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 레포 상대경로 → 마지막 커밋 시각. git 이 없거나 실패하면 빈 표(호출부가 파일 mtime 으로 폴백한다).
 *  한 번의 git log 로 전체를 얻는다(실측: 커밋 13,469개 · 9.5만 줄에 1초). 파일마다 git log 를 부르면 수천 번 뜬다. */
async function gitLastCommitTimes(repoPath: string, subdir: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileP("git",
      //  --relative: repo_path 가 레포 안쪽 폴더여도 경로를 repo_path 기준으로 받는다(루트면 영향 없음).
      ["-C", repoPath, "-c", "core.quotePath=false", "log", "--no-renames", "--relative", "--format=%x01%cI", "--name-only", "HEAD", "--", subdir || "."],
      { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    return parseGitLogTimes(stdout);
  } catch (e) {
    console.warn(`${SYSTEM}: git log 실패(파일 mtime 으로 진행): ${(e as Error).message}`);
    return new Map();
  }
}

/** 원본 blob 주소 — 경로 조각마다 인코딩한다(공백 · 한글 · `#` 이 든 경로가 링크에서 끊기지 않게). */
export function blobUrl(baseUrl: string, relpath: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl}/${toPosixRel(relpath).split("/").map(encodeURIComponent).join("/")}`;
}

/** 경로 모드 RawItem — 순수(단위테스트 대상). toRawItem(슬러그 모드)과 따로 두어 그쪽 출력을 한 바이트도 바꾸지 않는다.
 *  · external_id = content 기준 상대경로(NFC POSIX). name_hint = wikiPathName — 신규 행이 이 이름으로 태어난다.
 *  · path = 같은 경로 — 수집기 산출 규칙(output_config.category_rules)이 이 값에 맞춰 분류를 고른다.
 *  · 제목: 프론트매터 title → 본문 첫 `# 제목` → 경로(확장자 뺀). README 가 수백 개라 파일명만으로는 못 가린다.
 *  · 시각: 마지막 커밋 시각이 있으면 그것, 없으면 파일 mtime(클론한 시각이라 부정확하다는 것을 안다).
 *  · 가리기: **원문 전체를 먼저** 가린 뒤 앞머리를 풀고 링크를 바꾼다 — 앞머리 값(title · code_sot …)도 함께 가려지고,
 *    바꿔 넣은 내부 링크의 이름(끝의 경로 해시가 숫자만 10자리면 전화번호 꼴이다)이 가리기에 깨지지 않는다.
 *  · code_sot · source_sot 는 앞머리에서만 읽는다(본문 줄이 우연히 그 꼴이면 값으로 새지 않게). */
export function toRawItemPath(
  args: { relpath: string; raw: string; mtime?: string; committedAt?: string; instance: string; baseUrl: string;
          mask?: ReadonlySet<MaskKind>; maskKeepEmailDomains?: readonly string[] },
  targets: PathLinkTargets,
): RawItem {
  const rel = toPosixRel(args.relpath);
  const m = maskSensitive(args.raw, args.mask ?? new Set<MaskKind>(), args.maskKeepEmailDomains ?? []);
  const raw = m.text;
  const { title: fmTitle, body } = parseFrontmatter(raw);
  const linked = normalizeWikiLinksByPath(body, rel, targets);
  const title = fmTitle || firstHeading(body) || rel.replace(/\.md$/i, "");
  const masked = Object.fromEntries(Object.entries(m.masked).filter(([, v]) => Number(v) > 0));
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)?.[1] ?? "";
  const fmCodeSot = fm.match(/^code_sot:\s*(.+)$/m)?.[1]?.trim();
  const fmSourceSot = fm.match(/^source_sot:\s*(.+)$/m)?.[1]?.trim();
  const at = args.committedAt ?? args.mtime;
  return {
    type: "doc",
    provenance: {
      category: "collab_tool",
      system: SYSTEM,
      instance: args.instance,
      external_id: rel,
      external_url: blobUrl(args.baseUrl, rel),
    },
    name_hint: targets.byPath.get(rel) ?? wikiPathName(args.instance, rel),
    path: rel,
    title,
    body: linked || undefined,
    occurred_at: at,
    updated_at: at,
    fields: {
      domain_wiki: {
        relpath: rel, id_mode: "path", code_sot: fmCodeSot, source_sot: fmSourceSot,
        ...(args.committedAt ? { committed_at: args.committedAt } : {}),
        ...(Object.keys(masked).length ? { masked } : {}),
      },
    },
  };
}

async function* backfill(_opts?: BackfillOpts): AsyncIterable<RawItem> {
  const cfg = await loadConfig();
  if (!cfg.repoPath) {
    console.warn(`${SYSTEM}: repo_path 미설정 — 인입할 것이 없습니다(관리탭에서 로컬 체크아웃 경로 지정).`);
    return;
  }
  const contentRoot = path.join(cfg.repoPath, cfg.contentSubdir);
  if (!fs.existsSync(contentRoot)) {
    console.warn(`${SYSTEM}: content 경로 없음(${contentRoot}) — repo_path/content_subdir 확인.`);
    return;
  }
  // best-effort ff-only pull(자격증명 없으면 조용히 워킹트리 그대로 사용).
  if (cfg.gitPull) {
    try { await execFileP("git", ["-C", cfg.repoPath, "pull", "--ff-only"], { timeout: 60_000 }); }
    catch (e) { console.warn(`${SYSTEM}: git pull 실패(워킹트리로 진행): ${(e as Error).message}`); }
  }

  const all = listMarkdown(contentRoot);
  const inc = new GlobSet(cfg.include);
  if (inc.configured && !inc.size) console.warn(`${SYSTEM}: 포함 경로(include)에 유효한 패턴이 없다 — 아무것도 인입하지 않는다(설정: ${cfg.include.join(", ")}).`);
  const rels = selectMarkdown(all, cfg.include, cfg.exclude);
  if (rels.length !== all.length) console.log(`${SYSTEM}: 범위(include/exclude) ${all.length}개 중 ${rels.length}개.`);
  if (cfg.idMode === "path") { yield* backfillByPath(cfg, contentRoot, rels); return; }
  // 타깃셋 = 레포 슬러그(자기참조 해소) ∪ 기존 notion 미러 name(노션 URL 해소).
  const repoSlugs = new Set(rels.map((r) => wikiSlug(path.basename(r, ".md"))));
  const knownTargets = new Set<string>([...repoSlugs, ...(await notionTargetNames())]);

  let n = 0;
  for (const rel of rels) {
    const full = path.join(contentRoot, rel);
    try {
      const raw0 = fs.readFileSync(full, "utf8");
      //  가리기는 원문 전체에 먼저(경로 모드와 같은 이유 — 앞머리 값 · 바꿔 넣은 링크 보호). 안 켜면 원문 그대로.
      const raw = cfg.mask.size ? maskSensitive(raw0, cfg.mask, cfg.maskKeepEmailDomains).text : raw0;
      const mtime = fs.statSync(full).mtime.toISOString();
      yield toRawItem({ relpath: rel, raw, mtime, instance: cfg.instance, baseUrl: cfg.baseUrl }, knownTargets);
      n++;
    } catch (e) {
      console.warn(`${SYSTEM}: 파일 처리 실패(skip) ${rel}: ${(e as Error).message}`);
    }
  }
  console.log(`${SYSTEM}: ${n}개 md → 지식 인입(레포 슬러그 ${repoSlugs.size}, 타깃 ${knownTargets.size}).`);
}

/** 경로 모드 본체 — 범위 안 파일 전량을 매번 읽는다(삭제 전파 스윕의 전제는 슬러그 모드와 같다). */
async function* backfillByPath(cfg: DwConfig, contentRoot: string, rels: readonly string[]): AsyncIterable<RawItem> {
  const posix = rels.map(toPosixRel);
  const targets = buildPathLinkTargets(posix, (rel) => wikiPathName(cfg.instance, rel), await notionTargetNames());
  //  git log 경로는 레포 루트 기준이고 rel 은 content 기준이다 — 하위폴더를 붙여 찾는다.
  const sub = toPosixRel(path.relative(cfg.repoPath!, contentRoot)) || ".";
  const times = await gitLastCommitTimes(cfg.repoPath!, sub);
  //  경로 분류 규칙이 있으면 «어느 규칙에도 안 걸린 파일» 을 먼저 센다 — 그 파일은 target_category 로 가거나(있으면)
  //   미분류로 쌓인다. 미분류 지식은 소환되지 않으므로, 범위를 넓힌 뒤 규칙을 빠뜨린 것을 로그에서 바로 보게 한다.
  const oc = boundCollector()?.outputConfig;
  if (hasCategoryRules(oc)) {
    const miss = posix.filter((rel) => !ruleCategoryOnly(oc, rel));
    if (miss.length) console.warn(`${SYSTEM}: 경로 분류 규칙에 안 걸린 파일 ${miss.length}개(target_category ${typeof oc?.target_category === "string" && oc.target_category ? `'${oc.target_category}' 로` : "없음 → 미분류"}): ${miss.slice(0, 10).join(", ")}${miss.length > 10 ? " …" : ""}`);
  }
  let n = 0, timed = 0;
  for (let i = 0; i < rels.length; i++) {
    const rel = posix[i];
    const full = path.join(contentRoot, rels[i]);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const mtime = fs.statSync(full).mtime.toISOString();
      const committedAt = times.get(sub === "." ? rel : `${sub}/${rel}`);
      if (committedAt) timed++;
      yield toRawItemPath({ relpath: rel, raw, mtime, committedAt, instance: cfg.instance, baseUrl: cfg.baseUrl,
        mask: cfg.mask, maskKeepEmailDomains: cfg.maskKeepEmailDomains }, targets);
      n++;
    } catch (e) {
      console.warn(`${SYSTEM}: 파일 처리 실패(skip) ${rel}: ${(e as Error).message}`);
    }
  }
  console.log(`${SYSTEM}: 경로 모드 ${n}개 md → 지식 인입(커밋 시각 ${timed}개 · 가리기 ${[...cfg.mask].join(",") || "없음"}).`);
  //  커밋 시각을 못 찾은 파일은 mtime 을 쓰는데, mtime 은 다시 클론하면 바뀐다 — 그 파일들은 매 싱크 «변경» 으로 보여 판이 오른다.
  if (timed < n) console.warn(`${SYSTEM}: 커밋 시각을 못 찾은 파일 ${n - timed}개 — 파일 mtime 으로 대신했다(git log 실패 · 얕은 클론이면 확인).`);
}

// ── 후처리(#696) — 삭제 전파 스윕(이번 전량 싱크 미관측 행 아카이브). #1313 R44 로 run-sync 에서 이관. ──
//  안전장치: 미러 실패 0 AND 실인입>0 일 때만 — 경로 오설정/빈 run 이 전량 아카이브하는 오탐 방지.
//  커서 시맨틱은 건드리지 않는다(freezeCursor 미반환) — 스윕 실패는 비치명이고 다음 run 이 수렴한다.
async function postSync(ctx: PostSyncCtx): Promise<PostSyncResult> {
  const { pool, runStartIso, ingested, mirrorFailures } = ctx;
  if (mirrorFailures === 0 && ingested > 0) {
    try {
      //  스윕은 **이 수집기의 instance 안에서만** 돈다(#1881 G9) — 위키 레포를 둘 이상 붙였을 때
      //  한 레포의 싱크가 다른 레포의 지식을 아카이브하지 않게. instance 는 backfill 이 RawItem 에 실은 값과 같다.
      const { instance } = await loadConfig();
      const archived = await sweepDomainWikiArchived(pool, runStartIso, instance);
      logger.info({ system: SYSTEM, instance, ingested, archived }, "domain-wiki 후처리 완료(삭제 전파 스윕)");
    } catch (err) {
      logger.error({ err: (err as Error)?.message ?? String(err) }, "domain-wiki 스윕 실패(비치명 — 다음 run 수렴)");
    }
  } else {
    logger.warn({ system: SYSTEM, ingested, mirrorFailures }, "domain-wiki 스윕 생략(인입 0 또는 미러 실패 — 오탐 아카이브 방지)");
  }
  return {};
}

export const domainWikiConnector: Connector = {
  name: SYSTEM,
  backfill,
  postSync,
  //  게이트웨이 호스트의 레포 경로(repo_path)를 읽고 git pull 한다 — 판에는 그 경로가 없다(#3994 T3).
  needsGatewayDisk: true,
};
