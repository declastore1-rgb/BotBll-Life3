import { EmbedBuilder } from 'discord.js';

export function buildCustomEmbed(data) {
  const embed = new EmbedBuilder().setColor(data.color);
  if (data.title) embed.setTitle(data.title);
  if (data.description) embed.setDescription(data.description);
  if (data.authorName) embed.setAuthor({ name: data.authorName, ...(data.authorIconUrl ? { iconURL: data.authorIconUrl } : {}) });
  if (data.footerText) embed.setFooter({ text: data.footerText });
  if (data.imageUrl) embed.setImage(data.imageUrl);
  if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
  if (data.timestamp) embed.setTimestamp();
  return embed;
}
