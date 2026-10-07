#!/usr/bin/env node
/**
 * 从宣传片 HTML 里把内嵌的背景音乐抽出来，供 ffmpeg 混流。
 * 片子的音频是 Base64 data URI，没必要再单独维护一份 mp3。
 *
 * 用法: node tools/extract_audio.js <html路径> <输出mp3>
 */
const fs = require('fs');

const html = fs.readFileSync(process.argv[2], 'utf8');
const out = process.argv[3];

const m = html.match(/const BGM_B64\s*=\s*([\s\S]*?);\s*\n\s*const BGM_SRC/);
if (!m) { console.error('没找到内嵌音频（BGM_B64）'); process.exit(1); }

const parts = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
const b64 = parts.join('');
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`已抽出音频: ${out}  ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
