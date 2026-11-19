#!/usr/bin/env node
// 둘러보기 영상에 내레이션을 입힌다 — 자막 문장을 macOS 음성(say)으로 읽어 자막이 뜨는 자리에 놓고, 구운 mp4 에 소리 길로 넣는다.
//  자막 시간표는 render.mjs 가 굽을 때 남긴 out/<이름>-caps.json 이다(자막 문장 · 뜨는 시각 · 지는 시각).
//  제품은 영상을 **음소거로 자동 재생**하고 사람이 [소리 켜기] 를 누를 때만 들린다(web/v2/welcome-film.ts).
//   node narrate.mjs                          # out/welcome-tour.mp4 에 입힌다
//   node narrate.mjs --dest media             # public/media/welcome-tour.mp4 에 입힌다
//   node narrate.mjs --voice Yuna --rate 190
import { readFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const NAME = opt('name', 'welcome-tour');
const VOICE = opt('voice', 'Yuna');
const RATE = opt('rate', '');
const outDir = path.join(here, 'out');
const mp4 = opt('dest', 'out') === 'media' ? path.join(root, 'public/media', NAME + '.mp4') : path.join(outDir, NAME + '.mp4');
const capsFile = path.join(outDir, NAME + '-caps.json');
if (!existsSync(capsFile)) throw new Error('자막 시간표가 없다 — 먼저 render.mjs 로 구워라: ' + capsFile);
if (!existsSync(mp4)) throw new Error('영상이 없다: ' + mp4);
const { duration, caps } = JSON.parse(readFileSync(capsFile, 'utf8'));

const vo = path.join(outDir, 'vo'); rmSync(vo, { recursive: true, force: true }); mkdirSync(vo, { recursive: true });
const len = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

//  자막이 뜨고 0.2초 뒤에 읽기 시작한다. 다음 자막이 뜨기 전에 끝나야 한다 — 넘치면 그만큼만 빠르게 읽는다(최대 1.25배).
const LEAD = 0.2, GAP = 0.15, MAX_TEMPO = 1.25;
const sorted = caps.slice().sort((a, b) => a.t0 - b.t0);
const clips = sorted.map((c, i) => {
  const f = path.join(vo, c.id + '.aiff');
  execFileSync('say', ['-v', VOICE, ...(RATE ? ['-r', RATE] : []), '-o', f, c.text]);
  const d = len(f);
  const at = c.t0 + LEAD;
  const limit = (i + 1 < sorted.length ? sorted[i + 1].t0 : duration) - GAP - at;
  const tempo = d > limit ? d / limit : 1;
  if (tempo > MAX_TEMPO) throw new Error(`«${c.text}» 가 자리에 안 들어간다 — ${d.toFixed(2)}s / 자리 ${limit.toFixed(2)}s. 시간표를 늘려라.`);
  console.log(`  ${c.id.padEnd(4)} ${at.toFixed(2).padStart(6)}s  ${d.toFixed(2)}s${tempo > 1 ? `  ×${tempo.toFixed(2)}` : ''}  ${c.text}`);
  return { f, at, tempo };
});

//  하나로 섞는다 — 자리마다 늦추고(adelay), 모두 더한다. 말소리라 고르게(약한 압축) · 끝은 영상 길이에 맞춘다.
const m4a = path.join(outDir, NAME + '-vo.m4a');
const inputs = clips.flatMap((c) => ['-i', c.f]);
const chains = clips.map((c, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono${c.tempo > 1 ? `,atempo=${c.tempo.toFixed(4)}` : ''},adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`);
const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,volume=1.6,apad,atrim=0:${duration.toFixed(3)},aformat=channel_layouts=stereo[out]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...chains, mix].join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', m4a], { stdio: 'inherit' });

//  영상에 넣는다 — 그림은 다시 굽지 않는다(-c:v copy). 원래 소리 길이 있으면 바꾼다.
const tmp = mp4.replace(/\.mp4$/, '.vo-partial.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', m4a, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', tmp], { stdio: 'inherit' });
renameSync(tmp, mp4);
console.log(`[narrate] ${mp4} — 내레이션 ${clips.length}줄 · ${VOICE}`);
