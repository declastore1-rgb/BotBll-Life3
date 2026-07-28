import {
  AuditLogEvent,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from 'discord.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const LINK_PATTERN = /(?:https?:\/\/|www\.|discord(?:app)?\.com\/invite\/|discord\.gg\/|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,})(?:[^\s<]*)/gi;

export class AntiRaid {
  constructor(client, store) {
    this.client = client;
    this.store = store;
    this.joins = new Map();
    this.messages = new Map();
    this.spamWarnings = new Map();
    this.actions = new Map();
    this.raidModeUntil = new Map();
  }

  settings(guildId) {
    return this.store.getGuildSettings(guildId).antiRaid;
  }

  start() {
    this.client.on(Events.GuildMemberAdd, (member) => this.onMemberAdd(member).catch(console.error));
    this.client.on(Events.MessageCreate, (message) => this.onMessage(message).catch(console.error));
    this.client.on(Events.GuildBanAdd, (ban) => {
      this.onDestructiveEvent(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, 'baneos masivos').catch(console.error);
    });
    this.client.on(Events.WebhooksUpdate, (channel) => {
      this.onWebhookUpdate(channel.guild).catch(console.error);
    });
  }

  isTrusted(guild, userId, settings = this.settings(guild.id)) {
    if (!userId) return true;
    return userId === guild.ownerId
      || userId === this.client.user?.id
      || settings.trustedUserIds.includes(userId);
  }

  isRaidMode(guildId) {
    return (this.raidModeUntil.get(guildId) ?? 0) > Date.now();
  }

  clearRaidMode(guildId) {
    this.raidModeUntil.delete(guildId);
    this.joins.delete(guildId);
    for (const key of this.messages.keys()) {
      if (key.startsWith(`${guildId}:`)) this.messages.delete(key);
    }
    for (const key of this.spamWarnings.keys()) {
      if (key.startsWith(`${guildId}:`)) this.spamWarnings.delete(key);
    }
    for (const key of this.actions.keys()) {
      if (key.startsWith(`${guildId}:`)) this.actions.delete(key);
    }
  }

  status(guildId) {
    const settings = this.settings(guildId);
    return {
      enabled: settings.enabled,
      raidMode: this.isRaidMode(guildId),
      raidModeUntil: this.raidModeUntil.get(guildId) ?? null,
      action: settings.action,
      joins: `${settings.joinThreshold}/${settings.joinWindowSeconds}s`,
      minimumAge: `${settings.minAccountAgeHours}h`,
      spam: `${settings.spamMessageThreshold}/${settings.spamWindowSeconds}s`,
      spamWarning: settings.spamWarningEnabled ? `Aviso + sanción en ${settings.spamEscalationMinutes} min` : 'Sanción inmediata',
      mentions: settings.massMentionThreshold,
      destructive: `${settings.destructiveThreshold}/${settings.destructiveWindowSeconds}s`,
    };
  }

  activateRaidMode(guild, reason, settings = this.settings(guild.id)) {
    const until = Date.now() + settings.raidModeMinutes * 60_000;
    this.raidModeUntil.set(guild.id, until);
    this.log(guild, 'Modo raid activado', `${reason}\nActivo hasta <t:${Math.floor(until / 1_000)}:R>.`, 0xed4245);
  }

  async log(guild, title, description, color = 0xfee75c) {
    console.log(`[ANTI-RAID] ${guild.name}: ${title} - ${description.replaceAll('\n', ' ')}`);
    const logChannelId = this.store.getGuildSettings(guild.id).tickets.logChannelId;
    if (!logChannelId) return;
    const channel = guild.channels.cache.get(logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
    await channel.send({ embeds: [embed] }).catch(console.error);
  }

  async applyAction(member, reason, settings = this.settings(member?.guild.id)) {
    if (!member || this.isTrusted(member.guild, member.id, settings)) return false;
    const auditReason = `BLL Anti-Raid: ${reason}`;
    try {
      if (settings.action === 'ban' && member.bannable) {
        await member.ban({ reason: auditReason, deleteMessageSeconds: 60 * 60 });
        return true;
      }
      if (settings.action === 'kick' && member.kickable) {
        await member.kick(auditReason);
        return true;
      }
      if (member.moderatable) {
        await member.timeout(settings.timeoutMinutes * 60_000, auditReason);
        return true;
      }
    } catch (error) {
      console.error(`No se pudo sancionar a ${member.user?.tag ?? member.id}:`, error);
    }
    return false;
  }

  async punishExecutor(guild, executorId, reason, settings = this.settings(guild.id)) {
    if (this.isTrusted(guild, executorId, settings)) return;
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return;
    const applied = await this.applyAction(member, reason, settings);
    await this.log(
      guild,
      applied ? 'Amenaza neutralizada' : 'No se pudo sancionar',
      `<@${executorId}> fue detectado por **${reason}**.`,
      applied ? 0x57f287 : 0xed4245,
    );
  }

  async onMemberAdd(member) {
    const settings = this.settings(member.guild.id);
    if (!settings.enabled) return;
    const now = Date.now();
    const joinWindowMs = settings.joinWindowSeconds * 1_000;
    const recent = (this.joins.get(member.guild.id) ?? []).filter(
      (timestamp) => now - timestamp <= joinWindowMs,
    );
    recent.push(now);
    this.joins.set(member.guild.id, recent);

    if (member.user.bot) {
      await this.checkAddedBot(member, settings);
      return;
    }
    if (recent.length >= settings.joinThreshold && !this.isRaidMode(member.guild.id)) {
      this.activateRaidMode(
        member.guild,
        `${recent.length} cuentas entraron en ${settings.joinWindowSeconds} segundos.`,
        settings,
      );
    }

    const accountAge = now - member.user.createdTimestamp;
    if (this.isRaidMode(member.guild.id)) {
      const applied = await this.applyAction(member, 'entrada durante modo raid', settings);
      if (applied) await this.log(member.guild, 'Entrada bloqueada', `${member.user.tag} entró durante el modo raid.`);
      return;
    }
    if (accountAge < settings.minAccountAgeHours * 3_600_000) {
      const applied = await this.applyAction(member, 'cuenta demasiado nueva', settings);
      if (applied) {
        await this.log(
          member.guild,
          'Cuenta nueva bloqueada',
          `${member.user.tag} tenía una antigüedad inferior a ${settings.minAccountAgeHours} horas.`,
        );
      }
    }
  }

  async checkAddedBot(botMember, settings) {
    await sleep(750);
    settings = this.settings(botMember.guild.id);
    if (!settings.enabled) return;
    const logs = await botMember.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find(
      (item) => item.targetId === botMember.id && Date.now() - item.createdTimestamp < 10_000,
    );
    if (!entry || this.isTrusted(botMember.guild, entry.executorId, settings)) return;
    if (botMember.kickable) await botMember.kick('BLL Anti-Raid: bot no autorizado').catch(console.error);
    await this.punishExecutor(botMember.guild, entry.executorId, 'adición de bot no autorizado', settings);
  }

  async onMessage(message) {
    if (!message.guild || message.author.bot) return;
    const settings = this.settings(message.guild.id);
    if (!settings.enabled || this.isTrusted(message.guild, message.author.id, settings)) return;
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const spamWindowMs = settings.spamWindowSeconds * 1_000;
    const records = (this.messages.get(key) ?? []).filter((item) => now - item.timestamp <= spamWindowMs);
    const content = message.content.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
    records.push({ timestamp: now, content });
    this.messages.set(key, records);

    const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    const linkCount = (message.content.match(LINK_PATTERN) ?? []).length;
    const duplicateCount = content ? records.filter((item) => item.content === content).length : 0;
    const massMention = mentionCount >= settings.massMentionThreshold;
    const spam = records.length >= settings.spamMessageThreshold
      || duplicateCount >= settings.duplicateMessageThreshold
      || linkCount > settings.maxLinksPerMessage;
    if (!massMention && !spam) return;

    const reason = massMention ? 'menciones masivas' : linkCount > settings.maxLinksPerMessage ? 'exceso de enlaces' : 'spam';
    if (!massMention && settings.spamWarningEnabled) {
      const warningState = this.spamWarnings.get(key);
      if (warningState?.phase === 'pending') {
        this.messages.delete(key);
        await message.delete().catch(() => null);
        return;
      }
      if (!warningState || warningState.until <= now) {
        const pendingState = { phase: 'pending', until: Number.POSITIVE_INFINITY };
        this.spamWarnings.set(key, pendingState);
        this.messages.delete(key);
        await message.delete().catch(() => null);
        const warning = await message.channel.send({
          content: `<@${message.author.id}> ${settings.spamWarningMessage}`,
          allowedMentions: { users: [message.author.id], roles: [], parse: [] },
        }).catch(() => null);
        if (!warning) {
          if (this.spamWarnings.get(key) === pendingState) this.spamWarnings.delete(key);
          await this.log(message.guild, 'No se pudo advertir el spam', `<@${message.author.id}> superó el límite, pero el aviso no pudo enviarse.`);
          return;
        }
        if (this.spamWarnings.get(key) !== pendingState) {
          await warning.delete().catch(() => null);
          return;
        }
        const activeState = {
          phase: 'active',
          warnedAt: Date.now(),
          until: Date.now() + settings.spamEscalationMinutes * 60_000,
        };
        this.spamWarnings.set(key, activeState);
        const expirationDelay = activeState.until - Date.now();
        setTimeout(() => {
          if (this.spamWarnings.get(key) === activeState) this.spamWarnings.delete(key);
        }, expirationDelay).unref();
        setTimeout(() => warning.delete().catch(() => null), 12_000).unref();
        await this.log(message.guild, 'Advertencia de spam', `<@${message.author.id}> recibió un aviso antes de la sanción.`);
        return;
      }
    }

    const currentState = this.spamWarnings.get(key);
    if (currentState?.phase === 'sanctioning') {
      this.messages.delete(key);
      await message.delete().catch(() => null);
      return;
    }
    const escalated = currentState?.phase === 'active';
    const sanctionState = { phase: 'sanctioning', until: currentState?.until ?? now };
    this.spamWarnings.set(key, sanctionState);
    await message.delete().catch(() => null);
    const applied = await this.applyAction(message.member, reason, settings);
    this.messages.delete(key);
    if (this.spamWarnings.get(key) === sanctionState) this.spamWarnings.delete(key);
    await this.log(
      message.guild,
      applied ? 'Usuario sancionado' : 'Mensaje peligroso bloqueado',
      escalated
        ? `<@${message.author.id}> continuó con **${reason}** después del aviso.`
        : `<@${message.author.id}> fue detectado por **${reason}**.`,
    );
  }

  trackAction(guildId, executorId, action, windowMs) {
    const now = Date.now();
    const key = `${guildId}:${executorId}:${action}`;
    const timestamps = (this.actions.get(key) ?? []).filter((timestamp) => now - timestamp <= windowMs);
    timestamps.push(now);
    this.actions.set(key, timestamps);
    return timestamps.length;
  }

  async onDestructiveEvent(guild, auditType, targetId, label) {
    let settings = this.settings(guild.id);
    if (!settings.enabled) return;
    await sleep(750);
    settings = this.settings(guild.id);
    if (!settings.enabled) return;
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 }).catch(() => null);
    const entry = logs?.entries.find(
      (item) => item.targetId === targetId && Date.now() - item.createdTimestamp < 10_000,
    );
    if (!entry || this.isTrusted(guild, entry.executorId, settings)) return;

    const count = this.trackAction(
      guild.id,
      entry.executorId,
      auditType,
      settings.destructiveWindowSeconds * 1_000,
    );
    if (count < settings.destructiveThreshold) return;
    this.activateRaidMode(guild, `${label} detectados por <@${entry.executorId}>.`, settings);
    await this.punishExecutor(guild, entry.executorId, label, settings);
  }

  async onWebhookUpdate(guild) {
    let settings = this.settings(guild.id);
    if (!settings.enabled) return;
    await sleep(750);
    settings = this.settings(guild.id);
    if (!settings.enabled) return;
    const auditTypes = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate];
    for (const auditType of auditTypes) {
      const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (!entry || Date.now() - entry.createdTimestamp >= 10_000 || this.isTrusted(guild, entry.executorId, settings)) continue;
      const count = this.trackAction(
        guild.id,
        entry.executorId,
        'webhook',
        settings.destructiveWindowSeconds * 1_000,
      );
      if (count >= settings.destructiveThreshold) {
        await this.punishExecutor(guild, entry.executorId, 'cambios masivos de webhooks', settings);
      }
      break;
    }
  }
}
