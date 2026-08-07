/*
 * Comparación entre un punto de restauración y el estado actual del servidor.
 *
 * Sin dependencias: recibe estructuras ya serializadas, de modo que la lógica
 * puede ejercitarse de forma aislada sin necesidad de un servidor de Discord.
 *
 * La comparación se hace por identificador y, si el elemento ya no existe con
 * ese id, se intenta por nombre. Un canal recreado a mano tras un ataque tiene
 * id nuevo pero el mismo nombre, y contarlo como perdido sería engañoso.
 */

const CHANNEL_FIELDS = Object.freeze(['name', 'type', 'parentId', 'topic', 'nsfw', 'rateLimitPerUser']);
const ROLE_FIELDS = Object.freeze(['name', 'color', 'hoist', 'mentionable', 'permissions']);

function byId(items) {
  const map = new Map();
  for (const item of items ?? []) map.set(item.id, item);
  return map;
}

function byName(items) {
  const map = new Map();
  for (const item of items ?? []) {
    const key = String(item.name ?? '').toLocaleLowerCase('es');
    if (!map.has(key)) map.set(key, item);
  }
  return map;
}

function changedFields(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    const previous = before?.[field] ?? null;
    const current = after?.[field] ?? null;
    if (String(previous) !== String(current)) {
      changes.push({ field, before: previous, after: current });
    }
  }
  return changes;
}

function overwritesFingerprint(overwrites) {
  return (overwrites ?? [])
    .map((item) => `${item.id}:${item.allow}:${item.deny}`)
    .sort()
    .join('|');
}

/*
 * Clasifica cada elemento del punto de restauración en:
 *   missing: estaba guardado y ya no existe (ni por id ni por nombre)
 *   renamed: existe con el mismo nombre pero otro id, es decir, recreado
 *   changed: sigue existiendo pero con alguna propiedad distinta
 *   intact:  sin cambios
 * y detecta lo que existe ahora y no estaba en el punto (added).
 */
export function diffCollection(saved, current, fields, { compareOverwrites = false } = {}) {
  const currentById = byId(current);
  const currentByName = byName(current);
  const matchedIds = new Set();

  const missing = [];
  const recreated = [];
  const changed = [];
  let intact = 0;

  for (const item of saved ?? []) {
    const sameId = currentById.get(item.id);
    if (sameId) {
      matchedIds.add(sameId.id);
      const changes = changedFields(item, sameId, fields);
      if (compareOverwrites
        && overwritesFingerprint(item.permissionOverwrites) !== overwritesFingerprint(sameId.permissionOverwrites)) {
        changes.push({ field: 'permisos', before: 'guardados', after: 'distintos' });
      }
      if (changes.length) changed.push({ id: item.id, name: item.name, changes });
      else intact += 1;
      continue;
    }

    const sameName = currentByName.get(String(item.name ?? '').toLocaleLowerCase('es'));
    if (sameName && !matchedIds.has(sameName.id)) {
      matchedIds.add(sameName.id);
      recreated.push({ id: item.id, currentId: sameName.id, name: item.name });
      continue;
    }

    missing.push(item);
  }

  const added = (current ?? []).filter((item) => !matchedIds.has(item.id));
  return { missing, recreated, changed, added, intact };
}

export function diffSnapshot(point, currentState) {
  const channels = diffCollection(
    point?.channels,
    currentState?.channels,
    CHANNEL_FIELDS,
    { compareOverwrites: true },
  );
  const roles = diffCollection(point?.roles, currentState?.roles, ROLE_FIELDS);

  const lost = channels.missing.length + roles.missing.length;
  const altered = channels.changed.length + roles.changed.length;
  return {
    channels,
    roles,
    summary: {
      lost,
      altered,
      recreated: channels.recreated.length + roles.recreated.length,
      added: channels.added.length + roles.added.length,
      intact: channels.intact + roles.intact,
      // Un servidor con elementos perdidos es el caso que justifica restaurar.
      needsAttention: lost > 0 || altered > 0,
      severity: lost > 0 ? 'critical' : altered > 0 ? 'warning' : 'ok',
    },
  };
}

/* Texto corto para el panel y para el registro de auditoría. */
export function describeDiff(diff) {
  if (!diff?.summary) return 'Sin datos para comparar.';
  const { lost, altered, recreated, added } = diff.summary;
  if (!lost && !altered && !recreated && !added) return 'La estructura coincide con el punto guardado.';
  const parts = [];
  if (lost) parts.push(`${lost} elemento(s) perdido(s)`);
  if (altered) parts.push(`${altered} con cambios`);
  if (recreated) parts.push(`${recreated} recreado(s) a mano`);
  if (added) parts.push(`${added} nuevo(s) desde entonces`);
  return parts.join(' · ');
}
