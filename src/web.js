import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { ChannelType } from 'discord.js';
import {
  clearSessionCookie,
  createSession,
  readCookie,
  sessionCookie,
  verifyPassword,
  verifySession,
} from './auth.js';
import { config } from './config.js';
import { buildClaimKeyPanel, syncClaimKeyPublishedPanels } from './claimKey.js';
import { buildCustomEmbed } from './embeds.js';
import { can, dashboardPermissions, toPublicUser } from './store.js';
import {
  buildPanel,
  syncOpenTicketPermissions,
  syncPublishedPanels,
} from './tickets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const DASHBOARD_VERSION = 'claim-key-20260729-3';
const loginAttempts = new Map();
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
  if (body.enabled !== undefined) patch.enabled = cleanBoolean(body.enabled, undefined, 'enabled');
  if (body.spamWarningEnabled !== undefined) {
    patch.spamWarningEnabled = cleanBoolean(body.spamWarningEnabled, undefined, 'spamWarningEnabled');
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
  for (const key of ['enabled', 'autoRestore', 'removeDangerousRoles', 'emergencyMode']) {
    if (body[key] !== undefined) patch[key] = cleanBoolean(body[key], undefined, key);
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

  if (patch.panelDescription.length + patch.warningText.length + 4 > 4_096) {
    throw new Error('La descripción y la advertencia juntas superan el límite de 4096 caracteres de Discord.');
  }
  const totalCharacters = patch.panelTitle.length
    + patch.panelDescription.length
    + patch.warningText.length
    + patch.footerText.length
    + patch.authorName.length;
  if (totalCharacters > 6_000) {
    throw new Error(`El panel supera el máximo total de 6000 caracteres (${totalCharacters}).`);
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

function rateLimitLogin(request, response, next) {
  const key = request.ip;
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 15 * 60_000 });
    return next();
  }
  if (current.count >= 8) {
    response.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1_000)));
    return response.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }
  return next();
}

function registerFailedLogin(ip) {
  const now = Date.now();
  const current = loginAttempts.get(ip) ?? { count: 0, resetAt: now + 15 * 60_000 };
  current.count += 1;
  loginAttempts.set(ip, current);
}

export function createWebServer({ client, store, antiRaid, antiNuke, autoMod }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', 1);
  app.use((_request, response, next) => {
    response.setHeader('X-Dashboard-Version', DASHBOARD_VERSION);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  }));
  app.use(express.json({ limit: '64kb' }));

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
      const username = typeof request.body?.username === 'string' ? request.body.username : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      const user = store.getUserByUsername(username);
      const valid = user && !user.disabled
        ? await verifyPassword(password, user.passwordSalt, user.passwordHash)
        : false;
      if (!valid) {
        registerFailedLogin(request.ip);
        return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      loginAttempts.delete(request.ip);
      const token = createSession(user.id, config.sessionSecret, user.sessionVersion);
      const session = verifySession(token, config.sessionSecret);
      response.setHeader('Set-Cookie', sessionCookie(token, config.secureCookies));
      return response.json({ user: toPublicUser(user), csrf: session.csrf });
    } catch (error) {
      return next(error);
    }
  });

  const authenticate = (request, response, next) => {
    const session = verifySession(readCookie(request, 'bll_session'), config.sessionSecret);
    const user = session ? store.getUserById(session.userId) : null;
    if (
      !session
      || !user
      || user.disabled
      || session.sessionVersion !== user.sessionVersion
    ) return response.status(401).json({ error: 'Sesión no válida.' });
    request.dashboardAuth = { session, user };
    return next();
  };

  const requireCsrf = (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const token = request.get('X-CSRF-Token');
    if (!token || token !== request.dashboardAuth.session.csrf) {
      return response.status(403).json({ error: 'Token de seguridad inválido. Recarga la página.' });
    }
    return next();
  };

  const requirePermission = (permission) => (request, response, next) => {
    if (!can(request.dashboardAuth.user, permission)) {
      return response.status(403).json({ error: 'Tu usuario no tiene permiso para esta sección.' });
    }
    return next();
  };

  const requireAnyPermission = (...permissions) => (request, response, next) => {
    if (!permissions.some((permission) => can(request.dashboardAuth.user, permission))) {
      return response.status(403).json({ error: 'Tu usuario no tiene permiso para este recurso.' });
    }
    return next();
  };

  app.get('/api/auth/session', authenticate, (request, response) => {
    response.json({
      user: toPublicUser(request.dashboardAuth.user),
      csrf: request.dashboardAuth.session.csrf,
    });
  });

  app.use('/api', authenticate, requireCsrf);

  app.post('/api/auth/logout', (_request, response) => {
    response.setHeader('Set-Cookie', clearSessionCookie(config.secureCookies));
    response.json({ ok: true });
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
    const audit = store.getAudit().filter((entry) => {
      if (entry.module === 'Anti-Raid') return can(user, 'antiraid');
      if (entry.module === 'Anti-Nuke') return can(user, 'antinuke');
      if (entry.module === 'AutoMod') return can(user, 'automod');
      if (entry.module === 'Tickets') return can(user, 'tickets');
      if (entry.module === 'Claim Key') return can(user, 'claimkey');
      if (entry.module === 'Embeds') return can(user, 'embeds');
      return can(user, 'users');
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
        antiRaidEnabled: can(user, 'antiraid') ? settings.antiRaid.enabled : null,
        raidMode: can(user, 'antiraid') ? antiRaid.isRaidMode(config.guildId) : null,
        openTickets: can(user, 'tickets') ? ticketCount : null,
        claimKeyAvailable: claimKeyStats?.available ?? null,
        claimKeyClaimed: claimKeyStats?.claimed ?? null,
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

  app.get('/api/embeds', requirePermission('embeds'), (_request, response) => {
    response.json(store.getGuildSettings(config.guildId).embeds);
  });

  app.post('/api/embeds', requirePermission('embeds'), async (request, response, next) => {
    try {
      const embed = await store.saveEmbed(config.guildId, sanitizeSavedEmbed(request.body ?? {}), request.dashboardAuth.user);
      response.status(201).json({ embed });
    } catch (error) { next(error); }
  });

  app.patch('/api/embeds/:id', requirePermission('embeds'), async (request, response, next) => {
    try {
      const current = store.getGuildSettings(config.guildId).embeds.saved.find((item) => item.id === request.params.id);
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
      const section = store.getGuildSettings(config.guildId).embeds;
      const embed = section.saved.find((item) => item.id === request.params.id);
      const channelId = cleanSnowflake(request.body?.channelId, 'Canal', true);
      const guild = client.guilds.cache.get(config.guildId);
      const channel = guild?.channels.cache.get(channelId) ?? await guild?.channels.fetch(channelId).catch(() => null);
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
      const section = store.getGuildSettings(config.guildId).embeds;
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

  app.post('/api/account/password', async (request, response, next) => {
    try {
      const user = request.dashboardAuth.user;
      const currentPassword = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
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

  app.use((error, _request, response, _next) => {
    const invalidJson = error.type === 'entity.parse.failed';
    const safeMessage = invalidJson
      ? 'La solicitud contiene JSON inválido.'
      : error.message || 'Ocurrió un error inesperado.';
    console.error('[Dashboard]', {
      name: error.name || 'Error',
      type: error.type || 'application.error',
      status: Number(error.status) || 400,
      message: safeMessage,
    });
    if (response.headersSent) return;
    response.status(400).json({ error: safeMessage });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ Dashboard disponible en el puerto ${config.port}.`);
  });
  return server;
}
