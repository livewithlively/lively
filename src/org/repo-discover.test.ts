// 레포 발견(#825) 어댑터 단위 체크 — DB·네트워크 불요(fetch 스텁).
//  실행: npm run build && node dist/org/repo-discover.test.js
//  커버: provider 응답 → 픽커 옵션 매핑(GitHub·GitLab) · GitLab 서브그룹 리프이름 · clone 주소 선택(ssh/https)
//        · 페이지네이션 절단 표면화 · 조회 파라미터(min_access_level=20)·인증 헤더 고정.
import assert from "node:assert/strict";
import { listGithub, listGitlab, preferUrl } from "./repo-discover.js";

let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// fetch 스텁 — 요청 URL/헤더를 기록하고, 페이지별 고정 응답을 돌려준다.
interface Call { url: string; headers: Record<string, string> }
function stubFetch(pages: unknown[][]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
    const body = pages[page - 1] ?? [];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// ── GitHub — /user/repos 응답 매핑 ──
await ta("listGithub: 필드 매핑(name·full_name·clone_url·ssh_url·default_branch·private) + Bearer 헤더", async () => {
  const s = stubFetch([[
    { name: "context-ontology", full_name: "livewithlively/context-ontology", clone_url: "https://github.com/livewithlively/context-ontology.git", ssh_url: "git@github.com:livewithlively/context-ontology.git", default_branch: "main", private: true },
    { name: "legacy-app", full_name: "livewithlively/legacy-app", clone_url: "https://github.com/livewithlively/legacy-app.git", ssh_url: "git@github.com:livewithlively/legacy-app.git", default_branch: "master", private: false },
  ]]);
  try {
    const r = await listGithub("github.com", "T");
    assert.equal(r.truncated, false);
    assert.equal(r.options.length, 2);
    assert.deepEqual(r.options[0], {
      host: "github.com", name: "context-ontology", full_path: "livewithlively/context-ontology",
      http_url: "https://github.com/livewithlively/context-ontology.git",
      ssh_url: "git@github.com:livewithlively/context-ontology.git",
      default_branch: "main", private: true,
    });
    // 기본 브랜치가 master 인 레거시 레포 — 폼의 'main' 기본값을 덮어써야 하는 핵심 케이스.
    assert.equal(r.options[1].default_branch, "master");
    assert.equal(r.options[1].private, false);
    assert.equal(s.calls[0].headers.Authorization, "Bearer T");
    assert.match(s.calls[0].url, /^https:\/\/api\.github\.com\/user\/repos\?/);
  } finally { s.restore(); }
});

await ta("listGithub: GHE(self-hosted)는 /api/v3 베이스", async () => {
  const s = stubFetch([[]]);
  try {
    await listGithub("git.acme.io", "T");
    assert.match(s.calls[0].url, /^https:\/\/git\.acme\.io\/api\/v3\/user\/repos\?/);
  } finally { s.restore(); }
});

// ── GitLab — /api/v4/projects 응답 매핑 ──
await ta("listGitlab: 서브그룹 경로는 full_path 로, 이름은 리프만(레포명은 경로 컴포넌트라 슬래시 불가)", async () => {
  const s = stubFetch([[
    { path: "core-api", path_with_namespace: "acme-dev/platform/backend/core-api", http_url_to_repo: "https://git.example.com/acme-dev/platform/backend/core-api.git", ssh_url_to_repo: "git@git.example.com:acme-dev/platform/backend/core-api.git", default_branch: "develop", visibility: "private" },
  ]]);
  try {
    const r = await listGitlab("git.example.com", "T");
    const o = r.options[0];
    assert.equal(o.name, "core-api");                                        // 리프만 — repo_create 에 넣을 값
    assert.equal(o.full_path, "acme-dev/platform/backend/core-api");           // 사람이 구분하는 라벨
    assert.equal(o.default_branch, "develop");
    assert.equal(o.private, true);
    assert.equal(s.calls[0].headers["PRIVATE-TOKEN"], "T");
  } finally { s.restore(); }
});

await ta("listGitlab: min_access_level=20(Reporter) 로 조회 — 그룹 상속 접근을 잡고, 목록=클론가능 을 보장", async () => {
  const s = stubFetch([[]]);
  try {
    await listGitlab("git.example.com", "T");
    const u = new URL(s.calls[0].url);
    // membership=true 는 '직접 멤버십' 이라 그룹 Reporter 로 상속된 봇 계정을 놓칠 수 있다 — 회귀 방지로 못박는다.
    assert.equal(u.searchParams.get("min_access_level"), "20");
    assert.equal(u.searchParams.get("membership"), null);
    assert.equal(u.searchParams.get("simple"), "true");
    assert.equal(u.pathname, "/api/v4/projects");
  } finally { s.restore(); }
});

await ta("listGitlab: http_url_to_repo 가 없으면 호스트+경로로 복구(방어적)", async () => {
  const s = stubFetch([[{ path: "x", path_with_namespace: "g/x", ssh_url_to_repo: "git@h:g/x.git", visibility: "private" }]]);
  try {
    const r = await listGitlab("h", "T");
    assert.equal(r.options[0].http_url, "https://h/g/x.git");
    assert.equal(r.options[0].default_branch, null);
  } finally { s.restore(); }
});

// ── 페이지네이션 — 상한에서 잘리면 truncated 로 표면화(조용한 절단 금지) ──
await ta("페이지네이션: 가득 찬 페이지가 상한까지 이어지면 truncated=true", async () => {
  const full = (n: number) => Array.from({ length: 100 }, (_, i) => ({ path: `r${n}-${i}`, path_with_namespace: `g/r${n}-${i}`, visibility: "private" }));
  const s = stubFetch([full(1), full(2), full(3), full(4)]);
  try {
    const r = await listGitlab("h", "T");
    assert.equal(r.options.length, 300);   // MAX_PAGES(3) × PAGE_SIZE(100)
    assert.equal(r.truncated, true);       // 4페이지째는 안 읽고 잘렸음을 알린다
    assert.equal(s.calls.length, 3);
  } finally { s.restore(); }
});

await ta("페이지네이션: 마지막 페이지가 덜 찼으면 truncated=false", async () => {
  const s = stubFetch([Array.from({ length: 100 }, (_, i) => ({ path: `a${i}`, path_with_namespace: `g/a${i}`, visibility: "public" })), [{ path: "b", path_with_namespace: "g/b", visibility: "public" }]]);
  try {
    const r = await listGitlab("h", "T");
    assert.equal(r.options.length, 101);
    assert.equal(r.truncated, false);
  } finally { s.restore(); }
});

// ── clone 주소 선택 — git 전송이 SSH 면 SSH 주소를 채운다(HTTPS 막힌 셀프호스팅) ──
await ta("preferUrl: 전송이 ssh 면 ssh_url, https/미등록이면 http_url, 없으면 반대쪽으로 폴백", () => {
  const both = { http_url: "https://h/g/r.git", ssh_url: "git@h:g/r.git" };
  assert.equal(preferUrl(both, "ssh"), "git@h:g/r.git");
  assert.equal(preferUrl(both, "https"), "https://h/g/r.git");
  assert.equal(preferUrl(both, null), "https://h/g/r.git");
  assert.equal(preferUrl({ http_url: null, ssh_url: "git@h:g/r.git" }, "https"), "git@h:g/r.git");
  assert.equal(preferUrl({ http_url: "https://h/g/r.git", ssh_url: null }, "ssh"), "https://h/g/r.git");
  assert.equal(preferUrl({ http_url: null, ssh_url: null }, "ssh"), null);
  return Promise.resolve();
});

console.log(`\nREPO-DISCOVER UNIT: ${pass} passed`);
