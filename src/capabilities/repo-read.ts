// 등록 레포의 판 읽기 능력(앱 v2 #124) — repo_refs · repo_diff · repo_file · repo_grep.
//  본체는 project/repo-read.ts(머리말에 무엇을 · 어떤 판만 · 어느 레포만 읽는지). 여기는 표면(MCP + REST GET)과 앱 관문만.
//  scope=code — 코드 글이 나간다(repo_branch_list 와 같은 줄). 앱 토큰 요청은 그 앱이 매니페스트 context.repos 에 적은 레포만(assertAppRepoAllowed).
//  REST 의 :repo 칸은 / 를 받지 못하니 판 · 경로는 쿼리로 받는다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { repoRefs, repoDiff, repoFile, repoGrep, REPO_READ_LIMITS as L } from "../project/repo-read.js";
import { assertAppRepoAllowed } from "../apps/app-context.js";

// 쿼리스트링 → 숫자 · 참거짓(빈 글 · 모르는 글은 undefined = 미지정).
function numOpt(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return undefined;
}
function boolOpt(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}
const strOpt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const REV_HINT = "판 — 커밋 해시(40자) · 원격 브랜치 이름(main · origin/main) · 태그 이름(v1.2.3). 원격 브랜치 · 태그에서 닿는 커밋만 읽는다";
const repoField = z.string().max(100).describe("등록된 레포 이름(repo_list 의 name)");

const refsInput = {
  repo: repoField,
  tags: z.number().int().min(1).max(L.tagsMax).optional().describe(`태그를 최근 만든 순으로 몇 개까지(기본 ${L.tagsDefault})`),
};
type RefsInput = z.infer<z.ZodObject<typeof refsInput>>;
const refs: Capability = {
  name: "repo_refs",
  title: "레포 머리 · 태그",
  description:
    "등록된 레포의 기본 브랜치 머리와 태그(최근 만든 순) — {default_branch, head:{commit, date, subject}, tags:[{name, commit, date, tagged_at}], fetched_at}. " +
    "배포판(태그)이나 머리 커밋을 고를 때 쓴다. 게이트웨이가 받아 둔 사본을 읽으므로 fetched_at(마지막으로 받은 시각)이 오래됐으면 repo_refresh 로 먼저 받는다.",
  scope: "code",
  input: refsInput,
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/repos/:repo/refs"], parse: (req) => ({ repo: req.params?.repo, tags: numOpt(req.query?.tags) }) }] },
  handler: async (input: RefsInput, user: LivelyUser) => {
    await assertAppRepoAllowed(user, input.repo);
    return repoRefs(input.repo, { tags: input.tags });
  },
};

const diffInput = {
  repo: repoField,
  from: z.string().max(200).describe(`앞 ${REV_HINT}`),
  to: z.string().max(200).describe(`뒤 ${REV_HINT}`),
  path: z.string().max(1000).optional().describe("주면 그 파일의 패치(앞뒤 3줄), 안 주면 바뀐 파일 목록"),
};
type DiffInput = z.infer<z.ZodObject<typeof diffInput>>;
const diff: Capability = {
  name: "repo_diff",
  title: "레포 두 판 사이",
  description:
    "등록된 레포의 두 판 사이 — path 를 안 주면 바뀐 파일 목록 {files:[{status A·M·D, path}]}(이름 바꿈은 지움 + 더함), 주면 그 파일의 패치 {patch}(앞뒤 3줄 · " +
    `${L.patchBytes / 1024}KiB 까지). ${REV_HINT}.`,
  scope: "code",
  input: diffInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/repos/:repo/diff"],
      parse: (req) => ({ repo: req.params?.repo, from: strOpt(req.query?.from), to: strOpt(req.query?.to), path: strOpt(req.query?.path) }) }],
  },
  handler: async (input: DiffInput, user: LivelyUser) => {
    await assertAppRepoAllowed(user, input.repo);
    return repoDiff(input.repo, input.from, input.to, { path: input.path });
  },
};

const fileInput = {
  repo: repoField,
  commit: z.string().max(200).describe(REV_HINT),
  path: z.string().max(1000).describe("레포 안의 파일 경로(앞에 / 없이)"),
  offset: z.number().int().min(1).optional().describe("시작 줄(1부터 · 기본 1)"),
  limit: z.number().int().min(1).max(L.linesMax).optional().describe(`줄 수(기본 ${L.linesDefault} · 최대 ${L.linesMax})`),
  numbered: z.boolean().optional().describe("줄마다 «번호\\t글»(기본 true) — false 면 글 그대로"),
};
type FileInput = z.infer<z.ZodObject<typeof fileInput>>;
const file: Capability = {
  name: "repo_file",
  title: "레포 한 판의 파일",
  description:
    "등록된 레포의 한 판에서 파일 하나를 줄 범위로 읽는다 — {commit, total_lines, range:{from, to, has_more}, text}. text 는 줄마다 «번호\\t글»(numbered=false 면 글 그대로). " +
    `offset 1부터 · limit 기본 ${L.linesDefault} · 최대 ${L.linesMax}. 이진 파일 · ${L.fileBytes / 1024 / 1024}MiB 넘는 파일은 읽지 않는다. ${REV_HINT}.`,
  scope: "code",
  input: fileInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/repos/:repo/file"],
      parse: (req) => ({ repo: req.params?.repo, commit: strOpt(req.query?.commit), path: strOpt(req.query?.path),
        offset: numOpt(req.query?.offset), limit: numOpt(req.query?.limit), numbered: boolOpt(req.query?.numbered) }) }],
  },
  handler: async (input: FileInput, user: LivelyUser) => {
    await assertAppRepoAllowed(user, input.repo);
    return repoFile(input.repo, input.commit, input.path, { offset: input.offset, limit: input.limit, numbered: input.numbered });
  },
};

const grepInput = {
  repo: repoField,
  commit: z.string().max(200).describe(REV_HINT),
  q: z.string().min(1).max(L.patternMax).describe("찾을 글 — 글자 그대로(정규식 아님) · 한 줄"),
  path: z.string().max(1000).optional().describe("이 파일 · 폴더 아래만(앞에 / 없이)"),
  limit: z.number().int().min(1).max(L.grepMax).optional().describe(`맞은 줄 몇 개까지(기본 ${L.grepDefault} · 최대 ${L.grepMax})`),
  ignore_case: z.boolean().optional().describe("대소문자를 가리지 않는다(기본 false)"),
};
type GrepInput = z.infer<z.ZodObject<typeof grepInput>>;
const grep: Capability = {
  name: "repo_grep",
  title: "레포 한 판에서 찾기",
  description:
    "등록된 레포의 한 판에서 글자 그대로 찾는다(정규식 아님 · 대소문자 구분) — {commit, hits:[{path, line, text}], truncated}. path 를 주면 그 파일 · 폴더 아래만. " +
    `이진 파일은 건너뛴다. ${REV_HINT}.`,
  scope: "code",
  input: grepInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/repos/:repo/grep"],
      parse: (req) => ({ repo: req.params?.repo, commit: strOpt(req.query?.commit), q: strOpt(req.query?.q), path: strOpt(req.query?.path),
        limit: numOpt(req.query?.limit), ignore_case: boolOpt(req.query?.ignore_case) }) }],
  },
  handler: async (input: GrepInput, user: LivelyUser) => {
    await assertAppRepoAllowed(user, input.repo);
    return repoGrep(input.repo, input.commit, input.q, { path: input.path, limit: input.limit, ignore_case: input.ignore_case });
  },
};

export const repoReadCapabilities: Capability[] = [refs, diff, file, grep];
