import {
  AuditLogEvent,
  ChannelType,
  Events,
  PermissionFlagsBits,
} from 'discord.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const SUPPORTED_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
];

function serializeOverwrites(channel) {
  return channel.permissionOverwrites?.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  })) ?? [];
}

function serializeChannel(channel) {
  if (!SUPPORTED_CHANNEL_TYPES.has(channel.type)) return null;
  if ('topic' in channel && channel.topic?.startsWith('ticket-owner:')) return null;
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    parentId: channel.parentId,
    position: channel.rawPosition,
    topic: 'topic' in channel ? channel.topic : null,
    nsfw: 'nsfw' in channel ? channel.nsfw : false,
    rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 0,
    bitrate: 'bitrate' in channel ? channel.bitrate : null,
    userLimit: 'userLimit' in channel ? channel.userLimit : null,
    availableTags: 'availableTags' in channel ? channel.availableTags : [],
    defaultReactionEmoji: 'defaultReactionEmoji' in channel ? channel.defaultReactionEmoji : null,
    defaultAutoArchiveDuration: 'defaultAutoArchiveDuration' in channel ? channel.defaultAutoArchiveDuration : null,
    defaultThreadRateLimitPerUser: 'defaultThreadRateLimitPerUser' in channel ? channel.defaultThreadRateLimitPerUser : null,
    defaultSortOrder: 'defaultSortOrder' in channel ? channel.defaultSortOrder : null,
    defaultForumLayout: 'defaultForumLayout' in channel ? channel.defaultForumLayout : null,
    permissionOverwrites: serializeOverwrites(channel),
  };
}

function serializeRole(role) {
  if (role.managed || role.id === role.guild.id) return null;
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.rawPosition,
    memberIds: role.members.map((member) => member.id),
  };
}

function serializeEmoji(emoji) {
  return {
    id: emoji.id,
    name: emoji.name,
    imageUrl: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 256 }),
  };
}

function liveResource(guild, resourceType, id) {
  if (resourceType === 'channel') return guild.channels.cache.get(id);
  if (resourceType === 'role') return guild.roles.cache.get(id);
  return guild.emojis.cache.get(id);
}

export class AntiNuke {
  constructor(client, store, antiRaid) {
    this.client = client;
    this.store = store;
    this.antiRaid = antiRaid;
    this.actions = new Map();
    this.processedEntries = new Set();
    this.restoredIds = new Map();
    this.restoreTasks = new Map();
    this.eventQueues = new Map();
    this.snapshotTimers = new Map();
  }

  settings(guildId) {
    return this.store.getGuildSettings(guildId).antiNuke;
  }

  start() {
    this.client.on(Events.ChannelDelete, (channel) => {
      if (channel.guild) this.enqueueDeleted(channel.guild, 'channel', channel.id, AuditLogEvent.ChannelDelete);
    });
    this.client.on(Events.GuildRoleDelete, (role) => {
      this.enqueueDeleted(role.guild, 'role', role.id, AuditLogEvent.RoleDelete);
    });
    this.client.on(Events.GuildEmojiDelete, (emoji) => {
      this.enqueueDeleted(emoji.guild, 'emoji', emoji.id, AuditLogEvent.EmojiDelete);
    });

    this.client.on(Events.ChannelCreate, (channel) => this.onChanged(channel.guild, AuditLogEvent.ChannelCreate, channel.id));
    this.client.on(Events.ChannelUpdate, (_oldValue, channel) => this.onChanged(channel.guild, AuditLogEvent.ChannelUpdate, channel.id));
    this.client.on(Events.GuildRoleCreate, (role) => this.onChanged(role.guild, AuditLogEvent.RoleCreate, role.id));
    this.client.on(Events.GuildRoleUpdate, (_oldValue, role) => this.onChanged(role.guild, AuditLogEvent.RoleUpdate, role.id));
    this.client.on(Events.GuildEmojiCreate, (emoji) => this.onChanged(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id));
    this.client.on(Events.GuildEmojiUpdate, (_oldValue, emoji) => this.onChanged(emoji.guild, AuditLogEvent.EmojiUpdate, emoji.id));
    this.client.on(Events.GuildMemberUpdate, (oldMember, member) => {
      const rolesChanged = oldMember.roles.cache.size !== member.roles.cache.size
        || oldMember.roles.cache.some((_role, id) => !member.roles.cache.has(id));
      if (rolesChanged) this.onMemberRolesChanged(member).catch(console.error);
    });
    this.client.on(Events.GuildMemberRemove, (member) => {
      this.store.syncAntiNukeMemberRoles(member.guild.id, member.id, []).catch(console.error);
    });
    this.client.once(Events.ClientReady, async (readyClient) => {
      const guild = readyClient.guilds.cache.get(this.store.guildId);
      if (!guild) return;
      try {
        await guild.members.fetch();
      } catch (error) {
        console.error('Anti-Nuke conservó el snapshot anterior: no pudo cargar todos los miembros.', error);
        return;
      }
      await this.captureSnapshot(guild, { waitForIdle: true }).catch(console.error);
    });
  }

  isRestoring(guildId) {
    return this.eventQueues.has(guildId)
      || [...this.restoreTasks.keys()].some((key) => key.startsWith(`${guildId}:`));
  }

  async waitUntilIdle(guildId, timeoutMs = 15_000) {
    const startedAt = Date.now();
    while (this.isRestoring(guildId)) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('Anti-Nuke está procesando una restauración. Inténtalo nuevamente en unos segundos.');
      }
      await sleep(250);
    }
  }

  status(guildId) {
    const settings = this.settings(guildId);
    return {
      enabled: settings.enabled,
      emergencyMode: settings.emergencyMode,
      autoRestore: settings.autoRestore,
      snapshots: {
        channels: settings.snapshot.channels.length,
        roles: settings.snapshot.roles.length,
        emojis: settings.snapshot.emojis.length,
        capturedAt: settings.snapshot.capturedAt,
      },
      incidents: settings.incidents.slice(0, 20),
    };
  }

  enqueueDeleted(guild, resourceType, targetId, auditType) {
    const previous = this.eventQueues.get(guild.id) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.onDeleted(guild, resourceType, targetId, auditType))
      .catch(console.error);
    this.eventQueues.set(guild.id, operation);
    operation.finally(() => {
      if (this.eventQueues.get(guild.id) === operation) this.eventQueues.delete(guild.id);
    });
  }

  async onChanged(guild, auditType, targetId) {
    if (!guild || !this.settings(guild.id).enabled || this.isRestoring(guild.id)) return;
    const entry = await this.findAuditEntry(guild, auditType, targetId, 3);
    if (this.isRestoring(guild.id)) return;
    if (entry && this.antiRaid.isTrusted(guild, entry.executorId)) this.scheduleSnapshot(guild);
  }

  async onMemberRolesChanged(member) {
    if (!member.guild || !this.settings(member.guild.id).enabled) return;
    const entry = await this.findAuditEntry(
      member.guild,
      AuditLogEvent.MemberRoleUpdate,
      member.id,
      3,
    );
    if (!entry || !this.antiRaid.isTrusted(member.guild, entry.executorId)) return;
    const roleIds = member.roles.cache
      .filter((role) => !role.managed && role.id !== member.guild.id)
      .map((role) => role.id);
    await this.store.syncAntiNukeMemberRoles(member.guild.id, member.id, roleIds);
  }

  scheduleSnapshot(guild, delay = 1_500) {
    if (!guild) return;
    clearTimeout(this.snapshotTimers.get(guild.id));
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(guild.id);
      this.captureSnapshot(guild).catch(console.error);
    }, delay);
    timer.unref();
    this.snapshotTimers.set(guild.id, timer);
  }

  async captureSnapshot(guild, { waitForIdle = false } = {}) {
    if (this.isRestoring(guild.id)) {
      if (waitForIdle) await this.waitUntilIdle(guild.id);
      else {
        this.scheduleSnapshot(guild, 2_000);
        return null;
      }
    }
    const snapshot = {
      channels: guild.channels.cache.map(serializeChannel).filter(Boolean),
      roles: guild.roles.cache.map(serializeRole).filter(Boolean),
      emojis: guild.emojis.cache.map(serializeEmoji),
      capturedAt: new Date().toISOString(),
    };
    await this.store.replaceAntiNukeSnapshot(guild.id, snapshot);
    return snapshot;
  }

  async findAuditEntry(guild, type, targetId, attempts = 5) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt) await sleep(1_000);
      const logs = await guild.fetchAuditLogs({ type, limit: 50 }).catch(() => null);
      const entry = logs?.entries.find(
        (item) => item.targetId === targetId && Date.now() - item.createdTimestamp < 120_000,
      );
      if (entry) return entry;
    }
    return null;
  }

  trackAction(guildId, executorId, windowSeconds) {
    const now = Date.now();
    const key = `${guildId}:${executorId}`;
    const records = (this.actions.get(key) ?? []).filter(
      (timestamp) => now - timestamp <= windowSeconds * 1_000,
    );
    records.push(now);
    this.actions.set(key, records);
    return records.length;
  }

  resolveReplacement(id) {
    return this.restoredIds.get(id) ?? id;
  }

  async ensureChannelDependencies(guild, snapshot) {
    const relationErrors = [];
    const securitySnapshot = this.settings(guild.id).snapshot;
    if (snapshot.parentId && !guild.channels.cache.has(this.resolveReplacement(snapshot.parentId))) {
      const parent = securitySnapshot.channels.find((item) => item.id === snapshot.parentId);
      if (parent) {
        const result = await this.restore(guild, 'channel', parent);
        relationErrors.push(...result.relationErrors);
      }
    }
    for (const overwrite of snapshot.permissionOverwrites) {
      if (overwrite.type !== 0 || guild.roles.cache.has(this.resolveReplacement(overwrite.id))) continue;
      const role = securitySnapshot.roles.find((item) => item.id === overwrite.id);
      if (role) {
        const result = await this.restore(guild, 'role', role);
        relationErrors.push(...result.relationErrors);
      }
    }
    return relationErrors;
  }

  async restoreChannel(guild, snapshot) {
    const relationErrors = await this.ensureChannelDependencies(guild, snapshot);
    const options = {
      name: snapshot.name,
      type: snapshot.type,
      position: snapshot.position,
      permissionOverwrites: snapshot.permissionOverwrites.map((overwrite) => ({
        id: this.resolveReplacement(overwrite.id),
        type: overwrite.type,
        allow: BigInt(overwrite.allow),
        deny: BigInt(overwrite.deny),
      })),
      reason: 'BLL Anti-Nuke: restauración automática',
    };
    if (snapshot.parentId) options.parent = this.resolveReplacement(snapshot.parentId);
    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(snapshot.type)) {
      options.topic = snapshot.topic;
      options.nsfw = snapshot.nsfw;
      options.rateLimitPerUser = snapshot.rateLimitPerUser;
    }
    if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(snapshot.type)) {
      options.bitrate = snapshot.bitrate;
      options.userLimit = snapshot.userLimit;
    }
    if ([ChannelType.GuildForum, ChannelType.GuildMedia].includes(snapshot.type)) {
      options.topic = snapshot.topic;
      options.nsfw = snapshot.nsfw;
      options.rateLimitPerUser = snapshot.rateLimitPerUser;
      options.availableTags = snapshot.availableTags;
      options.defaultReactionEmoji = snapshot.defaultReactionEmoji;
      options.defaultAutoArchiveDuration = snapshot.defaultAutoArchiveDuration;
      options.defaultThreadRateLimitPerUser = snapshot.defaultThreadRateLimitPerUser;
      options.defaultSortOrder = snapshot.defaultSortOrder;
      options.defaultForumLayout = snapshot.defaultForumLayout;
    }
    return { resource: await guild.channels.create(options), relationErrors: [...new Set(relationErrors)] };
  }

  async restoreRoleRelations(guild, snapshot, role) {
    const errors = [];
    const memberResults = await Promise.allSettled((snapshot.memberIds ?? []).map(async (memberId) => {
      const member = guild.members.cache.get(memberId) ?? await guild.members.fetch(memberId);
      await member.roles.add(role, 'BLL Anti-Nuke: membresía de rol restaurada');
    }));
    if (memberResults.some((result) => result.status === 'rejected')) errors.push('No se restauraron todas las membresías.');

    const channelSnapshots = this.settings(guild.id).snapshot.channels;
    for (const channelSnapshot of channelSnapshots) {
      const original = channelSnapshot.permissionOverwrites.find((overwrite) => overwrite.id === snapshot.id);
      if (!original) continue;
      const channel = guild.channels.cache.get(this.resolveReplacement(channelSnapshot.id));
      if (!channel?.permissionOverwrites) continue;
      try {
        const overwrites = channel.permissionOverwrites.cache
          .filter((overwrite) => overwrite.id !== role.id)
          .map((overwrite) => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield,
          }));
        overwrites.push({
          id: role.id,
          type: original.type,
          allow: BigInt(original.allow),
          deny: BigInt(original.deny),
        });
        await channel.permissionOverwrites.set(overwrites, 'BLL Anti-Nuke: permisos de rol restaurados');
      } catch {
        errors.push(`No se restauraron permisos en ${channel.name}.`);
      }
    }
    return [...new Set(errors)];
  }

  async restoreRole(guild, snapshot) {
    const role = await guild.roles.create({
      name: snapshot.name,
      color: snapshot.color,
      hoist: snapshot.hoist,
      mentionable: snapshot.mentionable,
      permissions: BigInt(snapshot.permissions),
      reason: 'BLL Anti-Nuke: restauración automática',
    });
    const relationErrors = [];
    try {
      await role.setPosition(snapshot.position, 'BLL Anti-Nuke: posición restaurada');
    } catch {
      relationErrors.push('No se pudo restaurar la posición original del rol.');
    }
    relationErrors.push(...await this.restoreRoleRelations(guild, snapshot, role));
    return { resource: role, relationErrors: [...new Set(relationErrors)] };
  }

  async restoreEmoji(guild, snapshot) {
    const emoji = await guild.emojis.create({
      attachment: snapshot.imageUrl,
      name: snapshot.name,
      reason: 'BLL Anti-Nuke: restauración automática',
    });
    return { resource: emoji, relationErrors: [] };
  }

  async performRestore(guild, resourceType, snapshot) {
    if (resourceType === 'channel') return this.restoreChannel(guild, snapshot);
    if (resourceType === 'role') return this.restoreRole(guild, snapshot);
    return this.restoreEmoji(guild, snapshot);
  }

  async restore(guild, resourceType, snapshot) {
    if (!snapshot) throw new Error('No existe una copia previa de este recurso.');
    const replacementId = this.restoredIds.get(snapshot.id);
    const replacement = replacementId ? liveResource(guild, resourceType, replacementId) : null;
    if (replacement) return { resource: replacement, relationErrors: [] };
    const key = `${guild.id}:${resourceType}:${snapshot.id}`;
    if (this.restoreTasks.has(key)) return this.restoreTasks.get(key);
    const operation = this.performRestore(guild, resourceType, snapshot).then((result) => {
      this.restoredIds.set(snapshot.id, result.resource.id);
      return result;
    });
    this.restoreTasks.set(key, operation);
    try { return await operation; }
    finally { this.restoreTasks.delete(key); }
  }

  async removeDangerousRoles(member) {
    if (!member) return 0;
    const dangerous = member.roles.cache.filter(
      (role) => role.editable && DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission)),
    );
    if (!dangerous.size) return 0;
    await member.roles.remove(dangerous, 'BLL Anti-Nuke: neutralización preventiva');
    return dangerous.size;
  }

  async neutralize(guild, executorId, settings, reason) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return { rolesRemoved: 0, rolesError: 'Miembro no disponible.', sanctioned: false };
    let rolesRemoved = 0;
    let rolesError = '';
    if (settings.removeDangerousRoles) {
      try { rolesRemoved = await this.removeDangerousRoles(member); }
      catch (error) { rolesError = error.message; }
    }
    const sanctioned = await this.antiRaid.applyAction(member, reason);
    return { rolesRemoved, rolesError, sanctioned };
  }

  async onDeleted(guild, resourceType, targetId, auditType) {
    const settingsBefore = this.settings(guild.id);
    if (!settingsBefore.enabled) return;
    const resourceSnapshot = settingsBefore.snapshot[`${resourceType}s`].find((item) => item.id === targetId);
    const entry = await this.findAuditEntry(guild, auditType, targetId);
    const settings = this.settings(guild.id);
    if (!settings.enabled) return;
    if (entry && this.processedEntries.has(entry.id)) return;
    if (entry) {
      this.processedEntries.add(entry.id);
      if (this.processedEntries.size > 1_000) this.processedEntries.clear();
      if (this.antiRaid.isTrusted(guild, entry.executorId)) {
        this.scheduleSnapshot(guild);
        return;
      }
    }

    let restored = false;
    let restoreError = '';
    let relationErrors = [];
    if (settings.autoRestore) {
      try {
        const result = await this.restore(guild, resourceType, resourceSnapshot);
        restored = true;
        relationErrors = result.relationErrors;
      } catch (error) {
        restoreError = error.message;
      }
    }

    const count = entry ? this.trackAction(guild.id, entry.executorId, settings.actionWindowSeconds) : 0;
    const threshold = settings.emergencyMode ? 1 : settings.actionThreshold;
    let neutralization = { rolesRemoved: 0, rolesError: '', sanctioned: false };
    if (entry && count >= threshold) {
      neutralization = await this.neutralize(
        guild,
        entry.executorId,
        settings,
        `${resourceType} eliminado sin autorización`,
      );
      this.antiRaid.activateRaidMode(
        guild,
        `Anti-Nuke detectó eliminaciones destructivas de <@${entry.executorId}>.`,
      );
    }
    const neutralized = neutralization.rolesRemoved > 0 || neutralization.sanctioned;

    const incident = await this.store.recordAntiNukeIncident(guild.id, {
      resourceType,
      resourceId: targetId,
      resourceName: resourceSnapshot?.name ?? targetId,
      executorId: entry?.executorId ?? null,
      attributionMissing: !entry,
      actionCount: count,
      restored,
      restoreError,
      relationErrors,
      rolesRemoved: neutralization.rolesRemoved,
      rolesError: neutralization.rolesError,
      sanctioned: neutralization.sanctioned,
      emergencyMode: settings.emergencyMode,
    });
    const outcome = restored
      ? relationErrors.length ? `recreado con avisos: ${relationErrors.join(' ')}` : 'recurso restaurado'
      : restoreError ? `restauración fallida: ${restoreError}` : 'restauración desactivada';
    const actor = entry ? `<@${entry.executorId}>` : 'Autor no identificado';
    const reachedThreshold = Boolean(entry && count >= threshold);
    const title = reachedThreshold
      ? neutralized ? 'Anti-Nuke · Amenaza neutralizada' : 'Anti-Nuke · No se pudo neutralizar'
      : 'Anti-Nuke · Eliminación detectada';
    await this.antiRaid.log(
      guild,
      title,
      `${actor} eliminó **${incident.resourceName}** (${resourceType}). ${outcome}. Acciones: ${count}/${threshold}.`,
      reachedThreshold && !neutralized ? 0xed4245 : reachedThreshold ? 0x57f287 : 0xfee75c,
    );
    if (restored) this.scheduleSnapshot(guild, 2_000);
  }
}
