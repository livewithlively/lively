// 소개 영상을 굽는다 — film.html 을 프레임마다 seek(t) 하고 찍어 ffmpeg 로 묶는다.
//
//   node scripts/build-web.mjs                      # 아이콘 · 로고 표(public/app)를 먼저 만든다
//   cd scripts/welcome-film && npm install          # playwright-core (제품 의존성이 아니다)
//   node render.mjs                                 # → public/media/welcome-film.mp4 · welcome-film-poster.jpg
//   node render.mjs --still 3.9,12.5,26             # 그 시각의 그림만 out/still-*.png
//   node render.mjs --sheet 2                       # 2초마다 한 장씩 모은 판 out/sheet-*.jpg
//
//  필요한 것: 이 컴퓨터의 Google Chrome · ffmpeg · Pretendard 글꼴(설치돼 있어야 제품과 같은 글자가 나온다).
//  벽시계를 안 쓴다(engine.js) — 같은 소스는 언제 구워도 같은 영상이다.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const FPS = Number(opt('fps', 60));
const SCALE = Number(opt('scale', 2));          // 2 = 두 배로 그려 줄인다(움직이는 글자의 가장자리가 곱다)
const WORKERS = Number(opt('workers', 6));
const CRF = String(opt('crf', 20));
const outDir = path.join(here, 'out');
mkdirSync(outDir, { recursive: true });

execFileSync('node', [path.join(here, 'gen-assets.mjs')], { stdio: 'inherit' });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'film.html';
  const full = path.resolve(here, rel);
  if (!full.startsWith(here) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(readFileSync(full));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/film.html?render`;

//  작업자마다 브라우저를 따로 띄운다 — 한 브라우저의 여러 탭을 동시에 찍으면 뒤에 있는 탭이 프레임을 안 내어 캡처가 멈춘다.
const browsers = [];
async function openPage() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'] });
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('[film] 페이지 오류:', e.message); process.exitCode = 1; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[film] console:', m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__film, null, { timeout: 30000 });
  return page;
}
const shot = async (page, t, file) => {
  await page.evaluate((x) => window.__film.seek(x), t);
  await page.screenshot({ path: file, type: 'png' });
};

try {
  const first = await openPage();
  const duration = await first.evaluate(() => window.__film.duration);
  console.log(`[film] 길이 ${duration.toFixed(2)}s · ${FPS}fps · 배율 ${SCALE}`);

  if (opt('still')) {
    for (const s of String(opt('still')).split(',')) {
      const t = Number(s), file = path.join(outDir, `still-${t.toFixed(2).padStart(6, '0')}.png`);
      await shot(first, t, file); console.log('  ' + file);
    }
  } else if (opt('sheet')) {
    const step = Number(opt('sheet')) || 2, from = Number(opt('from', 0)), to = Number(opt('to', duration));
    const tmp = path.join(outDir, 'sheet-tmp'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
    let n = 0;
    for (let t = from; t <= to + 1e-6; t += step) await shot(first, Math.min(t, duration), path.join(tmp, `s_${String(n++).padStart(4, '0')}.png`));
    const cols = Number(opt('cols', 3)), file = path.join(outDir, `sheet-${from}-${to}.jpg`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(tmp, 's_%04d.png'), '-vf', `scale=960:-1,tile=${cols}x${Math.ceil(n / cols)}:padding=6:color=0x222a3a`, '-frames:v', '1', '-q:v', '3', file], { stdio: 'inherit' });
    rmSync(tmp, { recursive: true, force: true });
    console.log('  ' + file + ` (${n}장 · ${step}s 간격)`);
  } else {
    //  프레임을 디스크에 쌓지 않는다(두 배율 PNG 4천 장 = 수 GB) — 찍는 대로 차례를 맞춰 ffmpeg 에 흘려 넣는다.
    const total = Math.round(duration * FPS);
    const media = path.join(root, 'public/media'); mkdirSync(media, { recursive: true });
    const final = path.join(media, 'welcome-film.mp4'), poster = path.join(media, 'welcome-film-poster.jpg');
    const mp4 = path.join(outDir, 'welcome-film.partial.mp4');   // 다 구운 뒤에 옮긴다 — 굽는 동안 제품 자리의 파일이 반쪽이 되지 않게
    const vf = (SCALE !== 1 ? 'scale=1920:1080:flags=lanczos,' : '') + 'format=yuv420p';
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-profile:v', 'high', '-level', '4.2',
      '-g', String(FPS * 2), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', '-an', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg 실패 ' + code)))));
    const pages = [first, ...(await Promise.all(Array.from({ length: WORKERS - 1 }, openPage)))];
    const pending = new Map();
    let next = 0, written = 0, flushing = Promise.resolve(); const t0 = Date.now();
    const flush = () => (flushing = flushing.then(async () => {
      while (pending.has(written)) {
        const buf = pending.get(written); pending.delete(written);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        if (++written % 120 === 0) console.log(`  ${written}/${total} 프레임 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }));
    await Promise.all(pages.map(async (page) => {
      for (;;) {
        const f = next++; if (f >= total) return;
        while (f - written > 48) await new Promise((r) => setTimeout(r, 15));   // 앞 프레임이 밀리면 기다린다(메모리 상한)
        await page.evaluate((x) => window.__film.seek(x), f / FPS);
        pending.set(f, await page.screenshot({ type: 'png' }));
        flush();
      }
    }));
    await flush(); ff.stdin.end(); await ffDone;
    renameSync(mp4, final);
    //  포스터 = 첫 문장이 다 선 순간(재생 전에 보이는 그림).
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(opt('poster', 6.4)), '-i', final, '-frames:v', '1', '-q:v', '3', poster], { stdio: 'inherit' });
    console.log(`[film] ${final} — ${(statSync(final).size / 1048576).toFixed(2)}MB · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {}))); server.close();
}
