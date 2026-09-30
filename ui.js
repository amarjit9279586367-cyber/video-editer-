/* ==========================================================================
   ui.js: DOM, view transitions, 0-100% progress overlays, editor logic.
   All network calls live in api.js (ClipApi).
   ========================================================================== */
(() => {
  "use strict";

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "reel";
  const fmtTime = (s) => {
    s = Math.max(0, s || 0);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

  /* ---------- constants ---------- */
  const LANGS = [["en", "English"], ["hi", "Hindi"], ["bho", "Bhojpuri"], ["mai", "Maithili"], ["bn", "Bengali"], ["es", "Spanish"]];
  const LANG_NAME = Object.fromEntries(LANGS);
  const VOICES = [["robotic", "Robotic"], ["deep", "Deep"], ["chipmunk", "Chipmunk"], ["whisper", "Whisper"], ["telephone", "Telephone"], ["alien", "Alien"]];
  const VOICE_NAME = Object.fromEntries(VOICES);
  const QUALITY = { "720p": { label: "720p HD", mbps: 2.5 }, "1080p": { label: "1080p Full HD", mbps: 5 }, "4k": { label: "4K Ultra HD", mbps: 20 } };
  const LABEL_W = 108;

  const TOGGLES = {
    captions: {
      name: "Hormozi captions", title: "Building 3D captions", success: "Hormozi captions are on",
      stages: [[25, "Transcribing word by word"], [60, "Timing each word"], [90, "Styling in 3D"], [100, "Placing captions"]],
    },
    broll: {
      name: "AI B-roll", title: "Finding B-roll", success: "B-roll added to the timeline",
      stages: [[22, "Reading the transcript for visual cues"], [55, "Searching stock and AI footage"], [85, "Matching shots to the story"], [100, "Cutting B-roll into the timeline"]],
    },
    sfx: {
      name: "Meme sound effects", title: "Adding sound effects", success: "Meme sound effects added",
      stages: [[30, "Detecting punchlines and emphasis"], [70, "Picking sound effects"], [100, "Syncing effects to the beat"]],
    },
    studio: {
      name: "Studio sound", title: "Cleaning up the audio", success: "Studio sound applied",
      stages: [[30, "Profiling background noise"], [65, "Removing noise and echo"], [90, "Leveling voice and loudness"], [100, "Finishing the mix"]],
    },
  };

  /* ---------- state & elements ---------- */
  const defaultFx = () => ({ dubbing: null, voice: null, captions: false, broll: false, sfx: false, studio: false });
  const state = {
    step: "import",
    view: "import",
    source: null,
    genConfig: { ar: "9:16", duration: 30, count: "3" },
    clips: [],
    clip: null,
    original: null,
    fx: defaultFx(),
    data: { words: null, broll: null, sfx: null },
    thumb: null,
    busy: false,
    zoom: 1,
    lastRel: 0,
    pendingRel: 0,
    scrubbing: false,
  };

  const els = {};
  [
    "steps", "backendPill", "backendLabel", "brandHome",
    "viewImport", "viewGallery", "viewEditor",
    "tabLink", "tabUpload", "panelLink", "panelUpload", "ytInput", "ytFetch", "ytError", "dropzone", "fileInput",
    "sourceInput", "preview", "previewImg", "previewTitle", "previewMeta", "previewType", "previewChange",
    "generateBtn", "genHint", "demoNote",
    "galleryMeta", "clipGrid", "newVideoBtn",
    "editorBack", "editorTitle", "editorViral", "resetEdits",
    "frame", "editorVideo", "captionLayer", "brollCard", "brollLabel", "fxLayer", "bigPlay", "playerOverlay",
    "playBtn", "backBtn", "fwdBtn", "muteBtn", "timeLabel", "fxChips",
    "tlScroll", "tlInner", "tlZoom",
    "tools", "dubFrom", "dubTo", "dubSwap", "dubApply", "dubApplied", "voiceChips", "voiceApply", "voiceApplied", "thumbBtn",
    "exportPanel", "thumbSlot", "thumbImg", "quality", "exportEstimate", "exportBtn",
    "genOverlay", "toasts",
  ].forEach((id) => { els[id] = document.getElementById(id); });
  els.video = els.editorVideo;

  /* ---------- toasts ---------- */
  function toast(message, kind = "info", ms = 4200) {
    const t = document.createElement("div");
    t.className = "toast";
    t.dataset.kind = kind;
    t.textContent = message;
    els.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  /* ---------- progress overlay (0-100%) ---------- */
  class ProgressOverlay {
    constructor(host) {
      this.host = host;
      host.innerHTML = `
        <div class="proc-card" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="ring-bg" cx="60" cy="60" r="54"></circle>
              <circle class="ring-fg" cx="60" cy="60" r="54" pathLength="100"></circle>
            </svg>
            <div class="ring-num"><span class="pct">0</span><small>%</small></div>
          </div>
          <h3 class="proc-title"></h3>
          <p class="proc-stage"></p>
          <div class="proc-bar"><i></i></div>
          <button type="button" class="btn btn-ghost btn-sm proc-cancel">Cancel</button>
        </div>`;
      this.card = $(".proc-card", host);
      this.ring = $(".ring-fg", host);
      this.pct = $(".pct", host);
      this.titleEl = $(".proc-title", host);
      this.stageEl = $(".proc-stage", host);
      this.bar = $(".proc-bar i", host);
      this.cancelBtn = $(".proc-cancel", host);
      this.active = false;
      this.raf = 0;
      this._done = null;
      this._onCancel = null;
      this.cancelBtn.addEventListener("click", () => this._onCancel?.());
    }

    show({ title, stages, onCancel }) {
      this.stages = stages || [];
      this.custom = "";
      this.target = 0;
      this.value = 0;
      this._done = null;
      this._onCancel = onCancel;
      this.titleEl.textContent = title;
      this.host.hidden = false;
      this.active = true;
      this._render();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this._tick);
    }

    set(pct, stage) {
      this.target = Math.max(this.target, clamp(pct, 0, 100));
      if (stage) this.custom = stage;
    }

    finish() {
      this.target = 100;
      return new Promise((resolve) => { this._done = resolve; });
    }

    hide() {
      this.active = false;
      cancelAnimationFrame(this.raf);
      this.host.hidden = true;
      this._done = null;
    }

    _tick = () => {
      if (!this.active) return;
      const diff = this.target - this.value;
      this.value = Math.abs(diff) < 0.3 ? this.target : this.value + Math.max(0.3, Math.abs(diff) * 0.14) * Math.sign(diff);
      this._render();
      if (this.value >= 100 && this._done) {
        const done = this._done;
        this._done = null;
        setTimeout(() => { this.hide(); done(); }, 450);
      }
      this.raf = requestAnimationFrame(this._tick);
    };

    _render() {
      const v = clamp(this.value, 0, 100);
      this.pct.textContent = Math.floor(v);
      this.ring.style.strokeDashoffset = String(100 - v);
      this.bar.style.width = v + "%";
      this.card.setAttribute("aria-valuenow", String(Math.floor(v)));
      const auto = (this.stages.find(([max]) => v <= max) || this.stages[this.stages.length - 1] || [0, ""])[1];
      this.stageEl.textContent = this.custom || auto;
    }
  }

  const genOverlay = new ProgressOverlay(els.genOverlay);
  const playerOverlay = new ProgressOverlay(els.playerOverlay);

  function setBusy(on) {
    state.busy = on;
    $$("#tools button, #tools select, #tools input, #exportBtn, #quality, #resetEdits").forEach((el) => { el.disabled = on; });
  }

  // Runs an async task while showing a live 0-100% overlay. Never reloads the page.
  async function runJob(overlay, title, stages, task) {
    const ctrl = new AbortController();
    setBusy(true);
    overlay.show({ title, stages, onCancel: () => ctrl.abort() });
    try {
      const result = await task((pct, stage) => overlay.set(pct, stage), ctrl.signal);
      await overlay.finish();
      return { ok: true, result };
    } catch (err) {
      overlay.hide();
      if (err instanceof ClipApi.CancelError) toast("Cancelled");
      else toast(err.message || "Something went wrong. Try again.", "error", 6000);
      return { ok: false, error: err };
    } finally {
      setBusy(false);
    }
  }

  /* ---------- views & steps ---------- */
  const STEP_FOR_VIEW = { import: "import", gallery: "clips", editor: "edit" };

  function showView(name, step) {
    state.view = name;
    document.body.dataset.view = name;
    els.viewImport.hidden = name !== "import";
    els.viewGallery.hidden = name !== "gallery";
    els.viewEditor.hidden = name !== "editor";
    if (name !== "editor") els.video.pause();
    if (name !== "gallery") $$("#clipGrid video").forEach((v) => v.pause());
    setStep(step || STEP_FOR_VIEW[name]);
    window.scrollTo({ top: 0 });
    if (name === "editor") layoutTimeline();
  }

  function setStep(step) {
    state.step = step;
    $$(".step", els.steps).forEach((b) => {
      const s = b.dataset.step;
      if (s === "clips") b.disabled = !state.clips.length;
      if (s === "edit" || s === "export") b.disabled = !state.clip;
      if (s === step) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
  }

  /* ---------- Section 1: source input ---------- */
  function selectTab(which) {
    const link = which === "link";
    els.tabLink.setAttribute("aria-selected", String(link));
    els.tabUpload.setAttribute("aria-selected", String(!link));
    els.panelLink.hidden = !link;
    els.panelUpload.hidden = link;
  }

  function parseYouTubeId(raw) {
    try {
      const u = new URL(raw.trim());
      const host = u.hostname.replace(/^(www|m)\./, "");
      let id = null;
      if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
      else if (host.endsWith("youtube.com")) {
        if (u.pathname === "/watch") id = u.searchParams.get("v");
        else {
          const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]+)/);
          if (m) id = m[2];
        }
      }
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch (_) { return null; }
  }

  async function loadYouTube() {
    const raw = els.ytInput.value.trim();
    els.ytError.hidden = true;
    const id = parseYouTubeId(raw);
    if (!id) {
      els.ytError.textContent = "That doesn't look like a YouTube link. Paste a full watch, youtu.be or shorts URL.";
      els.ytError.hidden = false;
      return;
    }
    els.ytFetch.disabled = true;
    els.ytFetch.textContent = "Loading…";
    let info = {};
    try { info = await ClipApi.getVideoInfo(raw); }
    catch (err) { toast(err.message, "error", 6000); }
    els.ytFetch.disabled = false;
    els.ytFetch.textContent = "Load video";
    setSource({
      type: "youtube",
      url: raw,
      id,
      title: info.title || "YouTube video",
      meta: [info.channel, info.duration ? fmtTime(info.duration) : ""].filter(Boolean).join(", ") || "YouTube",
      thumb: info.thumbnail || `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      duration: info.duration || null,
      playbackUrl: ClipApi.DEMO_VIDEO_URL,
    });
  }

  function readVideoMeta(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      v.onerror = () => { clearTimeout(timer); reject(new Error("unreadable")); };
      v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
      v.onseeked = () => {
        clearTimeout(timer);
        let thumb = "";
        try {
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = Math.round(640 * ((v.videoHeight || 360) / (v.videoWidth || 640)));
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          thumb = c.toDataURL("image/jpeg", 0.8);
        } catch (_) { /* no thumbnail, still usable */ }
        resolve({ duration: v.duration, thumb });
      };
      v.src = url;
    });
  }

  async function loadLocalFile(file) {
    if (!file || !file.type.startsWith("video/")) {
      toast("Choose a video file (MP4, MOV or WebM).", "error");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const meta = await readVideoMeta(url);
      const mb = (file.size / 1048576).toFixed(file.size > 1e9 ? 1 : 0);
      setSource({
        type: "upload", file, title: file.name, thumb: meta.thumb, duration: meta.duration, playbackUrl: url,
        meta: `${fmtTime(meta.duration)} long, ${mb} MB`,
      });
    } catch (_) {
      URL.revokeObjectURL(url);
      toast("Couldn't read that video. Try an MP4 or WebM file.", "error");
    }
  }

  function setSource(src) {
    clearSource(true);
    state.source = src;
    els.previewImg.src = src.thumb || "";
    els.previewTitle.textContent = src.title;
    els.previewMeta.textContent = src.meta;
    els.previewType.textContent = src.type === "youtube" ? "YouTube link ready" : "Local video ready";
    els.sourceInput.hidden = true;
    els.preview.hidden = false;
    updateGenHint();
  }

  function clearSource(silent) {
    if (state.source?.type === "upload" && state.source.playbackUrl) {
      const stillUsed = state.clips.some((c) => c.videoUrl === state.source.playbackUrl);
      if (!stillUsed) URL.revokeObjectURL(state.source.playbackUrl);
    }
    state.source = null;
    els.fileInput.value = "";
    if (silent) return;
    els.preview.hidden = true;
    els.sourceInput.hidden = false;
    updateGenHint();
  }

  function getConfig() {
    return {
      ar: $('input[name="ar"]:checked').value,
      duration: Number($('input[name="dur"]:checked').value),
      count: $('input[name="count"]:checked').value,
    };
  }

  function updateGenHint() {
    const c = getConfig();
    els.generateBtn.disabled = !state.source;
    els.genHint.textContent = state.source
      ? `${c.count === "auto" ? "Auto number of" : c.count} ${c.count === "1" ? "clip" : "clips"}, ${c.duration} seconds each, ${c.ar}`
      : "Load a video to get started.";
    els.demoNote.hidden = !ClipApi.isDemo();
  }

  /* ---------- generate clips ---------- */
  async function onGenerate() {
    const src = state.source;
    if (!src) return;
    const cfg = getConfig();
    const demo = ClipApi.isDemo();
    const stages = [
      [14, src.type === "upload" ? "Uploading your video" : "Fetching the episode"],
      [34, "Transcribing speech"],
      [58, "Finding standout moments"],
      [80, "Scoring viral potential"],
      [100, "Cutting and framing clips"],
    ];

    const res = await runJob(genOverlay, "Finding your best moments", stages, async (report, signal) => {
      let videoId = src.videoId;
      if (!demo && src.type === "upload" && !videoId) {
        const up = await ClipApi.uploadVideo(src.file, (p) => report(p * 0.25), signal);
        videoId = src.videoId = up.video_id;
      }
      return ClipApi.generateClips(
        { source: src, videoId, aspectRatio: cfg.ar, clipDuration: cfg.duration, count: cfg.count },
        (p, stage) => report(demo ? p : 25 + p * 0.75, stage),
        signal
      );
    });
    if (!res.ok) return;
    if (!res.result.length) {
      toast("No clips found. Try a longer video or a shorter clip length.", "error", 6000);
      return;
    }
    state.clips = res.result.sort((a, b) => b.viralScore - a.viralScore);
    state.genConfig = cfg;
    renderGallery();
    showView("gallery");
    toast(`${state.clips.length} clips ready, best first.`, "success");
  }

  /* ---------- Section 2: gallery ---------- */
  function renderGallery() {
    const cfg = state.genConfig;
    els.clipGrid.dataset.ar = cfg.ar;
    els.clipGrid.style.setProperty("--ar", cfg.ar.replace(":", " / "));
    els.galleryMeta.textContent = `${state.clips.length} clips from “${state.source?.title || "your video"}”, ranked by viral score.`;
    els.clipGrid.innerHTML = state.clips.map((c) => {
      const tier = c.viralScore >= 90 ? "hot" : c.viralScore >= 80 ? "warm" : "cool";
      return `
        <article class="clip" data-id="${escapeHtml(c.id)}" data-tier="${tier}">
          <div class="clip-media">
            <video preload="metadata" playsinline></video>
            <button class="clip-play" type="button" aria-label="Play preview: ${escapeHtml(c.title)}">${icon("play")}</button>
            <span class="clip-dur">${fmtTime(c.end - c.start)}</span>
          </div>
          <div class="clip-info">
            <h3>${escapeHtml(c.title)}</h3>
            ${c.reason ? `<p class="why">${escapeHtml(c.reason)}</p>` : ""}
            <div class="score-row"><span>Viral Score 🔥</span><b>${c.viralScore}% Viral Chance</b></div>
            <div class="meter"><i style="width:${c.viralScore}%"></i></div>
            <button class="btn btn-primary btn-sm" type="button" data-edit>Edit in Pro</button>
          </div>
        </article>`;
    }).join("");

    $$(".clip", els.clipGrid).forEach((card) => {
      const clip = state.clips.find((c) => c.id === card.dataset.id);
      bindPreview(card, clip);
      $("[data-edit]", card).addEventListener("click", () => openEditor(clip));
    });
  }

  function bindPreview(card, clip) {
    const v = $("video", card);
    const btn = $(".clip-play", card);
    v.src = clip.videoUrl;
    v.addEventListener("loadedmetadata", () => { v.currentTime = clip.start + 0.05; });
    v.addEventListener("timeupdate", () => {
      if (v.currentTime >= clip.end) { v.pause(); v.currentTime = clip.start + 0.05; }
    });
    v.addEventListener("play", () => { card.classList.add("playing"); btn.innerHTML = icon("pause"); });
    v.addEventListener("pause", () => { card.classList.remove("playing"); btn.innerHTML = icon("play"); });
    const toggle = () => {
      if (!v.paused) return v.pause();
      $$("#clipGrid video").forEach((o) => { if (o !== v) o.pause(); });
      if (v.currentTime < clip.start || v.currentTime >= clip.end - 0.1) v.currentTime = clip.start;
      v.play().catch(() => toast("Playback was blocked. Press play again.", "error"));
    };
    btn.addEventListener("click", toggle);
    v.addEventListener("click", toggle);
  }

  /* ---------- Section 3: pro editor ---------- */
  function openEditor(clip) {
    state.clip = { ...clip };
    state.original = { ...clip };
    state.fx = defaultFx();
    state.data = { words: null, broll: null, sfx: null };
    state.thumb = null;
    state.pendingRel = 0;
    state.lastRel = 0;

    els.editorTitle.textContent = clip.title;
    els.editorViral.textContent = `${clip.viralScore}% Viral Chance 🔥`;
    els.frame.style.setProperty("--ar", state.genConfig.ar.replace(":", " / "));
    els.frame.dataset.ar = state.genConfig.ar;
    els.video.src = clip.videoUrl;
    els.video.load();
    els.thumbSlot.hidden = true;
    els.thumbImg.removeAttribute("src");

    showView("editor");
    refreshEditorUI();
    updateExportEstimate();
  }

  function clipDur() { return state.clip ? Math.max(0.1, state.clip.end - state.clip.start) : 0.1; }
  function currentRel() { return clamp(els.video.currentTime - state.clip.start, 0, clipDur()); }

  function refreshEditorUI() {
    syncToolsUI();
    renderTimeline();
    renderChips();
    syncEditor();
  }

  /* --- playback --- */
  let raf = 0;
  function loop() {
    syncEditor();
    if (!els.video.paused) raf = requestAnimationFrame(loop);
  }

  function togglePlay() {
    const v = els.video;
    if (!state.clip || state.busy) return;
    if (v.paused) {
      if (v.currentTime < state.clip.start - 0.05 || v.currentTime >= state.clip.end - 0.05) v.currentTime = state.clip.start;
      v.play().catch(() => toast("Playback was blocked. Press play again.", "error"));
    } else v.pause();
  }

  function seekRel(rel) {
    els.video.currentTime = state.clip.start + clamp(rel, 0, clipDur());
    syncEditor();
  }

  function syncEditor() {
    const c = state.clip;
    if (!c) return;
    const v = els.video;
    if (!v.paused && v.currentTime >= c.end - 0.02) {
      v.pause();
      v.currentTime = c.start;
    }
    const dur = clipDur();
    const rel = currentRel();
    els.tlInner.style.setProperty("--p", String(rel / dur));
    els.timeLabel.textContent = `${fmtTime(rel)} / ${fmtTime(dur)}`;
    updateCaptions(rel);
    updateFx(rel, !v.paused);

    if (!v.paused && !state.scrubbing && state.zoom > 1) {
      const lane = els.tlInner.clientWidth - LABEL_W;
      const x = LABEL_W + lane * (rel / dur);
      const s = els.tlScroll;
      if (x > s.scrollLeft + s.clientWidth - 24 || x < s.scrollLeft + LABEL_W) s.scrollLeft = x - s.clientWidth / 2;
    }
  }

  /* --- live effect layers --- */
  let capPage = -1;
  function updateCaptions(rel) {
    const layer = els.captionLayer;
    const words = state.data.words;
    const clear = () => { if (capPage !== -1) { layer.innerHTML = ""; capPage = -1; } };
    if (!state.fx.captions || !words?.length) return clear();

    let idx = words.findIndex((w) => rel >= w.start && rel < w.end);
    if (idx === -1) {
      idx = words.reduce((acc, w, i) => (w.start <= rel ? i : acc), -1);
      if (idx === -1 || rel - words[idx].end > 0.6) return clear();
    }
    const page = Math.floor(idx / 3);
    if (page !== capPage) {
      capPage = page;
      layer.innerHTML = words.slice(page * 3, page * 3 + 3)
        .map((w, i) => `<span class="cap-word" data-i="${page * 3 + i}">${escapeHtml(w.text)}</span>`).join(" ");
    }
    [...layer.children].forEach((n) => n.classList.toggle("on", Number(n.dataset.i) === idx));
  }

  function updateFx(rel, playing) {
    const b = state.fx.broll && state.data.broll ? state.data.broll.find((x) => rel >= x.start && rel < x.end) : null;
    els.brollCard.hidden = !b;
    if (b) els.brollLabel.textContent = `AI B-roll: ${b.label || "stock footage"}`;

    if (state.fx.sfx && state.data.sfx && playing) {
      state.data.sfx.forEach((s) => {
        if (state.lastRel < s.t && rel >= s.t && rel - s.t < 0.5) {
          const pop = document.createElement("span");
          pop.className = "sfx-pop";
          pop.textContent = s.e || "💥";
          pop.title = s.label || "";
          pop.addEventListener("animationend", () => pop.remove());
          els.fxLayer.appendChild(pop);
        }
      });
    }
    state.lastRel = rel;
  }

  /* --- mock data used when the backend doesn't return its own --- */
  const MOCK_SCRIPT = "Nobody tells you this about building something real. The first year is mostly about learning what not to do. And honestly that mistake is the best teacher you will ever get. So stop waiting for perfect and ship the thing".split(" ");
  function mockWords(dur) {
    const step = 0.42, out = [];
    for (let t = 0, i = 0; t < dur; t += step, i++) {
      out.push({ start: t, end: t + step, text: MOCK_SCRIPT[i % MOCK_SCRIPT.length].replace(/[.,]/g, "") });
    }
    return out;
  }
  function mockBroll(dur) {
    const len = Math.min(3.5, dur * 0.2);
    return [[0.2, "City skyline at dusk"], [0.55, "Team whiteboard session"], [0.8, "Stock ticker close-up"]]
      .map(([at, label]) => ({ start: dur * at, end: Math.min(dur, dur * at + len), label }));
  }
  function mockSfx(dur) {
    return [[0.12, "💥", "Vine boom"], [0.38, "📢", "Airhorn"], [0.62, "🔔", "Ding"], [0.85, "😂", "Laugh track"]]
      .map(([at, e, label]) => ({ t: dur * at, e, label }));
  }

  /* --- timeline --- */
  function waveBars(seedStr, clean) {
    let s = [...seedStr].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const phase = (s % 100) / 10;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    let out = "";
    for (let i = 0; i < 180; i++) {
      const env = 0.7 * Math.abs(Math.sin(i * 0.23 + phase)) + 0.3 * Math.abs(Math.sin(i * 0.05));
      const r = rnd();
      const h = clean ? (env > 0.28 ? Math.max(0.06, env * (0.5 + 0.5 * r)) : 0.04) : Math.max(0.22, env * (0.45 + 0.55 * r));
      out += `<i style="height:${(h * 100).toFixed(0)}%"></i>`;
    }
    return out;
  }

  function renderTimeline() {
    const c = state.clip;
    if (!c) return;
    const dur = clipDur();
    const fx = state.fx, d = state.data;
    const P = (t) => (clamp(t, 0, dur) / dur) * 100;
    const step = dur <= 20 ? 2 : dur <= 45 ? 5 : 10;
    let ticks = "";
    for (let t = 0; t <= dur + 0.01; t += step) ticks += `<span class="tick" style="left:${P(t)}%">${fmtTime(t)}</span>`;

    const row = (cls, label, ico, inner) =>
      `<div class="tl-row tl-${cls}"><div class="tl-label">${icon(ico)}<span>${label}</span></div><div class="tl-lane">${inner}</div></div>`;
    const empty = (t) => `<span class="tl-empty">${t}</span>`;

    const brollBlocks = fx.broll && d.broll
      ? d.broll.map((b) => `<div class="blk blk-broll" style="left:${P(b.start)}%;width:${P(b.end) - P(b.start)}%" title="${escapeHtml(b.label || "")}">B-roll</div>`).join("") : "";
    const sfxPins = fx.sfx && d.sfx
      ? d.sfx.map((s) => `<span class="pin" style="left:${P(s.t)}%" title="${escapeHtml(s.label || "")}">${s.e || "💥"}</span>`).join("") : "";

    let caps = "";
    if (fx.captions && d.words) {
      for (let i = 0; i < d.words.length; i += 3) {
        const g = d.words.slice(i, i + 3);
        caps += `<div class="blk blk-cap" style="left:${P(g[0].start)}%;width:${P(g[g.length - 1].end) - P(g[0].start)}%">${escapeHtml(g.map((w) => w.text).join(" "))}</div>`;
      }
    }

    const dub = fx.dubbing
      ? `<div class="blk blk-dub" style="left:0;width:100%">Dubbed ${LANG_NAME[fx.dubbing.from]} to ${LANG_NAME[fx.dubbing.to]}</div>` : "";
    const voice = fx.voice
      ? `<div class="blk blk-voice" style="left:0;width:100%">${VOICE_NAME[fx.voice]} voice</div>` : "";

    els.tlInner.innerHTML =
      `<div class="tl-row tl-ruler"><div class="tl-label"></div><div class="tl-lane">${ticks}</div></div>` +
      row("video", "Video", "film", `<div class="blk blk-video" style="left:0;width:100%">${escapeHtml(c.title)}</div>`) +
      row("fx", "B-roll · SFX", "sparkles", brollBlocks + sfxPins || empty("No B-roll or sound effects yet")) +
      row("caps", "Captions", "captions", caps || empty("Captions are off")) +
      row("dub", "Dubbing", "dub", dub || empty("Original language")) +
      row("voice", "Voice", "mic", voice || empty("Original voice")) +
      row("audio", "Audio", "wave", `<div class="wave ${fx.studio ? "clean" : ""}">${waveBars(c.id, fx.studio)}</div>`) +
      `<div class="tl-playhead" aria-hidden="true"></div>`;
    layoutTimeline();
  }

  function layoutTimeline() {
    const w = els.tlScroll.clientWidth;
    if (!w) return;
    els.tlInner.style.width = `${LABEL_W + (w - LABEL_W) * state.zoom}px`;
  }

  function seekFromPointer(e) {
    const rect = els.tlInner.getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left - LABEL_W) / (rect.width - LABEL_W), 0, 1);
    seekRel(pct * clipDur());
  }

  function renderChips() {
    const fx = state.fx, chips = [];
    if (fx.dubbing) chips.push(`Dub ${fx.dubbing.from.toUpperCase()} to ${fx.dubbing.to.toUpperCase()}`);
    if (fx.voice) chips.push(`${VOICE_NAME[fx.voice]} voice`);
    if (fx.captions) chips.push("3D captions");
    if (fx.broll) chips.push("B-roll");
    if (fx.sfx) chips.push("Meme SFX");
    if (fx.studio) chips.push("Studio sound");
    els.fxChips.innerHTML = chips.length
      ? chips.map((t) => `<span class="fx-chip">${escapeHtml(t)}</span>`).join("")
      : `<span class="fx-none">No edits yet. Pick a tool on the right.</span>`;
  }

  function syncToolsUI() {
    const fx = state.fx;
    $$(".switch", els.tools).forEach((sw) => sw.setAttribute("aria-checked", String(!!fx[sw.dataset.fx])));
    const on = { dubbing: !!fx.dubbing, voice: !!fx.voice, captions: fx.captions, "broll-sfx": fx.broll || fx.sfx, studio: fx.studio, thumbnail: !!state.thumb };
    $$(".tool", els.tools).forEach((t) => t.classList.toggle("on", !!on[t.dataset.tool]));

    els.dubApplied.hidden = !fx.dubbing;
    if (fx.dubbing) $("span", els.dubApplied).textContent = `Applied: ${LANG_NAME[fx.dubbing.from]} to ${LANG_NAME[fx.dubbing.to]}`;
    els.voiceApplied.hidden = !fx.voice;
    if (fx.voice) $("span", els.voiceApplied).textContent = `Applied: ${VOICE_NAME[fx.voice]} voice`;
  }

  /* --- running a tool --- */
  function applyResult(r) {
    if (!r) return;
    if (r.videoUrl) {
      state.pendingRel = currentRel();
      state.clip.videoUrl = r.videoUrl;
      state.clip.end = r.duration || clipDur();
      state.clip.start = 0;
      els.video.src = r.videoUrl;
      els.video.load();
    }
    if (r.words) state.data.words = r.words;
    if (r.broll) state.data.broll = r.broll;
    if (r.sfx) state.data.sfx = r.sfx;
  }

  async function runTool(tool, params, { title, stages, apply, success }) {
    if (state.busy || !state.clip) return { ok: false };
    els.video.pause();
    const res = await runJob(playerOverlay, title, stages, (report, signal) =>
      ClipApi.applyTool(state.clip.id, tool, params, report, signal));
    if (!res.ok) return res;
    applyResult(res.result);
    apply?.(res.result);
    refreshEditorUI();
    if (success) toast(success, "success");
    return res;
  }

  async function applyDubbing() {
    const from = els.dubFrom.value, to = els.dubTo.value;
    if (from === to) return toast("Pick two different languages to dub between.", "error");
    const target = LANG_NAME[to];
    await runTool("dubbing", { from, to }, {
      title: `Dubbing into ${target}`,
      stages: [[18, "Transcribing the original speech"], [42, `Translating to ${target}`], [72, "Cloning the speaker's voice"], [92, "Matching lip timing"], [100, "Mixing dubbed audio"]],
      apply: () => { state.fx.dubbing = { from, to }; },
      success: `Dubbed into ${target}`,
    });
  }

  async function applyVoice() {
    const sel = $('input[name="voice"]:checked', els.voiceChips);
    if (!sel) return toast("Choose a voice style first.", "error");
    const v = sel.value;
    await runTool("voice", { style: v }, {
      title: `Applying the ${VOICE_NAME[v]} voice`,
      stages: [[35, "Isolating the voice"], [75, "Reshaping pitch and tone"], [100, "Rendering the new voice"]],
      apply: () => { state.fx.voice = v; },
      success: `${VOICE_NAME[v]} voice applied`,
    });
  }

  async function toggleTool(key) {
    const cfg = TOGGLES[key];
    if (state.fx[key]) {
      state.fx[key] = false;
      refreshEditorUI();
      toast(`${cfg.name} removed`);
      return;
    }
    const dur = clipDur();
    await runTool(key, { enabled: true }, {
      title: cfg.title,
      stages: cfg.stages,
      apply: () => {
        state.fx[key] = true;
        if (key === "captions" && !state.data.words) state.data.words = mockWords(dur);
        if (key === "broll" && !state.data.broll) state.data.broll = mockBroll(dur);
        if (key === "sfx" && !state.data.sfx) state.data.sfx = mockSfx(dur);
      },
      success: cfg.success,
    });
  }

  function removeEffect(key) {
    state.fx[key] = null;
    if (state.clip.videoUrl !== state.original.videoUrl) {
      state.pendingRel = currentRel();
      state.clip = { ...state.original };
      els.video.src = state.clip.videoUrl;
      els.video.load();
      toast("Preview reset to the original audio. Your other edits still apply on export.");
    } else toast("Effect removed");
    refreshEditorUI();
  }

  function resetEdits() {
    if (state.busy || !state.clip) return;
    state.pendingRel = 0;
    state.clip = { ...state.original };
    state.fx = defaultFx();
    state.data = { words: null, broll: null, sfx: null };
    els.video.src = state.clip.videoUrl;
    els.video.load();
    setThumbnail(null);
    refreshEditorUI();
    toast("All edits cleared");
  }

  /* --- thumbnail --- */
  function wrapLines(g, text, maxWidth) {
    const lines = [];
    let line = "";
    text.split(" ").forEach((w) => {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    });
    if (line) lines.push(line);
    return lines;
  }

  async function renderThumbnailCanvas() {
    const ar = state.genConfig.ar;
    const [w, h] = ar === "9:16" ? [720, 1280] : ar === "1:1" ? [1080, 1080] : [1280, 720];
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const paintBackdrop = () => {
      const bg = g.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, "#2a1f4d");
      bg.addColorStop(1, "#ff5c78");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    };
    paintBackdrop();

    const v = els.video;
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
      g.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
      try { g.getImageData(0, 0, 1, 1); }
      catch (_) { paintBackdrop(); } // cross-origin footage taints the canvas; keep the gradient
    }

    const shade = g.createLinearGradient(0, h * 0.35, 0, h);
    shade.addColorStop(0, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.82)");
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);

    try { await document.fonts.load("64px Anton"); } catch (_) { /* fall back to Impact */ }
    const size = Math.round(Math.min(w, h * 0.7) * 0.115);
    g.font = `${size}px Anton, Impact, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.lineJoin = "round";
    const title = state.clip.title.toUpperCase();
    const lines = wrapLines(g, title, w * 0.86);
    const longest = title.split(" ").reduce((a, b) => (b.length > a.length ? b : a), "");
    const lineH = size * 1.12;
    let y = h - h * 0.08 - (lines.length - 1) * lineH;
    lines.forEach((line) => {
      const words = line.split(" ");
      const total = g.measureText(line).width;
      let x = (w - total) / 2;
      g.textAlign = "left";
      words.forEach((word, i) => {
        const chunk = word + (i < words.length - 1 ? " " : "");
        g.lineWidth = size * 0.16;
        g.strokeStyle = "#000";
        g.strokeText(chunk, x, y);
        g.fillStyle = word === longest ? "#ffc247" : "#fff";
        g.fillText(chunk, x, y);
        x += g.measureText(chunk).width;
      });
      y += lineH;
    });

    const badge = `${state.clip.viralScore}% VIRAL`;
    g.font = `${Math.round(size * 0.5)}px Anton, Impact, sans-serif`;
    const bw = g.measureText(badge).width + size * 0.6, bh = size * 0.85, bx = w * 0.05, by = h * 0.04;
    g.fillStyle = "#ff5c78";
    g.beginPath();
    g.roundRect(bx, by, bw, bh, bh / 2);
    g.fill();
    g.fillStyle = "#1a0d16";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(badge, bx + bw / 2, by + bh / 2 + 2);
    return c.toDataURL("image/jpeg", 0.92);
  }

  function setThumbnail(url) {
    state.thumb = url;
    els.thumbSlot.hidden = !url;
    if (url) els.thumbImg.src = url; else els.thumbImg.removeAttribute("src");
    syncToolsUI();
  }

  async function generateThumbnail() {
    const res = await runTool("thumbnail", { title: state.clip.title, aspect_ratio: state.genConfig.ar, at: currentRel() }, {
      title: "Designing your thumbnail",
      stages: [[30, "Picking the strongest frame"], [65, "Writing the headline"], [90, "Adding contrast and glow"], [100, "Rendering"]],
    });
    if (!res.ok) return;
    try {
      setThumbnail(res.result.thumbnailUrl || (await renderThumbnailCanvas()));
      toast("Thumbnail ready. It downloads with your reel.", "success");
      if (window.matchMedia("(max-width: 980px)").matches) els.exportPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (_) {
      toast("Couldn't draw the thumbnail. Try again.", "error");
    }
  }

  /* --- Section 4: export --- */
  function updateExportEstimate() {
    if (!state.clip) return;
    const q = QUALITY[els.quality.value];
    const mb = Math.max(1, Math.round((clipDur() * q.mbps) / 8));
    els.exportEstimate.textContent = `About ${mb} MB for ${Math.round(clipDur())} seconds at ${q.label}.`;
  }

  async function onExport() {
    if (state.busy || !state.clip) return;
    els.video.pause();
    setStep("export");
    const quality = els.quality.value;
    const q = QUALITY[quality];
    const res = await runJob(playerOverlay, `Rendering in ${q.label}`, [
      [20, "Applying your edits"], [55, "Rendering video frames"], [80, "Encoding audio"], [100, "Packaging your files"],
    ], (report, signal) => ClipApi.exportClip(state.clip.id, {
      quality, effects: state.fx, includeThumbnail: true, aspectRatio: state.genConfig.ar,
    }, report, signal));
    if (!res.ok) { setStep("edit"); return; }

    try {
      let thumbUrl = res.result.thumbnailUrl || state.thumb;
      if (!thumbUrl) thumbUrl = await renderThumbnailCanvas();
      setThumbnail(thumbUrl);
      const base = slug(state.clip.title);
      if (res.result.videoUrl) {
        await ClipApi.downloadFile(res.result.videoUrl, `${base}-${quality}.mp4`);
        await sleep(400);
        await ClipApi.downloadFile(thumbUrl, `${base}-thumbnail.jpg`);
        toast("Reel and thumbnail downloaded.", "success");
      } else {
        await ClipApi.downloadFile(thumbUrl, `${base}-thumbnail.jpg`);
        toast("Demo mode: thumbnail downloaded. Connect your backend to render the final MP4.", "info", 7000);
      }
    } catch (_) {
      toast("The export finished, but the download failed. Try again.", "error", 6000);
    }
  }

  /* ---------- backend status ---------- */
  async function initBackendPill() {
    const pill = els.backendPill;
    if (ClipApi.isDemo()) {
      pill.dataset.state = "demo";
      els.backendLabel.textContent = "Demo mode";
      pill.title = "Set BACKEND_URL in api.js to connect your Ngrok backend";
      return;
    }
    pill.dataset.state = "wait";
    els.backendLabel.textContent = "Connecting…";
    const ok = await ClipApi.checkHealth();
    pill.dataset.state = ok ? "ok" : "off";
    els.backendLabel.textContent = ok ? "Backend online" : "Backend offline";
    pill.title = ok ? "" : "Click to retry the connection";
  }

  /* ---------- wiring ---------- */
  function init() {
    // language + voice controls
    const opts = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("");
    els.dubFrom.innerHTML = opts;
    els.dubTo.innerHTML = opts;
    els.dubFrom.value = "en";
    els.dubTo.value = "hi";
    els.voiceChips.innerHTML = VOICES.map(([v, n], i) =>
      `<label class="chip"><input type="radio" name="voice" value="${v}" ${i === 0 ? "checked" : ""}><span>${n}</span></label>`).join("");

    // navigation
    els.brandHome.addEventListener("click", (e) => { e.preventDefault(); showView("import"); });
    els.steps.addEventListener("click", (e) => {
      const b = e.target.closest(".step");
      if (!b || b.disabled) return;
      const s = b.dataset.step;
      if (s === "import") showView("import");
      else if (s === "clips") showView("gallery");
      else if (s === "edit") showView("editor");
      else if (s === "export") {
        if (state.view !== "editor") showView("editor");
        setStep("export");
        els.exportPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    els.backendPill.addEventListener("click", initBackendPill);

    // section 1
    els.tabLink.addEventListener("click", () => selectTab("link"));
    els.tabUpload.addEventListener("click", () => selectTab("upload"));
    els.ytFetch.addEventListener("click", loadYouTube);
    els.ytInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadYouTube(); });
    els.dropzone.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", () => loadLocalFile(els.fileInput.files[0]));
    ["dragenter", "dragover"].forEach((t) => els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((t) => els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.remove("drag"); }));
    els.dropzone.addEventListener("drop", (e) => loadLocalFile(e.dataTransfer.files[0]));
    els.previewChange.addEventListener("click", () => clearSource(false));
    $$('input[name="ar"], input[name="dur"], input[name="count"]').forEach((i) => i.addEventListener("change", updateGenHint));
    els.generateBtn.addEventListener("click", onGenerate);

    // section 2
    els.newVideoBtn.addEventListener("click", () => showView("import"));

    // section 3: editor chrome
    els.editorBack.addEventListener("click", () => showView("gallery"));
    els.resetEdits.addEventListener("click", resetEdits);
    els.playBtn.addEventListener("click", togglePlay);
    els.bigPlay.addEventListener("click", togglePlay);
    els.video.addEventListener("click", togglePlay);
    els.backBtn.addEventListener("click", () => seekRel(currentRel() - 5));
    els.fwdBtn.addEventListener("click", () => seekRel(currentRel() + 5));
    els.muteBtn.addEventListener("click", () => {
      els.video.muted = !els.video.muted;
      els.muteBtn.innerHTML = icon(els.video.muted ? "mute" : "volume");
    });
    els.video.addEventListener("play", () => {
      els.frame.classList.add("playing");
      els.playBtn.innerHTML = icon("pause");
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    });
    els.video.addEventListener("pause", () => {
      els.frame.classList.remove("playing");
      els.playBtn.innerHTML = icon("play");
      syncEditor();
    });
    els.video.addEventListener("seeked", syncEditor);
    els.video.addEventListener("timeupdate", syncEditor);
    els.video.addEventListener("loadedmetadata", () => {
      if (!state.clip) return;
      els.video.currentTime = state.clip.start + state.pendingRel;
      state.pendingRel = 0;
      syncEditor();
    });
    els.video.addEventListener("error", () => { if (state.view === "editor") toast("This video couldn't be loaded.", "error"); });

    // timeline scrubbing + zoom
    els.tlInner.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tl-label") || !state.clip) return;
      state.scrubbing = true;
      els.tlInner.setPointerCapture(e.pointerId);
      seekFromPointer(e);
    });
    els.tlInner.addEventListener("pointermove", (e) => { if (state.scrubbing) seekFromPointer(e); });
    ["pointerup", "pointercancel"].forEach((t) => els.tlInner.addEventListener(t, () => { state.scrubbing = false; }));
    els.tlZoom.addEventListener("input", () => { state.zoom = Number(els.tlZoom.value); layoutTimeline(); syncEditor(); });
    window.addEventListener("resize", layoutTimeline);

    // pro tools
    els.dubApply.addEventListener("click", applyDubbing);
    els.dubSwap.addEventListener("click", () => { [els.dubFrom.value, els.dubTo.value] = [els.dubTo.value, els.dubFrom.value]; });
    els.voiceApply.addEventListener("click", applyVoice);
    els.thumbBtn.addEventListener("click", generateThumbnail);
    els.tools.addEventListener("click", (e) => {
      const sw = e.target.closest(".switch");
      if (sw && !state.busy) return toggleTool(sw.dataset.fx);
      const rm = e.target.closest("[data-remove]");
      if (rm && !state.busy) removeEffect(rm.dataset.remove);
    });

    // export
    els.quality.addEventListener("change", updateExportEstimate);
    els.exportBtn.addEventListener("click", onExport);

    // keyboard shortcuts in the editor
    document.addEventListener("keydown", (e) => {
      if (state.view !== "editor" || e.target.closest("input, select, textarea, button")) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft") seekRel(currentRel() - 1);
      else if (e.key === "ArrowRight") seekRel(currentRel() + 1);
    });

    updateGenHint();
    setStep("import");
    initBackendPill();
  }

  init();
})();
