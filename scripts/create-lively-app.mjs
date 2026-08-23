#!/usr/bin/env node
// 라이블리 앱 스캐폴드 — 동작하는 앱 하나를 통째로 만들어 준다 (#1780 SDK).
//  사용:  node scripts/create-lively-app.mjs <앱id> [대상폴더]
//  왜 필요한가: 매니페스트 필드·UI 브리지 배관·데이터 선언을 처음부터 손으로 맞추는 건 진입장벽이다.
//   여기서 나온 폴더는 **그대로 설치되어 바로 도는 앱**이다(관리자: org_app_install source={kind:'git'|'path'}).
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , rawId, rawDir] = process.argv;
const id = String(rawId || "").trim();
if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
  console.error("사용: node scripts/create-lively-app.mjs <앱id> [대상폴더]\n  앱id = 소문자 영숫자/- 2~32자(소문자·숫자로 시작)");
  process.exit(1);
}
const dir = path.resolve(rawDir || id);
if (existsSync(dir)) { console.error(`이미 있는 폴더입니다: ${dir}`); process.exit(1); }

const w = (rel, body) => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

w("lively-app.json", JSON.stringify({
  $schema: "https://dev.lvly.io/ui/lively-app.schema.json",
  id,
  title: id,
  version: "0.1.0",
  // 권한 상한 — 설치·동의 때 사람이 이 목록을 그대로 본다. 필요한 것만 남겨라.
  permissions: { scopes: [], tools: ["store_insert", "store_query", "store_update", "store_delete", "store_tables"] },
  // 이 앱 전용 표(app.<앱id>__notes) — 테넌트 격리는 서버가 한다.
  data: { tables: [{ name: "notes", columns: [{ name: "body", type: "text" }, { name: "done", type: "bool" }] }] },
  ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] },
}, null, 2) + "\n");

w("ui/index.html", `<!doctype html><meta charset="utf-8"><title>${id}</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; margin: 0; padding: 16px; color: #15233B; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  form { display: flex; gap: 6px; margin-bottom: 12px; }
  input { flex: 1; padding: 8px 10px; border: 1px solid #E6ECF5; border-radius: 8px; font: inherit; }
  button { padding: 8px 12px; border: 1px solid #E6ECF5; border-radius: 8px; background: #2D6BF0; color: #fff; font: inherit; cursor: pointer; }
  li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid #F0F3F8; }
  li button { background: none; color: #8B93A7; border: 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  .done { text-decoration: line-through; color: #8B93A7; }
</style>
<h1>${id}</h1>
<form id="f"><input id="t" placeholder="할 일을 적고 Enter" autocomplete="off"><button>추가</button></form>
<ul id="list"></ul>
<script>
  // window.lively 는 호스트가 주입한다 — 설치·번들 없이 바로 쓴다(apps/sdk/lively-app.d.ts 가 타입).
  const list = document.getElementById('list');
  async function draw() {
    const rows = await lively.store.query('notes', { limit: 100 });
    list.replaceChildren(...rows.map((r) => {
      const li = document.createElement('li');
      const s = document.createElement('span');
      s.textContent = r.body; if (r.done) s.className = 'done';
      s.onclick = () => lively.store.update('notes', { id: r.id }, { done: !r.done }).then(draw);
      const x = document.createElement('button'); x.textContent = '삭제';
      x.onclick = () => lively.store.delete('notes', { id: r.id }).then(draw);
      li.append(s, x); return li;
    }));
  }
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const t = document.getElementById('t');
    if (!t.value.trim()) return;
    await lively.store.insert('notes', { body: t.value.trim(), done: false });
    t.value = ''; draw();
  };
  lively.ready.then(draw);
</script>
`);

w(`skills/${id}/SKILL.md`, `---
name: ${id}
description: 이 앱으로 세션을 열었을 때 AI 가 무엇을 하는지 한 줄로 적으세요.
---
# ${id}

이 앱 세션의 AI 가 따를 지침을 여기에 씁니다. 이 앱이 가진 도구(매니페스트 permissions.tools)만 쓸 수 있습니다.
`);

// SDK 타입 동봉 — 앱을 TS 로 쓸 때 바로 참조할 수 있게.
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  copyFileSync(path.join(here, "..", "apps", "sdk", "lively-app.d.ts"), path.join(dir, "lively-app.d.ts"));
} catch { /* SDK 타입은 선택 — 없어도 앱은 돈다 */ }

w("README.md", `# ${id}

라이블리 앱입니다. 설치는 관리자가 합니다:

    POST /api/ui/apps/install   { "source": { "kind": "git", "url": "<이 레포 주소>" } }
    (또는 { "kind": "path", "path": "<게이트웨이가 읽을 수 있는 경로>" })

설치 뒤 쓸 사람이 동의하면(앱 목록에서 열기) 세션 화면 곁칸 **[앱]** 탭에서 열립니다.

- \`lively-app.json\` — 앱 정의(권한·UI·데이터). 편집기에서 \`$schema\` 로 자동완성됩니다.
- \`ui/index.html\` — 앱 화면. \`window.lively\` 로 도구·데이터를 씁니다(주입되므로 설치 불요).
- \`skills/${id}/SKILL.md\` — 이 앱으로 연 AI 세션의 지침.
`);

console.log(`✓ ${dir} 에 앱을 만들었습니다.
  - lively-app.json (권한·UI·데이터 선언)
  - ui/index.html   (window.lively 로 도는 할 일 목록 — 그대로 동작합니다)
  - skills/${id}/SKILL.md
설치: 관리자에게 org_app_install(source={kind:'git'|'path'}) 요청.`);
