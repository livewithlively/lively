// 소개 영상이 쓰는 그림(선 아이콘 · 서비스 로고)을 제품의 표에서 뽑아 assets.gen.js 로 적는다.
//  그림을 영상 쪽에 따로 두지 않는다 — 제품의 아이콘이 바뀌면 다시 구울 때 영상도 따라 바뀐다.
//  먼저 `node scripts/build-web.mjs` 가 public/app 을 만들어 두어야 한다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const ICON_NAMES = ['home', 'ctx', 'apps', 'chat', 'proj', 'wiki', 'src', 'tags', 'sess', 'learn', 'builder', 'check', 'doc', 'send', 'search', 'folder', 'spark', 'plus'];
const LOGO_NAMES = ['slack', 'notion', 'github', 'google-drive'];

const { ICONS } = await import(pathToFileURL(path.join(root, 'public/app/lib/icon-paths.js')).href);
const icons = {};
for (const n of ICON_NAMES) { if (!ICONS[n]) throw new Error('아이콘 표에 없는 이름: ' + n); icons[n] = ICONS[n]; }

//  svc-logos.js 는 core.js(브라우저 전용)를 물어서 node 로 import 할 수 없다 — 표(객체 리터럴)만 잘라 읽는다.
const src = readFileSync(path.join(root, 'public/app/svc-logos.js'), 'utf8');
const i = src.indexOf('const SVC_LOGO = {');
const j = src.indexOf('\n};', i);
if (i < 0 || j < 0) throw new Error('svc-logos.js 에서 SVC_LOGO 표를 못 찾았다');
const all = new Function('return ' + src.slice(i + 'const SVC_LOGO = '.length, j + 2))();
const logos = {};
for (const n of LOGO_NAMES) { if (!all[n]) throw new Error('로고 표에 없는 이름: ' + n); logos[n] = all[n]; }

writeFileSync(path.join(here, 'assets.gen.js'),
  '// gen-assets.mjs 가 만든다 — 손으로 고치지 않는다. 출처: web/lib/icon-paths.ts · web/svc-logos.ts\n'
  + 'export const ICONS = ' + JSON.stringify(icons, null, 1) + ';\n'
  + 'export const LOGOS = ' + JSON.stringify(logos) + ';\n');
console.log('[welcome-film] assets.gen.js — 아이콘 ' + ICON_NAMES.length + ' · 로고 ' + LOGO_NAMES.length);
