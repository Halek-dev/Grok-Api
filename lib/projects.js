'use strict';

/**
 * Projects — folders the team works inside. Pure functions over the store
 * that server.js keeps in DATA_DIR/projects.json:
 *
 *   {
 *     projects: [{ id, name, slug, createdAt, archived, defaults, references }],
 *     placements: { <imageId>: <projectId | 'unsorted'> }
 *   }
 *
 * A picture belongs to the project its run was made in (the `project` field
 * on its usage-log line). Moving it afterwards writes a placement, which wins
 * over the line. "Unsorted" is not a project: it is the absence of one, and
 * where everything made before projects existed already lives.
 *
 * `references` are source-photo ids kept with the project, shown as a tray in
 * the composer. `defaults` are the composer settings the project opens with.
 */
const crypto = require('node:crypto');

const MAX_NAME = 60;
const MAX_PROJECTS = 200;
const MAX_REFERENCES = 24;
const UNSORTED = 'unsorted';

function validProjectId(id) {
  return typeof id === 'string' && /^p-[0-9a-f]{12}$/.test(id);
}

function validImageId(id) {
  return typeof id === 'string' && /^[0-9a-f]{32}\.(png|jpg|webp)$/.test(id);
}

function tidyName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// The word in the address: "Summer gens" → summer-gens. Made unique among the
// live projects by a number, so two "Client A" projects do not share one.
function slugFor(name, taken) {
  let base = tidyName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  if (base === UNSORTED || base === 'all') base += '-1';
  let slug = base, n = 2;
  while (taken.indexOf(slug) !== -1) slug = base + '-' + n++;
  return slug;
}

function empty() {
  return { projects: [], placements: {} };
}

// Reads a stored object defensively: anything malformed is dropped, not thrown.
function normalise(store) {
  const out = empty();
  const src = store && typeof store === 'object' ? store : {};
  const seenSlug = [];
  (Array.isArray(src.projects) ? src.projects : []).forEach(function (p) {
    if (!p || !validProjectId(p.id) || !tidyName(p.name)) return;
    const slug = typeof p.slug === 'string' && /^[a-z0-9-]{1,41}$/.test(p.slug) && seenSlug.indexOf(p.slug) === -1
      ? p.slug : slugFor(p.name, seenSlug);
    seenSlug.push(slug);
    out.projects.push({
      id: p.id, name: tidyName(p.name), slug: slug,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
      archived: Boolean(p.archived),
      defaults: cleanDefaults(p.defaults),
      references: (Array.isArray(p.references) ? p.references : []).filter(validImageId).slice(0, MAX_REFERENCES)
    });
  });
  const ids = out.projects.map((p) => p.id);
  Object.keys(src.placements && typeof src.placements === 'object' ? src.placements : {}).forEach(function (img) {
    const to = src.placements[img];
    if (validImageId(img) && (to === UNSORTED || ids.indexOf(to) !== -1)) out.placements[img] = to;
  });
  return out;
}

function cleanDefaults(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  ['model', 'shape', 'resolution', 'quality'].forEach(function (k) {
    if (typeof d[k] === 'string' && d[k].length <= 40) out[k] = d[k];
  });
  return Object.keys(out).length ? out : null;
}

function find(store, id) {
  return store.projects.find((p) => p.id === id) || null;
}

function bySlug(store, slug) {
  return store.projects.find((p) => p.slug === slug) || null;
}

function create(store, name) {
  const clean = tidyName(name);
  if (!clean) return { store: store, changed: false, error: 'A project needs a name.' };
  if (store.projects.filter((p) => !p.archived).length >= MAX_PROJECTS) {
    return { store: store, changed: false, error: 'That is already ' + MAX_PROJECTS + ' projects. Archive some first.' };
  }
  const project = {
    id: 'p-' + crypto.randomBytes(6).toString('hex'),
    name: clean,
    slug: slugFor(clean, store.projects.map((p) => p.slug)),
    createdAt: new Date().toISOString(),
    archived: false,
    defaults: null,
    references: []
  };
  store.projects.push(project);
  return { store: store, changed: true, project: project };
}

function rename(store, id, name) {
  const p = find(store, id);
  const clean = tidyName(name);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  if (!clean) return { store: store, changed: false, error: 'A project needs a name.' };
  if (p.name === clean) return { store: store, changed: false, project: p };
  p.name = clean;
  p.slug = slugFor(clean, store.projects.filter((q) => q !== p).map((q) => q.slug));
  return { store: store, changed: true, project: p };
}

function setArchived(store, id, on) {
  const p = find(store, id);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  if (p.archived === Boolean(on)) return { store: store, changed: false, project: p };
  p.archived = Boolean(on);
  return { store: store, changed: true, project: p };
}

function setDefaults(store, id, defaults) {
  const p = find(store, id);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  p.defaults = cleanDefaults(defaults);
  return { store: store, changed: true, project: p };
}

// Deleting a project never deletes pictures: anything placed in it goes back
// to Unsorted, and the usage-log lines that name it simply name a project
// that no longer exists, which reads as Unsorted too.
function remove(store, id) {
  const p = find(store, id);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  store.projects = store.projects.filter((q) => q.id !== id);
  Object.keys(store.placements).forEach(function (img) {
    if (store.placements[img] === id) store.placements[img] = UNSORTED;
  });
  return { store: store, changed: true, project: p };
}

// Moves pictures. `to` is a project id or 'unsorted'.
function move(store, imageIds, to) {
  if (to !== UNSORTED && !find(store, to)) return { store: store, changed: false, error: 'No such project.' };
  let changed = false;
  (Array.isArray(imageIds) ? imageIds : []).filter(validImageId).forEach(function (img) {
    if (store.placements[img] !== to) { store.placements[img] = to; changed = true; }
  });
  return { store: store, changed: changed };
}

function addReference(store, id, sourceId) {
  const p = find(store, id);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  if (!validImageId(sourceId)) return { store: store, changed: false, error: 'Not a valid photo.' };
  if (p.references.indexOf(sourceId) !== -1) return { store: store, changed: false, project: p };
  if (p.references.length >= MAX_REFERENCES) {
    return { store: store, changed: false, error: 'A project holds up to ' + MAX_REFERENCES + ' reference photos.' };
  }
  p.references.push(sourceId);
  return { store: store, changed: true, project: p };
}

function removeReference(store, id, sourceId) {
  const p = find(store, id);
  if (!p) return { store: store, changed: false, error: 'No such project.' };
  const before = p.references.length;
  p.references = p.references.filter((r) => r !== sourceId);
  return { store: store, changed: p.references.length !== before, project: p };
}

// Every source id any project keeps as a reference: these are never pruned.
function allReferences(store) {
  const set = new Set();
  store.projects.forEach((p) => p.references.forEach((r) => set.add(r)));
  return set;
}

// Where a picture lives: a placement wins over the line it was made on; a
// line naming a project that no longer exists reads as Unsorted.
function placeOf(store, imageId, lineProject) {
  const placed = store.placements[imageId];
  if (placed) return placed === UNSORTED ? null : placed;
  return lineProject && find(store, lineProject) ? lineProject : null;
}

// Does a picture belong to the requested view? `want` is null (all),
// 'unsorted', or a project id.
function inView(want, projectId) {
  if (!want) return true;
  if (want === UNSORTED) return projectId === null;
  return projectId === want;
}

module.exports = {
  UNSORTED: UNSORTED, MAX_REFERENCES: MAX_REFERENCES,
  validProjectId: validProjectId, tidyName: tidyName, slugFor: slugFor,
  empty: empty, normalise: normalise, find: find, bySlug: bySlug,
  create: create, rename: rename, setArchived: setArchived, setDefaults: setDefaults, remove: remove,
  move: move, addReference: addReference, removeReference: removeReference, allReferences: allReferences,
  placeOf: placeOf, inView: inView
};
