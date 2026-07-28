import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

const TICKET_PREFIX = 'ticket-owner:';
const BUTTON_STYLES = Object.freeze({
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
});

export const ticketIds = Object.freeze({
  create: 'ticket:create',
  info: 'ticket:info',
  close: 'ticket:close',
  extraPrefix: 'ticket:extra:',
});

function resolveButtonStyle(style, fallback) {
  return BUTTON_STYLES[style] ?? BUTTON_STYLES[fallback];
}

function applyButtonEmoji(builder, emoji) {
  if (!emoji?.name && !emoji?.id) return builder;
  if (emoji.type === 'custom') {
    return builder.setEmoji({ id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) });
  }
  return builder.setEmoji(emoji.name);
}

function buildExtraButton(button) {
  const builder = applyButtonEmoji(new ButtonBuilder().setLabel(button.label), button.emoji);
  if (button.type === 'link') {
    return builder.setURL(button.value).setStyle(ButtonStyle.Link);
  }
  return builder
    .setCustomId(`${ticketIds.extraPrefix}${button.id}`)
    .setStyle(resolveButtonStyle(button.style, 'secondary'));
}

export function buildPanel(settings) {
  const embed = new EmbedBuilder()
    .setColor(settings.embedColor)
    .setTitle(settings.panelTitle)
    .setDescription(settings.panelDescription)
    .setFooter({ text: settings.footerText });
  if (settings.panelImageUrl) embed.setImage(settings.panelImageUrl);

  const createButton = applyButtonEmoji(
    new ButtonBuilder()
      .setCustomId(ticketIds.create)
      .setLabel(settings.createButtonLabel)
      .setStyle(resolveButtonStyle(settings.createButtonStyle, 'primary')),
    settings.createButtonEmoji,
  );
  const infoButton = applyButtonEmoji(
    new ButtonBuilder()
      .setCustomId(ticketIds.info)
      .setLabel(settings.infoButtonLabel)
      .setStyle(resolveButtonStyle(settings.infoButtonStyle, 'secondary')),
    settings.infoButtonEmoji,
  );
  const row = new ActionRowBuilder().addComponents(
    createButton,
    infoButton,
    ...(settings.extraButtons ?? []).map(buildExtraButton),
  );

  return { embeds: [embed], components: [row] };
}

async function resolveCategory(guild, settings) {
  if (settings.categoryId) {
    const configured = guild.channels.cache.get(settings.categoryId)
      ?? await guild.channels.fetch(settings.categoryId).catch(() => null);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'TICKETS',
  );
  if (existing) return existing;

  return guild.channels.create({
    name: 'TICKETS',
    type: ChannelType.GuildCategory,
    reason: 'Categoría automática para el sistema de tickets',
  });
}

function ticketName(user) {
  const safeName = user.username
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 70) || 'usuario';
  return `ticket-${safeName}-${user.id.slice(-4)}`;
}

async function sendTicketLog(guild, settings, title, description, color) {
  if (!settings.logChannelId) return;
  const channel = guild.channels.cache.get(settings.logChannelId);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: settings.footerText })
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(console.error);
}

export async function createTicket(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const settings = store.getGuildSettings(guild.id).tickets;
  if (!settings.enabled) {
    await interaction.editReply('El sistema de tickets está desactivado temporalmente.');
    return;
  }

  const duplicate = guild.channels.cache.find(
    (channel) => channel.topic === `${TICKET_PREFIX}${interaction.user.id}`,
  );
  if (duplicate) {
    await interaction.editReply(`Ya tienes un ticket abierto: ${duplicate}`);
    return;
  }

  const category = await resolveCategory(guild, settings);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (settings.supportRoleId && guild.roles.cache.has(settings.supportRoleId)) {
    overwrites.push({
      id: settings.supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: ticketName(interaction.user),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${TICKET_PREFIX}${interaction.user.id}`,
    permissionOverwrites: overwrites,
    reason: `Ticket abierto por ${interaction.user.tag}`,
  });

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Ticket de soporte')
    .setDescription(
      `${interaction.user}, describe tu consulta con todos los detalles posibles.\n` +
        'El equipo de soporte responderá tan pronto como sea posible.',
    )
    .setFooter({ text: settings.footerText })
    .setTimestamp();
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ticketIds.close)
      .setLabel('Cerrar ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
  const hasSupportRole = settings.supportRoleId && guild.roles.cache.has(settings.supportRoleId);
  const supportMention = hasSupportRole ? `<@&${settings.supportRoleId}>` : 'Equipo de soporte';

  await channel.send({
    content: `${interaction.user} · ${supportMention}`,
    embeds: [embed],
    components: [closeRow],
    allowedMentions: {
      users: [interaction.user.id],
      roles: hasSupportRole ? [settings.supportRoleId] : [],
    },
  });
  await sendTicketLog(
    guild,
    settings,
    'Ticket abierto',
    `${interaction.user} abrió ${channel}.`,
    0x57f287,
  );
  await interaction.editReply(`Tu ticket fue creado: ${channel}`);
}

export async function showServerInfo(interaction, store) {
  const guild = interaction.guild;
  const settings = store.getGuildSettings(guild.id).tickets;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Información de ${guild.name}`)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .addFields(
      { name: 'Miembros', value: guild.memberCount.toLocaleString('es-ES'), inline: true },
      { name: 'Creado', value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:D>`, inline: true },
      { name: 'ID', value: guild.id, inline: true },
    )
    .setFooter({ text: settings.footerText });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export async function handleExtraButton(interaction, store) {
  const settings = store.getGuildSettings(interaction.guildId).tickets;
  const buttonId = interaction.customId.slice(ticketIds.extraPrefix.length);
  const button = (settings.extraButtons ?? []).find((item) => item.id === buttonId);
  if (!button || button.type !== 'response') {
    await interaction.reply({
      content: 'Este botón ya no está disponible.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ content: button.value, flags: MessageFlags.Ephemeral });
}

export async function closeTicket(interaction, store) {
  const ownerId = interaction.channel?.topic?.startsWith(TICKET_PREFIX)
    ? interaction.channel.topic.slice(TICKET_PREFIX.length)
    : null;
  const settings = store.getGuildSettings(interaction.guildId).tickets;
  const member = interaction.member;
  const isSupport = settings.supportRoleId && member.roles.cache.has(settings.supportRoleId);
  const isAdministrator = member.permissions.has(PermissionFlagsBits.Administrator);

  if (!ownerId) {
    await interaction.reply({ content: 'Este canal no es un ticket válido.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== ownerId && !isSupport && !isAdministrator) {
    await interaction.reply({
      content: 'No tienes permiso para cerrar este ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply('El ticket se cerrará en 3 segundos.');
  await sendTicketLog(
    interaction.guild,
    settings,
    'Ticket cerrado',
    `<@${interaction.user.id}> cerró **#${interaction.channel.name}**.`,
    0xed4245,
  );
  setTimeout(() => {
    interaction.channel.delete(`Ticket cerrado por ${interaction.user.tag}`).catch(console.error);
  }, 3_000);
}

export async function syncOpenTicketPermissions(guild, previousRoleId, nextRoleId) {
  if (!previousRoleId && !nextRoleId) return { updated: 0, failed: 0 };
  const channels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText && channel.topic?.startsWith(TICKET_PREFIX),
  );
  const updated = [];
  let currentChannel = null;

  try {
    for (const channel of channels.values()) {
      currentChannel = channel;
      if (previousRoleId && previousRoleId !== nextRoleId) {
        await channel.permissionOverwrites.delete(
          previousRoleId,
          'Rol de soporte actualizado desde el dashboard',
        );
      }
      if (nextRoleId) {
        await channel.permissionOverwrites.edit(
          nextRoleId,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
          { reason: 'Rol de soporte actualizado desde el dashboard' },
        );
      }
      updated.push(channel);
      currentChannel = null;
    }
    return { updated: updated.length, failed: 0 };
  } catch (error) {
    const rollbackChannels = currentChannel ? [...updated, currentChannel] : updated;
    await Promise.allSettled(rollbackChannels.map(async (channel) => {
      if (nextRoleId && nextRoleId !== previousRoleId) {
        await channel.permissionOverwrites.delete(
          nextRoleId,
          'Rollback del rol de soporte',
        ).catch(() => null);
      }
      if (previousRoleId) {
        await channel.permissionOverwrites.edit(
          previousRoleId,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
          { reason: 'Rollback del rol de soporte' },
        );
      }
    }));
    throw new Error(`No se pudieron sincronizar los tickets abiertos: ${error.message}`);
  }
}

export async function syncPublishedPanels(guild, settings) {
  const active = [];
  let updated = 0;
  for (const panel of settings.publishedPanels ?? []) {
    try {
      const channel = guild.channels.cache.get(panel.channelId)
        ?? await guild.channels.fetch(panel.channelId);
      if (!channel?.isTextBased()) continue;
      const message = await channel.messages.fetch(panel.messageId);
      await message.edit(buildPanel(settings));
      active.push(panel);
      updated += 1;
    } catch (error) {
      if (![10003, 10008].includes(error.code)) {
        active.push(panel);
        console.error(`No se pudo actualizar el panel ${panel.messageId}:`, error);
      }
    }
  }
  return { active, updated };
}
