import { ChannelType, PermissionsBitField } from 'discord.js';
import { serializeChannel, serializeRole } from './antiNuke.js';
import { diffSnapshot } from './snapshotDiff.js';

/*
 * Puntos de restauración del servidor.
 *
 * Anti-Nuke mantiene una única copia viva para reponer lo que se borra mientras
 * está vigilando. Esto es distinto: guarda varias fotos con fecha que permiten
 * reconstruir la estructura aunque el ataque ocurriera con el bot caído, sin
 * permisos o llegando tarde.
 *
 * Regla de diseño: la restauración es SIEMPRE aditiva. Crea lo que falta y no
 * borra ni renombra nada de lo que existe. Restaurar no puede empeorar el
 * estado del servidor, y un punto antiguo nunca destruye trabajo reciente.
 */

const RESTORABLE_TYPES = new Set([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
]);

/* Permisos que no se reponen automáticamente: un punto antiguo no debe
 * devolver privilegios de administración a un rol que se degradó a propósito. */
const DANGEROUS_PERMISSIONS = new PermissionsBitField([
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
]);

export function captureServerState(guild) {
  const channels = [...guild.channels.cache.values()]
    .map((channel) => serializeChannel(channel))
    .filter(Boolean);
  const roles = [...guild.roles.cache.values()]
    .map((role) => serializeRole(role))
    .filter(Boolean);
  return { channels, roles };
}

export function buildRestorePoint(guild, { name, actor }) {
  const state = captureServerState(guild);
  return {
    name,
    createdBy: actor,
    guildName: guild.name,
    channels: state.channels,
    roles: state.roles,
  };
}

export function compareWithGuild(point, guild) {
  return diffSnapshot(point, captureServerState(guild));
}

function sanitizeOverwrites(overwrites, guild) {
  return (overwrites ?? [])
    .filter((item) => guild.roles.cache.has(item.id) || guild.members.cache.has(item.id))
    .map((item) => ({
      id: item.id,
      type: item.type,
      allow: BigInt(item.allow ?? '0'),
      deny: BigInt(item.deny ?? '0'),
    }));
}

/*
 * Recrea los roles que faltan. Devuelve un mapa del id antiguo al nuevo para
 * que los permisos de canal puedan apuntar a los roles recién creados.
 */
async function restoreRoles(guild, missingRoles, { keepDangerousPermissions }) {
  const mapping = new Map();
  const created = [];
  const failed = [];

  // De menor a mayor posición: así la jerarquía resultante se parece a la guardada.
  const ordered = [...missingRoles].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  for (const role of ordered) {
    let permissions = new PermissionsBitField(BigInt(role.permissions ?? '0'));
    let trimmed = false;
    if (!keepDangerousPermissions && permissions.any(DANGEROUS_PERMISSIONS)) {
      permissions = new PermissionsBitField(permissions.bitfield & ~DANGEROUS_PERMISSIONS.bitfield);
      trimmed = true;
    }
    try {
      const fresh = await guild.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions,
        reason: 'BLL Punto de restauración',
      });
      mapping.set(role.id, fresh.id);
      created.push({ name: role.name, id: fresh.id, trimmed });
    } catch (error) {
      console.error(`No se pudo recrear el rol ${role.name}:`, error);
      failed.push({ name: role.name, error: error.message });
    }
  }
  return { mapping, created, failed };
}

async function restoreChannels(guild, missingChannels, roleMapping) {
  const created = [];
  const failed = [];
  const categoryMapping = new Map();

  const remap = (id) => roleMapping.get(id) ?? id;
  // Las categorías primero: los canales necesitan su padre ya creado.
  const categories = missingChannels.filter((channel) => channel.type === ChannelType.GuildCategory);
  const rest = missingChannels.filter((channel) => channel.type !== ChannelType.GuildCategory);

  for (const channel of [...categories, ...rest]) {
    if (!RESTORABLE_TYPES.has(channel.type)) continue;
    const parentId = channel.parentId ? categoryMapping.get(channel.parentId) ?? channel.parentId : null;
    const parentExists = parentId && guild.channels.cache.has(parentId);
    try {
      const fresh = await guild.channels.create({
        name: channel.name,
        type: channel.type,
        parent: parentExists ? parentId : null,
        topic: channel.topic ?? undefined,
        nsfw: channel.nsfw ?? undefined,
        rateLimitPerUser: channel.rateLimitPerUser ?? undefined,
        bitrate: channel.bitrate ?? undefined,
        userLimit: channel.userLimit ?? undefined,
        permissionOverwrites: sanitizeOverwrites(
          (channel.permissionOverwrites ?? []).map((item) => ({ ...item, id: remap(item.id) })),
          guild,
        ),
        reason: 'BLL Punto de restauración',
      });
      if (channel.type === ChannelType.GuildCategory) categoryMapping.set(channel.id, fresh.id);
      created.push({ name: channel.name, id: fresh.id });
    } catch (error) {
      console.error(`No se pudo recrear el canal ${channel.name}:`, error);
      failed.push({ name: channel.name, error: error.message });
    }
  }
  return { created, failed };
}

/*
 * Restaura un punto sobre el servidor.
 *
 * scope: 'all' | 'channels' | 'roles'
 * keepDangerousPermissions: repone también permisos de administración.
 */
export async function restorePoint(guild, point, {
  scope = 'all',
  keepDangerousPermissions = false,
} = {}) {
  const diff = compareWithGuild(point, guild);
  const wantsRoles = scope === 'all' || scope === 'roles';
  const wantsChannels = scope === 'all' || scope === 'channels';

  const roleResult = wantsRoles
    ? await restoreRoles(guild, diff.roles.missing, { keepDangerousPermissions })
    : { mapping: new Map(), created: [], failed: [] };

  const channelResult = wantsChannels
    ? await restoreChannels(guild, diff.channels.missing, roleResult.mapping)
    : { created: [], failed: [] };

  return {
    roles: { created: roleResult.created, failed: roleResult.failed },
    channels: { created: channelResult.created, failed: channelResult.failed },
    trimmedRoles: roleResult.created.filter((role) => role.trimmed).map((role) => role.name),
    summary: {
      rolesCreated: roleResult.created.length,
      channelsCreated: channelResult.created.length,
      failures: roleResult.failed.length + channelResult.failed.length,
    },
  };
}
