import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';

const BUTTON_STYLES = Object.freeze({
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
});

export const claimKeyIds = Object.freeze({
  claim: 'claimkey:claim',
});

function resolveButtonStyle(style) {
  return BUTTON_STYLES[style] ?? ButtonStyle.Primary;
}

function applyButtonEmoji(builder, emoji) {
  if (!emoji?.name && !emoji?.id) return builder;
  if (emoji.type === 'custom') {
    return builder.setEmoji({ id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) });
  }
  return builder.setEmoji(emoji.name);
}

function safeCodeBlock(value) {
  return String(value).replaceAll('```', '`\u200b``');
}

export function buildClaimKeyPanel(settings) {
  const description = [
    settings.panelDescription,
    settings.warningText ? `\n> ${settings.warningText}` : '',
  ].filter(Boolean).join('\n');
  const embed = new EmbedBuilder()
    .setColor(settings.embedColor)
    .setTitle(settings.panelTitle)
    .setDescription(description)
    .setFooter({ text: settings.footerText });

  if (settings.authorName) {
    embed.setAuthor({
      name: settings.authorName,
      ...(settings.authorIconUrl ? { iconURL: settings.authorIconUrl } : {}),
    });
  }
  if (settings.panelImageUrl) embed.setImage(settings.panelImageUrl);
  if (settings.thumbnailUrl) embed.setThumbnail(settings.thumbnailUrl);

  const button = applyButtonEmoji(
    new ButtonBuilder()
      .setCustomId(claimKeyIds.claim)
      .setLabel(settings.buttonLabel)
      .setStyle(resolveButtonStyle(settings.buttonStyle))
      .setDisabled(!settings.enabled),
    settings.buttonEmoji,
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] },
  };
}

export async function handleClaimKeyClaim(interaction, store) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Esta acción solo está disponible dentro del servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!store.isClaimKeyPublishedPanel(interaction.guildId, interaction.channelId, interaction.message?.id)) {
    await interaction.editReply({
      content: 'Este panel ya no está activo. Usa una publicación vigente del servidor.',
      allowedMentions: { parse: [] },
    });
    return;
  }
  const result = await store.claimCredential(interaction.guildId, {
    id: interaction.user.id,
    username: interaction.user.username,
    globalName: interaction.user.globalName ?? '',
    tag: interaction.user.tag,
  });

  if (result.status === 'disabled') {
    await interaction.editReply({
      content: 'La entrega de accesos está desactivada temporalmente.',
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (result.status === 'already_claimed') {
    await interaction.editReply({
      content: 'Tu cuenta de Discord ya reclamó un acceso. Por seguridad, las credenciales no vuelven a mostrarse.',
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (result.status === 'out_of_stock') {
    await interaction.editReply({
      content: 'No quedan accesos disponibles en este momento. Inténtalo nuevamente más tarde.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Acceso entregado correctamente')
    .setDescription('Estas credenciales son privadas. Guárdalas ahora y no las compartas con otras personas.')
    .addFields(
      { name: 'Usuario', value: `\`\`\`\n${safeCodeBlock(result.username)}\n\`\`\`` },
      { name: 'Contraseña', value: `\`\`\`\n${safeCodeBlock(result.password)}\n\`\`\`` },
    )
    .setFooter({ text: 'BLL$LIFE Access · Una entrega por cuenta de Discord' })
    .setTimestamp(new Date(result.claimedAt));

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export async function syncClaimKeyPublishedPanels(guild, settings) {
  const active = [];
  let updated = 0;
  for (const panel of settings.publishedPanels ?? []) {
    try {
      const channel = guild.channels.cache.get(panel.channelId)
        ?? await guild.channels.fetch(panel.channelId);
      if (!channel?.isTextBased() || channel.isThread()) continue;
      const message = await channel.messages.fetch(panel.messageId);
      await message.edit(buildClaimKeyPanel(settings));
      active.push(panel);
      updated += 1;
    } catch (error) {
      if (![10003, 10008].includes(error.code)) {
        active.push(panel);
        console.error(`No se pudo actualizar el panel Claim Key ${panel.messageId}:`, error);
      }
    }
  }
  return { active, updated };
}
