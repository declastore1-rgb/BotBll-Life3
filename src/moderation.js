import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

const COLOR_ACTION = 0xed4245;
const COLOR_INFO = 0x4da3ff;
const COLOR_OK = 0x3ddc9a;
const COLOR_WARN = 0xffc25c;

const MAX_REASON = 400;
const BULK_DELETE_MAX = 100;
/* Discord no permite borrar en bloque mensajes de más de 14 días. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

function cleanReason(value) {
  const reason = (value ?? '').trim();
  if (!reason) return 'Sin motivo indicado.';
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason;
}

function auditReason(action, executorTag, reason) {
  return `BLL ${action} por ${executorTag}: ${reason}`.slice(0, 512);
}

/*
 * Comprobaciones previas comunes a toda sanción. Devuelve un mensaje de error
 * si la acción no debe ejecutarse, o null si puede continuar.
 *
 * El orden importa: primero los casos que protegen al servidor de un error
 * del propio staff (autosanción, jerarquía) y después la capacidad del bot.
 */
export function blockedReason({ interaction, targetMember, targetId, antiRaid, needs }) {
  const executor = interaction.member;
  const guild = interaction.guild;

  if (targetId === executor.id) return 'No puedes aplicarte una sanción a ti mismo.';
  if (targetId === interaction.client.user.id) return 'No puedo sancionarme a mí mismo.';
  if (targetId === guild.ownerId) return 'No se puede sancionar a la persona propietaria del servidor.';

  if (antiRaid?.isTrusted(guild, targetId)) {
    return 'Ese usuario está en la lista de confianza. Retíralo de la lista antes de sancionarlo.';
  }

  if (targetMember) {
    const executorTop = executor.roles.highest.position;
    const targetTop = targetMember.roles.highest.position;
    if (executor.id !== guild.ownerId && targetTop >= executorTop) {
      return 'Ese usuario tiene un rol igual o superior al tuyo.';
    }
    if (targetMember.roles.highest.position >= guild.members.me.roles.highest.position) {
      return 'Mi rol está por debajo del de ese usuario, así que no puedo actuar sobre él.';
    }
    if (needs === 'ban' && !targetMember.bannable) return 'No tengo permiso para banear a ese usuario.';
    if (needs === 'kick' && !targetMember.kickable) return 'No tengo permiso para expulsar a ese usuario.';
    if (needs === 'timeout' && !targetMember.moderatable) return 'No tengo permiso para aislar a ese usuario.';
  } else if (needs !== 'ban') {
    return 'Ese usuario no está en el servidor.';
  }

  return null;
}

export class Moderation {
  constructor({ client, store, antiRaid, autoMod }) {
    this.client = client;
    this.store = store;
    this.antiRaid = antiRaid;
    this.autoMod = autoMod;
  }

  /* Deja constancia en el historial del panel y en el canal de logs. */
  async record(interaction, action, description, color = COLOR_ACTION) {
    // Se guarda solo el tag: el campo actorId del historial identifica cuentas
    // del panel, no de Discord, y mezclar ambos espacios de IDs induce a error.
    await this.store.recordAudit(interaction.user.tag, 'Moderación', action)
      .catch((error) => console.error('No se pudo registrar la acción de moderación:', error));
    await this.antiRaid.log(interaction.guild, `Moderación · ${action}`, description, color);
  }

  async notifyTarget(user, guildName, action, reason) {
    const embed = new EmbedBuilder()
      .setColor(COLOR_WARN)
      .setTitle(`${action} en ${guildName}`)
      .setDescription(reason)
      .setTimestamp();
    await user.send({ embeds: [embed] }).catch(() => null);
  }

  async reply(interaction, description, color = COLOR_OK) {
    const embed = new EmbedBuilder().setColor(color).setDescription(description);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  async deny(interaction, description) {
    await this.reply(interaction, `⚠️ ${description}`, COLOR_WARN);
  }

  /*
   * Resuelve el objetivo del comando. Se usa fetch en lugar de la caché para
   * que el ban funcione también con usuarios que ya salieron del servidor.
   */
  async resolveTarget(interaction) {
    const user = interaction.options.getUser('usuario', true);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    return { user, member };
  }

  async handle(interaction) {
    const handlers = {
      warn: () => this.warn(interaction),
      timeout: () => this.timeout(interaction),
      kick: () => this.kick(interaction),
      ban: () => this.ban(interaction),
      clear: () => this.clear(interaction),
      slowmode: () => this.slowmode(interaction),
      lockdown: () => this.lockdown(interaction),
      userinfo: () => this.userinfo(interaction),
    };
    const handler = handlers[interaction.commandName];
    if (!handler) return false;
    await handler();
    return true;
  }

  async warn(interaction) {
    const { user, member } = await this.resolveTarget(interaction);
    const reason = cleanReason(interaction.options.getString('motivo'));
    const blocked = blockedReason({
      interaction, targetMember: member, targetId: user.id, antiRaid: this.antiRaid, needs: 'warn',
    });
    if (blocked) return this.deny(interaction, blocked);

    await this.notifyTarget(user, interaction.guild.name, 'Has recibido una advertencia', reason);
    await this.record(
      interaction,
      `Advertencia a ${user.tag}`,
      `<@${user.id}> fue advertido por <@${interaction.user.id}>.\n**Motivo:** ${reason}`,
      COLOR_WARN,
    );
    await this.reply(interaction, `Advertencia enviada a **${user.tag}**.`);
  }

  async timeout(interaction) {
    const { user, member } = await this.resolveTarget(interaction);
    const minutes = interaction.options.getInteger('minutos', true);
    const reason = cleanReason(interaction.options.getString('motivo'));
    const blocked = blockedReason({
      interaction, targetMember: member, targetId: user.id, antiRaid: this.antiRaid, needs: 'timeout',
    });
    if (blocked) return this.deny(interaction, blocked);

    try {
      await member.timeout(minutes * 60_000, auditReason('timeout', interaction.user.tag, reason));
    } catch (error) {
      console.error('No se pudo aplicar el timeout:', error);
      return this.deny(interaction, 'Discord rechazó el timeout. Revisa mis permisos y la jerarquía de roles.');
    }

    await this.notifyTarget(user, interaction.guild.name, `Has sido aislado ${minutes} minuto(s)`, reason);
    await this.record(
      interaction,
      `Timeout de ${minutes} min a ${user.tag}`,
      `<@${user.id}> fue aislado ${minutes} minuto(s) por <@${interaction.user.id}>.\n**Motivo:** ${reason}`,
    );
    await this.reply(interaction, `**${user.tag}** aislado durante ${minutes} minuto(s).`);
  }

  async kick(interaction) {
    const { user, member } = await this.resolveTarget(interaction);
    const reason = cleanReason(interaction.options.getString('motivo'));
    const blocked = blockedReason({
      interaction, targetMember: member, targetId: user.id, antiRaid: this.antiRaid, needs: 'kick',
    });
    if (blocked) return this.deny(interaction, blocked);

    // El aviso se envía antes de expulsar: después ya no compartimos servidor.
    await this.notifyTarget(user, interaction.guild.name, 'Has sido expulsado', reason);
    try {
      await member.kick(auditReason('expulsión', interaction.user.tag, reason));
    } catch (error) {
      console.error('No se pudo expulsar al usuario:', error);
      return this.deny(interaction, 'Discord rechazó la expulsión. Revisa mis permisos y la jerarquía de roles.');
    }

    await this.record(
      interaction,
      `Expulsión de ${user.tag}`,
      `<@${user.id}> fue expulsado por <@${interaction.user.id}>.\n**Motivo:** ${reason}`,
    );
    await this.reply(interaction, `**${user.tag}** fue expulsado.`);
  }

  async ban(interaction) {
    const { user, member } = await this.resolveTarget(interaction);
    const reason = cleanReason(interaction.options.getString('motivo'));
    const purgeHours = interaction.options.getInteger('borrar_horas') ?? 0;
    const blocked = blockedReason({
      interaction, targetMember: member, targetId: user.id, antiRaid: this.antiRaid, needs: 'ban',
    });
    if (blocked) return this.deny(interaction, blocked);

    if (member) await this.notifyTarget(user, interaction.guild.name, 'Has sido baneado', reason);
    try {
      await interaction.guild.members.ban(user.id, {
        reason: auditReason('ban', interaction.user.tag, reason),
        deleteMessageSeconds: purgeHours * 3_600,
      });
    } catch (error) {
      console.error('No se pudo banear al usuario:', error);
      return this.deny(interaction, 'Discord rechazó el ban. Revisa mis permisos y la jerarquía de roles.');
    }

    const purgeNote = purgeHours > 0 ? `\nMensajes borrados de las últimas ${purgeHours} h.` : '';
    await this.record(
      interaction,
      `Ban de ${user.tag}`,
      `<@${user.id}> fue baneado por <@${interaction.user.id}>.\n**Motivo:** ${reason}${purgeNote}`,
    );
    await this.reply(interaction, `**${user.tag}** fue baneado.${purgeNote}`);
  }

  async clear(interaction) {
    const amount = interaction.options.getInteger('cantidad', true);
    const target = interaction.options.getUser('usuario');
    const channel = interaction.channel;
    if (!channel?.isTextBased()) {
      return this.deny(interaction, 'Este comando solo funciona en canales de texto.');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const fetched = await channel.messages.fetch({ limit: BULK_DELETE_MAX }).catch(() => null);
    if (!fetched) return this.deny(interaction, 'No pude leer el historial de este canal.');

    const now = Date.now();
    const candidates = [...fetched.values()]
      .filter((message) => !message.pinned)
      .filter((message) => now - message.createdTimestamp < BULK_DELETE_MAX_AGE_MS)
      .filter((message) => !target || message.author.id === target.id)
      .slice(0, amount);

    if (!candidates.length) {
      return this.reply(
        interaction,
        'No hay mensajes que pueda borrar aquí. Los mensajes fijados y los de más de 14 días no se pueden eliminar en bloque.',
        COLOR_WARN,
      );
    }

    const deleted = await channel.bulkDelete(candidates, true).catch(() => null);
    if (!deleted) return this.deny(interaction, 'Discord rechazó el borrado. Revisa mis permisos en el canal.');

    const scope = target ? ` de **${target.tag}**` : '';
    await this.record(
      interaction,
      `Limpieza de ${deleted.size} mensaje(s)`,
      `<@${interaction.user.id}> borró ${deleted.size} mensaje(s)${scope} en ${channel}.`,
      COLOR_INFO,
    );
    await this.reply(interaction, `Se borraron **${deleted.size}** mensaje(s)${scope}.`);
  }

  async slowmode(interaction) {
    const seconds = interaction.options.getInteger('segundos', true);
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    if (!channel?.isTextBased()) return this.deny(interaction, 'Selecciona un canal de texto.');

    try {
      await channel.setRateLimitPerUser(seconds, auditReason('slowmode', interaction.user.tag, `${seconds}s`));
    } catch (error) {
      console.error('No se pudo aplicar el slowmode:', error);
      return this.deny(interaction, 'No pude cambiar el modo lento. Revisa mis permisos en ese canal.');
    }

    const label = seconds === 0 ? 'desactivado' : `${seconds} segundo(s)`;
    await this.record(
      interaction,
      `Modo lento ${label} en #${channel.name}`,
      `<@${interaction.user.id}> ajustó el modo lento de ${channel} a ${label}.`,
      COLOR_INFO,
    );
    await this.reply(interaction, `Modo lento ${label} en ${channel}.`);
  }

  async lockdown(interaction) {
    const channel = interaction.options.getChannel('canal') ?? interaction.channel;
    const unlock = interaction.options.getBoolean('abrir') ?? false;
    if (!channel?.isTextBased()) return this.deny(interaction, 'Selecciona un canal de texto.');

    const everyone = interaction.guild.roles.everyone;
    try {
      await channel.permissionOverwrites.edit(
        everyone,
        { SendMessages: unlock ? null : false },
        { reason: auditReason(unlock ? 'apertura de canal' : 'cierre de canal', interaction.user.tag, 'lockdown') },
      );
    } catch (error) {
      console.error('No se pudo cambiar el estado del canal:', error);
      return this.deny(interaction, 'No pude cambiar los permisos del canal. Revisa mi rol.');
    }

    const action = unlock ? 'reabierto' : 'cerrado';
    await this.record(
      interaction,
      `Canal ${action}: #${channel.name}`,
      `<@${interaction.user.id}> ${action} ${channel} para @everyone.`,
      unlock ? COLOR_OK : COLOR_ACTION,
    );
    await this.reply(interaction, `${channel} ${action} para todos los miembros.`);
  }

  async userinfo(interaction) {
    const { user, member } = await this.resolveTarget(interaction);
    const settings = this.store.getGuildSettings(interaction.guildId).autoMod;
    const windowMs = settings.strikeWindowHours * 3_600_000;
    const strike = settings.strikes.find((item) => item.userId === user.id);
    const activeStrike = strike && Date.now() - strike.lastAt <= windowMs ? strike : null;

    const embed = new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle(`Ficha de ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Cuenta creada', value: `<t:${Math.floor(user.createdTimestamp / 1_000)}:R>`, inline: true },
        {
          name: 'Se unió',
          value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1_000)}:R>` : 'No está en el servidor',
          inline: true,
        },
        {
          name: 'Strikes activos de AutoMod',
          value: activeStrike ? `${activeStrike.count} · última regla: ${activeStrike.lastRule}` : 'Ninguno',
          inline: false,
        },
        {
          name: 'Confianza',
          value: this.antiRaid.isTrusted(interaction.guild, user.id) ? 'En lista de confianza' : 'Miembro normal',
          inline: true,
        },
        {
          name: 'Aislado',
          value: member?.isCommunicationDisabled?.()
            ? `Sí, hasta <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1_000)}:R>`
            : 'No',
          inline: true,
        },
      );
    if (member?.roles?.cache.size > 1) {
      const roles = member.roles.cache
        .filter((role) => role.id !== interaction.guild.id)
        .sort((left, right) => right.position - left.position)
        .map((role) => `<@&${role.id}>`)
        .slice(0, 15)
        .join(' ');
      embed.addFields({ name: 'Roles', value: roles || 'Ninguno', inline: false });
    }

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
}

/* Permiso nativo de Discord exigido por cada comando, además del rol de comandos. */
export const MODERATION_PERMISSIONS = Object.freeze({
  warn: PermissionFlagsBits.ModerateMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
  clear: PermissionFlagsBits.ManageMessages,
  slowmode: PermissionFlagsBits.ManageChannels,
  lockdown: PermissionFlagsBits.ManageChannels,
  userinfo: PermissionFlagsBits.ModerateMembers,
});
