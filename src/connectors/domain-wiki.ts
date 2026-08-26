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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Connector, BackfillOpts, PostSyncCtx, PostSyncResult } from "./types.js";
import type { RawItem } from "../items/store.js";
import { itemsPool } from "../db/client.js";
import { sweepDomainWikiArchived } from "../v6/connector-mirror.js";
import { logger } from "../log.js";
import { resolveConnectorConfig } from "./config.js";
import { normalizeWikiLinks, parseFrontmatter, wikiSlug } from "./domain-wiki-md.js";

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
}

async function loadConfig(): Promise<DwConfig> {
  const c = await resolveConnectorConfig(SYSTEM);
  return {
    repoPath: c.repo_path?.trim() || null,
    contentSubdir: c.content_subdir?.trim() || CONTENT_DEFAULT,
    gitPull: (c.git_pull ?? "").trim().toLowerCase() === "true",
    //  기본값을 씌우지 않는다 — 예시 도메인이 근거 링크로 새는 것을 막는다(위 toRawItem 주석).
    baseUrl: (c.base_url?.trim() || "").replace(/\/+$/, ""),
    instance: c.instance?.trim() || INSTANCE_DEFAULT,
  };
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

  const rels = listMarkdown(contentRoot);
  // 타깃셋 = 레포 슬러그(자기참조 해소) ∪ 기존 notion 미러 name(노션 URL 해소).
  const repoSlugs = new Set(rels.map((r) => wikiSlug(path.basename(r, ".md"))));
  const knownTargets = new Set<string>([...repoSlugs, ...(await notionTargetNames())]);

  let n = 0;
  for (const rel of rels) {
    const full = path.join(contentRoot, rel);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const mtime = fs.statSync(full).mtime.toISOString();
      yield toRawItem({ relpath: rel, raw, mtime, instance: cfg.instance, baseUrl: cfg.baseUrl }, knownTargets);
      n++;
    } catch (e) {
      console.warn(`${SYSTEM}: 파일 처리 실패(skip) ${rel}: ${(e as Error).message}`);
    }
  }
  console.log(`${SYSTEM}: ${n}개 md → 지식 인입(레포 슬러그 ${repoSlugs.size}, 타깃 ${knownTargets.size}).`);
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
};
