// 등록 레포(git) → 위키 수집기 다리 (#1881 G9)
//
// ── 왜 다리 하나면 되나 ────────────────────────────────────────────────────────────────────
//  이 조각이 생기기 전에도 `domain-wiki` 커넥터는 git 마크다운을 지식으로 바꾸고 있었다(#696). 막고 있던 것은
//  인증이 아니라 **경로**였다: "게이트웨이 호스트에 repo 를 clone/pull 하고 그 절대경로를 입력"이 필수 필드였다
//  (connectors/config.ts 의 repo_path). 서버에 SSH 로 들어갈 수 있는 사람만 쓸 수 있는 기능이었다는 뜻이고,
//  셀프서브 사용자에겐 존재하지 않는 것과 같았다.
//  그런데 레포를 등록하면 게이트웨이가 이미 `workspace/repos/<name>` 에 클론을 두고 최신화까지 한다
//  (project-provision·scheduler/repo-refresh). 그래서 여기서 하는 일은 **그 경로를 수집기 설정에 채워 넣는 것뿐**이고,
//  자격증명은 한 개도 더 필요하지 않다. 레포 연결이 끝난 순간 자료 수집의 전제도 이미 끝나 있었다.
//
// ── 코드 레포는 대상이 아니다 ──────────────────────────────────────────────────────────────
//  윤상민(2026-08-26): "맥락수집은 코드 대상으로 할필욘없고 llm위키 등 맥락을 깃 레포에 저장하는 경우에만 대상이
//  되겠지. 나머지 코드들은 레포연결 수준으로." 그래서 등록 레포를 자동으로 훑지 않는다 — 사람이 "이 레포는 위키다"
//  라고 표시한 것만, 그것도 **꺼진 채로** 만들고 표본을 본 뒤 승인하게 한다(로컬 L3 #1921 과 같은 규율:
//  켜진 채로 생성하면 사람이 내용을 보기 전에 지식이 쌓인다).
import fs from "node:fs";
import path from "node:path";
import { PROJECT_SHARED_BASE } from "../project/project-fs.js";
import { REPOS_SUBDIR } from "../project/project-provision.js";
import { getRepo } from "../domainmap/core/repos.js";
import { listMarkdown } from "../connectors/domain-wiki.js";
import { upsertCollector, listCollectors } from "./store/collectors.js";
import { HttpError } from "../http-error.js";

/** 이 레포의 위키 수집기 key(=사람이 보는 식별자·URL 컴포넌트). */
export function wikiCollectorKey(repo: string): string {
  return `wiki-${String(repo).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

/**
 * 이 레포로 인입한 지식의 `external_instance`.
 *  ⚠ 스윕(sweepDomainWikiArchived)이 이 값으로 범위를 좁힌다 — 레포마다 달라야 한다. 같은 값을 두 레포가 쓰면
 *  한쪽 싱크가 다른 쪽 지식을 아카이브한다(그 사고를 막으려고 스윕에 instance 를 필수로 만들었다).
 */
export function wikiInstance(repo: string): string {
  return wikiCollectorKey(repo);
}

/** 게이트웨이가 이 레포를 클론해 두는 자리 — provision·repo-refresh 와 같은 경로여야 한다. */
export function repoClonePath(repo: string): string {
  return path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR, String(repo).trim());
}

/**
 * 스캔할 하위폴더 추정.
 *  `content/` 가 있으면 그것(우리 `llm-wiki-init-*` 스킬이 만드는 구조이자 Quartz 관례), 없으면 레포 루트(".").
 *  ⚠ 루트를 고르면 README·CHANGELOG 같은 코드 레포의 부속 문서까지 지식이 된다. 그래서 추정 결과와 md 개수를
 *   함께 돌려주고, 켜기 전에 사람이 표본으로 확인하게 한다 — 추정을 조용히 확정하지 않는다.
 */
export function detectContentSubdir(clonePath: string): string {
  try {
    if (fs.statSync(path.join(clonePath, "content")).isDirectory()) return "content";
  } catch { /* 없으면 루트 */ }
  return ".";
}

/**
 * clone 주소 → 파일 blob URL 접두(근거 칩이 원본을 열 때 쓴다).
 *  호스트별 문법이 갈린다: GitHub `/blob/<branch>` · GitLab `/-/blob/<branch>`.
 *  자체 운영 GitLab 은 호스트 이름으로 판별할 수 없으므로(git.company.com 같은 이름이 흔하다) GitLab 문법으로
 *  **추정**하고 그 사실을 `guessed` 로 알린다 — 조용히 틀린 링크를 만드는 것도, 링크를 통째로 버리는 것도
 *  둘 다 나쁘기 때문이다. 사람이 base_url 을 직접 넣으면 그 값이 이긴다.
 */
export function blobBaseUrl(gitUrl: string | null | undefined, branch: string | null | undefined): { url: string | null; guessed: boolean } {
  const raw = String(gitUrl ?? "").trim();
  if (!raw) return { url: null, guessed: false };
  const br = String(branch ?? "").trim() || "main";
  let host = "", repoPath = "";
  const ssh = raw.match(/^(?:ssh:\/\/)?(?:[^@]+@)([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (ssh) { host = ssh[1]; repoPath = ssh[2]; }
  else {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { url: null, guessed: false };
      host = u.hostname;
      //  ⚠ 순서가 중요하다 — 끝 슬래시를 **먼저** 걷어야 `.git` 이 끝에 오고 그때 지워진다.
      //   반대로 하면 `https://host/o/r.git/` 이 `o/r.git` 으로 남아 링크가 `/o/r.git/blob/main` 이 된다(실측).
      repoPath = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
    } catch { return { url: null, guessed: false }; }
  }
  if (!host || !repoPath) return { url: null, guessed: false };
  //  호스트는 DNS 상 대소문자를 가리지 않는다 — `git@GitHub.com:...` 도 GitHub 이다. 판정과 출력 모두
  //  소문자로 정규화한다(판정만 소문자로 하면 링크에 대문자 호스트가 그대로 남아 지저분하고 비교가 어긋난다).
  const h = host.toLowerCase();
  if (h === "github.com") return { url: `https://${h}/${repoPath}/blob/${br}`, guessed: false };
  if (h === "gitlab.com") return { url: `https://${h}/${repoPath}/-/blob/${br}`, guessed: false };
  return { url: `https://${h}/${repoPath}/-/blob/${br}`, guessed: true };
}

export interface WikiRepoEnsureResult {
  repo: string;
  collector_id: number;
  key: string;
  instance: string;
  created: boolean;
  enabled: boolean;
  clone_path: string;
  content_subdir: string;
  /** 지금 그 경로에서 보이는 .md 개수 — 켜기 전에 "정말 위키인가"를 사람이 가늠하는 유일한 숫자. */
  markdown_files: number;
  base_url: string | null;
  /** base_url 을 호스트 문법으로 추정했는가(열리지 않으면 사람이 고쳐야 한다). */
  base_url_guessed: boolean;
}

/**
 * 이 레포의 위키 수집기를 준비한다(없으면 만든다 — 기본은 **꺼진 채**).
 *  enable=true 면 켠다(표본을 보고 난 뒤의 승인 경로). 이미 있으면 경로·추정값만 최신으로 맞춘다(멱등).
 */
export async function ensureWikiRepoCollector(opts: {
  repo: string;
  enable?: boolean;
  actor?: string;
  source?: string;
}): Promise<WikiRepoEnsureResult> {
  const repo = String(opts.repo ?? "").trim();
  if (!repo) throw new HttpError(400, "레포 이름이 필요합니다");
  const row = await getRepo(repo); // 없으면 404 — 등록되지 않은 레포는 클론도 없다

  const clonePath = repoClonePath(repo);
  if (!fs.existsSync(path.join(clonePath, ".git"))) {
    // 클론이 아직 없다 = 이 레포를 쓰는 프로젝트가 한 번도 준비되지 않았다는 뜻. 경로를 지어내 저장하면
    //  수집기는 만들어지되 매 실행 "content 경로 없음" 만 남기고 조용히 아무것도 안 한다 — 그래서 여기서 막는다.
    throw new HttpError(409,
      `레포 '${repo}' 의 클론이 아직 없습니다(${clonePath}). 이 레포를 쓰는 프로젝트를 한 번 준비하거나 레포 화면에서 [코드 최신화]를 누른 뒤 다시 시도하세요.`);
  }

  const contentSubdir = detectContentSubdir(clonePath);
  const contentRoot = path.join(clonePath, contentSubdir);
  const markdownFiles = fs.existsSync(contentRoot) ? listMarkdown(contentRoot).length : 0;
  const base = blobBaseUrl(row?.git_url ?? null, row?.default_branch ?? null);

  const key = wikiCollectorKey(repo);
  const instance = wikiInstance(repo);
  const existing = (await listCollectors()).find((c) => c.key === key);
  //  ⚠ 슬러그는 대소문자를 접는다 — 레포 'Lively' 와 'lively' 는 같은 key 로 떨어진다. 그대로 두면 뒤에 온
  //   레포가 앞 레포의 수집기를 **말없이 빼앗고**, 두 레포가 같은 instance 를 쓰게 되어 서로의 지식을 아카이브한다
  //   (스윕을 instance 로 좁힌 의미가 사라진다). 남의 자리면 만들지 않고 막는다.
  const takenBy = existing?.config?.repo_path;
  if (takenBy && takenBy !== clonePath) {
    throw new HttpError(409,
      `수집기 이름 '${key}' 를 이미 다른 레포가 쓰고 있습니다(${takenBy}). 레포 이름이 대소문자만 다르면 같은 자리로 접힙니다 — 한쪽 이름을 바꾸거나 그 수집기를 먼저 정리하세요.`);
  }

  const view = await upsertCollector({
    ...(existing?.id ? { id: existing.id } : { key, instance_key: key }),
    preset_key: "domain-wiki",
    label: `위키 · ${repo}`,
    //  enable 미지정 = 지금 상태 유지(준비만). true/false 를 명시하면 그대로 — 끄기도 같은 문으로 되게 한다.
    enabled: typeof opts.enable === "boolean" ? opts.enable : (existing?.enabled ?? false),
    config: {
      repo_path: clonePath,
      content_subdir: contentSubdir,
      git_pull: "false",   // 최신화는 repo-refresh 스케줄러의 일이다 — 여기서 또 pull 하면 자격·충돌 표면이 늘어난다
      instance,
      ...(base.url ? { base_url: base.url } : {}),
    },
    note: `등록 레포 '${repo}' 의 마크다운을 지식으로 인입합니다(#1881 G9). 경로는 게이트웨이 공유 클론이라 사람이 관리하지 않습니다.`,
  }, opts.actor, opts.source ?? "web");

  return {
    repo,
    collector_id: view.id,
    key,
    instance,
    created: !existing,
    enabled: !!view.enabled,
    clone_path: clonePath,
    content_subdir: contentSubdir,
    markdown_files: markdownFiles,
    base_url: base.url,
    base_url_guessed: base.guessed,
  };
}
