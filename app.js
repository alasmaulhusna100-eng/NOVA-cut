'use strict';
/* NovaCut AI Video Studio — সম্পূর্ণ ক্লায়েন্ট-সাইড ভিডিও এডিটর (PWA) */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (t) => { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'); };
  const fmt1 = (t) => (Math.round(t * 10) / 10).toFixed(1) + 's';

  const PRESETS = [
    ['none', 'স্বাভাবিক', ''],
    ['cinematic', 'সিনেমাটিক', 'contrast(1.15) saturate(1.2) sepia(.15) hue-rotate(-8deg)'],
    ['vintage', 'ভিন্টেজ', 'sepia(.5) contrast(.95) saturate(.85) brightness(1.05)'],
    ['bw', 'সাদা-কালো', 'grayscale(1) contrast(1.1)'],
    ['vivid', 'ভিভিড', 'saturate(1.6) contrast(1.1)'],
    ['cool', 'কুল', 'hue-rotate(15deg) saturate(1.1) brightness(1.02)'],
    ['warm', 'ওয়ার্ম', 'sepia(.25) saturate(1.2) hue-rotate(-12deg)'],
    ['fade', 'ফেড', 'contrast(.85) brightness(1.1) saturate(.8)'],
  ];
  const PRESET_CSS = Object.fromEntries(PRESETS.map((p) => [p[0], p[2]]));

  const S = {
    clips: [], texts: [], selected: null,
    playhead: 0, playing: false, exporting: false,
    aspect: '16:9', exportShort: 720,
  };
  let uid = 1;
  let raf = 0, activeIdx = 0, switching = false, onEnded = null, wakeLock = null;

  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');

  /* ---------- ইউটিলিটি ---------- */
  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  const effDur = (c) => Math.max(0.05, (c.trimEnd - c.trimStart) / c.speed);
  const totalDur = () => S.clips.reduce((a, c) => a + effDur(c), 0);
  function clipOffset(i) { let a = 0; for (let k = 0; k < i; k++) a += effDur(S.clips[k]); return a; }
  function locate(t) {
    if (!S.clips.length) return null;
    let acc = 0;
    for (let i = 0; i < S.clips.length; i++) {
      const d = effDur(S.clips[i]);
      if (t < acc + d || i === S.clips.length - 1) return { i, local: clamp(t - acc, 0, d), start: acc };
      acc += d;
    }
    return null;
  }
  const sel = () => S.clips.find((c) => c.id === S.selected) || null;

  function getDims() {
    const [aw, ah] = S.aspect.split(':').map(Number);
    const short = S.exporting ? S.exportShort : 720;
    let W, H;
    if (aw >= ah) { H = short; W = Math.round(short * aw / ah); } else { W = short; H = Math.round(short * ah / aw); }
    return [W - (W % 2), H - (H % 2)];
  }

  /* ---------- অডিও গ্রাফ (এক্সপোর্টের জন্য মিক্স) ---------- */
  let audioCtx = null, destNode = null, monitorGain = null;
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      destNode = audioCtx.createMediaStreamDestination();
      monitorGain = audioCtx.createGain();
      monitorGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function attachAudio(c) {
    ensureAudio();
    if (c.gain) return;
    const src = audioCtx.createMediaElementSource(c.video);
    c.gain = audioCtx.createGain();
    c.gain.gain.value = c.volume;
    src.connect(c.gain);
    c.gain.connect(destNode);
    c.gain.connect(monitorGain);
  }

  /* ---------- ক্লিপ তৈরি ---------- */
  function whenReady(v) {
    return new Promise((res) => {
      if (v.readyState >= 2) return res();
      const done = () => { v.removeEventListener('loadeddata', done); res(); };
      v.addEventListener('loadeddata', done);
      setTimeout(res, 4000);
    });
  }
  function seekVideo(v, t) {
    return new Promise((res) => {
      if (v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.02) return res();
      let finished = false;
      const done = () => { if (finished) return; finished = true; v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      try { v.currentTime = t; } catch (e) { done(); }
      setTimeout(done, 1000);
    });
  }
  function getDuration(url) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        if (isFinite(v.duration)) return res(v.duration);
        // কিছু WebM ফাইলে duration Infinity থাকে
        v.ontimeupdate = () => { v.ontimeupdate = null; res(isFinite(v.duration) ? v.duration : 0); };
        v.currentTime = 1e101;
      };
      v.onerror = () => rej(new Error('ভিডিও লোড হয়নি'));
      v.src = url;
    });
  }
  function newVideoEl(url) {
    const v = document.createElement('video');
    v.src = url; v.preload = 'auto'; v.playsInline = true; v.setAttribute('playsinline', '');
    return v;
  }
  function makeClip(o) {
    return Object.assign({
      id: uid++, speed: 1, volume: 1, filter: 'none', fit: 'cover',
      adj: { b: 100, c: 100, s: 100 }, thumb: '', gain: null,
    }, o, { video: newVideoEl(o.blobUrl) });
  }
  async function makeThumb(c) {
    try {
      await whenReady(c.video);
      await seekVideo(c.video, Math.min(c.trimStart + 0.1, Math.max(0, c.duration - 0.05)));
      const t = document.createElement('canvas'); t.width = 120; t.height = 68;
      t.getContext('2d').drawImage(c.video, 0, 0, 120, 68);
      c.thumb = t.toDataURL('image/jpeg', 0.6);
      renderStrip();
    } catch (e) { /* থাম্বনেইল ঐচ্ছিক */ }
  }

  async function importFiles(files) {
    let added = 0;
    for (const f of files) {
      if (!f.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v|3gp)$/i.test(f.name)) { toast('ভিডিও ফাইল নয়: ' + f.name); continue; }
      const url = URL.createObjectURL(f);
      try {
        const dur = await getDuration(url);
        if (!dur) throw new Error('duration');
        const c = makeClip({ name: f.name, blob: f, blobUrl: url, duration: dur, trimStart: 0, trimEnd: dur });
        S.clips.push(c); S.selected = c.id; added++;
        makeThumb(c);
      } catch (e) { URL.revokeObjectURL(url); toast('এই ভিডিও খোলা যায়নি: ' + f.name); }
    }
    if (added) { afterStructureChange(); await seek(S.playhead); toast(added + ' টি ভিডিও যোগ হয়েছে'); }
  }

  /* ---------- রেন্ডার ---------- */
  function filterString(c) {
    const a = c.adj;
    return [PRESET_CSS[c.filter] || '', `brightness(${a.b}%)`, `contrast(${a.c}%)`, `saturate(${a.s}%)`].join(' ').trim();
  }
  function drawVideo(c, W, H) {
    const v = c.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || v.readyState < 2) return;
    const s = c.fit === 'contain' ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    ctx.filter = filterString(c);
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.filter = 'none';
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapLines(text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
      }
      out.push(line);
    }
    return out;
  }
  function drawTexts(W, H, t) {
    for (const tx of S.texts) {
      if (t < tx.start || t > tx.end) continue;
      const px = Math.round(tx.size / 100 * Math.min(W, H));
      ctx.font = `700 ${px}px "Noto Sans Bengali","Hind Siliguri",system-ui,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxW = W * 0.88, lines = wrapLines(tx.text, maxW), lh = px * 1.3, bh = lines.length * lh;
      const cy = tx.pos === 'top' ? H * 0.14 + bh / 2 : tx.pos === 'middle' ? H / 2 : H * 0.86 - bh / 2;
      if (tx.bg) {
        const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + px * 0.8;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        roundRect(W / 2 - w / 2, cy - bh / 2 - px * 0.25, w, bh + px * 0.5, px * 0.3); ctx.fill();
      }
      ctx.lineWidth = Math.max(2, px / 8); ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = tx.color;
      lines.forEach((l, i) => {
        const y = cy - bh / 2 + lh * (i + 0.5);
        ctx.strokeText(l, W / 2, y); ctx.fillText(l, W / 2, y);
      });
    }
  }
  function render() {
    const [W, H] = getDims();
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const loc = locate(S.playhead);
    if (loc) {
      const c = S.playing && S.clips[activeIdx] ? S.clips[activeIdx] : S.clips[loc.i];
      drawVideo(c, W, H);
    }
    drawTexts(W, H, S.playhead);
  }

  /* ---------- প্লেব্যাক ইঞ্জিন ---------- */
  function updatePlayBtn() { $('#btnPlay').textContent = S.playing ? '❚❚' : '▶'; }
  function updateTime() {
    const total = totalDur();
    const sc = $('#scrub');
    sc.max = String(total || 0); sc.value = String(S.playhead);
    $('#timeLbl').textContent = fmt(S.playhead) + ' / ' + fmt(total);
    if (S.exporting) $('#progBar').style.width = (total ? clamp(S.playhead / total, 0, 1) * 100 : 0) + '%';
  }
  function pauseAll() { S.clips.forEach((c) => { try { c.video.pause(); } catch (e) { /* ignore */ } }); }
  function stopPlayback() {
    S.playing = false; switching = false;
    cancelAnimationFrame(raf); pauseAll(); updatePlayBtn();
  }
  async function activate(i, local) {
    const c = S.clips[i];
    activeIdx = i;
    attachAudio(c);
    c.gain.gain.value = c.volume;
    c.video.playbackRate = c.speed;
    await seekVideo(c.video, c.trimStart + local * c.speed);
  }
  async function seek(t) {
    if (S.playing) stopPlayback();
    S.playhead = clamp(t, 0, totalDur());
    const loc = locate(S.playhead);
    if (loc) { activeIdx = loc.i; const c = S.clips[loc.i]; await seekVideo(c.video, c.trimStart + loc.local * c.speed); }
    render(); updateTime();
  }
  async function play() {
    if (!S.clips.length || S.playing) return;
    ensureAudio();
    if (S.playhead >= totalDur() - 0.05) S.playhead = 0;
    const loc = locate(S.playhead);
    S.playing = true; switching = true; updatePlayBtn();
    await activate(loc.i, loc.local);
    if (!S.playing) return;
    try { await S.clips[loc.i].video.play(); } catch (e) {
      S.playing = false; switching = false; updatePlayBtn(); toast('প্লে শুরু করা যায়নি, আবার চেষ্টা করুন'); return;
    }
    switching = false;
    tick();
  }
  async function advance() {
    switching = true;
    const n = activeIdx + 1;
    await activate(n, 0);
    if (S.playing) { try { await S.clips[n].video.play(); } catch (e) { /* ignore */ } }
    switching = false;
  }
  function finish() {
    stopPlayback();
    S.playhead = totalDur(); render(); updateTime();
    if (onEnded) { const f = onEnded; onEnded = null; f(); }
  }
  function tick() {
    if (!S.playing) return;
    if (!switching) {
      const c = S.clips[activeIdx], v = c.video;
      S.playhead = clipOffset(activeIdx) + Math.max(0, (v.currentTime - c.trimStart) / c.speed);
      if (v.currentTime >= c.trimEnd - 0.03 || v.ended) {
        v.pause();
        if (activeIdx < S.clips.length - 1) advance(); else { finish(); return; }
      }
    }
    render(); updateTime();
    raf = requestAnimationFrame(tick);
  }

  /* ---------- UI: স্ট্রিপ, প্যানেল ---------- */
  function afterStructureChange() {
    if (S.selected && !sel()) S.selected = S.clips.length ? S.clips[0].id : null;
    S.playhead = clamp(S.playhead, 0, totalDur());
    $('#empty').hidden = S.clips.length > 0;
    renderStrip(); refreshEdit(); refreshFilter(); updateTime(); render();
  }
  function renderStrip() {
    const el = $('#strip'); el.textContent = '';
    S.clips.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (c.id === S.selected ? ' sel' : '');
      b.style.minWidth = clamp(effDur(c) * 18, 92, 260) + 'px';
      const img = document.createElement('img'); img.alt = ''; if (c.thumb) img.src = c.thumb;
      const sp = document.createElement('span');
      sp.textContent = (i + 1) + '. ' + fmt1(effDur(c)) + (c.speed !== 1 ? ' · ' + c.speed + '×' : '');
      b.append(img, sp);
      b.onclick = () => { S.selected = c.id; renderStrip(); refreshEdit(); refreshFilter(); seek(clipOffset(i)); };
      el.appendChild(b);
    });
    const add = document.createElement('button');
    add.className = 'chip add'; add.textContent = '＋'; add.setAttribute('aria-label', 'ভিডিও যোগ করুন');
    add.onclick = () => $('#file').click();
    el.appendChild(add);
  }
  function refreshEdit() {
    const c = sel();
    $('#editEmpty').hidden = !!c; $('#editBody').hidden = !c;
    if (!c) return;
    const ts = $('#trimStart'), te = $('#trimEnd');
    ts.max = te.max = String(c.duration);
    ts.value = String(c.trimStart); te.value = String(c.trimEnd);
    $('#tsOut').textContent = fmt1(c.trimStart); $('#teOut').textContent = fmt1(c.trimEnd);
    $('#speed').value = String(c.speed); $('#fit').value = c.fit;
    $('#volume').value = String(c.volume); $('#volOut').textContent = Math.round(c.volume * 100) + '%';
  }
  function refreshFilter() {
    const c = sel();
    $('#filterEmpty').hidden = !!c; $('#filterBody').hidden = !c;
    if (!c) return;
    $$('.fbtn').forEach((b) => b.classList.toggle('on', b.dataset.f === c.filter));
    $('#adjB').value = c.adj.b; $('#adjC').value = c.adj.c; $('#adjS').value = c.adj.s;
    $('#bOut').textContent = c.adj.b; $('#cOut').textContent = c.adj.c; $('#sOut').textContent = c.adj.s;
  }
  function renderTexts() {
    const ul = $('#txtList'); ul.textContent = '';
    [...S.texts].sort((a, b) => a.start - b.start).forEach((tx) => {
      const li = document.createElement('li');
      const d = document.createElement('div'); d.className = 't';
      d.textContent = tx.text.replace(/\n/g, ' ');
      const sm = document.createElement('small'); sm.textContent = fmt1(tx.start) + ' → ' + fmt1(tx.end);
      d.appendChild(sm);
      const x = document.createElement('button'); x.textContent = '✕'; x.setAttribute('aria-label', 'মুছুন');
      x.onclick = () => { S.texts = S.texts.filter((t) => t !== tx); renderTexts(); render(); };
      li.append(d, x); ul.appendChild(li);
    });
  }

  /* ---------- এডিট অ্যাকশন ---------- */
  function jumpToClip(c, atEnd) {
    const i = S.clips.indexOf(c);
    seek(clipOffset(i) + (atEnd ? Math.max(0, effDur(c) - 0.05) : 0));
  }
  function bindEdit() {
    $('#trimStart').oninput = (e) => {
      const c = sel(); if (!c) return;
      c.trimStart = Math.min(+e.target.value, c.trimEnd - 0.1);
      $('#tsOut').textContent = fmt1(c.trimStart); renderStrip(); jumpToClip(c, false);
    };
    $('#trimEnd').oninput = (e) => {
      const c = sel(); if (!c) return;
      c.trimEnd = Math.max(+e.target.value, c.trimStart + 0.1);
      $('#teOut').textContent = fmt1(c.trimEnd); renderStrip(); jumpToClip(c, true);
    };
    $('#trimStart').onchange = $('#trimEnd').onchange = () => { refreshEdit(); updateTime(); };
    $('#speed').onchange = (e) => { const c = sel(); if (!c) return; c.speed = +e.target.value; c.video.playbackRate = c.speed; renderStrip(); updateTime(); };
    $('#fit').onchange = (e) => { const c = sel(); if (!c) return; c.fit = e.target.value; render(); };
    $('#volume').oninput = (e) => {
      const c = sel(); if (!c) return;
      c.volume = +e.target.value; $('#volOut').textContent = Math.round(c.volume * 100) + '%';
      if (c.gain) c.gain.gain.value = c.volume;
    };
    $('#btnSplit').onclick = () => {
      const loc = locate(S.playhead); if (!loc) return;
      const c = S.clips[loc.i], at = c.trimStart + loc.local * c.speed;
      if (at <= c.trimStart + 0.1 || at >= c.trimEnd - 0.1) return toast('প্লেহেড ক্লিপের একদম শুরু/শেষে — মাঝামাঝি কোথাও রাখুন');
      const n = cloneClip(c); n.trimStart = at; c.trimEnd = at;
      S.clips.splice(loc.i + 1, 0, n); S.selected = n.id;
      afterStructureChange(); toast('ক্লিপ দুই ভাগ হয়েছে');
    };
    $('#btnDup').onclick = () => {
      const c = sel(); if (!c) return;
      const n = cloneClip(c); S.clips.splice(S.clips.indexOf(c) + 1, 0, n); S.selected = n.id;
      afterStructureChange(); toast('ডুপ্লিকেট হয়েছে');
    };
    $('#btnDel').onclick = () => {
      const c = sel(); if (!c) return;
      stopPlayback();
      const i = S.clips.indexOf(c); S.clips.splice(i, 1);
      disposeIfUnused(c);
      S.selected = S.clips.length ? S.clips[Math.min(i, S.clips.length - 1)].id : null;
      afterStructureChange(); seek(S.playhead);
    };
    $('#btnLeft').onclick = () => moveClip(-1);
    $('#btnRight').onclick = () => moveClip(1);
  }
  function moveClip(d) {
    const c = sel(); if (!c) return;
    const i = S.clips.indexOf(c), j = i + d;
    if (j < 0 || j >= S.clips.length) return;
    S.clips.splice(i, 1); S.clips.splice(j, 0, c);
    renderStrip(); updateTime(); seek(clipOffset(j));
  }
  function cloneClip(c) {
    const n = makeClip({ name: c.name, blob: c.blob, blobUrl: c.blobUrl, duration: c.duration, trimStart: c.trimStart, trimEnd: c.trimEnd });
    Object.assign(n, { speed: c.speed, volume: c.volume, filter: c.filter, fit: c.fit, adj: { ...c.adj }, thumb: c.thumb });
    return n;
  }
  function disposeIfUnused(c) {
    if (!S.clips.some((o) => o.blobUrl === c.blobUrl)) URL.revokeObjectURL(c.blobUrl);
    c.video.removeAttribute('src'); c.video.load();
  }

  /* ---------- ফিল্টার ---------- */
  function buildFilters() {
    const g = $('#filterGrid');
    PRESETS.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.className = 'fbtn'; b.dataset.f = id; b.textContent = label;
      b.onclick = () => { const c = sel(); if (!c) return; c.filter = id; refreshFilter(); render(); };
      g.appendChild(b);
    });
    const bind = (id, key, out) => {
      $(id).oninput = (e) => { const c = sel(); if (!c) return; c.adj[key] = +e.target.value; $(out).textContent = e.target.value; render(); };
    };
    bind('#adjB', 'b', '#bOut'); bind('#adjC', 'c', '#cOut'); bind('#adjS', 's', '#sOut');
    $('#btnApplyAll').onclick = () => {
      const c = sel(); if (!c) return;
      S.clips.forEach((o) => { o.filter = c.filter; o.adj = { ...c.adj }; });
      render(); toast('সব ক্লিপে প্রয়োগ হয়েছে');
    };
  }

  /* ---------- টেক্সট / ক্যাপশন ---------- */
  function bindText() {
    $('#txtSize').oninput = (e) => { $('#txtSizeOut').textContent = e.target.value; };
    $('#btnAddText').onclick = () => {
      const text = $('#txtInput').value.trim();
      if (!text) return toast('আগে কিছু লিখুন');
      const total = totalDur();
      let start = parseFloat($('#txtStart').value), end = parseFloat($('#txtEnd').value);
      if (!isFinite(start)) start = S.playhead;
      if (!isFinite(end) || end <= start) end = start + 3;
      if (total && start >= total) return toast('শুরুর সময় ভিডিওর দৈর্ঘ্যের বাইরে');
      S.texts.push({
        text, start, end: total ? Math.min(end, total) : end,
        size: +$('#txtSize').value, color: $('#txtColor').value, pos: $('#txtPos').value, bg: $('#txtBg').checked,
      });
      $('#txtInput').value = '';
      $('#txtStart').value = (+($('#txtEnd').value) || end).toFixed(1);
      $('#txtEnd').value = ((+$('#txtStart').value) + 3).toFixed(1);
      renderTexts(); render();
    };
  }
  function scriptToCaptions() {
    const raw = $('#scriptBox').value.trim();
    const total = totalDur();
    if (!raw) return toast('আগে স্ক্রিপ্ট লিখুন');
    if (!total) return toast('আগে ভিডিও যোগ করুন');
    const parts = raw.split(/\n+|(?<=[।.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const weights = parts.map((p) => Math.max(8, p.length));
    const sum = weights.reduce((a, b) => a + b, 0);
    S.texts = S.texts.filter((t) => !t.auto);
    let t0 = 0;
    parts.forEach((p, i) => {
      const d = total * weights[i] / sum;
      S.texts.push({ text: p, start: t0, end: Math.min(total, t0 + d), size: +$('#txtSize').value, color: $('#txtColor').value, pos: $('#txtPos').value, bg: true, auto: true });
      t0 += d;
    });
    renderTexts(); render(); toast(parts.length + ' টি ক্যাপশন তৈরি হয়েছে');
  }
  const srtTime = (t) => {
    const ms = Math.round((t % 1) * 1000), s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
  };
  function downloadSrt() {
    if (!S.texts.length) return toast('কোনো টেক্সট/ক্যাপশন নেই');
    const body = [...S.texts].sort((a, b) => a.start - b.start)
      .map((t, i) => `${i + 1}\n${srtTime(t.start)} --> ${srtTime(t.end)}\n${t.text}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'novacut-captions.srt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------- AI: নীরবতা কাটা (অফলাইন অডিও বিশ্লেষণ) ---------- */
  async function removeSilence() {
    const c = sel(); if (!c) return toast('আগে একটি ক্লিপ সিলেক্ট করুন');
    if (c.blob.size > 300 * 1024 * 1024) return toast('ফাইল অনেক বড় (৩০০MB+), ছোট ক্লিপে চেষ্টা করুন');
    stopPlayback();
    const btn = $('#btnSilence'); btn.disabled = true; toast('অডিও বিশ্লেষণ হচ্ছে… একটু অপেক্ষা করুন', 8000);
    try {
      ensureAudio();
      const audio = await audioCtx.decodeAudioData(await c.blob.arrayBuffer());
      const data = audio.getChannelData(0), sr = audio.sampleRate;
      const win = Math.floor(sr * 0.05), thr = Math.pow(10, +$('#silThr').value / 20);
      const minSilence = 0.4, segs = [];
      let inSeg = false, segStart = 0, lastLoud = 0, silent = 0;
      for (let w = 0; w * win < data.length; w++) {
        let sum = 0; const end = Math.min(data.length, (w + 1) * win);
        for (let k = w * win; k < end; k++) sum += data[k] * data[k];
        const rms = Math.sqrt(sum / Math.max(1, end - w * win)), t = w * 0.05;
        if (rms > thr) {
          if (!inSeg) { inSeg = true; segStart = t; }
          silent = 0; lastLoud = t + 0.05;
        } else if (inSeg) {
          silent += 0.05;
          if (silent >= minSilence) { segs.push([segStart, lastLoud]); inSeg = false; }
        }
      }
      if (inSeg) segs.push([segStart, lastLoud]);
      const out = segs
        .map(([a, b]) => [Math.max(c.trimStart, a - 0.1), Math.min(c.trimEnd, b + 0.15)])
        .filter(([a, b]) => b - a >= 0.3);
      if (!out.length) return toast('কোনো কথা/শব্দ পাওয়া যায়নি — সংবেদনশীলতা বাড়িয়ে দেখুন');
      const kept = out.reduce((s, [a, b]) => s + (b - a), 0), orig = c.trimEnd - c.trimStart;
      if (out.length === 1 && orig - kept < 0.3) return toast('কাটার মতো নীরব অংশ পাওয়া যায়নি');
      const idx = S.clips.indexOf(c);
      const repl = out.map(([a, b]) => { const n = cloneClip(c); n.trimStart = a; n.trimEnd = b; return n; });
      S.clips.splice(idx, 1, ...repl);
      S.selected = repl[0].id;
      afterStructureChange(); seek(clipOffset(idx));
      toast(`${out.length} টি অংশ রাখা হয়েছে, ${fmt1(orig - kept)} নীরবতা বাদ গেছে`, 4000);
    } catch (e) {
      toast('এই ফাইলের অডিও পড়া যায়নি (অডিও ট্র্যাক নেই বা ফরম্যাট অসমর্থিত)', 4000);
    } finally { btn.disabled = false; }
  }

  /* ---------- AI: স্ক্রিপ্ট লেখক (ইউজারের নিজস্ব API) ---------- */
  function loadAiSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('novacut-ai') || '{}');
      if (s.base) $('#aiBase').value = s.base;
      if (s.model) $('#aiModel').value = s.model;
      if (s.key) $('#aiKey').value = s.key;
    } catch (e) { /* ignore */ }
  }
  function saveAiSettings() {
    try {
      localStorage.setItem('novacut-ai', JSON.stringify({ base: $('#aiBase').value.trim(), model: $('#aiModel').value.trim(), key: $('#aiKey').value }));
    } catch (e) { /* ignore */ }
  }
  async function aiScript() {
    const base = $('#aiBase').value.trim().replace(/\/+$/, ''), key = $('#aiKey').value.trim(), model = $('#aiModel').value.trim();
    const topic = $('#aiTopic').value.trim();
    if (!topic) return toast('টপিক লিখুন');
    if (!key) { $('.adv').open = true; return toast('API Key দিন (API সেটিংস খুলে)'); }
    saveAiSettings();
    const btn = $('#btnAiScript'); btn.disabled = true; toast('AI স্ক্রিপ্ট লিখছে…', 20000);
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model, temperature: 0.8,
          messages: [
            { role: 'system', content: 'You write short, punchy voice-over scripts for short videos. Output ONLY the script, one short sentence per line, no numbering, no headings.' },
            { role: 'user', content: `Topic: ${topic}\nLanguage: ${$('#aiLang').value}\nTarget length: about ${+$('#aiSec').value || 30} seconds of speech.` },
          ],
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) throw new Error('empty');
      $('#scriptBox').value = text.trim();
      toast('স্ক্রিপ্ট তৈরি — এখন "ক্যাপশন তৈরি করুন" চাপুন', 4000);
    } catch (e) {
      toast('AI রিকোয়েস্ট ব্যর্থ: ' + e.message + ' (URL/Key/Model ঠিক আছে কি দেখুন)', 5000);
    } finally { btn.disabled = false; }
  }

  /* ---------- এক্সপোর্ট ---------- */
  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }
  async function doExport() {
    if (!S.clips.length) return toast('আগে ভিডিও যোগ করুন');
    if (!window.MediaRecorder || !canvas.captureStream) return toast('এই ব্রাউজারে এক্সপোর্ট সাপোর্ট নেই — Chrome ব্যবহার করুন');
    stopPlayback(); ensureAudio();
    S.exporting = true; S.exportShort = +$('#res').value;
    const btn = $('#btnExport'); btn.disabled = true;
    $('#progWrap').hidden = false; $('#progBar').style.width = '0%'; $('#result').hidden = true;
    monitorGain.gain.value = 0;
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }

    const mime = pickMime();
    const stream = new MediaStream([
      ...canvas.captureStream(+$('#fps').value).getVideoTracks(),
      ...destNode.stream.getAudioTracks(),
    ]);
    const chunks = [];
    const rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: S.exportShort >= 1080 ? 8e6 : 5e6 }, mime ? { mimeType: mime } : {}));
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    S.playhead = 0; render();
    const ended = new Promise((res) => { onEnded = res; });
    rec.start(500);
    play();
    await ended;
    await new Promise((r) => setTimeout(r, 400));
    rec.stop(); await stopped;

    S.exporting = false; monitorGain.gain.value = 1;
    try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (e) { /* ignore */ }
    btn.disabled = false; $('#progBar').style.width = '100%';
    render();

    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) return toast('এক্সপোর্ট ব্যর্থ হয়েছে, আবার চেষ্টা করুন');
    const url = URL.createObjectURL(blob);
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    $('#resultVideo').src = url;
    const a = $('#dlLink'); a.href = url; a.download = 'novacut-' + Date.now() + '.' + ext;
    $('#result').hidden = false;
    toast('এক্সপোর্ট সম্পন্ন ✔');
  }

  /* ---------- গ্যালারি থেকে শেয়ার করা ভিডিও ---------- */
  async function loadShared() {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open('novacut-shared');
      const keys = await cache.keys(), files = [];
      for (const k of keys) {
        const r = await cache.match(k);
        const blob = await r.blob();
        files.push(new File([blob], decodeURIComponent(r.headers.get('X-Name') || 'shared.mp4'), { type: blob.type }));
        await cache.delete(k);
      }
      history.replaceState(null, '', location.pathname);
      if (files.length) importFiles(files);
    } catch (e) { /* ignore */ }
  }

  /* ---------- ইভেন্ট বাইন্ডিং ---------- */
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
    if (name === 'text') { $('#txtStart').value = S.playhead.toFixed(1); $('#txtEnd').value = (S.playhead + 3).toFixed(1); }
  }

  function init() {
    buildFilters(); bindEdit(); bindText(); loadAiSettings(); renderStrip(); render();

    $$('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
    $('#empty').onclick = $('#btnAdd').onclick = () => $('#file').click();
    $('#file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f); };
    $('#btnClear').onclick = () => {
      if (!S.clips.length || !confirm('সব ক্লিপ ও টেক্সট মুছে ফেলবেন?')) return;
      stopPlayback(); const old = S.clips; S.clips = []; S.texts = []; S.selected = null; S.playhead = 0;
      old.forEach(disposeIfUnused); renderTexts(); afterStructureChange();
    };
    $('#btnPlay').onclick = () => { if (S.exporting) return; if (S.playing) stopPlayback(); else play(); };
    $('#scrub').oninput = (e) => { if (!S.exporting) seek(+e.target.value); };
    $('#aspect').onchange = (e) => { S.aspect = e.target.value; render(); };
    $('#silThr').oninput = (e) => { $('#silOut').textContent = '−' + Math.abs(e.target.value) + ' dB'; };
    $('#btnSilence').onclick = removeSilence;
    $('#btnScriptCaps').onclick = scriptToCaptions;
    $('#btnAiScript').onclick = aiScript;
    $('#btnExport').onclick = doExport;
    $('#btnSrt').onclick = downloadSrt;
    ['#aiBase', '#aiModel', '#aiKey'].forEach((s) => { $(s).onchange = saveAiSettings; });

    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
    $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; };
    window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
    window.addEventListener('beforeunload', (e) => { if (S.clips.length) { e.preventDefault(); e.returnValue = ''; } });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
    }
    if (/[?&]shared=/.test(location.search)) loadShared();
  }
  init();
})();
