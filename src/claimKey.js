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

export function buildClaimKeyCredentialEmbed(settings, claimed) {
  return new EmbedBuilder()
    .setColor(settings.credentialEmbedColor)
    .setTitle(settings.credentialEmbedTitle)
    .setDescription(settings.credentialEmbedDescription)
    .addFields(
      { name: 'Usuario', value: `\`\`\`\n${safeCodeBlock(claimed.username)}\n\`\`\`` },
      { name: 'Contraseña', value: `\`\`\`\n${safeCodeBlock(claimed.password)}\n\`\`\`` },
    )
    .setFooter({ text: settings.credentialEmbedFooter })
    .setTimestamp(new Date(claimed.claimedAt));
}

export function buildClaimKeyDeliveryEmbed(settings) {
  const embed = new EmbedBuilder()
    .setColor(settings.deliveryEmbedColor)
    .setTitle(settings.deliveryEmbedTitle)
    .setDescription(settings.deliveryEmbedDescription)
    .setFooter({ text: settings.deliveryEmbedFooter });
  if (settings.deliveryEmbedImageUrl) embed.setImage(settings.deliveryEmbedImageUrl);
  if (settings.deliveryEmbedThumbnailUrl) embed.setThumbnail(settings.deliveryEmbedThumbnailUrl);
  return embed;
}

export function buildClaimKeyConfirmationEmbed(settings) {
  return new EmbedBuilder()
    .setColor(settings.confirmationEmbedColor)
    .setTitle(settings.confirmationEmbedTitle)
    .setDescription(settings.confirmationEmbedDescription)
    .setFooter({ text: settings.confirmationEmbedFooter })
    .setTimestamp();
}

function embedCharacterCount(embed) {
  const data = embed.toJSON();
  return [
    data.title,
    data.description,
    data.footer?.text,
    data.author?.name,
    ...(data.fields ?? []).flatMap((field) => [field.name, field.value]),
  ].reduce((total, value) => total + (value?.length ?? 0), 0);
}

export function buildClaimKeyDirectMessage(settings, claimed) {
  const embeds = [
    buildClaimKeyCredentialEmbed(settings, claimed),
    buildClaimKeyDeliveryEmbed(settings),
  ];
  const totalCharacters = embeds.reduce((total, embed) => total + embedCharacterCount(embed), 0);
  if (totalCharacters > 6_000) {
    const error = new Error(`El mensaje privado supera el límite agregado de Discord (${totalCharacters}/6000).`);
    error.code = 'CLAIM_KEY_DM_INVALID';
    throw error;
  }
  return {
    embeds,
    allowedMentions: { parse: [] },
  };
}

function buildClaimKeyDmClosedEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('No pude enviarte el mensaje privado')
    .setDescription('Activa los mensajes directos para este servidor y vuelve a pulsar **Obtener clave**. Tu credencial no fue consumida.')
    .setFooter({ text: 'BLL$LIFE Access · Entrega protegida' });
}

function buildClaimKeyDeliveryErrorEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('No se pudo completar la entrega')
    .setDescription('Ocurrió un error temporal o de configuración al preparar el mensaje privado. Tu credencial no fue consumida. Inténtalo más tarde o avisa al equipo.')
    .setFooter({ text: 'BLL$LIFE Access · Entrega revertida' });
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
  const settings = store.getClaimKeyAdminView(interaction.guildId).settings;
  let result;
  try {
    result = await store.deliverClaimCredential(interaction.guildId, {
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName ?? '',
      tag: interaction.user.tag,
    }, async (claimed) => {
      await interaction.user.send(buildClaimKeyDirectMessage(settings, claimed));
    });
  } catch (error) {
    if (error.code !== 'CLAIM_KEY_DM_FAILED') throw error;
    const dmClosed = error.reason === 'dm_closed';
    if (!dmClosed) {
      const providerCode = ['string', 'number'].includes(typeof error.cause?.code)
        ? String(error.cause.code).slice(0, 64)
        : 'unknown';
      console.error('Falló una entrega privada de Claim Key.', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        reason: error.reason ?? 'delivery_error',
        providerCode,
      });
    }
    await interaction.editReply({
      embeds: [dmClosed ? buildClaimKeyDmClosedEmbed() : buildClaimKeyDeliveryErrorEmbed()],
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (result.status === 'claimed') {
    await interaction.editReply({
      embeds: [buildClaimKeyConfirmationEmbed(settings)],
      allowedMentions: { parse: [] },
    });
    return;
  }

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
  }
}

export async function syncClaimKeyPublishedPanels(guild, settings) {
  const panels = settings.publishedPanels ?? [];
  const active = [];
  let updated = 0;
  let failed = 0;
  for (const panel of panels) {
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
        failed += 1;
        console.error(`No se pudo actualizar el panel Claim Key ${panel.messageId}:`, error);
      }
    }
  }
  return {
    active,
    updated,
    failed,
    total: panels.length,
    pruned: panels.length - active.length,
  };
}
