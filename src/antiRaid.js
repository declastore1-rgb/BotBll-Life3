import {
  AuditLogEvent,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from './config.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class AntiRaid {
  constructor(client) {
    this.client = client;
    this.joins = new Map();
    this.messages = new Map();
    this.actions = new Map();
    this.raidModeUntil = new Map();
  }

  start() {
    this.client.on(Events.GuildMemberAdd, (member) => this.onMemberAdd(member).catch(console.error));
    this.client.on(Events.MessageCreate, (message) => this.onMessage(message).catch(console.error));
    this.client.on(Events.ChannelDelete, (channel) => {
      if (channel.guild) this.onDestructiveEvent(channel.guild, AuditLogEvent.ChannelDelete, channel.id, 'eliminación de canales').catch(console.error);
    });
    this.client.on(Events.GuildRoleDelete, (role) => {
      this.onDestructiveEvent(role.guild, AuditLogEvent.RoleDelete, role.id, 'eliminación de roles').catch(console.error);
    });
    this.client.on(Events.GuildBanAdd, (ban) => {
      this.onDestructiveEvent(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, 'baneos masivos').catch(console.error);
    });
    this.client.on(Events.WebhooksUpdate, (channel) => {
      this.onWebhookUpdate(channel.guild).catch(console.error);
    });
  }

  isTrusted(guild, userId) {
    if (!userId) return true;
    return userId === guild.ownerId || userId === this.client.user.id || config.antiRaid.trustedUserIds.has(userId);
  }

  isRaidMode(guildId) {
    return (this.raidModeUntil.get(guildId) ?? 0) > Date.now();
  }

  status(guildId) {
    return {
      enabled: config.antiRaid.enabled,
      raidMode: this.isRaidMode(guildId),
      raidModeUntil: this.raidModeUntil.get(guildId) ?? null,
      action: config.antiRaid.action,
      joins: `${config.antiRaid.joinThreshold}/${config.antiRaid.joinWindowMs / 1_000}s`,
      minimumAge: `${config.antiRaid.minAccountAgeMs / 3_600_000}h`,
      spam: `${config.antiRaid.spamMessageThreshold}/${config.antiRaid.spamWindowMs / 1_000}s`,
      mentions: config.antiRaid.massMentionThreshold,
      destructive: `${config.antiRaid.destructiveThreshold}/${config.antiRaid.destructiveWindowMs / 1_000}s`,
    };
  }

  activateRaidMode(guild, reason) {
    const until = Date.now() + config.antiRaid.raidModeMs;
    this.raidModeUntil.set(guild.id, until);
    this.log(guild, '🚨 Modo raid activado', `${reason}\nActivo hasta <t:${Math.floor(until / 1_000)}:R>.`, 0xed4245);
  }

  async log(guild, title, description, color = 0xfee75c) {
    console.log(`[ANTI-RAID] ${guild.name}: ${title} - ${description.replaceAll('\n', ' ')}`);
    if (!config.logChannelId) return;
    const channel = guild.channels.cache.get(config.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
    await channel.send({ embeds: [embed] }).catch(console.error);
  }

  async applyAction(member, reason) {
    if (!member || this.isTrusted(member.guild, member.id)) return false;
    const auditReason = `BLL Anti-Raid: ${reason}`;

    try {
      if (config.antiRaid.action === 'ban' && member.bannable) {
        await member.ban({ reason: auditReason, deleteMessageSeconds: 60 * 60 });
        return true;
      }
      if (config.antiRaid.action === 'kick' && member.kickable) {
        await member.kick(auditReason);
        return true;
      }
      if (member.moderatable) {
        await member.timeout(config.antiRaid.timeoutMs, auditReason);
        return true;
      }
    } catch (error) {
      console.error(`No se pudo sancionar a ${member.user?.tag ?? member.id}:`, error);
    }
    return false;
  }

  async punishExecutor(guild, executorId, reason) {
    if (this.isTrusted(guild, executorId)) return;
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return;
    const applied = await this.applyAction(member, reason);
    await this.log(
      guild,
      applied ? '🛡️ Amenaza neutralizada' : '⚠️ No se pudo sancionar',
      `<@${executorId}> fue detectado por **${reason}**.`,
      applied ? 0x57f287 : 0xed4245,
    );
  }

  async onMemberAdd(member) {
    if (!config.antiRaid.enabled) return;
    const now = Date.now();
    const recent = (this.joins.get(member.guild.id) ?? []).filter(
      (timestamp) => now - timestamp <= config.antiRaid.joinWindowMs,
    );
    recent.push(now);
    this.joins.set(member.guild.id, recent);

    if (member.user.bot) {
      await this.checkAddedBot(member);
      return;
    }

    if (recent.length >= config.antiRaid.joinThreshold && !this.isRaidMode(member.guild.id)) {
      this.activateRaidMode(
        member.guild,
        `${recent.length} cuentas entraron en ${config.antiRaid.joinWindowMs / 1_000} segundos.`,
      );
    }

    const accountAge = now - member.user.createdTimestamp;
    if (this.isRaidMode(member.guild.id)) {
      const applied = await this.applyAction(member, 'entrada durante modo raid');
      if (applied) await this.log(member.guild, 'Entrada bloqueada', `${member.user.tag} entró durante el modo raid.`);
      return;
    }

    if (accountAge < config.antiRaid.minAccountAgeMs) {
      const applied = await this.applyAction(member, 'cuenta demasiado nueva');
      if (applied) {
        await this.log(
          member.guild,
          'Cuenta nueva bloqueada',
          `${member.user.tag} tenía una antigüedad inferior a ${config.antiRaid.minAccountAgeMs / 3_600_000} horas.`,
        );
      }
    }
  }

  async checkAddedBot(botMember) {
    await sleep(750);
    const logs = await botMember.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find(
      (item) => item.targetId === botMember.id && Date.now() - item.createdTimestamp < 10_000,
    );
    if (!entry || this.isTrusted(botMember.guild, entry.executorId)) return;

    if (botMember.kickable) await botMember.kick('BLL Anti-Raid: bot no autorizado').catch(console.error);
    await this.punishExecutor(botMember.guild, entry.executorId, 'adición de bot no autorizado');
  }

  async onMessage(message) {
    if (!config.antiRaid.enabled || !message.guild || message.author.bot) return;
    if (this.isTrusted(message.guild, message.author.id)) return;
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const timestamps = (this.messages.get(key) ?? []).filter(
      (timestamp) => now - timestamp <= config.antiRaid.spamWindowMs,
    );
    timestamps.push(now);
    this.messages.set(key, timestamps);

    const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    const massMention = mentionCount >= config.antiRaid.massMentionThreshold;
    const spam = timestamps.length >= config.antiRaid.spamMessageThreshold;
    if (!massMention && !spam) return;

    await message.delete().catch(() => null);
    const reason = massMention ? 'menciones masivas' : 'spam';
    const applied = await this.applyAction(message.member, reason);
    this.messages.delete(key);
    await this.log(
      message.guild,
      applied ? 'Mensaje peligroso bloqueado' : 'Mensaje eliminado',
      `<@${message.author.id}> fue detectado por **${reason}**.`,
    );
  }

  trackAction(guildId, executorId, action) {
    const now = Date.now();
    const key = `${guildId}:${executorId}:${action}`;
    const timestamps = (this.actions.get(key) ?? []).filter(
      (timestamp) => now - timestamp <= config.antiRaid.destructiveWindowMs,
    );
    timestamps.push(now);
    this.actions.set(key, timestamps);
    return timestamps.length;
  }

  async onDestructiveEvent(guild, auditType, targetId, label) {
    if (!config.antiRaid.enabled) return;
    await sleep(750);
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 }).catch(() => null);
    const entry = logs?.entries.find(
      (item) => item.targetId === targetId && Date.now() - item.createdTimestamp < 10_000,
    );
    if (!entry || this.isTrusted(guild, entry.executorId)) return;

    const count = this.trackAction(guild.id, entry.executorId, auditType);
    if (count < config.antiRaid.destructiveThreshold) return;
    this.activateRaidMode(guild, `${label} detectados por <@${entry.executorId}>.`);
    await this.punishExecutor(guild, entry.executorId, label);
  }

  async onWebhookUpdate(guild) {
    if (!config.antiRaid.enabled) return;
    await sleep(750);
    const auditTypes = [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate];
    for (const auditType of auditTypes) {
      const logs = await guild.fetchAuditLogs({ type: auditType, limit: 1 }).catch(() => null);
      const entry = logs?.entries.first();
      if (!entry || Date.now() - entry.createdTimestamp >= 10_000 || this.isTrusted(guild, entry.executorId)) continue;
      const count = this.trackAction(guild.id, entry.executorId, 'webhook');
      if (count >= config.antiRaid.destructiveThreshold) {
        await this.punishExecutor(guild, entry.executorId, 'cambios masivos de webhooks');
      }
      break;
    }
  }
}
