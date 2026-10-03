'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/projects.js');

const IMG = (n) => String(n).padStart(32, '0') + '.png';

test('create: id, slug from the name, unique slugs, empty name refused', () => {
  const s = P.empty();
  const a = P.create(s, '  Summer   gens ');
  assert.equal(a.changed, true);
  assert.equal(a.project.name, 'Summer gens');
  assert.equal(a.project.slug, 'summer-gens');
  assert.equal(P.validProjectId(a.project.id), true);
  const b = P.create(s, 'Summer gens');
  assert.equal(b.project.slug, 'summer-gens-2');
  assert.equal(P.create(s, '   ').error, 'A project needs a name.');
  assert.equal(P.create(s, 'Unsorted').project.slug, 'unsorted-1');
  assert.equal(s.projects.length, 3);
});

test('rename changes the slug; archive and defaults are kept', () => {
  const s = P.empty();
  const id = P.create(s, 'Draft').project.id;
  assert.equal(P.rename(s, id, 'Client A · lookbook').project.slug, 'client-a-lookbook');
  assert.equal(P.rename(s, id, 'Client A · lookbook').changed, false);
  assert.equal(P.rename(s, 'p-000000000000', 'x').error, 'No such project.');
  assert.equal(P.setArchived(s, id, true).project.archived, true);
  assert.equal(P.setArchived(s, id, true).changed, false);
  const d = P.setDefaults(s, id, { model: 'grok-imagine-image-2.0', shape: '3:4', resolution: '2k', evil: 'x', quality: 'y'.repeat(50) });
  assert.deepEqual(d.project.defaults, { model: 'grok-imagine-image-2.0', shape: '3:4', resolution: '2k' });
  assert.equal(P.setDefaults(s, id, {}).project.defaults, null);
});

test('a picture is where its line says, unless it was moved', () => {
  const s = P.empty();
  const a = P.create(s, 'A').project.id;
  const b = P.create(s, 'B').project.id;
  assert.equal(P.placeOf(s, IMG(1), a), a);
  assert.equal(P.placeOf(s, IMG(1), null), null);
  assert.equal(P.placeOf(s, IMG(1), 'p-deadbeefcafe'), null);   // a project that no longer exists
  assert.equal(P.move(s, [IMG(1), 'nope'], b).changed, true);
  assert.equal(P.placeOf(s, IMG(1), a), b);
  assert.equal(P.move(s, [IMG(1)], b).changed, false);
  assert.equal(P.move(s, [IMG(1)], P.UNSORTED).changed, true);
  assert.equal(P.placeOf(s, IMG(1), a), null);
  assert.equal(P.move(s, [IMG(2)], 'p-deadbeefcafe').error, 'No such project.');
});

test('inView: all, unsorted, or one project', () => {
  assert.equal(P.inView(null, 'p-1'), true);
  assert.equal(P.inView(null, null), true);
  assert.equal(P.inView(P.UNSORTED, null), true);
  assert.equal(P.inView(P.UNSORTED, 'p-1'), false);
  assert.equal(P.inView('p-1', 'p-1'), true);
  assert.equal(P.inView('p-1', 'p-2'), false);
});

test('deleting a project sends its placed pictures to Unsorted and keeps the rest', () => {
  const s = P.empty();
  const a = P.create(s, 'A').project.id;
  P.move(s, [IMG(1)], a);
  assert.equal(P.remove(s, a).changed, true);
  assert.equal(s.projects.length, 0);
  assert.equal(s.placements[IMG(1)], P.UNSORTED);
  assert.equal(P.remove(s, a).error, 'No such project.');
});

test('references: added once, capped, removed, and pooled for the pruner', () => {
  const s = P.empty();
  const a = P.create(s, 'A').project.id;
  assert.equal(P.addReference(s, a, IMG(1)).changed, true);
  assert.equal(P.addReference(s, a, IMG(1)).changed, false);
  assert.equal(P.addReference(s, a, 'bad').error, 'Not a valid photo.');
  for (let i = 2; i <= P.MAX_REFERENCES; i++) P.addReference(s, a, IMG(i));
  assert.match(P.addReference(s, a, IMG(99)).error, /up to/);
  assert.equal(P.allReferences(s).size, P.MAX_REFERENCES);
  assert.equal(P.removeReference(s, a, IMG(1)).changed, true);
  assert.equal(P.removeReference(s, a, IMG(1)).changed, false);
});

test('normalise drops anything malformed and fixes duplicate slugs', () => {
  const s = P.normalise({
    projects: [
      { id: 'p-aaaaaaaaaaaa', name: 'One', slug: 'one', references: ['bad', IMG(1)], defaults: { model: 'm', junk: 1 } },
      { id: 'p-bbbbbbbbbbbb', name: 'Two', slug: 'one' },
      { id: 'nope', name: 'Three' },
      { id: 'p-cccccccccccc', name: '   ' }
    ],
    placements: { [IMG(1)]: 'p-aaaaaaaaaaaa', [IMG(2)]: 'p-gone00000000', [IMG(3)]: 'unsorted', bad: 'p-aaaaaaaaaaaa' }
  });
  assert.deepEqual(s.projects.map((p) => p.slug), ['one', 'two']);
  assert.deepEqual(s.projects[0].references, [IMG(1)]);
  assert.deepEqual(s.projects[0].defaults, { model: 'm' });
  assert.deepEqual(Object.keys(s.placements).sort(), [IMG(1), IMG(3)].sort());
  assert.deepEqual(P.normalise(null), P.empty());
});
