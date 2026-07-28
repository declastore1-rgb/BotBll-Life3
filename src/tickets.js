import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from './config.js';

const PANEL_COLOR = 0x2b2d31;
const TICKET_PREFIX = 'ticket-owner:';

export const ticketIds = Object.freeze({
  create: 'ticket:create',
  info: 'ticket:info',
  close: 'ticket:close',
});

export function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(PANEL_COLOR)
    .setTitle('BLL $ LIFE - Ticket')
    .setDescription(
      '🇪🇸 · ¡Hola! Usa los botones de abajo para abrir un ticket de soporte o ver información adicional del servidor.\n\n' +
        '🇺🇸 · Hello! Use the buttons below to open a support ticket or view additional server information.\n\n' +
        '🇧🇷 · Olá! Use os botões abaixo para abrir um ticket de suporte ou visualizar informações adicionais do servidor.',
    )
    .setFooter({ text: 'Copyright Team Bll $ Life' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ticketIds.create)
      .setLabel('Abrir ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(ticketIds.info)
      .setLabel('Información')
      .setEmoji('ℹ️')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function resolveCategory(guild) {
  if (config.ticketCategoryId) {
    const configured = guild.channels.cache.get(config.ticketCategoryId);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === 'TICKETS',
  );
  if (existing) return existing;

  return guild.channels.create({
    name: 'TICKETS',
    type: ChannelType.GuildCategory,
    reason: 'Categoria automatica para el sistema de tickets',
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

export async function createTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const duplicate = guild.channels.cache.find(
    (channel) => channel.topic === `${TICKET_PREFIX}${interaction.user.id}`,
  );

  if (duplicate) {
    await interaction.editReply(`Ya tienes un ticket abierto: ${duplicate}`);
    return;
  }

  const category = await resolveCategory(guild);
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
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

  if (config.supportRoleId && guild.roles.cache.has(config.supportRoleId)) {
    overwrites.push({
      id: config.supportRoleId,
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
    .setFooter({ text: 'Copyright Team Bll $ Life' })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ticketIds.close)
      .setLabel('Cerrar ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );

  const supportMention = config.supportRoleId && guild.roles.cache.has(config.supportRoleId)
    ? `<@&${config.supportRoleId}>`
    : 'Equipo de soporte';

  await channel.send({
    content: `${interaction.user} · ${supportMention}`,
    embeds: [embed],
    components: [closeRow],
    allowedMentions: {
      users: [interaction.user.id],
      roles: config.supportRoleId ? [config.supportRoleId] : [],
    },
  });
  await interaction.editReply(`Tu ticket fue creado: ${channel}`);
}

export async function showServerInfo(interaction) {
  const guild = interaction.guild;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Información de ${guild.name}`)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .addFields(
      { name: 'Miembros', value: guild.memberCount.toLocaleString('es-ES'), inline: true },
      { name: 'Creado', value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:D>`, inline: true },
      { name: 'ID', value: guild.id, inline: true },
    )
    .setFooter({ text: 'Copyright Team Bll $ Life' });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export async function closeTicket(interaction) {
  const ownerId = interaction.channel?.topic?.startsWith(TICKET_PREFIX)
    ? interaction.channel.topic.slice(TICKET_PREFIX.length)
    : null;
  const member = interaction.member;
  const isSupport = config.supportRoleId && member.roles.cache.has(config.supportRoleId);
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

  await interaction.reply('🔒 El ticket se cerrará en 3 segundos.');
  setTimeout(() => {
    interaction.channel.delete(`Ticket cerrado por ${interaction.user.tag}`).catch(console.error);
  }, 3_000);
}
