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
import { can, dashboardPermissions, toPublicUser } from './store.js';
import {
  buildPanel,
  syncOpenTicketPermissions,
  syncPublishedPanels,
} from './tickets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const loginAttempts = new Map();
const SNOWFLAKE = /^\d{17,20}$/;
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);
const EXTRA_BUTTON_ID = /^[a-zA-Z0-9_-]{1,36}$/;

function cleanText(value, fallback, maxLength) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Uno de los textos no es válido.');
  const clean = value.trim();
  if (!clean || clean.length > maxLength) throw new Error(`El texto debe tener entre 1 y ${maxLength} caracteres.`);
  return clean;
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
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function sanitizeExtraButtons(value, current) {
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
      return { id, label, type, style: 'link', value: url.toString() };
    }
    if (typeof button.value !== 'string') throw new Error(`El botón “${label}” necesita contenido.`);
    return {
      id,
      label,
      type,
      style: cleanButtonStyle(button.style, 'secondary'),
      value: cleanText(button.value, undefined, 2_000),
    };
  });
}

function sanitizeAntiRaid(body) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
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

function sanitizeTickets(body, current) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
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
  patch.createButtonLabel = cleanText(body.createButtonLabel, current.createButtonLabel, 80);
  patch.createButtonStyle = cleanButtonStyle(body.createButtonStyle, current.createButtonStyle);
  patch.infoButtonLabel = cleanText(body.infoButtonLabel, current.infoButtonLabel, 80);
  patch.infoButtonStyle = cleanButtonStyle(body.infoButtonStyle, current.infoButtonStyle);
  patch.extraButtons = sanitizeExtraButtons(body.extraButtons, current.extraButtons ?? []);
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

export function createWebServer({ client, store, antiRaid }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
        connectSrc: ["'self'"],
      },
    },
  }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_request, response) => {
    response.status(client.isReady() ? 200 : 503).json({
      ok: client.isReady(),
      discord: client.isReady() ? 'connected' : 'connecting',
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
    const audit = store.getAudit().filter((entry) => {
      if (entry.module === 'Anti-Raid') return can(user, 'antiraid');
      if (entry.module === 'Tickets') return can(user, 'tickets');
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
        dashboardUsers: can(user, 'users') ? store.listUsers().length : null,
      },
      permissions: dashboardPermissions.filter((permission) => can(user, permission)),
      audit,
    });
  });

  app.get('/api/discord/resources', requirePermission('tickets'), (request, response) => {
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
    return response.json({ roles, categories, channels });
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

  app.get('/api/tickets', requirePermission('tickets'), (_request, response) => {
    response.json({ settings: store.getGuildSettings(config.guildId).tickets });
  });

  app.patch('/api/tickets', requirePermission('tickets'), async (request, response, next) => {
    try {
      const current = store.getGuildSettings(config.guildId).tickets;
      const patch = sanitizeTickets(request.body ?? {}, current);
      const proposed = { ...current, ...patch };
      const guild = client.guilds.cache.get(config.guildId);
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

  app.use('/assets', express.static(publicDir, { fallthrough: false, maxAge: '1h' }));
  app.get('/', (_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

  app.use((error, _request, response, _next) => {
    console.error('[Dashboard]', error);
    if (response.headersSent) return;
    const status = error.type === 'entity.parse.failed' ? 400 : 400;
    response.status(status).json({ error: error.message || 'Ocurrió un error inesperado.' });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ Dashboard disponible en el puerto ${config.port}.`);
  });
  return server;
}
