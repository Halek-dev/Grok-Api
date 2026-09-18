'use strict';

/**
 * Where saved images, the usage log and favourites live.
 *
 * On Railway, Fly and most container hosts the service's own disk is replaced
 * on every deploy, so anything written next to server.js disappears with each
 * push. Only a mounted volume survives. This decides the folder, and says when
 * the choice means the history will not survive a deploy. Pure: no I/O.
 *
 * Order: an explicit DATA_DIR wins. Otherwise, if Railway reports an attached
 * volume (it sets RAILWAY_VOLUME_MOUNT_PATH), use that — attaching a volume is
 * then the whole fix, with no variable to remember. Otherwise the project
 * folder, which is right on a laptop and wrong on a container host.
 */
const path = require('node:path');

function resolveStorage(env, root) {
  const get = function (name) {
    const v = env(name);
    return v === undefined || v === null || String(v).trim() === '' ? '' : String(v).trim();
  };
  const explicit = get('DATA_DIR');
  const volume = get('RAILWAY_VOLUME_MOUNT_PATH');
  // Any of these means "this is a Railway container".
  const onRailway = Boolean(get('RAILWAY_ENVIRONMENT') || get('RAILWAY_PROJECT_ID') || get('RAILWAY_SERVICE_ID'));

  let dir, source;
  if (explicit) { dir = explicit; source = 'DATA_DIR'; }
  else if (volume) { dir = volume; source = 'Railway volume'; }
  else { dir = root; source = 'project folder'; }
  dir = path.resolve(dir);

  // Survives a deploy only if it sits on the mounted volume. With no volume at
  // all nothing does; with a volume but a DATA_DIR pointing elsewhere, the
  // volume is attached and unused, which is the easiest mistake to make.
  let ephemeral = false;
  let why = '';
  if (onRailway) {
    const vol = volume ? path.resolve(volume) : '';
    const inside = vol && (dir === vol || dir.startsWith(vol + path.sep));
    if (!vol) {
      ephemeral = true;
      why = 'no volume is attached to this Railway service';
    } else if (!inside) {
      ephemeral = true;
      why = 'DATA_DIR (' + dir + ') is not inside the attached volume (' + vol + ')';
    }
  }
  return { dir: dir, source: source, onRailway: onRailway, ephemeral: ephemeral, why: why };
}

module.exports = { resolveStorage: resolveStorage };
