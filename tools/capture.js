#!/usr/bin/env node
/**
 * 把宣传片渲染成逐帧图像序列，交给 ffmpeg 编码。
 *
 * 为什么不用"逐帧 seek + 截图"：
 *   这条片子有大量独立 tween、粒子、随机布局，逐帧 seek 很难做到像素级可复现，
 *   一旦有残余抖动，成片就会"闪"。
 *
 * 改用"慢放实拍"：
 *   画面本来就锁在音频时钟上，把音频放慢 SLOW 倍，整条时间轴就等比例放慢。
 *   用 CDP screencast 抓"实际绘制出来的每一帧"，并记录每帧的 CDP 时间戳；
 *   因为动画以 1/SLOW 的速度匀速推进，动画时间 = (时间戳 - 起点) / SLOW。
 *   于是得到一串"时间 → 帧"的对应关系，写成 concat 清单（带每帧时长），
 *   ffmpeg 就能按真实节奏还原，再用 -vsync cfr 归一化成恒定帧率。
 *   这样即使 CI 机器渲染速度不稳，也不会卡顿、不会丢帧、不会加速。
 *
 * 用法: node tools/capture.js <html路径> <输出目录> [slow] [宽] [高]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = path.resolve(process.argv[2] || 'PulsesSwap-Trailer.html');
const OUT = path.resolve(process.argv[3] || 'frames');
const SLOW = Number(process.argv[4] || 4);
const W = Number(process.argv[5] || 1920);
const H = Number(process.argv[6] || 1080);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--force-color-profile=srgb', '--font-render-hinting=none'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.goto('file://' + HTML + '?slow=' + SLOW, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const client = await page.context().newCDPSession(page);
  const frames = [];          // { file, ts }
  let n = 0;

  client.on('Page.screencastFrame', async (ev) => {
    const file = path.join(OUT, 'f' + String(n++).padStart(6, '0') + '.jpg');
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ file, ts: ev.metadata.timestamp });
    try { await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (e) {}
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 96, everyNthFrame: 1, maxWidth: W, maxHeight: H,
  });

  // 点开场门开始播放（浏览器要求用户手势才能放音频）
  await page.mouse.click(Math.round(W / 2), Math.round(H / 2));

  // 等整片放完：正常 96.6s，慢放 SLOW 倍就是 96.6*SLOW 秒，再多留 15s 余量
  const budgetMs = (96.6 * SLOW + 15) * 1000;
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < budgetMs) {
    const st = await page.evaluate(() => {
      const a = document.getElementById('bgm');
      return { time: window.__tl ? window.__tl.time() : 0, dur: window.__tl ? window.__tl.duration() : 0,
               ended: a ? a.ended : false };
    }).catch(() => null);
    if (st && (st.ended || (st.dur && st.time >= st.dur - 0.02))) { done = true; break; }
    await page.waitForTimeout(500);
  }

  await client.send('Page.stopScreencast').catch(() => {});
  await browser.close();

  // 每帧时长 = 相邻时间戳差 / SLOW（因为动画以 1/SLOW 速度推进）
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1];
    let d = next ? (next.ts - frames[i].ts) / SLOW : 1 / 60;
    d = Math.max(d, 1 / 240);        // 夹掉异常小的间隔
    d = Math.min(d, 1 / 10);         // 夹掉异常大的间隔（避免长冻结）
    lines.push(`file '${frames[i].file}'`);
    lines.push(`duration ${d.toFixed(6)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);   // concat 要求末帧重复一次
  fs.writeFileSync(path.join(OUT, 'list.txt'), lines.join('\n') + '\n');

  const span = frames.length ? (frames[frames.length - 1].ts - frames[0].ts) / SLOW : 0;
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    frames: frames.length, slow: SLOW, animationSpanSec: span,
    completed: done, errors,
  }, null, 2));
  console.log(`帧数 ${frames.length}，动画跨度 ${span.toFixed(2)}s，正常结束=${done}`);
  if (errors.length) console.log('页面错误:', errors.slice(0, 3).join(' | '));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
