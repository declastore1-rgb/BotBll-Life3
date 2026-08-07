import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  clearSessionCookie,
  createSession,
  readCookie,
  safeTokenEqual,
  sessionCookie,
  verifyPassword,
  verifySession,
} from './auth.js';
import { config } from './config.js';
import { buildClaimKeyPanel, syncClaimKeyPublishedPanels } from './claimKey.js';
import { buildCustomEmbed } from './embeds.js';
import {
  getSecurityProfile,
  isSanctionSeverity,
  isSecurityProfileId,
  isSecurityResponseMode,
  listSecurityProfiles,
} from './securityProfiles.js';
import { can, dashboardPermissions, toPublicClient, toPublicUser } from './store.js';
import {
  buildPanel,
  syncOpenTicketPermissions,
  syncPublishedPanels,
} from './tickets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const DASHBOARD_VERSION = 'client-portal-20260805-2';
const loginAttempts = new Map();
const passwordChangeAttempts = new Map();
const passwordChangeInFlight = new Map();
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_IP_ATTEMPTS = 30;
const LOGIN_MAX_IDENTITY_ATTEMPTS = 8;
const LOGIN_ATTEMPT_MAX_KEYS = 5_000;
const PASSWORD_CHANGE_WINDOW_MS = 15 * 60_000;
const PASSWORD_CHANGE_MAX_IP_ATTEMPTS = 30;
const PASSWORD_CHANGE_MAX_PRINCIPAL_ATTEMPTS = 8;
const PASSWORD_CHANGE_MAX_IP_IN_FLIGHT = 6;
const PASSWORD_CHANGE_MAX_PRINCIPAL_IN_FLIGHT = 1;
const PASSWORD_CHANGE_MAX_KEYS = 5_000;
const DUMMY_PASSWORD_SALT = 'bll-login-timing-salt-v1';
const DUMMY_PASSWORD_HASH = '0'.repeat(128);
const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);
const BUTTON_STYLE_COLORS = Object.freeze({
  primary: '#5865F2',
  secondary: '#4E5058',
  success: '#248046',
  danger: '#DA373C',
  link: '#4E5058',
});
const EXTRA_BUTTON_ID = /^[a-zA-Z0-9_-]{1,36}$/;
const KEYCAP_EMOJI = /^[#*0-9]\uFE0F?\u20E3$/u;
const FLAG_EMOJI = /^\p{Regional_Indicator}{2}$/u;
const PICTOGRAPHIC_EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*$/u;
const graphemeSegmenter = new Intl.Segmenter('es', { granularity: 'grapheme' });

function cleanText(value, fallback, maxLength) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Uno de los textos no es válido.');
  const clean = value.trim();
  if (!clean || clean.length > maxLength) throw new Error(`El texto debe tener entre 1 y ${maxLength} caracteres.`);
  return clean;
}

function cleanBoolean(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} debe ser verdadero o falso.`);
  return value;
}

function cleanSnowflake(value, field, required = false) {
  if (value === undefined) return undefined;
  const clean = String(value).trim();
  if (!clean && !required) return '';
  if (!SNOWFLAKE.test(clean)) throw new Error(`${field} debe ser un ID válido de Discord.`);
  return clean;
}

function cleanInteger(body, key, minimum, maximum) {
  if (body[key] === undefined) return undefined;
  const value = Number(body[key]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} debe estar entre ${minimum} y ${maximum}.`);
  }
  return value;
}

function cleanColor(value, fallback) {
  if (value === undefined) return fallback;
  const color = String(value).trim().toUpperCase();
  if (!HEX_COLOR.test(color)) throw new Error('El color del embed debe usar formato #RRGGBB.');
  return color;
}

function cleanButtonStyle(value, fallback) {
  if (value === undefined) return fallback;
  if (!BUTTON_STYLES.has(value)) throw new Error('Uno de los colores de botón no es válido.');
  return value;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  if (host.includes(':')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function cleanPublicUrl(value, fallback = '') {
  if (value === undefined) return fallback;
  const clean = String(value).trim();
  if (!clean) return '';
  let url;
  try { url = new URL(clean); } catch { throw new Error('Una de las imágenes o URLs no es válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateHostname(url.hostname) || url.toString().length > 2_048) {
    throw new Error('Las imágenes y enlaces deben usar HTTPS y un destino público.');
  }
  return url.toString();
}

function cleanEmoji(value, guild, fallback = null) {
  if (value === undefined) return fallback;
  if (!value) return null;
  if (value.type === 'custom') {
    const emoji = guild?.emojis.cache.get(String(value.id));
    if (!emoji) throw new Error('Uno de los emojis del servidor ya no existe.');
    return { type: 'custom', id: emoji.id, name: emoji.name, animated: emoji.animated };
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const graphemes = [...graphemeSegmenter.segment(name)];
  const validEmoji = KEYCAP_EMOJI.test(name) || FLAG_EMOJI.test(name) || PICTOGRAPHIC_EMOJI.test(name);
  if (name.length > 16 || graphemes.length !== 1 || graphemes[0].segment !== name || !validEmoji) {
    throw new Error('Selecciona un único emoji tradicional válido.');
  }
  return { type: 'unicode', name };
}

function sanitizeExtraButtons(value, current, guild) {
  if (value === undefined) return current;
  if (!Array.isArray(value) || value.length > 3) {
    throw new Error('Puedes configurar hasta 3 botones adicionales.');
  }
  const ids = new Set();
  return value.map((button) => {
    if (!button || typeof button !== 'object') throw new Error('Uno de los botones adicionales no es válido.');
    const rawId = typeof button.id === 'string' ? button.id : '';
    const id = EXTRA_BUTTON_ID.test(rawId) ? rawId : randomUUID();
    if (ids.has(id)) throw new Error('Dos botones adicionales tienen el mismo ID.');
    ids.add(id);
    const type = button.type;
    if (!['response', 'link'].includes(type)) throw new Error('El tipo de botón adicional no es válido.');
    if (typeof button.label !== 'string') throw new Error('Cada botón necesita una etiqueta.');
    const label = cleanText(button.label, undefined, 80);
    if (type === 'link') {
      let url;
      try { url = new URL(button.value); } catch { throw new Error(`El enlace de “${label}” no es válido.`); }
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || isPrivateHostname(url.hostname)
        || url.toString().length > 512
      ) {
        throw new Error(`El enlace de “${label}” debe usar HTTPS y un destino público.`);
      }
      return {
        id,
        label,
        type,
        style: 'link',
        color: BUTTON_STYLE_COLORS.link,
        value: url.toString(),
        emoji: cleanEmoji(button.emoji, guild),
      };
    }
    if (typeof button.value !== 'string') throw new Error(`El botón “${label}” necesita contenido.`);
    const style = cleanButtonStyle(button.style, 'secondary');
    return {
      id,
      label,
      type,
      style,
      color: BUTTON_STYLE_COLORS[style],
      value: cleanText(button.value, undefined, 2_000),
      emoji: cleanEmoji(button.emoji, guild),
    };
  });
}

function sanitizeAntiRaid(body) {
  const patch = {};
  for (const key of ['enabled', 'spamWarningEnabled', 'blockUnauthorizedBots']) {
    if (body[key] !== undefined) patch[key] = cleanBoolean(body[key], undefined, key);
  }
  if (body.responseMode !== undefined) {
    if (!isSecurityResponseMode(body.responseMode)) throw new Error('El nivel de respuesta Anti-Raid no es válido.');
    patch.responseMode = body.responseMode;
  }
  if (body.spamWarningMessage !== undefined) patch.spamWarningMessage = cleanText(body.spamWarningMessage, undefined, 180);
  if (body.action !== undefined) {
    if (!['ban', 'kick', 'timeout'].includes(body.action)) throw new Error('La sanción seleccionada no es válida.');
    patch.action = body.action;
  }
  const numericFields = {
    joinThreshold: [2, 100],
    joinWindowSeconds: [1, 300],
    raidModeMinutes: [1, 1_440],
    minAccountAgeHours: [0, 8_760],
    massMentionThreshold: [2, 100],
    spamMessageThreshold: [3, 100],
    spamWindowSeconds: [1, 300],
    spamEscalationMinutes: [1, 1_440],
    duplicateMessageThreshold: [2, 20],
    maxLinksPerMessage: [1, 20],
    destructiveThreshold: [2, 50],
    destructiveWindowSeconds: [1, 300],
    timeoutMinutes: [1, 40_320],
  };
  for (const [key, [minimum, maximum]] of Object.entries(numericFields)) {
    const value = cleanInteger(body, key, minimum, maximum);
    if (value !== undefined) patch[key] = value;
  }
  if (body.trustedUserIds !== undefined) {
    const ids = Array.isArray(body.trustedUserIds)
      ? body.trustedUserIds
      : String(body.trustedUserIds).split(',');
    patch.trustedUserIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (patch.trustedUserIds.some((id) => !SNOWFLAKE.test(id))) {
      throw new Error('La lista blanca contiene un ID de Discord inválido.');
    }
  }
  return patch;
}

function cleanList(value, field, maximumItems, maximumLength, validator = () => true) {
  if (value === undefined) return undefined;
  const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const items = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  if (items.length > maximumItems) throw new Error(`${field} permite un máximo de ${maximumItems} elementos.`);
  if (items.some((item) => item.length > maximumLength || !validator(item))) {
    throw new Error(`${field} contiene un valor inválido.`);
  }
  return items;
}

function sanitizeAntiNuke(body) {
  const patch = {};
  for (const key of ['enabled', 'autoRestore', 'removeDangerousRoles']) {
    if (body[key] !== undefined) patch[key] = cleanBoolean(body[key], undefined, key);
  }
  if (body.responseMode !== undefined) {
    if (!isSecurityResponseMode(body.responseMode)) throw new Error('El nivel de respuesta Anti-Nuke no es válido.');
    patch.responseMode = body.responseMode;
  }
  for (const [key, minimum, maximum] of [
    ['actionThreshold', 1, 20],
    ['actionWindowSeconds', 3, 300],
  ]) {
    const value = cleanInteger(body, key, minimum, maximum);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

function sanitizeAutoMod(body) {
  const patch = {};
  for (const key of ['enabled', 'blockInvites', 'blockUnauthorizedLinks', 'blockSuspiciousFiles']) {
    if (body[key] !== undefined) patch[key] = cleanBoolean(body[key], undefined, key);
  }
  if (body.responseMode !== undefined) {
    if (!isSecurityResponseMode(body.responseMode)) throw new Error('El nivel de respuesta AutoMod no es válido.');
    patch.responseMode = body.responseMode;
  }
  if (body.sanctionSeverity !== undefined) {
    if (!isSanctionSeverity(body.sanctionSeverity)) {
      throw new Error('El alcance de sanciones de AutoMod no es válido.');
    }
    patch.sanctionSeverity = body.sanctionSeverity;
  }
  const numericFields = {
    maxCapsPercent: [50, 100],
    capsMinimumLength: [4, 100],
    maxEmojis: [1, 100],
    timeoutStrike: [2, 10],
    finalStrike: [2, 20],
    strikeWindowHours: [1, 720],
    timeoutMinutes: [1, 40_320],
  };
  for (const [key, [minimum, maximum]] of Object.entries(numericFields)) {
    const value = cleanInteger(body, key, minimum, maximum);
    if (value !== undefined) patch[key] = value;
  }
  if (body.finalAction !== undefined) {
    if (!['ban', 'kick', 'timeout'].includes(body.finalAction)) throw new Error('La sanción final de AutoMod no es válida.');
    patch.finalAction = body.finalAction;
  }
  if (body.warningMessage !== undefined) patch.warningMessage = cleanText(body.warningMessage, undefined, 240);
  const blockedWords = cleanList(body.blockedWords, 'Palabras prohibidas', 100, 50);
  if (blockedWords !== undefined) patch.blockedWords = blockedWords;
  const allowedDomains = cleanList(
    body.allowedDomains,
    'Dominios permitidos',
    100,
    253,
    (item) => /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}$/i.test(item),
  );
  if (allowedDomains !== undefined) patch.allowedDomains = allowedDomains.map((item) => item.toLowerCase().replace(/^www\./, ''));
  const suspiciousExtensions = cleanList(
    body.suspiciousExtensions,
    'Extensiones sospechosas',
    50,
    10,
    (item) => /^[a-z0-9]+$/i.test(item.replace(/^\./, '')),
  );
  if (suspiciousExtensions !== undefined) patch.suspiciousExtensions = suspiciousExtensions.map((item) => item.toLowerCase().replace(/^\./, ''));
  for (const key of ['ignoredChannelIds', 'ignoredRoleIds']) {
    const ids = cleanList(body[key], key, 100, 20, (item) => SNOWFLAKE.test(item));
    if (ids !== undefined) patch[key] = ids;
  }
  const timeoutStrike = patch.timeoutStrike ?? body.timeoutStrike;
  const finalStrike = patch.finalStrike ?? body.finalStrike;
  if (timeoutStrike !== undefined && finalStrike !== undefined && Number(finalStrike) <= Number(timeoutStrike)) {
    throw new Error('La sanción final debe ocurrir después del primer timeout.');
  }
  return patch;
}

const SECURITY_PERMISSIONS = Object.freeze(['antiraid', 'antinuke', 'automod']);

function publicSecurityProfile(profileId) {
  if (isSecurityProfileId(profileId)) {
    const { settings: _settings, ...profile } = getSecurityProfile(profileId);
    return profile;
  }
  return {
    id: 'custom',
    name: 'Personalizado',
    tone: 'custom',
    tagline: 'Configuración ajustada manualmente.',
    description: 'Los parámetros actuales no corresponden exactamente a un perfil predefinido.',
    safeguards: [],
    moduleSummary: {},
  };
}

function buildSecurityHealth(guild, settings) {
  if (!guild) {
    return {
      score: 0,
      checks: [{
        id: 'discord',
        label: 'Conexión con Discord',
        status: 'critical',
        detail: 'El servidor no está disponible para comprobar la protección.',
      }],
    };
  }
  const botMember = guild.members.me;
  const requiredPermissions = [
    ['Ver auditoría', PermissionFlagsBits.ViewAuditLog],
    ['Gestionar canales', PermissionFlagsBits.ManageChannels],
    ['Gestionar roles', PermissionFlagsBits.ManageRoles],
    ['Gestionar webhooks', PermissionFlagsBits.ManageWebhooks],
    ['Gestionar expresiones', PermissionFlagsBits.ManageGuildExpressions],
    ['Banear miembros', PermissionFlagsBits.BanMembers],
    ['Expulsar miembros', PermissionFlagsBits.KickMembers],
    ['Aislar miembros', PermissionFlagsBits.ModerateMembers],
  ];
  const missingPermissions = requiredPermissions
    .filter(([, permission]) => !botMember?.permissions.has(permission))
    .map(([label]) => label);
  const dangerousRolesAbove = botMember
    ? guild.roles.cache.filter(
      (role) => !role.managed
        && role.id !== guild.id
        && role.position >= botMember.roles.highest.position
        && [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]
          .some((permission) => role.permissions.has(permission)),
    ).size
    : 0;
  const logChannel = settings.tickets.logChannelId
    ? guild.channels.cache.get(settings.tickets.logChannelId)
    : null;
  const everyoneCanViewLogChannel = logChannel?.isTextBased()
    ? logChannel.permissionsFor?.(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)
    : null;
  const privateLogChannel = logChannel?.isTextBased() && everyoneCanViewLogChannel === false;
  const snapshot = settings.antiNuke.snapshot;
  const checks = [
    {
      id: 'discord',
      label: 'Conexión con Discord',
      status: 'ok',
      detail: `${guild.name} está disponible para protección en tiempo real.`,
    },
    {
      id: 'permissions',
      label: 'Permisos del bot',
      status: missingPermissions.length ? 'critical' : 'ok',
      detail: missingPermissions.length
        ? `Faltan: ${missingPermissions.join(', ')}.`
        : 'El bot tiene todos los permisos operativos requeridos.',
    },
    {
      id: 'hierarchy',
      label: 'Jerarquía de roles',
      status: dangerousRolesAbove ? 'warning' : botMember ? 'ok' : 'critical',
      detail: !botMember
        ? 'No se pudo localizar al miembro del bot.'
        : dangerousRolesAbove
          ? `${dangerousRolesAbove} rol(es) peligroso(s) están por encima o al mismo nivel del bot.`
          : 'El rol del bot puede actuar sobre los roles administrativos detectados.',
    },
    {
      id: 'logs',
      label: 'Canal privado de alertas',
      status: privateLogChannel ? 'ok' : 'warning',
      detail: privateLogChannel
        ? `Las alertas se envían de forma privada a #${logChannel.name}.`
        : logChannel?.isTextBased()
          ? `#${logChannel.name} es visible para @everyone o no tiene privacidad verificable.`
          : 'Configura un canal de logs privado desde Tickets.',
    },
    {
      id: 'snapshot',
      label: 'Copia Anti-Nuke',
      status: snapshot.capturedAt ? 'ok' : 'warning',
      detail: snapshot.capturedAt
        ? `Última copia: ${snapshot.capturedAt}.`
        : 'Todavía no existe una copia estructural completa.',
    },
  ];
  return {
    score: Math.round((checks.filter((check) => check.status === 'ok').length / checks.length) * 100),
    checks,
  };
}

function sanitizeTickets(body, current, guild) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = cleanBoolean(body.enabled, undefined, 'enabled');
  for (const [key, label, required] of [
    ['categoryId', 'Categoría', false],
    ['supportRoleId', 'Rol de soporte', false],
    ['logChannelId', 'Canal de logs', false],
    ['commandRoleId', 'Rol de comandos', true],
  ]) {
    const value = cleanSnowflake(body[key], label, required);
    if (value !== undefined) patch[key] = value;
  }
  patch.panelTitle = cleanText(body.panelTitle, current.panelTitle, 256);
  patch.panelDescription = cleanText(body.panelDescription, current.panelDescription, 4_000);
  patch.footerText = cleanText(body.footerText, current.footerText, 2_048);
  patch.embedColor = cleanColor(body.embedColor, current.embedColor);
  patch.panelImageUrl = cleanPublicUrl(body.panelImageUrl, current.panelImageUrl);
  patch.createButtonLabel = cleanText(body.createButtonLabel, current.createButtonLabel, 80);
  patch.createButtonStyle = cleanButtonStyle(body.createButtonStyle, current.createButtonStyle);
  patch.createButtonColor = BUTTON_STYLE_COLORS[patch.createButtonStyle];
  patch.createButtonEmoji = cleanEmoji(body.createButtonEmoji, guild, current.createButtonEmoji);
  patch.infoButtonLabel = cleanText(body.infoButtonLabel, current.infoButtonLabel, 80);
  patch.infoButtonStyle = cleanButtonStyle(body.infoButtonStyle, current.infoButtonStyle);
  patch.infoButtonColor = BUTTON_STYLE_COLORS[patch.infoButtonStyle];
  patch.infoButtonEmoji = cleanEmoji(body.infoButtonEmoji, guild, current.infoButtonEmoji);
  patch.extraButtons = sanitizeExtraButtons(body.extraButtons, current.extraButtons ?? [], guild);
  return patch;
}

function validateTicketTargets(guild, patch) {
  if (!guild) throw new Error('Discord todavía no está conectado.');
  if (patch.categoryId && guild.channels.cache.get(patch.categoryId)?.type !== ChannelType.GuildCategory) {
    throw new Error('La categoría seleccionada no existe en el servidor.');
  }
  if (patch.supportRoleId && !guild.roles.cache.has(patch.supportRoleId)) {
    throw new Error('El rol de soporte seleccionado no existe.');
  }
  const commandRole = guild.roles.cache.get(patch.commandRoleId);
  if (!commandRole || commandRole.id === guild.id || commandRole.managed) {
    throw new Error('Selecciona un rol de comandos válido y administrable.');
  }
  if (patch.logChannelId && guild.channels.cache.get(patch.logChannelId)?.type !== ChannelType.GuildText) {
    throw new Error('El canal de logs seleccionado no existe o no es de texto.');
  }
}

function cleanOptionalText(value, fallback = '', maxLength = 1_000) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('Uno de los textos del embed no es válido.');
  return value.trim();
}

function sanitizeClaimKey(body, current, guild) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = cleanBoolean(body.enabled, undefined, 'enabled');
  patch.panelTitle = cleanText(body.panelTitle, current.panelTitle, 256);
  patch.panelDescription = cleanText(body.panelDescription, current.panelDescription, 4_000);
  patch.warningText = cleanText(body.warningText, current.warningText, 1_000);
  patch.footerText = cleanText(body.footerText, current.footerText, 2_048);
  patch.embedColor = cleanColor(body.embedColor, current.embedColor);
  patch.authorName = cleanOptionalText(body.authorName, current.authorName, 256);
  patch.authorIconUrl = cleanPublicUrl(body.authorIconUrl, current.authorIconUrl);
  patch.panelImageUrl = cleanPublicUrl(body.panelImageUrl, current.panelImageUrl);
  patch.thumbnailUrl = cleanPublicUrl(body.thumbnailUrl, current.thumbnailUrl);
  patch.buttonLabel = cleanText(body.buttonLabel, current.buttonLabel, 80);
  patch.buttonStyle = cleanButtonStyle(body.buttonStyle, current.buttonStyle);
  patch.buttonColor = BUTTON_STYLE_COLORS[patch.buttonStyle];
  patch.buttonEmoji = cleanEmoji(body.buttonEmoji, guild, current.buttonEmoji);
  patch.credentialEmbedTitle = cleanText(body.credentialEmbedTitle, current.credentialEmbedTitle, 256);
  patch.credentialEmbedDescription = cleanText(body.credentialEmbedDescription, current.credentialEmbedDescription, 4_000);
  patch.credentialEmbedFooter = cleanText(body.credentialEmbedFooter, current.credentialEmbedFooter, 2_048);
  patch.credentialEmbedColor = cleanColor(body.credentialEmbedColor, current.credentialEmbedColor);
  patch.deliveryEmbedTitle = cleanText(body.deliveryEmbedTitle, current.deliveryEmbedTitle, 256);
  patch.deliveryEmbedDescription = cleanText(body.deliveryEmbedDescription, current.deliveryEmbedDescription, 4_000);
  patch.deliveryEmbedFooter = cleanText(body.deliveryEmbedFooter, current.deliveryEmbedFooter, 2_048);
  patch.deliveryEmbedColor = cleanColor(body.deliveryEmbedColor, current.deliveryEmbedColor);
  patch.deliveryEmbedImageUrl = cleanPublicUrl(body.deliveryEmbedImageUrl, current.deliveryEmbedImageUrl);
  patch.deliveryEmbedThumbnailUrl = cleanPublicUrl(body.deliveryEmbedThumbnailUrl, current.deliveryEmbedThumbnailUrl);
  patch.confirmationEmbedTitle = cleanText(body.confirmationEmbedTitle, current.confirmationEmbedTitle, 256);
  patch.confirmationEmbedDescription = cleanText(body.confirmationEmbedDescription, current.confirmationEmbedDescription, 4_000);
  patch.confirmationEmbedFooter = cleanText(body.confirmationEmbedFooter, current.confirmationEmbedFooter, 2_048);
  patch.confirmationEmbedColor = cleanColor(body.confirmationEmbedColor, current.confirmationEmbedColor);

  const panelDescriptionOverhead = patch.warningText ? 4 : 0;
  if (patch.panelDescription.length + patch.warningText.length + panelDescriptionOverhead > 4_096) {
    throw new Error('La descripción y la advertencia juntas superan el límite de 4096 caracteres de Discord.');
  }

  // Usuario y contraseña son campos dinámicos del primer embed. Se reserva su peor caso,
  // incluyendo delimitadores y la expansión necesaria para neutralizar bloques de código.
  const maximumCodeBlockValueLength = (maximum) => maximum + Math.floor(maximum / 3) + 8;
  const credentialFieldReserve = 'Usuario'.length
    + maximumCodeBlockValueLength(128)
    + 'Contraseña'.length
    + maximumCodeBlockValueLength(512);
  const panelTotal = patch.panelTitle.length
    + patch.panelDescription.length
    + patch.warningText.length
    + panelDescriptionOverhead
    + patch.footerText.length
    + patch.authorName.length;
  const credentialTotal = patch.credentialEmbedTitle.length
    + patch.credentialEmbedDescription.length
    + patch.credentialEmbedFooter.length
    + credentialFieldReserve;
  const deliveryTotal = patch.deliveryEmbedTitle.length
    + patch.deliveryEmbedDescription.length
    + patch.deliveryEmbedFooter.length;
  const confirmationTotal = patch.confirmationEmbedTitle.length
    + patch.confirmationEmbedDescription.length
    + patch.confirmationEmbedFooter.length;
  const embedTotals = [
    ['panel público', panelTotal],
    ['credenciales privadas', credentialTotal],
    ['descargas privadas', deliveryTotal],
    ['confirmación', confirmationTotal],
  ];
  const oversized = embedTotals.find(([, total]) => total > 6_000);
  if (oversized) {
    throw new Error(`El embed de ${oversized[0]} supera el máximo total de 6000 caracteres (${oversized[1]}).`);
  }
  const directMessageTotal = credentialTotal + deliveryTotal;
  if (directMessageTotal > 6_000) {
    throw new Error(
      `Los dos embeds del mensaje privado superan juntos el máximo de 6000 caracteres de Discord (${directMessageTotal}).`,
    );
  }
  return patch;
}

function sanitizeClaimKeyCredentials(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 250) {
    throw new Error('Envía entre 1 y 250 credenciales por petición.');
  }
  const usernames = new Set();
  return value.map((credential, index) => {
    const line = index + 1;
    if (!credential || typeof credential !== 'object') {
      throw new Error(`La credencial de la línea ${line} no es válida.`);
    }
    const username = typeof credential.username === 'string' ? credential.username.trim() : '';
    const password = typeof credential.password === 'string' ? credential.password : '';
    if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/u.test(username)) {
      throw new Error(`La línea ${line} tiene un usuario inválido (1–128 caracteres, sin controles).`);
    }
    if (!password || password.length > 512 || /[\u0000-\u001f\u007f]/u.test(password)) {
      throw new Error(`La línea ${line} tiene una contraseña inválida (1–512 caracteres, sin controles).`);
    }
    const normalized = username.toLocaleLowerCase('en-US');
    if (usernames.has(normalized)) {
      throw new Error(`La línea ${line} repite un usuario de esta importación.`);
    }
    usernames.add(normalized);
    return { username, password };
  });
}

function sanitizeSavedEmbed(body, current = {}) {
  const value = {
    id: current.id,
    name: cleanText(body.name, current.name, 80),
    title: cleanOptionalText(body.title, current.title, 256),
    description: cleanOptionalText(body.description, current.description, 4_000),
    color: cleanColor(body.color, current.color ?? '#5865F2'),
    authorName: cleanOptionalText(body.authorName, current.authorName, 256),
    authorIconUrl: cleanPublicUrl(body.authorIconUrl, current.authorIconUrl),
    footerText: cleanOptionalText(body.footerText, current.footerText, 2_048),
    imageUrl: cleanPublicUrl(body.imageUrl, current.imageUrl),
    thumbnailUrl: cleanPublicUrl(body.thumbnailUrl, current.thumbnailUrl),
    timestamp: cleanBoolean(body.timestamp, current.timestamp ?? false, 'timestamp'),
  };
  if (!value.title && !value.description) throw new Error('El embed necesita título o descripción.');
  const totalCharacters = value.title.length
    + value.description.length
    + value.authorName.length
    + value.footerText.length;
  if (totalCharacters > 6_000) {
    throw new Error(`El embed supera el máximo total de 6000 caracteres (${totalCharacters}).`);
  }
  return value;
}

function cleanClientUsername(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim())) {
    throw new Error('El usuario debe tener entre 3 y 32 caracteres válidos.');
  }
  return value.trim();
}

function sanitizeClientAccount(body, current = null) {
  const username = cleanClientUsername(body.username, current?.username);
  const displayName = cleanText(body.displayName, current?.displayName ?? username, 80);
  const disabled = body.disabled === undefined
    ? Boolean(current?.disabled)
    : cleanBoolean(body.disabled, false, 'disabled');
  let password;
  if (body.password !== undefined && body.password !== '') {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
      throw new Error('La contraseña debe tener entre 8 y 128 caracteres.');
    }
    password = body.password;
  } else if (!current) {
    throw new Error('La contraseña del cliente es obligatoria.');
  }
  return { username, displayName, disabled, ...(password ? { password } : {}) };
}

function sanitizeClientPortal(body, current) {
  const downloadsSource = body.downloads === undefined ? current.downloads : body.downloads;
  if (!Array.isArray(downloadsSource) || downloadsSource.length > 20) {
    throw new Error('El catálogo debe contener entre 0 y 20 descargas.');
  }
  const ids = new Set();
  const downloads = downloadsSource.map((download, index) => {
    if (!download || typeof download !== 'object') throw new Error(`La descarga ${index + 1} no es válida.`);
    const rawId = typeof download.id === 'string' ? download.id : '';
    const id = /^[a-zA-Z0-9_-]{1,36}$/.test(rawId) ? rawId : randomUUID();
    if (ids.has(id)) throw new Error('Dos descargas no pueden tener el mismo ID.');
    ids.add(id);
    const previous = current.downloads.find((item) => item.id === id);
    return {
      id,
      name: cleanText(download.name, previous?.name ?? `Descarga ${index + 1}`, 80),
      version: cleanText(download.version, previous?.version ?? 'Actual', 40),
      description: cleanText(
        download.description,
        previous?.description ?? 'Descarga disponible para clientes autorizados.',
        500,
      ),
      buttonLabel: cleanText(download.buttonLabel, previous?.buttonLabel ?? 'Descargar', 80),
      url: cleanPublicUrl(download.url, previous?.url),
      enabled: download.enabled === undefined
        ? previous?.enabled !== false
        : cleanBoolean(download.enabled, true, 'enabled'),
      updatedAt: new Date().toISOString(),
    };
  });
  return {
    title: cleanText(body.title, current.title, 120),
    description: cleanText(body.description, current.description, 1_000),
    notice: cleanText(body.notice, current.notice, 500),
    downloads,
  };
}

function pruneLoginAttempts(now = Date.now()) {
  for (const [key, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(key);
  }
  while (loginAttempts.size > LOGIN_ATTEMPT_MAX_KEYS) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
}

function loginRateLimitKeys(request) {
  const usernameInput = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
  const username = /^[a-zA-Z0-9_.-]{3,32}$/.test(usernameInput)
    ? usernameInput.toLocaleLowerCase('en-US')
    : '';
  return {
    ip: `ip:${request.ip}`,
    identity: `identity:${username || '<invalid>'}`,
  };
}

function rateLimitLogin(request, response, next) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const keys = loginRateLimitKeys(request);
  const budgets = [
    { key: keys.ip, limit: LOGIN_MAX_IP_ATTEMPTS },
    { key: keys.identity, limit: LOGIN_MAX_IDENTITY_ATTEMPTS },
  ];
  let retryAfter = 0;
  for (const budget of budgets) {
    const current = loginAttempts.get(budget.key);
    if (current && current.resetAt > now && current.count >= budget.limit) {
      retryAfter = Math.max(retryAfter, Math.ceil((current.resetAt - now) / 1_000));
    }
  }
  if (retryAfter > 0) {
    response.set('Retry-After', String(retryAfter));
    return response.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }
  for (const budget of budgets) {
    const current = loginAttempts.get(budget.key);
    const attempt = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + LOGIN_WINDOW_MS }
      : current;
    attempt.count += 1;
    loginAttempts.delete(budget.key);
    loginAttempts.set(budget.key, attempt);
  }
  request.loginIdentityAttemptKey = keys.identity;
  pruneLoginAttempts(now);
  return next();
}

function prunePasswordChangeAttempts(now = Date.now()) {
  for (const [key, attempt] of passwordChangeAttempts) {
    if (attempt.resetAt <= now) passwordChangeAttempts.delete(key);
  }
  while (passwordChangeAttempts.size > PASSWORD_CHANGE_MAX_KEYS) {
    passwordChangeAttempts.delete(passwordChangeAttempts.keys().next().value);
  }
}

function decrementPasswordChangeInFlight(key) {
  const count = passwordChangeInFlight.get(key) ?? 0;
  if (count <= 1) passwordChangeInFlight.delete(key);
  else passwordChangeInFlight.set(key, count - 1);
}

function rateLimitPasswordChange(request, response, next) {
  const principal = request.dashboardAuth?.principal;
  const principalType = request.dashboardAuth?.principalType;
  if (!principal?.id || !principalType) {
    return response.status(401).json({ error: 'Sesión no válida.' });
  }

  const now = Date.now();
  prunePasswordChangeAttempts(now);
  const keys = {
    ip: `ip:${request.ip}`,
    principal: `principal:${principalType}:${principal.id}`,
  };
  const budgets = [
    { key: keys.ip, limit: PASSWORD_CHANGE_MAX_IP_ATTEMPTS },
    { key: keys.principal, limit: PASSWORD_CHANGE_MAX_PRINCIPAL_ATTEMPTS },
  ];
  const concurrentBudgets = [
    { key: keys.ip, limit: PASSWORD_CHANGE_MAX_IP_IN_FLIGHT },
    { key: keys.principal, limit: PASSWORD_CHANGE_MAX_PRINCIPAL_IN_FLIGHT },
  ];

  let retryAfter = 0;
  for (const budget of budgets) {
    const current = passwordChangeAttempts.get(budget.key);
    if (current && current.resetAt > now && current.count >= budget.limit) {
      retryAfter = Math.max(retryAfter, Math.ceil((current.resetAt - now) / 1_000));
    }
  }
  const concurrencyExceeded = concurrentBudgets.some(
    (budget) => (passwordChangeInFlight.get(budget.key) ?? 0) >= budget.limit,
  );
  if (retryAfter > 0 || concurrencyExceeded) {
    response.set('Retry-After', String(retryAfter || 1));
    return response.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }

  for (const budget of budgets) {
    const current = passwordChangeAttempts.get(budget.key);
    const attempt = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + PASSWORD_CHANGE_WINDOW_MS }
      : current;
    attempt.count += 1;
    passwordChangeAttempts.delete(budget.key);
    passwordChangeAttempts.set(budget.key, attempt);
  }
  for (const budget of concurrentBudgets) {
    passwordChangeInFlight.set(budget.key, (passwordChangeInFlight.get(budget.key) ?? 0) + 1);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const budget of concurrentBudgets) decrementPasswordChangeInFlight(budget.key);
  };
  request.releasePasswordChangeLimit = release;
  response.once('finish', release);
  return next();
}

export function createWebServer({ client, store, antiRaid, antiNuke, autoMod }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  const trustProxySetting = process.env.TRUST_PROXY?.trim().toLowerCase();
  const trustProxy = trustProxySetting === 'true'
    ? 1
    : trustProxySetting === 'false'
      ? false
      : process.env.RAILWAY_ENVIRONMENT ? 1 : false;
  app.set('trust proxy', trustProxy);
  const publicOriginSetting = process.env.DASHBOARD_PUBLIC_ORIGIN?.trim();
  let dashboardPublicOrigin = null;
  if (publicOriginSetting) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(publicOriginSetting);
    } catch {
      throw new Error('DASHBOARD_PUBLIC_ORIGIN debe ser un origen HTTP o HTTPS válido.');
    }
    if (
      !['http:', 'https:'].includes(parsedOrigin.protocol)
      || parsedOrigin.username
      || parsedOrigin.password
      || parsedOrigin.pathname !== '/'
      || parsedOrigin.search
      || parsedOrigin.hash
    ) {
      throw new Error('DASHBOARD_PUBLIC_ORIGIN debe contener solo protocolo y dominio.');
    }
    dashboardPublicOrigin = parsedOrigin.origin;
  }
  app.use((_request, response, next) => {
    response.setHeader('X-Dashboard-Version', DASHBOARD_VERSION);
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  }));
  app.use(express.json({ limit: '64kb', type: 'application/json' }));
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  let claimKeyControlQueue = Promise.resolve();
  const runClaimKeyControlOperation = (operation) => {
    const result = claimKeyControlQueue.then(operation, operation);
    claimKeyControlQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const syncCurrentClaimKeyPanels = async () => {
    let view = store.getClaimKeyAdminView(config.guildId);
    const panels = view.settings.publishedPanels ?? [];
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      return {
        view,
        panelsUpdated: 0,
        panelsFailed: panels.length,
        panelsTotal: panels.length,
        panelsPruned: 0,
      };
    }

    const panelSync = await syncClaimKeyPublishedPanels(guild, view.settings);
    if (panelSync.active.length !== panels.length) {
      await store.replaceClaimKeyPublishedPanels(config.guildId, panelSync.active);
      view = store.getClaimKeyAdminView(config.guildId);
    }
    return {
      view,
      panelsUpdated: panelSync.updated,
      panelsFailed: panelSync.failed,
      panelsTotal: panelSync.total,
      panelsPruned: panelSync.pruned,
    };
  };

  app.get('/health', (_request, response) => {
    response.status(client.isReady() ? 200 : 503).json({
      ok: client.isReady(),
      discord: client.isReady() ? 'connected' : 'connecting',
      dashboardVersion: DASHBOARD_VERSION,
      uptime: Math.floor(process.uptime()),
    });
  });

  app.post('/api/auth/login', rateLimitLogin, async (request, response, next) => {
    try {
      const usernameInput = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
      const passwordInput = typeof request.body?.password === 'string' ? request.body.password : '';
      const usernameAllowed = /^[a-zA-Z0-9_.-]{3,32}$/.test(usernameInput);
      const passwordAllowed = passwordInput.length >= 1 && passwordInput.length <= 128;
      const username = usernameAllowed ? usernameInput : '';
      const password = passwordAllowed ? passwordInput : '';
      const staff = store.getUserByUsername(username);
      const clientAccount = staff ? null : store.getClientByUsername(username);
      const principal = staff ?? clientAccount;
      const principalType = staff ? 'staff' : clientAccount ? 'client' : null;
      const passwordMatches = await verifyPassword(
        password,
        principal?.passwordSalt ?? DUMMY_PASSWORD_SALT,
        principal?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
      const valid = Boolean(
        usernameAllowed
        && passwordAllowed
        && principal
        && !principal.disabled
        && passwordMatches
      );
      if (!valid) {
        return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      loginAttempts.delete(request.loginIdentityAttemptKey);
      const token = createSession(
        principal.id,
        config.sessionSecret,
        principal.sessionVersion,
        principalType,
      );
      const session = verifySession(token, config.sessionSecret);
      const publicPrincipal = principalType === 'staff'
        ? toPublicUser(principal)
        : toPublicClient(principal);
      response.setHeader('Set-Cookie', sessionCookie(token, config.secureCookies));
      return response.json({ user: publicPrincipal, csrf: session.csrf });
    } catch (error) {
      return next(error);
    }
  });

  const authenticate = (request, response, next) => {
    const session = verifySession(readCookie(request, 'bll_session'), config.sessionSecret);
    const principal = session?.principalType === 'client'
      ? store.getClientById(session.principalId)
      : session?.principalType === 'staff'
        ? store.getUserById(session.principalId)
        : null;
    if (
      !session
      || !principal
      || principal.disabled
      || session.sessionVersion !== principal.sessionVersion
    ) return response.status(401).json({ error: 'Sesión no válida.' });
    request.dashboardAuth = {
      session,
      principal,
      principalType: session.principalType,
      user: session.principalType === 'staff' ? principal : null,
      client: session.principalType === 'client' ? principal : null,
    };
    return next();
  };

  const requireSameOrigin = (request, response, next) => {
    const fetchSite = request.get('Sec-Fetch-Site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
      return response.status(403).json({ error: 'Origen de solicitud no permitido.' });
    }
    const origin = request.get('Origin');
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        const expectedHost = request.get('host')?.toLowerCase();
        const allowed = dashboardPublicOrigin
          ? parsedOrigin.origin === dashboardPublicOrigin
          : ['http:', 'https:'].includes(parsedOrigin.protocol)
            && Boolean(expectedHost)
            && parsedOrigin.host.toLowerCase() === expectedHost;
        if (!allowed) {
          return response.status(403).json({ error: 'Origen de solicitud no permitido.' });
        }
      } catch {
        return response.status(403).json({ error: 'Origen de solicitud no permitido.' });
      }
    }
    return next();
  };

  const requireCsrf = (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    return requireSameOrigin(request, response, () => {
      const token = request.get('X-CSRF-Token');
      if (!safeTokenEqual(token, request.dashboardAuth.session.csrf)) {
        return response.status(403).json({ error: 'Token de seguridad inválido. Recarga la página.' });
      }
      return next();
    });
  };

  const requireStaff = (request, response, next) => {
    if (request.dashboardAuth.principalType !== 'staff') {
      return response.status(403).json({ error: 'Esta sección es exclusiva del personal autorizado.' });
    }
    return next();
  };

  const requireClient = (request, response, next) => {
    if (request.dashboardAuth.principalType !== 'client') {
      return response.status(403).json({ error: 'Esta sección es exclusiva para clientes.' });
    }
    return next();
  };

  const requirePermission = (permission) => (request, response, next) => {
    if (request.dashboardAuth.principalType !== 'staff' || !can(request.dashboardAuth.user, permission)) {
      return response.status(403).json({ error: 'Tu usuario no tiene permiso para esta sección.' });
    }
    return next();
  };

  const requireAnyPermission = (...permissions) => (request, response, next) => {
    if (
      request.dashboardAuth.principalType !== 'staff'
      || !permissions.some((permission) => can(request.dashboardAuth.user, permission))
    ) {
      return response.status(403).json({ error: 'Tu usuario no tiene permiso para este recurso.' });
    }
    return next();
  };

  const requireAllPermissions = (...permissions) => (request, response, next) => {
    if (
      request.dashboardAuth.principalType !== 'staff'
      || !permissions.every((permission) => can(request.dashboardAuth.user, permission))
    ) {
      return response.status(403).json({
        error: 'Necesitas permisos de Anti-Raid, Anti-Nuke y AutoMod para cambiar el perfil global.',
      });
    }
    return next();
  };

  const securityCenterPayload = (user) => {
    const settings = store.getGuildSettings(config.guildId);
    const security = store.getSecurityState(config.guildId);
    const access = {
      antiRaid: can(user, 'antiraid'),
      antiNuke: can(user, 'antinuke'),
      autoMod: can(user, 'automod'),
    };
    access.canActivateProfile = SECURITY_PERMISSIONS.every((permission) => can(user, permission));
    const { snapshot: _snapshot, incidents: _incidents, ...antiNukeSettings } = settings.antiNuke;
    const { strikes: _strikes, ...autoModSettings } = settings.autoMod;
    return {
      security,
      activeProfile: publicSecurityProfile(security.profile),
      profiles: listSecurityProfiles(),
      access,
      health: buildSecurityHealth(client.guilds.cache.get(config.guildId), settings),
      modules: {
        antiRaid: access.antiRaid
          ? { settings: settings.antiRaid, status: antiRaid.status(config.guildId) }
          : null,
        antiNuke: access.antiNuke
          ? { settings: antiNukeSettings, status: antiNuke.status(config.guildId) }
          : null,
        autoMod: access.autoMod
          ? { settings: autoModSettings, status: autoMod.status(config.guildId) }
          : null,
      },
    };
  };

  app.get('/api/auth/session', authenticate, (request, response) => {
    const principal = request.dashboardAuth.principalType === 'staff'
      ? toPublicUser(request.dashboardAuth.user)
      : toPublicClient(request.dashboardAuth.client);
    response.json({
      user: principal,
      csrf: request.dashboardAuth.session.csrf,
    });
  });

  app.post('/api/auth/logout', requireSameOrigin, (_request, response) => {
    response.setHeader('Set-Cookie', clearSessionCookie(config.secureCookies));
    response.json({ ok: true });
  });

  app.use('/api', authenticate, requireCsrf);

  app.get('/api/client/downloads', requireClient, (request, response) => {
    response.json({
      client: toPublicClient(request.dashboardAuth.client),
      portal: store.getClientPortal(config.guildId, false),
    });
  });

  app.post('/api/client/password', requireClient, rateLimitPasswordChange, async (request, response, next) => {
    try {
      const clientAccount = request.dashboardAuth.client;
      const currentPassword = typeof request.body?.currentPassword === 'string'
        ? request.body.currentPassword
        : '';
      if (currentPassword.length < 1 || currentPassword.length > 128) {
        return response.status(400).json({ error: 'La contraseña actual no es correcta.' });
      }
      const valid = await verifyPassword(
        currentPassword,
        clientAccount.passwordSalt,
        clientAccount.passwordHash,
      );
      if (!valid) return response.status(400).json({ error: 'La contraseña actual no es correcta.' });
      const sessionVersion = await store.changeClientPassword(
        clientAccount.id,
        request.body?.newPassword,
        clientAccount,
      );
      const token = createSession(clientAccount.id, config.sessionSecret, sessionVersion, 'client');
      const session = verifySession(token, config.sessionSecret);
      response.setHeader('Set-Cookie', sessionCookie(token, config.secureCookies));
      return response.json({ ok: true, csrf: session.csrf });
    } catch (error) {
      return next(error);
    } finally {
      request.releasePasswordChangeLimit?.();
    }
  });

  app.use('/api', requireStaff);

  app.get('/api/admin/clients', requirePermission('clients'), (_request, response) => {
    response.json({ clients: store.listClients() });
  });

  app.post('/api/admin/clients', requirePermission('clients'), async (request, response, next) => {
    try {
      const input = sanitizeClientAccount(request.body ?? {});
      const clientAccount = await store.createClient(input, request.dashboardAuth.user);
      response.status(201).json({ client: clientAccount });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/clients/:id', requirePermission('clients'), async (request, response, next) => {
    try {
      const current = store.getClientById(request.params.id);
      if (!current) throw new Error('Cliente no encontrado.');
      const input = sanitizeClientAccount(request.body ?? {}, current);
      const clientAccount = await store.updateClient(
        request.params.id,
        input,
        request.dashboardAuth.user,
        request.body?.expectedUpdatedAt,
      );
      response.json({ client: clientAccount });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/clients/:id', requirePermission('clients'), async (request, response, next) => {
    try {
      await store.deleteClient(
        request.params.id,
        request.dashboardAuth.user,
        request.body?.expectedUpdatedAt,
      );
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/client-portal', requirePermission('clients'), (_request, response) => {
    response.json({ portal: store.getClientPortal(config.guildId, true) });
  });

  app.patch('/api/admin/client-portal', requirePermission('clients'), async (request, response, next) => {
    try {
      const current = store.getClientPortal(config.guildId, true);
      const portal = sanitizeClientPortal(request.body ?? {}, current);
      const updatedPortal = await store.updateClientPortal(
        config.guildId,
        portal,
        request.dashboardAuth.user,
        request.body?.expectedUpdatedAt,
      );
      response.json({ portal: updatedPortal });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/overview', (request, response) => {
    const guild = client.guilds.cache.get(config.guildId);
    const settings = store.getGuildSettings(config.guildId);
    const user = request.dashboardAuth.user;
    const ticketCount = guild
      ? guild.channels.cache.filter((channel) => channel.topic?.startsWith('ticket-owner:')).size
      : 0;
    const claimKeyStats = can(user, 'claimkey')
      ? store.getClaimKeyAdminView(config.guildId).stats
      : null;
    const audit = store.getAudit(100).filter((entry) => {
      if (entry.module === 'Anti-Raid') return can(user, 'antiraid');
      if (entry.module === 'Anti-Nuke') return can(user, 'antinuke');
      if (entry.module === 'AutoMod') return can(user, 'automod');
      if (entry.module === 'Tickets') return can(user, 'tickets');
      if (entry.module === 'Claim Key') return can(user, 'claimkey');
      if (entry.module === 'Seguridad') return SECURITY_PERMISSIONS.some((permission) => can(user, permission));
      if (entry.module === 'Embeds') return can(user, 'embeds') && entry.actorId === user.id;
      if (entry.module === 'Clientes') return can(user, 'clients');
      return can(user, 'users');
    }).slice(0, 12).map((entry) => {
      const publicEntry = { ...entry };
      delete publicEntry.actorId;
      return publicEntry;
    });
    response.json({
      bot: {
        ready: client.isReady(),
        username: client.user?.username ?? 'Conectando',
        avatar: client.user?.displayAvatarURL({ size: 128 }) ?? null,
        ping: client.ws.ping,
      },
      guild: guild
        ? { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }), members: guild.memberCount }
        : { id: config.guildId, name: 'Servidor no disponible', icon: null, members: 0 },
      stats: {
        securityProfile: SECURITY_PERMISSIONS.some((permission) => can(user, permission))
          ? settings.security.profile
          : null,
        securityProfileName: SECURITY_PERMISSIONS.some((permission) => can(user, permission))
          ? publicSecurityProfile(settings.security.profile).name
          : null,
        antiRaidEnabled: can(user, 'antiraid') ? settings.antiRaid.enabled : null,
        raidMode: can(user, 'antiraid') ? antiRaid.isRaidMode(config.guildId) : null,
        openTickets: can(user, 'tickets') ? ticketCount : null,
        claimKeyAvailable: claimKeyStats?.available ?? null,
        claimKeyClaimed: claimKeyStats?.claimed ?? null,
        clients: can(user, 'clients') ? store.listClients().length : null,
        dashboardUsers: can(user, 'users') ? store.listUsers().length : null,
      },
      permissions: dashboardPermissions.filter((permission) => can(user, permission)),
      audit,
    });
  });

  app.get('/api/discord/resources', requireAnyPermission('antiraid', 'antinuke', 'automod', 'tickets', 'claimkey', 'embeds'), (_request, response) => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return response.status(503).json({ error: 'Discord todavía no está conectado.' });
    const roles = guild.roles.cache
      .filter((role) => !role.managed && role.id !== guild.id)
      .sort((left, right) => right.position - left.position)
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }));
    const categories = guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => ({ id: channel.id, name: channel.name }));
    const channels = guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildText)
      .map((channel) => ({ id: channel.id, name: channel.name }));
    const emojis = guild.emojis.cache.map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated,
      url: emoji.imageURL({ size: 64 }),
    }));
    return response.json({ roles, categories, channels, emojis });
  });

  app.get(
    '/api/security',
    requireAnyPermission(...SECURITY_PERMISSIONS),
    (request, response) => response.json(securityCenterPayload(request.dashboardAuth.user)),
  );

  app.put(
    '/api/security/profile',
    requireAllPermissions(...SECURITY_PERMISSIONS),
    async (request, response, next) => {
      try {
        const profileId = request.body?.profile;
        if (!isSecurityProfileId(profileId)) {
          throw new Error('El perfil de seguridad seleccionado no es válido.');
        }
        const guild = client.guilds.cache.get(config.guildId);
        const current = store.getGuildSettings(config.guildId);
        const needsInitialSnapshot = !current.antiNuke.snapshot.capturedAt;
        await store.applySecurityProfile(
          config.guildId,
          profileId,
          request.dashboardAuth.user,
        );
        antiRaid.clearRaidMode(config.guildId);
        antiNuke.clearRuntimeState(config.guildId);
        let snapshotWarning = '';
        if (needsInitialSnapshot) {
          if (!guild) {
            snapshotWarning = 'La protección quedó activa, pero la copia Anti-Nuke sigue pendiente porque Discord no está conectado.';
          } else {
            try {
              await guild.members.fetch();
              await antiNuke.captureSnapshot(guild, { waitForIdle: true });
            } catch (error) {
              console.error('No se pudo crear la copia Anti-Nuke inicial después de activar el perfil:', error);
              snapshotWarning = 'La protección quedó activa, pero no se pudo crear la copia Anti-Nuke inicial.';
            }
          }
        }
        if (guild) {
          const profile = getSecurityProfile(profileId);
          await antiRaid.log(
            guild,
            `Centro de Seguridad · ${profile.name}`,
            profileId === 'emergency'
              ? `Activado desde la web por **${request.dashboardAuth.user.username}**. Las nuevas entradas quedan bloqueadas hasta cambiar de perfil.`
              : `Activado desde la web por **${request.dashboardAuth.user.username}**.`,
            profileId === 'emergency' ? 0xed4245 : profileId === 'lite' ? 0xfee75c : 0x57f287,
          );
        }
        const payload = securityCenterPayload(request.dashboardAuth.user);
        if (snapshotWarning) payload.snapshotWarning = snapshotWarning;
        response.json(payload);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get('/api/antiraid', requirePermission('antiraid'), (_request, response) => {
    response.json({
      settings: store.getGuildSettings(config.guildId).antiRaid,
      status: antiRaid.status(config.guildId),
    });
  });

  app.patch('/api/antiraid', requirePermission('antiraid'), async (request, response, next) => {
    try {
      const patch = sanitizeAntiRaid(request.body ?? {});
      const settings = await store.updateGuildSection(
        config.guildId,
        'antiRaid',
        patch,
        request.dashboardAuth.user,
      );
      if (patch.enabled === false) antiRaid.clearRaidMode(config.guildId);
      response.json({ settings, status: antiRaid.status(config.guildId) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/antinuke', requirePermission('antinuke'), (_request, response) => {
    const section = store.getGuildSettings(config.guildId).antiNuke;
    const { snapshot: _snapshot, incidents: _incidents, ...settings } = section;
    response.json({ settings, status: antiNuke.status(config.guildId) });
  });

  app.patch('/api/antinuke', requirePermission('antinuke'), async (request, response, next) => {
    try {
      const current = store.getGuildSettings(config.guildId).antiNuke;
      const patch = sanitizeAntiNuke(request.body ?? {});
      if (!current.enabled && patch.enabled === true) {
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) throw new Error('Discord todavía no está conectado.');
        await guild.members.fetch();
        await antiNuke.captureSnapshot(guild, { waitForIdle: true });
      }
      const settings = await store.updateGuildSection(
        config.guildId,
        'antiNuke',
        patch,
        request.dashboardAuth.user,
      );
      antiNuke.clearRuntimeState(config.guildId);
      const { snapshot: _snapshot, incidents: _incidents, ...publicSettings } = settings;
      response.json({ settings: publicSettings, status: antiNuke.status(config.guildId) });
    } catch (error) { next(error); }
  });

  app.post('/api/antinuke/snapshot', requirePermission('antinuke'), async (request, response, next) => {
    try {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) throw new Error('Discord todavía no está conectado.');
      await guild.members.fetch();
      await antiNuke.captureSnapshot(guild, { waitForIdle: true });
      await store.recordAudit(request.dashboardAuth.user, 'Anti-Nuke', 'Copia de seguridad actualizada manualmente');
      response.json({ status: antiNuke.status(config.guildId) });
    } catch (error) { next(error); }
  });

  app.get('/api/automod', requirePermission('automod'), (_request, response) => {
    const section = store.getGuildSettings(config.guildId).autoMod;
    const { strikes: _strikes, ...settings } = section;
    response.json({ settings, status: autoMod.status(config.guildId) });
  });

  app.patch('/api/automod', requirePermission('automod'), async (request, response, next) => {
    try {
      const current = store.getGuildSettings(config.guildId).autoMod;
      const patch = sanitizeAutoMod(request.body ?? {});
      const proposed = { ...current, ...patch };
      if (proposed.finalStrike <= proposed.timeoutStrike) {
        throw new Error('La sanción final debe ocurrir después del primer timeout.');
      }
      const settings = await store.updateGuildSection(
        config.guildId,
        'autoMod',
        patch,
        request.dashboardAuth.user,
      );
      const { strikes: _strikes, ...publicSettings } = settings;
      response.json({ settings: publicSettings, status: autoMod.status(config.guildId) });
    } catch (error) { next(error); }
  });

  app.delete('/api/automod/strikes', requirePermission('automod'), async (request, response, next) => {
    try {
      await store.clearAutoModStrikes(config.guildId, request.dashboardAuth.user);
      response.json({ ok: true, status: autoMod.status(config.guildId) });
    } catch (error) { next(error); }
  });

  app.get('/api/tickets', requirePermission('tickets'), (_request, response) => {
    response.json({ settings: store.getGuildSettings(config.guildId).tickets });
  });

  app.patch('/api/tickets', requirePermission('tickets'), async (request, response, next) => {
    try {
      const current = store.getGuildSettings(config.guildId).tickets;
      const guild = client.guilds.cache.get(config.guildId);
      const patch = sanitizeTickets(request.body ?? {}, current, guild);
      const proposed = { ...current, ...patch };
      validateTicketTargets(guild, proposed);
      const permissionsSync = await syncOpenTicketPermissions(
        guild,
        current.supportRoleId,
        proposed.supportRoleId,
      );
      let settings;
      try {
        settings = await store.updateGuildSection(
          config.guildId,
          'tickets',
          patch,
          request.dashboardAuth.user,
        );
      } catch (error) {
        await syncOpenTicketPermissions(guild, proposed.supportRoleId, current.supportRoleId)
          .catch((rollbackError) => console.error('No se pudo revertir el rol de soporte:', rollbackError));
        throw error;
      }
      const panelSync = await syncPublishedPanels(guild, settings);
      if (panelSync.active.length !== (settings.publishedPanels ?? []).length) {
        await store.replacePublishedPanels(config.guildId, panelSync.active);
        settings.publishedPanels = panelSync.active;
      }
      response.json({ settings, permissionsSync, panelsUpdated: panelSync.updated });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/tickets/publish', requirePermission('tickets'), async (request, response, next) => {
    try {
      const channelId = cleanSnowflake(request.body?.channelId, 'Canal', true);
      const guild = client.guilds.cache.get(config.guildId);
      const channel = guild?.channels.cache.get(channelId);
      if (!channel?.isTextBased()) throw new Error('El canal seleccionado no está disponible.');
      const tickets = store.getGuildSettings(config.guildId).tickets;
      if (!tickets.enabled) throw new Error('Activa primero el sistema de tickets.');
      const message = await channel.send(buildPanel(tickets));
      await store.recordPublishedPanel(
        config.guildId,
        channel.id,
        message.id,
        request.dashboardAuth.user,
      );
      response.json({ ok: true, messageId: message.id });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/claim-key', requirePermission('claimkey'), (_request, response) => {
    response.json(store.getClaimKeyAdminView(config.guildId));
  });

  app.patch('/api/claim-key', requirePermission('claimkey'), async (request, response, next) => {
    try {
      const result = await runClaimKeyControlOperation(async () => {
        const current = store.getClaimKeyAdminView(config.guildId).settings;
        const guild = client.guilds.cache.get(config.guildId);
        const patch = sanitizeClaimKey(request.body ?? {}, current, guild);
        await store.updateClaimKeySettings(
          config.guildId,
          patch,
          request.dashboardAuth.user,
        );
        return syncCurrentClaimKeyPanels();
      });
      response.json({
        ...result.view,
        panelsUpdated: result.panelsUpdated,
        panelsFailed: result.panelsFailed,
        panelsTotal: result.panelsTotal,
        panelsPruned: result.panelsPruned,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/claim-key/credentials', requirePermission('claimkey'), async (request, response, next) => {
    try {
      const credentials = sanitizeClaimKeyCredentials(request.body?.credentials);
      const view = await store.addClaimKeyCredentials(
        config.guildId,
        credentials,
        request.dashboardAuth.user,
      );
      response.status(201).json(view);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/claim-key/credentials/:id', requirePermission('claimkey'), async (request, response, next) => {
    try {
      const view = await store.deleteClaimKeyCredential(
        config.guildId,
        request.params.id,
        request.dashboardAuth.user,
      );
      response.json(view);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/claim-key/claims/reset', requirePermission('claimkey'), async (request, response, next) => {
    try {
      const result = await runClaimKeyControlOperation(async () => {
        const reset = await store.resetClaimKeyClaims(
          config.guildId,
          request.dashboardAuth.user,
        );
        const sync = await syncCurrentClaimKeyPanels();
        return { ...sync, resetCount: reset.resetCount };
      });
      response.json({
        ...result.view,
        resetCount: result.resetCount,
        panelsUpdated: result.panelsUpdated,
        panelsFailed: result.panelsFailed,
        panelsTotal: result.panelsTotal,
        panelsPruned: result.panelsPruned,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/claim-key/publish', requirePermission('claimkey'), async (request, response, next) => {
    try {
      const channelId = cleanSnowflake(request.body?.channelId, 'Canal', true);
      const result = await runClaimKeyControlOperation(async () => {
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) throw new Error('Discord todavía no está conectado.');
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased() || channel.isThread()) {
          throw new Error('Selecciona un canal de texto que no sea un hilo.');
        }
        const sync = await syncCurrentClaimKeyPanels();
        const view = sync.view;
        if (!view.settings.enabled) throw new Error('Activa Claim Key antes de publicar el panel.');
        if (view.stats.available < 1) throw new Error('Añade al menos una credencial disponible antes de publicar.');
        if ((view.settings.publishedPanels ?? []).length >= 25) {
          throw new Error('Has alcanzado el límite de 25 paneles activos. Elimina uno en Discord antes de publicar otro.');
        }
        const message = await channel.send(buildClaimKeyPanel(view.settings));
        try {
          await store.recordClaimKeyPublishedPanel(
            config.guildId,
            channel.id,
            message.id,
            request.dashboardAuth.user,
          );
        } catch (error) {
          await message.delete().catch(() => null);
          throw error;
        }
        return { ...sync, messageId: message.id };
      });
      response.status(201).json({
        ok: true,
        messageId: result.messageId,
        panelsUpdated: result.panelsUpdated,
        panelsFailed: result.panelsFailed,
        panelsPruned: result.panelsPruned,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/embeds', requirePermission('embeds'), (request, response) => {
    response.json(store.getUserEmbeds(config.guildId, request.dashboardAuth.user.id));
  });

  app.post('/api/embeds', requirePermission('embeds'), async (request, response, next) => {
    try {
      const embed = await store.saveEmbed(config.guildId, sanitizeSavedEmbed(request.body ?? {}), request.dashboardAuth.user);
      response.status(201).json({ embed });
    } catch (error) { next(error); }
  });

  app.patch('/api/embeds/:id', requirePermission('embeds'), async (request, response, next) => {
    try {
      const current = store.getUserEmbed(config.guildId, request.params.id, request.dashboardAuth.user.id);
      if (!current) throw new Error('Embed no encontrado.');
      const embed = await store.saveEmbed(config.guildId, sanitizeSavedEmbed(request.body ?? {}, current), request.dashboardAuth.user);
      response.json({ embed });
    } catch (error) { next(error); }
  });

  app.delete('/api/embeds/:id', requirePermission('embeds'), async (request, response, next) => {
    try { await store.deleteEmbed(config.guildId, request.params.id, request.dashboardAuth.user); response.json({ ok: true }); }
    catch (error) { next(error); }
  });

  app.post('/api/embeds/:id/send', requirePermission('embeds'), async (request, response, next) => {
    try {
      const ownerUserId = request.dashboardAuth.user.id;
      if (!store.getUserEmbed(config.guildId, request.params.id, ownerUserId)) {
        throw new Error('Embed o canal no disponible.');
      }
      const channelId = cleanSnowflake(request.body?.channelId, 'Canal', true);
      const guild = client.guilds.cache.get(config.guildId);
      const channel = guild?.channels.cache.get(channelId) ?? await guild?.channels.fetch(channelId).catch(() => null);
      const embed = store.getUserEmbed(config.guildId, request.params.id, ownerUserId);
      if (!embed || !channel?.isTextBased() || channel.isThread()) throw new Error('Embed o canal no disponible.');
      await channel.send({ embeds: [buildCustomEmbed(embed)] });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.put('/api/embeds/:id/schedule', requirePermission('embeds'), async (request, response, next) => {
    try {
      const channelId = cleanSnowflake(request.body?.channelId, 'Canal', true);
      const intervalMinutes = cleanInteger(request.body ?? {}, 'intervalMinutes', 5, 43_200);
      if (intervalMinutes === undefined) throw new Error('Debes indicar el intervalo de envío.');
      const section = store.getUserEmbeds(config.guildId, request.dashboardAuth.user.id);
      if (!section.saved.some((item) => item.id === request.params.id)) throw new Error('Embed no encontrado.');
      const guild = client.guilds.cache.get(config.guildId);
      const channel = guild?.channels.cache.get(channelId) ?? await guild?.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || channel.isThread()) throw new Error('El canal seleccionado no está disponible.');
      const previous = section.schedules.find((item) => item.embedId === request.params.id);
      const schedule = await store.saveSchedule(config.guildId, {
        embedId: request.params.id,
        channelId,
        intervalMinutes,
        enabled: cleanBoolean(request.body?.enabled, false, 'enabled'),
        nextRunAt: Date.now() + intervalMinutes * 60_000,
        lastRunAt: previous?.lastRunAt ?? null,
        lastError: '',
      }, request.dashboardAuth.user);
      response.json({ schedule });
    } catch (error) { next(error); }
  });

  app.delete('/api/embeds/:id/schedule', requirePermission('embeds'), async (request, response, next) => {
    try { await store.deleteSchedule(config.guildId, request.params.id, request.dashboardAuth.user); response.json({ ok: true }); }
    catch (error) { next(error); }
  });

  app.get('/api/users', requirePermission('users'), (_request, response) => {
    response.json({ users: store.listUsers(), availablePermissions: dashboardPermissions });
  });

  app.post('/api/users', requirePermission('users'), async (request, response, next) => {
    try {
      if (!request.dashboardAuth.user.isAdmin && request.body?.isAdmin) {
        throw new Error('Solo un administrador puede crear otra cuenta administradora.');
      }
      const user = await store.createUser(request.body ?? {}, request.dashboardAuth.user);
      response.status(201).json({ user });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/users/:id', requirePermission('users'), async (request, response, next) => {
    try {
      const actor = request.dashboardAuth.user;
      if (request.params.id === actor.id) {
        throw new Error('Usa la sección Mi cuenta para modificar tu propio acceso.');
      }
      const input = { ...(request.body ?? {}) };
      if (!actor.isAdmin) {
        if (input.isAdmin === true) throw new Error('Solo un administrador puede conceder acceso total.');
        delete input.isAdmin;
      }
      const user = await store.updateUser(request.params.id, input, actor);
      response.json({ user });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/users/:id', requirePermission('users'), async (request, response, next) => {
    try {
      const actor = request.dashboardAuth.user;
      if (request.params.id === actor.id) throw new Error('No puedes eliminar tu propia sesión.');
      await store.deleteUser(request.params.id, actor);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/account/password', rateLimitPasswordChange, async (request, response, next) => {
    try {
      const user = request.dashboardAuth.user;
      const currentPassword = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
      if (currentPassword.length < 1 || currentPassword.length > 128) {
        return response.status(400).json({ error: 'La contraseña actual no es correcta.' });
      }
      const valid = await verifyPassword(currentPassword, user.passwordSalt, user.passwordHash);
      if (!valid) return response.status(400).json({ error: 'La contraseña actual no es correcta.' });
      const sessionVersion = await store.changeOwnPassword(
        user.id,
        request.body?.newPassword,
        user,
      );
      const token = createSession(user.id, config.sessionSecret, sessionVersion);
      const session = verifySession(token, config.sessionSecret);
      response.setHeader('Set-Cookie', sessionCookie(token, config.secureCookies));
      return response.json({ ok: true, csrf: session.csrf });
    } catch (error) {
      return next(error);
    } finally {
      request.releasePasswordChangeLimit?.();
    }
  });

  const disableDashboardCache = (response) => {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
  };
  app.use('/assets', express.static(publicDir, {
    fallthrough: false,
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: disableDashboardCache,
  }));
  app.get('/', (_request, response) => {
    disableDashboardCache(response);
    response.sendFile(path.join(publicDir, 'index.html'), { cacheControl: false, lastModified: false });
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);

    const invalidJson = error?.type === 'entity.parse.failed';
    const payloadTooLarge = error?.type === 'entity.too.large';
    const missingAsset = error?.status === 404;
    const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';
    const clientConflict = error?.code === 'CLIENT_CONFLICT';
    const applicationError = error?.name === 'Error'
      && (!error.code || String(error.code).startsWith('CLAIM_KEY_') || clientConflict)
      && rawMessage.length > 0
      && rawMessage.length <= 500
      && !/[\r\n\u0000-\u001f\u007f]/u.test(rawMessage);

    let status = 500;
    let safeMessage = 'Ocurrió un error inesperado. Inténtalo nuevamente.';
    if (invalidJson) {
      status = 400;
      safeMessage = 'La solicitud contiene JSON inválido.';
    } else if (payloadTooLarge) {
      status = 413;
      safeMessage = 'La solicitud supera el tamaño permitido.';
    } else if (missingAsset) {
      status = 404;
      safeMessage = 'Recurso no encontrado.';
    } else if (applicationError) {
      status = clientConflict ? 409 : 400;
      safeMessage = rawMessage;
    }

    const logMessage = invalidJson
      ? 'Cuerpo JSON inválido; contenido omitido para proteger datos sensibles.'
      : rawMessage || 'Error sin mensaje';
    console.error('[Dashboard]', {
      name: error?.name || 'Error',
      type: error?.type || 'application.error',
      code: error?.code || null,
      status,
      message: logMessage,
    });
    return response.status(status).json({ error: safeMessage });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ Dashboard disponible en el puerto ${config.port}.`);
  });
  return server;
}
