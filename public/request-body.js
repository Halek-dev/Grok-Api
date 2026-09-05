/* ==========================================================================
   Imagine studio — the body the client sends to POST /api/images.

   Kept out of app.js so it can be loaded by the test runner as well as the
   page: in the browser it attaches to window.ImagineRequest, under Node it is
   a CommonJS module. No DOM, no fetch, no state — one run and one frame index
   in, one JSON-ready object out.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImagineRequest = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One image per request, always. A run of several frames or variants is
  // several requests, so frames land as they finish and one failure stays
  // confined to its frame. `n` is therefore 1 here and the run's count is the
  // number of times this is called.
  function buildFrameBody(run, index, opts) {
    opts = opts || {};
    var body = {
      mode: run.mode === 'edit' ? 'edit' : 'generate',
      model: run.model,
      prompt: run.prompt,
      n: 1,
      aspect_ratio: run.shape || 'auto',
      resolution: run.resolution || '1k',
      user: opts.user || '',
      runId: run.id
    };
    if (run.quality) body.quality = run.quality;

    if (body.mode === 'edit') {
      var sources = Array.isArray(run.sources) ? run.sources : [];
      if (run.plan === 'reference') {
        // Every source, in the order shown: the first is the base, the rest
        // are references. Order is the outcome, so it is never reshuffled.
        body.sources = sources.slice();
        body.consent = opts.consent === true;
      } else {
        // Edit each: this frame edits its own photo and nothing else.
        body.sources = sources[index] ? [sources[index]] : [];
      }
    }
    return body;
  }

  return { buildFrameBody: buildFrameBody };
}));
