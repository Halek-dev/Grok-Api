/* ==========================================================================
   Imagine studio — client
   Vanilla JS, no framework, no build step.

   Prices are never hardcoded here. They arrive from /api/config and every
   estimate is recomputed from that object. If a model has no price entry the UI
   says the cost is unknown rather than showing a wrong one.
   ========================================================================== */
'use strict';

(function () {

  // -------------------------------------------------------------------------
  // Constants that are UI copy, not money and not API behaviour
  // -------------------------------------------------------------------------

  // Shape values are the aspect_ratio enum the API accepts. Labels are the ratio
  // itself — the user never sees an API enum name.
  var SHAPES = [
    { value: 'auto',  label: 'Auto' },
    { value: '1:1',   label: '1:1' },
    { value: '16:9',  label: '16:9' },
    { value: '9:16',  label: '9:16' },
    { value: '4:3',   label: '4:3' },
    { value: '3:4',   label: '3:4' },
    { value: '3:2',   label: '3:2' },
    { value: '2:3',   label: '2:3' },
    { value: '2:1',   label: '2:1' },
    { value: '21:9',  label: '21:9' }
  ];

  var RESOLUTIONS = ['1k', '2k'];

  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var STORE_KEY = 'imagine-studio/settings';
  var SPEND_KEY = 'imagine-studio/spend';
  var PASS_KEY = 'imagine-studio/password';

  // -------------------------------------------------------------------------
  // Element handles
  // -------------------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var gate = $('gate'), gateForm = $('gate-form'), gatePassword = $('gate-password'),
      gateError = $('gate-error'), gateSubmit = $('gate-submit'),
      gateToggle = $('gate-password-toggle');
  var app = $('app');
  var userName = $('user-name'), userNameMobile = $('user-name-mobile'), mobileWho = $('mobile-who');
  var spendAmount = $('spend-amount'), spendRuns = $('spend-runs');
  var rail = $('rail'), modeswitch = $('modeswitch');
  var tabGenerate = $('tab-generate'), tabEdit = $('tab-edit');
  var promptEl = $('prompt'), promptLabel = $('prompt-label'), promptCount = $('prompt-count'),
      promptGuidance = $('prompt-guidance');
  var modelEl = $('model'), modelNote = $('model-note'), retirementEl = $('retirement');
  var qualityField = $('quality-field'), qualityEl = $('quality'), qualityNote = $('quality-note');
  var shapeSize = $('shape-size'), shapeEl = $('shape'), sizeEl = $('size');
  var framesField = $('frames-field'), framesEl = $('frames'), framesValue = $('frames-value');
  var sourceField = $('source-field'), dropzone = $('dropzone'), fileInput = $('file-input'),
      dropzoneTitle = $('dropzone-title'), dropzoneBody = $('dropzone-body'),
      sourceList = $('source-list');
  var actionBtn = $('action'), actionReason = $('action-reason'),
      costLine = $('cost-line'), costLabel = $('cost-label'), costValue = $('cost-value');
  var runError = $('run-error');
  var cancelRow = $('cancel-row'), cancelBtn = $('cancel-run');
  var results = $('results'), empty = $('empty');
  var lightbox = $('lightbox'), lbCount = $('lb-count'), lbMeta = $('lb-meta'),
      lbImage = $('lb-image'), lbPrompt = $('lb-prompt'), lbTime = $('lb-time'),
      lbDownload = $('lb-download'), lbEdit = $('lb-edit'), lbClose = $('lb-close');

  // -------------------------------------------------------------------------
  // State. Runs and their images live in memory for the session only — nothing
  // is stored server-side, so a refresh empties the sheet.
  // -------------------------------------------------------------------------
  var config = null;
  var password = '';
  var state = {
    mode: 'generate',
    model: '',
    quality: 'auto',
    shape: '9:16',
    resolution: '1k',
    frames: 1,
    name: '',
    sources: [] // [{ dataUri, name, size, width, height }] — one edit per photo
  };
  var runs = [];
  var busy = false;
  var rateLimitUntil = 0;
  var rateLimitTimer = null;
  var runTimer = null;
  var lightboxState = null;
  var activeRun = null;
  var retiredFallback = null;
  var lastFocused = null;
  var seq = 0;

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  function money(n) {
    return '$' + Number(n).toFixed(2);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clockTime(date) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function duration(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function bytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // xAI does not return one format: 1k comes back as JPEG, 2k as PNG, and that
  // is not something the request states. Read it off the bytes rather than
  // assuming, or the data URI lies about its type and downloads get the wrong
  // extension.
  function sniffImage(b64) {
    var head = '';
    try {
      head = atob(b64.slice(0, 16));
    } catch (err) {
      head = '';
    }
    if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
    if (head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8) return { mime: 'image/jpeg', ext: 'jpg' };
    if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    return { mime: 'image/png', ext: 'png' };
  }

  function wordCount(text) {
    var t = String(text || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function readStore(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* private window, or storage full — the app still works, it just forgets */
    }
  }

  // -------------------------------------------------------------------------
  // Shape and size. Sizes are shown as pixels, never as an API enum.
  //
  // These are xAI's real output sizes, measured one image per combination on
  // 4 September 2026. They are not derivable from a formula: 1:1 exactly doubles
  // between 1k and 2k while 16:9 scales by 2.2, and the ratios are held exactly
  // rather than a pixel budget. If xAI changes what it returns, re-measure —
  // do not try to compute these.
  // -------------------------------------------------------------------------
  var SIZE_TABLE = {
    '1:1':  { '1k': [1024, 1024], '2k': [2048, 2048] },
    '16:9': { '1k': [1280,  720], '2k': [2816, 1584] },
    '9:16': { '1k': [ 720, 1280], '2k': [1584, 2816] },
    '4:3':  { '1k': [1152,  864], '2k': [2368, 1776] },
    '3:4':  { '1k': [ 864, 1152], '2k': [1776, 2368] },
    '3:2':  { '1k': [1248,  832], '2k': [2496, 1664] },
    '2:3':  { '1k': [ 832, 1248], '2k': [1664, 2496] },
    '2:1':  { '1k': [1408,  704], '2k': [2912, 1456] },
    '21:9': { '1k': [1568,  672], '2k': [3136, 1344] }
  };

  function dimsFor(shape, res) {
    var row = SIZE_TABLE[shape];
    return row && row[res] ? { w: row[res][0], h: row[res][1] } : null;
  }

  function sizeLabel(shape, res) {
    var d = dimsFor(shape, res);
    if (d) return d.w + '×' + d.h;
    // On "auto" the model picks the shape, so the pixels depend on what it
    // chooses. Quote the budget it works to instead of inventing a pair.
    return res === '2k' ? '≈4 MP' : '≈1 MP';
  }

  // Null for "auto": the model chooses the frame, so guessing a ratio would only
  // make the grid jump when the real image arrives.
  function aspectRatioCss(shape) {
    if (!shape || shape === 'auto') return null;
    var parts = String(shape).split(':');
    return (Number(parts[0]) || 1) + ' / ' + (Number(parts[1]) || 1);
  }

  // -------------------------------------------------------------------------
  // Cost. Mirrors the server, from the same price object.
  // -------------------------------------------------------------------------
  function priceEntry(model) {
    return config && config.prices ? config.prices[model] : null;
  }

  function acceptsQuality(model) {
    return Boolean(config && config.qualityModels && config.qualityModels.indexOf(model) !== -1);
  }

  function tierFor(model, quality, mode) {
    var p = priceEntry(model);
    if (!p || !p.tiers) return null;
    if (p.tiers['default']) return p.tiers['default'];
    if (!p.autoQuality) return null;
    var q = (!quality || quality === 'auto')
      ? p.autoQuality[mode === 'edit' ? 'edit' : 'generate']
      : quality;
    return p.tiers[q] || null;
  }

  // Per-image output price. Returns null when we genuinely do not know.
  function perImage(model, quality, resolution, mode) {
    var tier = tierFor(model, quality, mode);
    if (!tier) return null;
    var res = mode === 'edit' ? '1k' : resolution;
    var v = tier[res];
    return typeof v === 'number' ? v : null;
  }

  function estimate() {
    var mode = state.mode;
    var per = perImage(state.model, state.quality, state.resolution, mode);
    if (per == null) return null;
    var p = priceEntry(state.model);
    var count = mode === 'edit' ? Math.max(1, state.sources.length) : state.frames;
    // input is charged once per source image, so an edit of N photos pays it N times.
    var input = mode === 'edit' && p && typeof p.input === 'number' ? p.input : 0;
    return { total: (per + input) * count, per: per, count: count, input: input };
  }

  // -------------------------------------------------------------------------
  // Spend — this browser's runs today, reset at local midnight.
  // -------------------------------------------------------------------------
  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function loadSpend() {
    var s = readStore(SPEND_KEY);
    if (!s || s.date !== todayStamp()) return { date: todayStamp(), amount: 0, runs: 0 };
    return s;
  }

  var spend = loadSpend();

  function renderSpend() {
    spend = spend.date === todayStamp() ? spend : { date: todayStamp(), amount: 0, runs: 0 };
    spendAmount.textContent = money(spend.amount);
    if (spend.runs > 0) {
      spendRuns.hidden = false;
      spendRuns.textContent = '· ' + spend.runs + (spend.runs === 1 ? ' run' : ' runs');
    } else {
      spendRuns.hidden = true;
    }
  }

  // Spend increments only on a completed run, never on a failure.
  function addSpend(amount, isNewRun) {
    if (typeof amount !== 'number' || !isFinite(amount)) return;
    spend.amount = Math.round((spend.amount + amount) * 1e6) / 1e6;
    if (isNewRun) spend.runs += 1;
    writeStore(SPEND_KEY, spend);
    renderSpend();
  }

  // -------------------------------------------------------------------------
  // 09 Retirement. Computed from the local date against the model's retirement
  // instant and re-read on load and on window focus — never hardcoded.
  // -------------------------------------------------------------------------
  function retirementFor(model) {
    var p = priceEntry(model);
    if (!p || !p.retiresAt) return null;
    var at = Date.parse(p.retiresAt);
    if (isNaN(at)) return null;
    var now = Date.now();
    var msLeft = at - now;
    var successor = null;
    var prices = config.prices;
    for (var id in prices) {
      if (id !== model && !prices[id].retiresAt) { successor = prices[id]; break; }
    }
    return {
      at: at,
      msLeft: msLeft,
      retired: msLeft <= 0,
      hours: Math.max(0, Math.ceil(msLeft / 3600000)),
      days: Math.max(0, Math.ceil(msLeft / 86400000)),
      dateLabel: new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      label: p.label,
      successor: successor ? successor.label : 'another model'
    };
  }

  function renderRetirement() {
    retirementEl.innerHTML = '';
    // The retired model cannot be selected, so its notice is shown against
    // whatever replaced it until the user picks a model themselves.
    var r = retirementFor(state.model) || (retiredFallback ? retirementFor(retiredFallback) : null);
    if (!r) { retirementEl.hidden = true; return; }
    retirementEl.hidden = false;

    var box = el('div', 'notice ' + (r.retired ? 'notice--danger' : 'notice--warning'));
    var title = el('div', 'notice__title num');
    var body = el('div', 'notice__body');

    if (r.retired) {
      title.textContent = 'Retired on ' + r.dateLabel;
      body.textContent = r.label + ' no longer accepts requests. Pick ' + r.successor +
        ' to generate. Existing images stay downloadable.';
    } else if (r.msLeft <= 48 * 3600000) {
      title.textContent = 'Retires in ' + r.hours + (r.hours === 1 ? ' hour' : ' hours');
      body.textContent = r.label + ' stops working today at midnight UTC. Anything queued after that fails. Switch to ' + r.successor + '.';
    } else {
      title.textContent = 'Retires in ' + r.days + ' days';
      body.textContent = r.label + ' stops working on ' + r.dateLabel + '. Switch to ' + r.successor +
        ' for new work — different look, so re-check anything you have already approved.';
    }
    box.appendChild(title);
    box.appendChild(body);
    retirementEl.appendChild(box);
  }

  function modelIsRetired(model) {
    var r = retirementFor(model);
    return Boolean(r && r.retired);
  }

  // -------------------------------------------------------------------------
  // Rail rendering
  // -------------------------------------------------------------------------
  function buildModelOptions() {
    var prices = config.prices || {};
    var ids = Object.keys(prices);
    // Live models first in declared order; a retired one drops to the bottom,
    // disabled, so the list still explains where it went.
    var live = ids.filter(function (id) { return !modelIsRetired(id); });
    var dead = ids.filter(modelIsRetired);

    modelEl.innerHTML = '';
    live.concat(dead).forEach(function (id) {
      var p = prices[id];
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.label + (modelIsRetired(id) ? ' — retired' : '');
      opt.disabled = modelIsRetired(id);
      modelEl.appendChild(opt);
    });

    if (!prices[state.model] || modelIsRetired(state.model)) {
      // Moving someone off a model they had chosen is not something to do
      // silently — remember it so the notice can explain why their images will
      // look different from the ones they already approved.
      if (prices[state.model] && modelIsRetired(state.model)) retiredFallback = state.model;
      var fallback = live.filter(function (id) { return prices[id].isDefault; })[0] || live[0] || ids[0];
      state.model = fallback;
    }
    modelEl.value = state.model;

    var chosen = prices[state.model];
    if (chosen && chosen.isDefault) {
      modelNote.hidden = false;
      modelNote.textContent = 'default';
    } else {
      modelNote.hidden = true;
    }
  }

  function buildShapeOptions() {
    shapeEl.innerHTML = '';
    SHAPES.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      shapeEl.appendChild(opt);
    });
    shapeEl.value = state.shape;
  }

  // Sizes are relabelled when the shape changes; both resolutions stay available,
  // so the chosen one is kept rather than silently reset to the dearer option.
  function buildSizeOptions() {
    sizeEl.innerHTML = '';
    RESOLUTIONS.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r;
      opt.textContent = sizeLabel(state.shape, r);
      sizeEl.appendChild(opt);
    });
    sizeEl.value = state.resolution;
  }

  // The design shows the open list with a price on every row, so you compare
  // while choosing rather than one selection at a time. A native select keeps the
  // keyboard and screen-reader behaviour, so the prices go into the option text.
  function buildQualityOptions() {
    var p = priceEntry(state.model);
    if (!p || !p.tiers || p.tiers['default']) return;

    var keys = ['auto'].concat(Object.keys(p.tiers));
    if (keys.indexOf(state.quality) === -1) state.quality = 'auto';

    qualityEl.innerHTML = '';
    keys.forEach(function (q) {
      var per = perImage(state.model, q, state.resolution, state.mode);
      var label = q.charAt(0).toUpperCase() + q.slice(1);
      var opt = document.createElement('option');
      opt.value = q;
      opt.textContent = per == null
        ? label
        : label + ' — ' + money(per) + (state.mode === 'edit' ? '' : ' a frame');
      qualityEl.appendChild(opt);
    });
    qualityEl.value = state.quality;
  }

  function renderQuality() {
    // Only grok-imagine-image-2.0 accepts quality; sending it to any other model
    // is a 400, so the control is absent rather than present-and-broken.
    if (!acceptsQuality(state.model)) {
      qualityField.hidden = true;
      return;
    }
    qualityField.hidden = false;
    // Rebuilt on every settings change: the price on each row depends on the
    // model, the size and whether this is a generation or an edit.
    buildQualityOptions();

    var per = perImage(state.model, state.quality, state.resolution, state.mode);
    if (per == null) {
      qualityNote.textContent = '';
      return;
    }
    qualityNote.textContent = state.mode === 'edit' ? money(per) : money(per) + ' a frame';
  }

  function renderModeChrome() {
    var editing = state.mode === 'edit';

    tabGenerate.setAttribute('aria-selected', String(!editing));
    tabEdit.setAttribute('aria-selected', String(editing));
    tabGenerate.tabIndex = editing ? -1 : 0;
    tabEdit.tabIndex = editing ? 0 : -1;

    sourceField.hidden = !editing;
    // The frames slider is removed, not disabled: an edit returns one image.
    framesField.hidden = editing;
    shapeSize.hidden = editing;

    promptLabel.textContent = editing ? 'What should change?' : 'What should it make?';
    promptEl.placeholder = editing
      ? 'Describe the change — “make the background a plain warm grey”'
      : 'Describe the image — subject, setting, light, mood';
    promptEl.classList.toggle('textarea--edit', editing);
    promptEl.classList.toggle('textarea--generate', !editing);
    promptGuidance.textContent = editing
      ? (state.sources.length > 1
          ? 'The same change is applied to each photo, one image back per photo.'
          : 'An edit returns one image. Run it again for another attempt.')
      : 'Plain description works better than keywords.';
  }

  // The dropzone stays put so more photos can be added; loaded ones list below it.
  function renderSource() {
    sourceList.innerHTML = '';
    state.sources.forEach(function (src, i) {
      var row = el('div', 'source');

      var thumb = document.createElement('img');
      thumb.className = 'source__thumb';
      thumb.src = src.dataUri;
      thumb.alt = 'Photo to edit: ' + src.name;
      row.appendChild(thumb);

      var meta = el('div', 'source__meta');
      meta.appendChild(el('div', 'source__name', src.name));
      meta.appendChild(el('div', 'source__dims num', src.width
        ? src.width + '×' + src.height + ' · ' + bytes(src.size)
        : bytes(src.size)));
      row.appendChild(meta);

      var remove = el('button', 'btn-destructive on-sunken', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + src.name);
      remove.disabled = busy;
      remove.addEventListener('click', function () {
        state.sources.splice(i, 1);
        resetDropzone();
        renderRail();
        (state.sources.length ? sourceList.querySelector('button') : dropzone).focus();
      });
      row.appendChild(remove);

      sourceList.appendChild(row);
    });

    var count = state.sources.length;
    dropzoneTitle.dataset.more = count ? '1' : '';
    if (!dropzone.classList.contains('is-rejected') && !dropzone.classList.contains('is-over')) {
      dropzoneTitle.textContent = count ? 'Drop more photos here' : 'Drop photos here';
    }
  }

  function resetDropzone() {
    dropzone.classList.remove('is-rejected', 'is-over');
    dropzoneTitle.textContent = 'Drop a photo here';
    dropzoneBody.innerHTML = 'Or <span class="dropzone__link">choose a file</span>. JPG, PNG or WebP, up to 10 MB.';
  }

  function rejectDrop(title, body) {
    dropzone.classList.remove('is-over');
    dropzone.classList.add('is-rejected');
    dropzoneTitle.textContent = title;
    dropzoneBody.textContent = body;
  }

  // -------------------------------------------------------------------------
  // The action button: label, enabled state, reason, cost line
  // -------------------------------------------------------------------------
  function actionLabel() {
    if (state.mode === 'edit') {
      var photos = state.sources.length;
      return photos > 1 ? 'Apply edit to ' + photos + ' photos' : 'Apply edit';
    }
    return state.frames > 1 ? 'Generate ' + state.frames + ' frames' : 'Generate';
  }

  function blockingReason() {
    if (!config) return 'Loading the studio.';
    if (!config.hasKey) return null; // handled as a full error notice
    if (modelIsRetired(state.model)) return 'Pick a model that still accepts requests.';
    if (state.mode === 'edit' && !state.sources.length) {
      return wordCount(promptEl.value) >= 3
        ? 'Add a photo to edit.'
        : 'Add a photo and describe the change.';
    }
    if (!promptEl.value.trim()) {
      return state.mode === 'edit'
        ? 'Describe the change you want.'
        : 'Write a prompt to start. Nothing is charged until you generate.';
    }
    if (wordCount(promptEl.value) < 3) return 'A prompt needs at least three words.';
    return null;
  }

  function renderAction() {
    if (busy) return; // the busy state owns the button until the run settles

    var reason = blockingReason();
    var rateLeft = Math.max(0, Math.ceil((rateLimitUntil - Date.now()) / 1000));

    actionBtn.classList.remove('is-busy');

    if (rateLeft > 0) {
      actionBtn.disabled = true;
      actionBtn.textContent = (state.mode === 'edit' ? 'Apply edit in ' : 'Generate in ') + duration(rateLeft * 1000);
      actionBtn.classList.add('num');
    } else {
      actionBtn.classList.remove('num');
      actionBtn.disabled = Boolean(reason) || !config || !config.hasKey;
      actionBtn.textContent = actionLabel();
    }

    // Disabled action always carries a reason underneath.
    if (reason && rateLeft <= 0) {
      actionReason.hidden = false;
      actionReason.textContent = reason;
      costLine.hidden = true;
    } else {
      actionReason.hidden = true;
      renderCost();
    }

    // The prompt shows its own error only once something has been typed.
    var short = promptEl.value.trim() && wordCount(promptEl.value) < 3;
    promptEl.classList.toggle('is-error', Boolean(short));
  }

  function renderCost() {
    var est = estimate();
    if (!est) {
      // No price entry for this model: say the cost is unknown, never guess.
      costLine.hidden = false;
      costLabel.textContent = 'Estimated cost';
      costValue.textContent = 'unknown';
      return;
    }
    costLine.hidden = false;
    costLabel.textContent = 'Estimated cost';
    if (state.mode === 'edit') {
      costValue.textContent = est.count > 1
        ? money(est.total) + ' · ' + est.count + ' × ' + money(est.per + est.input)
        : money(est.total) + ' · 1 image';
    } else {
      costValue.textContent = money(est.total) + ' · ' + est.count + ' × ' + money(est.per);
    }
  }

  // Recompute on every settings change.
  function renderRail() {
    renderModeChrome();
    renderQuality();
    buildSizeOptions();
    renderRetirement();
    renderSource();
    framesValue.textContent = state.frames + (state.frames === 1 ? ' frame' : ' frames');
    framesValue.classList.toggle('is-idle', state.frames === 1);
    framesEl.value = state.frames;
    framesEl.style.setProperty('--fill', ((state.frames - 1) / 9 * 100) + '%');
    promptCount.textContent = promptEl.value.length + ' / 1000';
    renderAction();
    persist();
  }

  function persist() {
    writeStore(STORE_KEY, {
      model: state.model,
      quality: state.quality,
      shape: state.shape,
      resolution: state.resolution,
      frames: state.frames,
      name: state.name
    });
  }

  // -------------------------------------------------------------------------
  // 10 Errors. Warning for things that clear on their own or with a retry,
  // danger for things that need a person. They persist until the next
  // successful action — no auto-dismiss, no toasts anywhere in this product.
  // -------------------------------------------------------------------------
  function clearError() {
    runError.innerHTML = '';
  }

  function showError(title, body, tone) {
    runError.innerHTML = '';
    var box = el('div', 'notice notice--run notice--' + (tone === 'warning' ? 'warning' : 'danger'));
    box.appendChild(el('div', 'notice__title num', title));
    box.appendChild(el('div', 'notice__body num', body));
    runError.appendChild(box);
  }

  function describeFailure(payload, status) {
    var code = payload && payload.code;
    var message = (payload && payload.error) || ('xAI returned status ' + status + '.');

    if (code === 'no_key') {
      return ['danger', 'No API key on the server',
        'Generating is switched off until someone adds the team key to the server environment. Post in #design-ops — nothing you change here will fix it.'];
    }
    if (code === 'moderation') {
      return ['danger', 'The prompt was blocked, no images returned',
        'Moderation at xAI rejected this wording, most often over a named person, a brand or violence. Rewrite the subject in plainer terms and run it again. You were not charged.'];
    }
    if (code === 'rate_limited') {
      var wait = payload && payload.retryAfter ? payload.retryAfter : 30;
      return ['warning', 'Too many runs in a row',
        'The shared key hit its limit. The button unlocks in ' + wait + ' seconds — someone else on the team may be generating right now. Nothing was charged.'];
    }
    if (code === 'no_credits') {
      return ['danger', 'The prepaid credits ran out',
        'The team account has no balance left, so no new runs will start. Ask in #design-ops to top it up. Images already on this page still download.'];
    }
    if (code === 'key_rejected') {
      return ['danger', 'xAI rejected the team key',
        message + ' Someone needs to check XAI_API_KEY on the server. Nothing was charged.'];
    }
    if (code === 'timeout') {
      var secs = (payload && payload.seconds) || 180;
      return ['warning', 'Timed out after ' + secs + ' seconds',
        'Nothing came back, so nothing was charged. Large sizes and high frame counts time out most often — retry, or drop the size and the number of frames.'];
    }
    if (code === 'network') {
      return ['danger', 'Could not reach xAI',
        message + ' This is the server’s connection, not yours. Retry, and if it keeps failing post in #design-ops.'];
    }
    if (code === 'too_large') {
      return ['danger', 'That photo is too large',
        message];
    }
    if (code === 'bad_request') {
      return ['danger', 'xAI would not accept that request', message];
    }
    // Unmapped: show the status code and what to do with it. Never "something
    // went wrong".
    return ['danger', 'xAI returned ' + status,
      message + ' Retry, then post the code in #design-ops.'];
  }

  function startRateLimit(seconds) {
    rateLimitUntil = Date.now() + seconds * 1000;
    if (rateLimitTimer) clearInterval(rateLimitTimer);
    rateLimitTimer = setInterval(function () {
      if (Date.now() >= rateLimitUntil) {
        clearInterval(rateLimitTimer);
        rateLimitTimer = null;
        rateLimitUntil = 0;
      }
      renderAction();
    }, 1000);
    renderAction();
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------
  function renderRuns() {
    // Results persist newest-first until cleared. A refresh empties the sheet.
    empty.hidden = runs.length > 0;
    Array.prototype.slice.call(results.querySelectorAll('.run')).forEach(function (n) { n.remove(); });

    runs.forEach(function (run) {
      results.insertBefore(renderRun(run), empty);
    });
  }

  // Frames that came back, in slot order. Each carries its own frame number, so
  // a run that lost frame 3 still labels the rest correctly.
  function doneImages(run) {
    var out = [];
    run.frames.forEach(function (f) { if (f.image) out.push(f.image); });
    return out;
  }

  function countText(run) {
    var total = run.frames.length;
    var got = doneImages(run).length;
    var text;
    var word = run.mode === 'edit' ? ' photo' : ' frame';
    if (run.status === 'running' || got === total) {
      text = total + (total === 1 ? word : word + 's');
    } else {
      // Say plainly that some are missing rather than quoting the number asked for.
      text = got + ' of ' + total + word + 's';
    }
    if (run.status !== 'running' && typeof run.cost === 'number' && run.cost > 0) {
      text += ' · ' + money(run.cost);
    }
    return text;
  }

  // Prefer the dimensions of the image that came back over the rail's estimate.
  function sizeChipText(run) {
    var shapeText = run.shape === 'auto' ? 'Auto' : run.shape;
    var first = doneImages(run)[0];
    if (first && first.width) return shapeText + ' · ' + first.width + '×' + first.height;
    return shapeText + ' · ' + sizeLabel(run.shape, run.resolution);
  }

  function chipsFor(run) {
    var p = priceEntry(run.model);
    var chips = [p ? p.label : run.model];

    // A degraded run was retried without the optional settings, so the shape,
    // size and quality asked for did not apply. Say that rather than showing
    // chips that describe a run which never happened.
    if (run.degraded) {
      chips.push('Settings dropped');
      chips.push(countText(run));
      return chips;
    }

    if (run.quality && acceptsQuality(run.model)) {
      chips.push(run.quality.charAt(0).toUpperCase() + run.quality.slice(1));
    }
    chips.push(run.mode === 'edit' ? 'Edit' : sizeChipText(run));
    chips.push(countText(run));
    return chips;
  }

  function renderRun(run) {
    var card = el('article', 'run');
    card.dataset.runId = run.id;

    var head = el('div', 'run__head');
    var headline = el('div', 'run__headline');
    var promptLine = el('div', 'run__prompt', run.prompt);
    promptLine.title = run.prompt;
    headline.appendChild(promptLine);

    var chipRow = el('div', 'run__chips');
    var sizeText = run.mode === 'edit' ? null : sizeChipText(run);
    chipsFor(run).forEach(function (text, i) {
      var chip = el('span', 'chip' + (i >= 2 ? ' num' : ''), text);
      // Tagged so the first image can correct it to real dimensions on load.
      if (sizeText && text === sizeText) chip.dataset.sizeChip = '1';
      chipRow.appendChild(chip);
    });
    headline.appendChild(chipRow);
    head.appendChild(headline);

    var aside = el('div', 'run__aside');
    var got = doneImages(run).length;

    if (run.status === 'running') {
      // Frames arrive one at a time now, so the header can say how many are back.
      var backNode = el('span', 'run__status num', got + ' of ' + run.frames.length + ' back');
      backNode.dataset.backFor = run.id;
      aside.appendChild(backNode);
      var elapsed = el('span', 'run__time num', 'Running ' + duration(Date.now() - run.startedAt));
      elapsed.dataset.elapsedFor = run.id;
      aside.appendChild(elapsed);
    } else {
      var made = new Date(run.finishedAt || run.startedAt);
      var when = clockTime(made);
      var took = duration((run.finishedAt || Date.now()) - run.startedAt);
      var timeText;
      if (run.status === 'cancelled') {
        timeText = 'Cancelled · kept ' + got + ' of ' + run.frames.length;
      } else if (run.restored) {
        // Restored from the server: the duration was not recorded, and the run
        // may not even be from today, so date it rather than invent a 0:00.
        var today = new Date();
        var sameDay = made.toDateString() === today.toDateString();
        timeText = sameDay ? when : made.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' + when;
      } else {
        timeText = when + ' · took ' + took;
      }
      aside.appendChild(el('span', 'run__time num', timeText));
      if (got > 0) {
        var dlAll = el('button', 'btn-text btn-text--13', got > 1 ? 'Download all' : 'Download');
        dlAll.type = 'button';
        dlAll.addEventListener('click', function () { downloadRun(run); });
        aside.appendChild(dlAll);
      }
    }
    head.appendChild(aside);
    card.appendChild(head);

    var grid = el('div', 'run__grid');
    var ratio = run.mode === 'edit' ? null : aspectRatioCss(run.shape);
    run.frames.forEach(function (frame, i) {
      grid.appendChild(renderFrame(run, i, ratio));
    });
    card.appendChild(grid);
    return card;
  }

  function mkTextButton(text, fn) {
    var b = el('button', 'btn-text', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function renderFrame(run, index, ratio) {
    var frame = run.frames[index];
    var wrap = el('div', 'frame');
    wrap.dataset.frameFor = run.id + ':' + index;
    var foot = el('div', 'frame__foot');
    var label = el('span', 'frame__label num', 'Frame ' + (index + 1));
    var actions = el('span', 'frame__actions');

    // Still waiting. Sunken fill with a hairline — no shimmer sweep. Only the
    // frame actually being worked on pulses; the rest sit quiet as "Queued".
    if (frame.status === 'running' || frame.status === 'queued') {
      var running = frame.status === 'running';
      var ph = el('div', running ? 'frame__placeholder' : 'frame__placeholder frame__placeholder--idle',
        running ? 'Rendering' : '');
      if (ratio) ph.style.aspectRatio = ratio; else ph.style.minHeight = '240px';
      wrap.appendChild(ph);
      foot.appendChild(label);
      foot.appendChild(el('span', 'frame__label num', running ? 'In progress' : 'Queued'));
      wrap.appendChild(foot);
      return wrap;
    }

    // A single frame failed inside an otherwise good batch. Offer to retry just
    // this one rather than making the whole run again.
    if (frame.status === 'failed') {
      var box = el('div', 'frame__failed');
      if (ratio) box.style.aspectRatio = ratio; else box.style.minHeight = '240px';
      var msg = el('span', null);
      msg.appendChild(el('b', null, 'Frame ' + (index + 1) + ' failed'));
      msg.appendChild(document.createTextNode(frame.error || 'The other frames arrived. Use Again to retry just this one.'));
      box.appendChild(msg);
      wrap.appendChild(box);
      foot.appendChild(label);
      actions.appendChild(mkTextButton('Again', function () { retryFrame(run, index); }));
      foot.appendChild(actions);
      wrap.appendChild(foot);
      return wrap;
    }

    if (frame.status === 'cancelled') {
      var cbox = el('div', 'frame__placeholder frame__placeholder--idle', '');
      if (ratio) cbox.style.aspectRatio = ratio; else cbox.style.minHeight = '240px';
      wrap.appendChild(cbox);
      foot.appendChild(label);
      foot.appendChild(el('span', 'frame__label num', 'Not started'));
      wrap.appendChild(foot);
      return wrap;
    }

    var image = frame.image;
    if (!image) return wrap;

    var btn = el('button', 'frame__button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open frame ' + (index + 1) + ' full size');
    var img = document.createElement('img');
    img.src = image.src;
    // Alt text on generated images uses the prompt.
    img.alt = run.prompt;
    img.loading = 'lazy';
    if (ratio) img.style.aspectRatio = ratio;
    // Record what xAI actually produced. The rail's size label is an estimate;
    // this is the real thing, and it is what results and the lightbox report.
    img.addEventListener('load', function () {
      if (image.width) return;
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      var card = wrap.closest('.run');
      var chip = card && card.querySelector('[data-size-chip]');
      if (chip) chip.textContent = sizeChipText(run);
    });
    btn.appendChild(img);
    btn.addEventListener('click', function () { openLightbox(run, image); });
    wrap.appendChild(btn);

    foot.appendChild(label);
    actions.appendChild(mkTextButton('Download', function () { downloadImage(run, image); }));
    actions.appendChild(el('span', 'frame__sep', '·'));
    actions.appendChild(mkTextButton('Edit this', function () { editThis(run, image); }));
    actions.appendChild(el('span', 'frame__sep', '·'));
    actions.appendChild(mkTextButton('Again', function () { again(run); }));

    foot.appendChild(actions);
    wrap.appendChild(foot);
    return wrap;
  }

  // Repaint one frame in place. The grid never reflows, so a frame landing does
  // not move the ones already on screen.
  function refreshFrame(run, index) {
    var node = results.querySelector('[data-frame-for="' + run.id + ':' + index + '"]');
    if (!node) return;
    var ratio = run.mode === 'edit' ? null : aspectRatioCss(run.shape);
    node.replaceWith(renderFrame(run, index, ratio));
  }

  function refreshRunHeader(run) {
    var card = results.querySelector('[data-run-id="' + run.id + '"]');
    if (!card) return;
    var back = card.querySelector('[data-back-for="' + run.id + '"]');
    if (back) back.textContent = doneImages(run).length + ' of ' + run.frames.length + ' back';
    var chips = card.querySelectorAll('.chip');
    var texts = chipsFor(run);
    if (chips.length === texts.length) {
      for (var i = 0; i < chips.length; i++) chips[i].textContent = texts[i];
    }
  }

  function tickElapsed() {
    runs.forEach(function (run) {
      if (run.status !== 'running') return;
      var node = results.querySelector('[data-elapsed-for="' + run.id + '"]');
      if (node) node.textContent = 'Running ' + duration(Date.now() - run.startedAt);
    });
  }

  // -------------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------------
  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  }

  function imageFileName(run, image) {
    return slug(run.prompt) + '-frame-' + (image.frame || 1) + '.' + (image.ext || 'png');
  }

  function downloadImage(run, image) {
    if (!image) return;
    var a = document.createElement('a');
    a.href = image.src;
    a.download = imageFileName(run, image);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadRun(run) {
    doneImages(run).forEach(function (image, i) {
      setTimeout(function () { downloadImage(run, image); }, i * 150);
    });
  }

  // -------------------------------------------------------------------------
  // Edit this / Again
  // -------------------------------------------------------------------------
  function toDataUri(src) {
    if (!src || src.indexOf('/api/image/') !== 0) return Promise.resolve(src);
    return fetch(src)
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result)); };
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      });
  }

  async function editThis(run, image) {
    if (!image) return;
    closeLightbox();

    // Coming from generate, the prompt holds a description of an image, which is
    // the wrong instruction for an edit — leaving it would let Cmd+Enter fire
    // nonsense. Coming from edit, the user may have already typed the change, so
    // never overwrite that: only the source swaps.
    if (state.mode !== 'edit') promptEl.value = '';

    // Chaining matters: the source may itself be the output of an edit.
    var dataUri;
    try {
      dataUri = await toDataUri(image.src);
    } catch (err) {
      showError('That image could not be loaded for editing',
        'It may have been cleared from the server. Generate it again, or pick another frame.',
        'danger');
      return;
    }

    state.sources = [{
      dataUri: dataUri,
      name: imageFileName(run, image),
      size: image.bytes || 0,
      width: image.width || 0,
      height: image.height || 0
    }];
    setMode('edit');
    resetDropzone();
    clearError();
    renderRail();
    promptEl.focus();
    promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
  }

  // Again re-runs that group's stored settings, not the rail's current values.
  function again(run) {
    if (busy) return;
    submitRun({
      mode: run.mode,
      model: run.model,
      prompt: run.prompt,
      quality: run.quality,
      shape: run.shape,
      resolution: run.resolution,
      n: run.frames ? run.frames.length : run.n,
      sources: run.sources || []
    });
  }

  // -------------------------------------------------------------------------
  // 08 Lightbox
  // -------------------------------------------------------------------------
  // Opens on an image, not a slot: a run can have gaps where frames failed, and
  // the arrows should move through what actually arrived.
  function openLightbox(run, image) {
    var list = doneImages(run);
    var pos = list.indexOf(image);
    if (pos === -1) return;
    lastFocused = document.activeElement;
    lightboxState = { run: run, list: list, index: pos };
    renderLightbox();
    lightbox.hidden = false;
    lbClose.focus();
    document.addEventListener('keydown', lightboxKeys, true);
  }

  function renderLightbox() {
    if (!lightboxState) return;
    var run = lightboxState.run;
    var image = lightboxState.list[lightboxState.index];
    if (!image) return;

    // Names the frame's own number against the run total, so a partial run reads
    // truthfully — "Frame 5 of 6" even when only three came back.
    lbCount.textContent = 'Frame ' + (image.frame || 1) + ' of ' + run.frames.length;
    var p = priceEntry(run.model);
    var meta = [p ? p.label : run.model];
    if (run.quality && acceptsQuality(run.model)) {
      meta.push(run.quality.charAt(0).toUpperCase() + run.quality.slice(1));
    }
    // Real dimensions once the image has loaded; the rail estimate only until then.
    if (image.width) meta.push(image.width + '×' + image.height);
    else if (run.mode !== 'edit') meta.push(sizeLabel(run.shape, run.resolution));
    lbMeta.textContent = meta.join(' · ');

    lbImage.src = image.src;
    lbImage.alt = run.prompt;
    lbPrompt.textContent = image.revised_prompt || run.prompt;
    lbTime.textContent = 'Generated ' + clockTime(new Date(run.finishedAt || run.startedAt)) + ' today';
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    document.removeEventListener('keydown', lightboxKeys, true);
    lightboxState = null;
    // Focus returns to the image that opened it.
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  }

  function lightboxKeys(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLightbox();
      return;
    }
    // Arrow keys move within the run.
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!lightboxState) return;
      e.preventDefault();
      var n = lightboxState.list.length;
      var step = e.key === 'ArrowRight' ? 1 : -1;
      lightboxState.index = (lightboxState.index + step + n) % n;
      renderLightbox();
      return;
    }
    if (e.key === 'Tab') {
      // Trap focus inside the dialog.
      var focusables = lightbox.querySelectorAll('button');
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  lbClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('mousedown', function (e) {
    if (e.target === lightbox) closeLightbox();
  });
  lbDownload.addEventListener('click', function () {
    if (lightboxState) downloadImage(lightboxState.run, lightboxState.list[lightboxState.index]);
  });
  lbEdit.addEventListener('click', function () {
    if (lightboxState) editThis(lightboxState.run, lightboxState.list[lightboxState.index]);
  });

  // -------------------------------------------------------------------------
  // Submitting a run
  // -------------------------------------------------------------------------
  function currentSettings() {
    return {
      mode: state.mode,
      model: state.model,
      prompt: promptEl.value.trim(),
      quality: acceptsQuality(state.model) ? state.quality : null,
      shape: state.shape,
      resolution: state.resolution,
      n: state.mode === 'edit' ? 1 : state.frames,
      sources: state.mode === 'edit' ? state.sources.map(function (s) { return s.dataUri; }) : []
    };
  }

  function setBusy(on, label) {
    busy = on;
    modeswitch.classList.toggle('is-disabled', on);
    tabGenerate.disabled = on;
    tabEdit.disabled = on;
    promptEl.disabled = on;
    modelEl.disabled = on;
    qualityEl.disabled = on;
    shapeEl.disabled = on;
    sizeEl.disabled = on;
    framesEl.disabled = on;
    dropzone.disabled = on;

    actionBtn.disabled = on;
    actionBtn.classList.toggle('is-busy', on);
    // Re-render the photo rows so their Remove buttons follow the busy state —
    // pulling a source out from under a run in flight would strand it.
    renderSource();
    if (on) {
      setBusyLabel(label);
      actionReason.hidden = true;
      costLine.hidden = false;
      costLabel.textContent = state.mode === 'edit'
        ? 'Charged as photos arrive'
        : 'Charged as frames arrive';
      var est = estimate();
      costValue.textContent = est ? money(est.total) : 'unknown';
      promptGuidance.textContent = 'Locked while a run is in flight.';
      cancelRow.hidden = false;
    } else {
      cancelRow.hidden = true;
      renderModeChrome();
      renderAction();
    }
  }

  function setBusyLabel(label) {
    actionBtn.innerHTML = '';
    actionBtn.appendChild(el('span', 'pulse'));
    actionBtn.appendChild(el('span', null, label));
  }

  // Frames are requested one at a time, so the button can name the one being
  // worked on rather than the batch.
  function busyLabelFor(run) {
    if (run.mode === 'edit') {
      if (run.frames.length === 1) return 'Applying the edit';
      return 'Editing photo ' + Math.min(doneImages(run).length + 1, run.frames.length) +
        ' of ' + run.frames.length;
    }
    var got = doneImages(run).length;
    var total = run.frames.length;
    return 'Generating frame ' + Math.min(got + 1, total) + ' of ' + total;
  }

  // Ask xAI for one image per request rather than one request for many.
  //
  // Inside a single request xAI works through `n` images one after another, so a
  // six-frame batch takes six times as long as one and shows nothing until the
  // last is done — and at 2k a full batch runs past the server's timeout, losing
  // work that has almost certainly already been billed. One image per request
  // keeps every call short, lets frames appear as they land, and confines a
  // failure to the frame it happened to.
  var FRAME_CONCURRENCY = 3;

  function requestOneFrame(run, index) {
    var body = {
      mode: run.mode,
      model: run.model,
      prompt: run.prompt,
      user: state.name || '',
      runId: run.id
    };
    if (run.mode === 'edit') {
      // The server wraps this into xAI's { url, type } shape; send the plain URI.
      body.image = run.sources[index];
    } else {
      body.n = 1;
      body.aspect_ratio = run.shape;
      body.resolution = run.resolution;
    }
    if (run.quality) body.quality = run.quality;

    var headers = { 'content-type': 'application/json' };
    if (password) headers['x-team-password'] = password;

    var controller = new AbortController();
    run.controllers.push(controller);

    return fetch('/api/images', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (payload) {
        return { ok: res.ok, status: res.status, payload: payload };
      });
    });
  }

  function applyFrameResult(run, index, result) {
    var frame = run.frames[index];
    if (frame.status === 'cancelled') return;

    if (!result.ok) {
      var payload = result.payload;
      if (result.status === 401 && payload && payload.code === 'unauthorized') {
        run.authFailed = true;
        frame.status = 'failed';
        frame.error = '';
        return;
      }
      if (payload && payload.code === 'rate_limited') run.rateLimit = payload.retryAfter || 30;
      var described = describeFailure(payload, result.status);
      frame.status = 'failed';
      // Two lines everywhere else; inside a frame card there is only room for one.
      frame.error = described[1] + '. Use Again to retry just this one.';
      run.lastFailure = described;
      refreshFrame(run, index);
      refreshRunHeader(run);
      return;
    }

    var item = (result.payload.images || [])[0];
    if (!item) {
      frame.status = 'failed';
      frame.error = 'Nothing came back for this frame. Use Again to retry just this one.';
      refreshFrame(run, index);
      return;
    }

    var kind = item.b64 ? sniffImage(item.b64) : { mime: null, ext: 'png' };
    frame.image = {
      id: item.id || null,
      src: item.id ? '/api/image/' + item.id
        : (item.b64 ? 'data:' + kind.mime + ';base64,' + item.b64 : item.url),
      ext: kind.ext,
      bytes: item.b64 ? Math.round(item.b64.length * 0.75) : 0,
      // Filled in from the image itself once it loads — the only truthful
      // source for the dimensions xAI actually produced.
      width: 0,
      height: 0,
      frame: index + 1,
      revised_prompt: item.revised_prompt || null
    };
    frame.status = 'done';

    var cost = typeof result.payload.cost === 'number' ? result.payload.cost : 0;
    run.cost = (run.cost || 0) + cost;
    // Money is spent the moment a frame arrives, so it is counted then. The run
    // itself is only counted once, on its first frame.
    addSpend(cost, !run.counted);
    run.counted = true;
    if (result.payload.degraded) run.degraded = true;

    refreshFrame(run, index);
    refreshRunHeader(run);
    if (busy) setBusyLabel(busyLabelFor(run));
  }

  function cancelRun(run) {
    if (!run || run.status !== 'running') return;
    run.cancelled = true;
    run.frames.forEach(function (f) {
      if (f.status === 'queued') f.status = 'cancelled';
    });
    run.controllers.forEach(function (c) {
      try { c.abort(); } catch (err) { /* already settled */ }
    });
  }

  async function submitRun(settings) {
    if (busy) return;
    if (Date.now() < rateLimitUntil) return;

    var total = settings.mode === 'edit' ? Math.max(1, settings.sources.length) : settings.n;
    var frames = [];
    for (var i = 0; i < total; i++) frames.push({ status: 'queued', image: null, error: null });

    var run = {
      id: 'run-' + (++seq) + '-' + Date.now().toString(36),
      mode: settings.mode,
      model: settings.model,
      prompt: settings.prompt,
      quality: settings.quality,
      shape: settings.shape,
      resolution: settings.resolution,
      n: total,
      sources: settings.sources || [],
      frames: frames,
      controllers: [],
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      cost: 0,
      counted: false,
      cancelled: false,
      degraded: false
    };

    clearError();
    runs.unshift(run);
    renderRuns();
    if (runTimer) clearInterval(runTimer);
    runTimer = setInterval(tickElapsed, 1000);

    activeRun = run;
    setBusy(true, busyLabelFor(run));

    var next = 0;
    async function worker() {
      while (true) {
        if (run.cancelled) return;
        var index = next++;
        if (index >= total) return;
        var frame = run.frames[index];
        if (frame.status === 'cancelled') continue;
        frame.status = 'running';
        refreshFrame(run, index);
        try {
          var result = await requestOneFrame(run, index);
          applyFrameResult(run, index, result);
        } catch (err) {
          if (run.cancelled || (err && err.name === 'AbortError')) {
            frame.status = 'cancelled';
          } else {
            frame.status = 'failed';
            frame.error = 'Could not reach the studio server. Use Again to retry just this one.';
            run.reachFailed = true;
          }
          refreshFrame(run, index);
        }
      }
    }

    var pool = [];
    for (var w = 0; w < Math.min(FRAME_CONCURRENCY, total); w++) pool.push(worker());

    try {
      await Promise.all(pool);
    } finally {
      run.status = run.cancelled ? 'cancelled' : 'done';
      run.finishedAt = Date.now();
      activeRun = null;
      // Restore the button in a finally, so a failure never leaves it stuck.
      setBusy(false);
      if (runTimer && !runs.some(function (r) { return r.status === 'running'; })) {
        clearInterval(runTimer);
        runTimer = null;
      }
    }

    var got = doneImages(run).length;

    // Every frame failed: there is nothing to show, so the card goes and the
    // error takes the rail as before.
    if (got === 0 && !run.cancelled) {
      runs = runs.filter(function (r) { return r !== run; });
      renderRuns();
      if (run.authFailed) { lockOut(); return; }
      if (run.reachFailed) {
        showError('Could not reach the studio server',
          'The request to this app’s own server failed. Check the server is still running, then retry. Nothing was charged.',
          'danger');
      } else if (run.lastFailure) {
        showError(run.lastFailure[1], run.lastFailure[2], run.lastFailure[0]);
      }
      if (run.rateLimit) startRateLimit(run.rateLimit);
      return;
    }

    renderRuns();

    if (run.cancelled) {
      showError('Run cancelled',
        got > 0
          ? 'Stopped after ' + got + ' of ' + run.frames.length + ' frames. You were charged ' +
            money(run.cost) + ' for the ' + (got === 1 ? 'one that arrived' : got + ' that arrived') + '.'
          : 'Stopped before any frame arrived, so nothing was charged.',
        'warning');
      return;
    }

    if (got < run.frames.length) {
      showError('Some frames did not arrive',
        got + ' of ' + run.frames.length + ' came back and are in the run above. Use Again on a failed frame to retry just that one. You were charged ' +
        money(run.cost) + ' for what arrived.',
        'warning');
      if (run.rateLimit) startRateLimit(run.rateLimit);
      return;
    }

    if (run.degraded) {
      showError('Run completed with fewer settings',
        'xAI would not accept one of the optional settings, so it was retried with just the prompt. Shape, size and quality were dropped for this run.',
        'warning');
    }
  }

  // Retry one failed frame in place, without re-running the whole group.
  async function retryFrame(run, index) {
    if (busy) return;
    var frame = run.frames[index];
    if (!frame || frame.status === 'done') return;

    run.controllers = [];
    run.cancelled = false;
    run.status = 'running';
    frame.status = 'running';
    frame.error = null;
    refreshFrame(run, index);

    activeRun = run;
    setBusy(true, 'Retrying frame ' + (index + 1));
    try {
      var result = await requestOneFrame(run, index);
      applyFrameResult(run, index, result);
    } catch (err) {
      frame.status = 'failed';
      frame.error = 'Could not reach the studio server. Use Again to retry just this one.';
      refreshFrame(run, index);
    } finally {
      run.status = 'done';
      run.finishedAt = Date.now();
      activeRun = null;
      setBusy(false);
      renderRuns();
    }
  }

  // -------------------------------------------------------------------------
  // Mode switching. Switching keeps the prompt text and the loaded photo, so a
  // mis-click costs nothing.
  // -------------------------------------------------------------------------
  function setMode(mode) {
    if (busy) return;
    state.mode = mode === 'edit' ? 'edit' : 'generate';
    renderRail();
  }

  [tabGenerate, tabEdit].forEach(function (tab) {
    tab.addEventListener('click', function () { setMode(tab.dataset.mode); });
  });

  modeswitch.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var next = state.mode === 'generate' ? 'edit' : 'generate';
    setMode(next);
    (next === 'edit' ? tabEdit : tabGenerate).focus();
  });

  // -------------------------------------------------------------------------
  // Dropzone. Keyboard operable: it is a real button, and the hidden file input
  // is driven from it.
  // -------------------------------------------------------------------------
  dropzone.addEventListener('click', function () { fileInput.click(); });

  ['dragenter', 'dragover'].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.remove('is-rejected');
      dropzone.classList.add('is-over');
      dropzoneTitle.textContent = 'Release to use this photo';
      dropzoneBody.textContent = 'One photo at a time.';
    });
  });

  ['dragleave', 'dragend'].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      if (!dropzone.classList.contains('is-rejected')) resetDropzone();
    });
  });

  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('is-over');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) takeFiles(files);
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files.length) takeFiles(fileInput.files);
    fileInput.value = '';
  });

  // Removal is per row, wired in renderSource where each row is built.

  function fileKind(file) {
    if (file.type && file.type.indexOf('image/') === 0) return file.type.split('/')[1].toUpperCase();
    if (file.type) return file.type.split('/').pop().toUpperCase();
    var dot = file.name.lastIndexOf('.');
    return dot === -1 ? 'file' : file.name.slice(dot + 1).toUpperCase();
  }

  // The same cap as frames: ten edits in one run, ten frames in one run.
  var MAX_SOURCES = 10;

  function readOneFile(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUri = String(reader.result);
        var probe = new Image();
        probe.onload = function () {
          resolve({ dataUri: dataUri, name: file.name, size: file.size,
                    width: probe.naturalWidth, height: probe.naturalHeight });
        };
        probe.onerror = function () {
          resolve({ dataUri: dataUri, name: file.name, size: file.size, width: 0, height: 0 });
        };
        probe.src = dataUri;
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  // Takes whatever was dropped or chosen, keeps the usable photos and explains
  // the first thing it had to turn away. Already-loaded photos are never lost to
  // a bad file in the same batch.
  async function takeFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;

    var room = MAX_SOURCES - state.sources.length;
    var rejected = null;

    if (room <= 0) {
      rejectDrop('That is already ' + MAX_SOURCES + ' photos',
        'Ten is the most in one run. Remove one to add another, or edit these first.');
      return;
    }

    var accepted = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (ACCEPTED_TYPES.indexOf(f.type) === -1) {
        rejected = rejected || ['That file is a ' + fileKind(f),
          'Editing needs an image. Drop a JPG, PNG or WebP instead.'];
        continue;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        rejected = rejected || ['That photo is ' + bytes(f.size),
          'The limit is 10 MB. Export it smaller, or scale it to 2048px on the long edge and drop it again.'];
        continue;
      }
      if (accepted.length >= room) {
        rejected = rejected || ['That is more than ' + MAX_SOURCES + ' photos',
          'Ten is the most in one run, so the rest were left out.'];
        continue;
      }
      accepted.push(f);
    }

    var loaded = await Promise.all(accepted.map(readOneFile));
    loaded.forEach(function (src) { if (src) state.sources.push(src); });

    if (loaded.some(function (s) { return !s; }) && !rejected) {
      rejected = ['A photo could not be read',
        'The file may be damaged. Try exporting it again, then drop it here.'];
    }

    if (rejected) rejectDrop(rejected[0], rejected[1]);
    else { resetDropzone(); clearError(); }
    renderRail();
  }

  // -------------------------------------------------------------------------
  // Rail wiring
  // -------------------------------------------------------------------------
  promptEl.addEventListener('input', function () {
    promptCount.textContent = promptEl.value.length + ' / 1000';
    renderAction();
  });

  modelEl.addEventListener('change', function () {
    // Their own choice supersedes the explanation of the forced one.
    retiredFallback = null;
    state.model = modelEl.value;
    buildModelOptions();
    renderRail();
  });

  qualityEl.addEventListener('change', function () {
    state.quality = qualityEl.value;
    renderRail();
  });

  shapeEl.addEventListener('change', function () {
    state.shape = shapeEl.value;
    renderRail();
  });

  sizeEl.addEventListener('change', function () {
    state.resolution = sizeEl.value;
    renderRail();
  });

  framesEl.addEventListener('input', function () {
    state.frames = Number(framesEl.value);
    renderRail();
  });

  // Shift+arrows step 5 on the slider.
  framesEl.addEventListener('keydown', function (e) {
    if (!e.shiftKey) return;
    var step = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step = 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step = -5;
    if (!step) return;
    e.preventDefault();
    state.frames = Math.min(10, Math.max(1, state.frames + step));
    renderRail();
  });

  function syncName(value) {
    state.name = value;
    if (userName.value !== value) userName.value = value;
    if (userNameMobile.value !== value) userNameMobile.value = value;
    persist();
  }
  userName.addEventListener('input', function () { syncName(userName.value); });
  userNameMobile.addEventListener('input', function () { syncName(userNameMobile.value); });

  Array.prototype.slice.call(document.querySelectorAll('.seed')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      promptEl.value = btn.dataset.seed;
      promptCount.textContent = promptEl.value.length + ' / 1000';
      renderAction();
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    });
  });

  cancelBtn.addEventListener('click', function () {
    if (activeRun) cancelRun(activeRun);
  });

  rail.addEventListener('submit', function (e) {
    e.preventDefault();
    if (blockingReason() || busy || Date.now() < rateLimitUntil) return;
    submitRun(currentSettings());
  });

  // Cmd/Ctrl + Enter fires the action button from anywhere in the rail.
  rail.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!actionBtn.disabled) rail.requestSubmit();
    }
  });

  // The retirement count is re-read on window focus, never left stale.
  window.addEventListener('focus', function () {
    if (!config) return;
    buildModelOptions();
    renderRetirement();
    renderSpend();
  });

  // On phones the name field moves to the bottom of the rail.
  var narrow = window.matchMedia('(max-width: 560px)');
  function placeNameField() {
    mobileWho.hidden = !narrow.matches;
    document.body.classList.toggle('has-pinned-action', narrow.matches);
  }
  narrow.addEventListener('change', placeNameField);

  // -------------------------------------------------------------------------
  // Password gate
  // -------------------------------------------------------------------------
  function lockOut() {
    password = '';
    try { localStorage.removeItem(PASS_KEY); } catch (err) { /* ignore */ }
    app.hidden = true;
    gate.hidden = false;
    gateError.hidden = false;
    gateError.textContent = 'That password is no longer accepted. Enter it again.';
    gatePassword.value = '';
    gatePassword.focus();
  }

  async function tryPassword(candidate) {
    var res = await fetch('/api/usage', {
      headers: candidate ? { 'x-team-password': candidate } : {}
    });
    return res.ok;
  }

  // Reveal control. Keeping focus in the field means the caret does not jump,
  // so someone checking a typo can carry on typing straight away.
  gateToggle.addEventListener('click', function () {
    var showing = gatePassword.type === 'text';
    var end = gatePassword.value.length;
    gatePassword.type = showing ? 'password' : 'text';
    gateToggle.setAttribute('aria-pressed', String(!showing));
    gateToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    gateToggle.title = showing ? 'Show password' : 'Hide password';
    gatePassword.focus();
    try { gatePassword.setSelectionRange(end, end); } catch (err) { /* not supported while type=password */ }
  });

  // Never leave a password on screen once the gate is done with.
  function hidePassword() {
    if (gatePassword.type !== 'text') return;
    gatePassword.type = 'password';
    gateToggle.setAttribute('aria-pressed', 'false');
    gateToggle.setAttribute('aria-label', 'Show password');
    gateToggle.title = 'Show password';
  }

  // Enter submits the gate. Browsers do this implicitly for a single-field form,
  // but the gate is the only way into the app, so it is wired explicitly rather
  // than left to implicit submission.
  gatePassword.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !gateSubmit.disabled) {
      e.preventDefault();
      gateForm.requestSubmit();
    }
  });

  gateForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var candidate = gatePassword.value;
    gateSubmit.disabled = true;
    gateSubmit.textContent = 'Checking';
    try {
      var ok = await tryPassword(candidate);
      if (!ok) {
        // The field keeps its value.
        gatePassword.classList.add('is-error');
        gateError.hidden = false;
        gateError.textContent = 'Password not recognised. Check for a trailing space, then try again.';
        gatePassword.focus();
        return;
      }
      password = candidate;
      writeStore(PASS_KEY, candidate);
      hidePassword();
      gatePassword.classList.remove('is-error');
      gateError.hidden = true;
      enterStudio();
    } catch (err) {
      gateError.hidden = false;
      gateError.textContent = 'Could not reach the studio server. Check it is still running, then try again.';
    } finally {
      gateSubmit.disabled = false;
      gateSubmit.textContent = 'Unlock studio';
    }
  });

  function enterStudio() {
    gate.hidden = true;
    app.hidden = false;
    placeNameField();
    renderRail();
    promptEl.focus();
    loadSavedRuns();
  }

  // Runs saved by the server, rebuilt into the same shape a live run has so the
  // rest of the app cannot tell the difference.
  async function loadSavedRuns() {
    if (!config || !config.savesImages) return;
    try {
      var headers = password ? { 'x-team-password': password } : {};
      var res = await fetch('/api/runs?limit=20', { headers: headers });
      if (!res.ok) return;
      var payload = await res.json();
      var restored = (payload.runs || []).map(function (r) {
        var frames = r.images.map(function (img) {
          return {
            status: 'done',
            error: null,
            image: {
              id: img.id,
              src: '/api/image/' + img.id,
              ext: (img.id.split('.').pop() || 'png'),
              bytes: 0, width: 0, height: 0,
              frame: img.frame,
              revised_prompt: null
            }
          };
        });
        var at = Date.parse(r.timestamp) || Date.now();
        return {
          id: 'saved-' + r.id,
          mode: r.mode === 'edit' ? 'edit' : 'generate',
          model: r.model,
          prompt: r.prompt || '',
          quality: r.quality,
          shape: r.aspect_ratio || 'auto',
          resolution: r.resolution || '1k',
          n: frames.length,
          sources: [],
          frames: frames,
          controllers: [],
          status: 'done',
          startedAt: at,
          finishedAt: at,
          cost: r.cost,
          counted: true,
          cancelled: false,
          degraded: false,
          restored: true
        };
      });
      if (!restored.length) return;
      // Anything generated in this tab stays on top of what was restored.
      runs = runs.concat(restored);
      renderRuns();
    } catch (err) {
      // The sheet simply stays empty; nothing here is worth an error card.
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  async function boot() {
    var saved = readStore(STORE_KEY) || {};

    try {
      var res = await fetch('/api/config');
      config = await res.json();
    } catch (err) {
      document.body.innerHTML =
        '<div class="gate"><div class="gate__card">' +
        '<div class="gate__title">The studio server is not answering</div>' +
        '<p class="gate__sub">This page loaded but /api/config did not. Check that node server.js is still running, then reload.</p>' +
        '</div></div>';
      return;
    }

    state.model = saved.model || '';
    state.quality = saved.quality || 'auto';
    state.shape = saved.shape || '9:16';
    state.resolution = saved.resolution || '1k';
    state.frames = Math.min(10, Math.max(1, Number(saved.frames) || 1));
    state.name = saved.name || '';

    buildModelOptions();
    buildShapeOptions();
    buildSizeOptions();
    syncName(state.name);
    renderSpend();

    // No key on the server blocks everything, and no password will change that.
    if (!config.hasKey) {
      gate.hidden = true;
      app.hidden = false;
      placeNameField();
      renderRail();
      showError('No API key on the server',
        'Generating is switched off until someone adds the team key to the server environment. Post in #design-ops — nothing you change here will fix it.',
        'danger');
      loadSavedRuns();
      return;
    }

    if (!config.requiresPassword) {
      enterStudio();
      return;
    }

    var stored = readStore(PASS_KEY);
    if (stored) {
      try {
        if (await tryPassword(stored)) {
          password = stored;
          enterStudio();
          return;
        }
      } catch (err) { /* fall through to the gate */ }
    }

    gate.hidden = false;
    gatePassword.focus();
  }

  boot();
})();
