import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from './auth.js';
import {
  getSecurityProfile,
  isSanctionSeverity,
  isSecurityProfileId,
  normalizeSecuritySettings,
  securityProfilePatches,
} from './securityProfiles.js';

export const dashboardPermissions = Object.freeze([
  'antiraid',
  'antinuke',
  'automod',
  'tickets',
  'claimkey',
  'embeds',
  'clients',
  'users',
]);

const CLAIM_KEY_CIPHER = 'aes-256-gcm';
const CLAIM_KEY_CONTEXT = 'bll-claim-key-credentials-v1';
const CLAIM_KEY_MAX_IMPORT = 250;
const CLAIM_KEY_MAX_CREDENTIALS = 5_000;
const CLIENT_MAX_ACCOUNTS = 5_000;
const CLIENT_PORTAL_MAX_DOWNLOADS = 20;
/* Límites de los puntos de restauración: el estado vive en un único JSON que
 * se reescribe completo en cada cambio, así que conviene acotar su tamaño. */
const RESTORE_POINT_MAX = 10;
const RESTORE_POINT_MAX_CHANNELS = 500;
const RESTORE_POINT_MAX_ROLES = 250;
const EMBED_MAX_PER_USER = 100;
const CLIENT_DOWNLOAD_ID = /^[a-zA-Z0-9_-]{1,36}$/;
const CLAIM_KEY_SETTING_KEYS = Object.freeze(new Set([
  'enabled',
  'panelTitle',
  'panelDescription',
  'warningText',
  'footerText',
  'embedColor',
  'authorName',
  'authorIconUrl',
  'panelImageUrl',
  'thumbnailUrl',
  'buttonLabel',
  'buttonStyle',
  'buttonColor',
  'buttonEmoji',
  'credentialEmbedTitle',
  'credentialEmbedDescription',
  'credentialEmbedFooter',
  'credentialEmbedColor',
  'deliveryEmbedTitle',
  'deliveryEmbedDescription',
  'deliveryEmbedFooter',
  'deliveryEmbedColor',
  'deliveryEmbedImageUrl',
  'deliveryEmbedThumbnailUrl',
  'confirmationEmbedTitle',
  'confirmationEmbedDescription',
  'confirmationEmbedFooter',
  'confirmationEmbedColor',
]));
const clone = (value) => structuredClone(value);
const normalizeUsername = (username) => username.trim().toLowerCase();
const actorName = (actor) => typeof actor === 'string' ? actor : actor?.username ?? 'Sistema';

function clientConflictError(message) {
  const error = new Error(message);
  error.code = 'CLIENT_CONFLICT';
  return error;
}

function nextUpdatedAt(previousUpdatedAt) {
  const previousTimestamp = Number.isFinite(Date.parse(previousUpdatedAt))
    ? Date.parse(previousUpdatedAt)
    : 0;
  return new Date(Math.max(Date.now(), previousTimestamp + 1)).toISOString();
}

function deriveClaimKeyEncryptionKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Claim Key necesita un secreto de cifrado de al menos 32 caracteres.');
  }
  return createHash('sha256')
    .update(CLAIM_KEY_CONTEXT)
    .update('\0')
    .update(secret)
    .digest();
}

function encryptCredentialSecret(password, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CLAIM_KEY_CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: CLAIM_KEY_CIPHER,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptCredentialSecret(secret, key) {
  if (
    !secret
    || secret.version !== 1
    || secret.algorithm !== CLAIM_KEY_CIPHER
    || !secret.iv
    || !secret.ciphertext
    || !secret.authTag
  ) {
    throw new Error('Una credencial guardada no tiene un formato de cifrado válido.');
  }
  try {
    const decipher = createDecipheriv(CLAIM_KEY_CIPHER, key, Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('No se pudo descifrar la credencial. Revisa el secreto del dashboard.');
  }
}

function normalizeClaimCredentialInput(value) {
  if (!value || typeof value !== 'object') throw new Error('Una credencial no es válida.');
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/u.test(username)) {
    throw new Error('Cada usuario debe tener entre 1 y 128 caracteres sin saltos de línea.');
  }
  if (!password || password.length > 512 || /[\u0000-\u001f\u007f]/u.test(password)) {
    throw new Error('Cada contraseña debe tener entre 1 y 512 caracteres sin saltos de línea.');
  }
  return { username, password };
}

function normalizeStoredClaimCredential(value, key) {
  if (!value || typeof value !== 'object') return null;
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/u.test(username)) return null;
  let secret = value.secret;
  if (!secret && typeof value.password === 'string' && value.password) {
    secret = encryptCredentialSecret(value.password, key);
  }
  if (!secret) return null;
  const claimedBy = value.claimedBy && typeof value.claimedBy.userId === 'string'
    ? {
        userId: value.claimedBy.userId.slice(0, 32),
        username: String(value.claimedBy.username ?? '').slice(0, 128),
        globalName: String(value.claimedBy.globalName ?? '').slice(0, 128),
        tag: String(value.claimedBy.tag ?? '').slice(0, 128),
        claimedAt: typeof value.claimedBy.claimedAt === 'string'
          ? value.claimedBy.claimedAt
          : typeof value.claimedAt === 'string' ? value.claimedAt : new Date().toISOString(),
      }
    : null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : randomUUID(),
    username,
    secret: clone(secret),
    status: claimedBy ? 'claimed' : 'available',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    claimedBy,
  };
}

function normalizeClaimKeyPanels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const panels = [];
  for (const panel of value.slice(-25)) {
    const channelId = typeof panel?.channelId === 'string' ? panel.channelId : '';
    const messageId = typeof panel?.messageId === 'string' ? panel.messageId : '';
    if (!channelId || !messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    panels.push({ channelId, messageId });
  }
  return panels;
}

function isPublicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.includes(':')) return false;
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return !(parts[0] === 10
      || parts[0] === 127
      || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168));
  } catch {
    return false;
  }
}

function storedText(value, fallback, maximum) {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim();
  return clean && clean.length <= maximum ? clean : fallback;
}

function normalizeClientPortal(existing = {}, defaults = {}) {
  const fallbackDownloads = Array.isArray(defaults.downloads) ? defaults.downloads : [];
  const source = Array.isArray(existing.downloads) ? existing.downloads : fallbackDownloads;
  const downloads = [];
  const ids = new Set();
  for (const [index, item] of source.slice(0, CLIENT_PORTAL_MAX_DOWNLOADS).entries()) {
    if (!item || typeof item !== 'object' || !isPublicHttpsUrl(item.url)) continue;
    let id = CLIENT_DOWNLOAD_ID.test(String(item.id ?? '')) ? String(item.id) : `download-${index + 1}`;
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    downloads.push({
      id,
      name: storedText(item.name, `Descarga ${index + 1}`, 80),
      version: storedText(item.version, 'Actual', 40),
      description: storedText(item.description, 'Descarga disponible para clientes autorizados.', 500),
      buttonLabel: storedText(item.buttonLabel, 'Descargar', 80),
      url: new URL(item.url).toString(),
      enabled: item.enabled !== false,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }
  return {
    title: storedText(existing.title, storedText(defaults.title, 'Centro de Descargas', 120), 120),
    description: storedText(
      existing.description,
      storedText(defaults.description, 'Descargas disponibles para clientes.', 1_000),
      1_000,
    ),
    notice: storedText(existing.notice, storedText(defaults.notice, 'No compartas tu cuenta.', 500), 500),
    downloads,
    updatedAt: typeof existing.updatedAt === 'string' ? existing.updatedAt : new Date().toISOString(),
  };
}

function normalizeStoredClient(value) {
  if (!value || typeof value !== 'object') return null;
  let username;
  try { username = validateUsername(value.username); } catch { return null; }
  if (typeof value.passwordHash !== 'string' || typeof value.passwordSalt !== 'string') return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : randomUUID(),
    username,
    displayName: storedText(value.displayName, username, 80),
    passwordHash: value.passwordHash,
    passwordSalt: value.passwordSalt,
    sessionVersion: Number.isInteger(value.sessionVersion) && value.sessionVersion > 0 ? value.sessionVersion : 1,
    disabled: Boolean(value.disabled),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function publicClaimKeyView(section) {
  const credentials = (section.credentials ?? []).map((credential) => ({
    id: credential.id,
    username: credential.username,
    passwordMasked: '••••••••',
    status: credential.claimedBy ? 'claimed' : 'available',
    createdAt: credential.createdAt,
    claimedBy: credential.claimedBy ? clone(credential.claimedBy) : null,
  }));
  const available = credentials.filter((credential) => credential.status === 'available').length;
  const claimed = credentials.length - available;
  const { credentials: _credentials, ...settings } = section;
  return {
    settings: clone(settings),
    stats: { available, claimed, total: credentials.length },
    credentials,
  };
}

function publicUser(user) {
  const {
    passwordHash: _passwordHash,
    passwordSalt: _passwordSalt,
    sessionVersion: _sessionVersion,
    ...safeUser
  } = user;
  return { ...clone(safeUser), accountType: 'staff' };
}

function publicClient(client) {
  const {
    passwordHash: _passwordHash,
    passwordSalt: _passwordSalt,
    sessionVersion: _sessionVersion,
    ...safeClient
  } = client;
  return { ...clone(safeClient), accountType: 'client' };
}

function publicClientPortal(section, includeDisabled = false) {
  const downloads = (section?.downloads ?? [])
    .filter((download) => includeDisabled || download.enabled)
    .map((download) => clone(download));
  return {
    title: section?.title ?? 'Centro de Descargas',
    description: section?.description ?? '',
    notice: section?.notice ?? '',
    updatedAt: section?.updatedAt ?? null,
    downloads,
  };
}

function publicSecuritySettings(security) {
  const { activatedByUserId: _activatedByUserId, ...safeSecurity } = security ?? {};
  return clone(safeSecurity);
}

/*
 * Alcance de sanciones de AutoMod. Las configuraciones guardadas antes de
 * existir este campo se migran a partir del modo de respuesta, para que el
 * comportamiento no cambie solo por actualizar: pasivo nunca sanciona y
 * estricto sanciona cualquier falta.
 */
function normalizeRestorePoints(value) {
  if (!Array.isArray(value)) return [];
  const points = [];
  for (const item of value.slice(0, RESTORE_POINT_MAX)) {
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item.channels) || !Array.isArray(item.roles)) continue;
    points.push({
      id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
      name: storedText(item.name, 'Punto guardado', 80),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      createdBy: storedText(item.createdBy, 'Sistema', 64),
      guildName: storedText(item.guildName, 'Servidor', 120),
      channels: item.channels.slice(0, RESTORE_POINT_MAX_CHANNELS),
      roles: item.roles.slice(0, RESTORE_POINT_MAX_ROLES),
    });
  }
  return points;
}

function normalizeSanctionSeverity(autoMod) {
  const stored = autoMod?.sanctionSeverity;
  if (isSanctionSeverity(stored)) return stored;
  if (autoMod?.responseMode === 'passive') return 'none';
  if (autoMod?.responseMode === 'strict') return 'all';
  return 'high';
}

function guildMatchesSecurityProfile(settings, profileId) {
  const patches = securityProfilePatches(profileId);
  return Object.entries(patches).every(([moduleName, patch]) => (
    Object.entries(patch).every(([key, value]) => Object.is(settings[moduleName]?.[key], value))
  ));
}

function userCanManageEmbeds(user) {
  return Boolean(user && !user.disabled && (user.isAdmin || user.permissions.includes('embeds')));
}

function requireEmbedOwnerId(actor) {
  if (!actor?.id || typeof actor.id !== 'string') {
    throw new Error('No se pudo identificar al propietario del embed.');
  }
  return actor.id;
}

function requireCurrentEmbedManager(data, ownerUserId) {
  const owner = data.users.find((user) => user.id === ownerUserId);
  if (!userCanManageEmbeds(owner)) {
    throw new Error('Tu usuario ya no tiene permiso para administrar embeds.');
  }
  return owner;
}

function publicSavedEmbed(embed) {
  const { ownerUserId: _ownerUserId, ...safeEmbed } = embed;
  return clone(safeEmbed);
}

function publicEmbedSchedule(schedule) {
  const { ownerUserId: _ownerUserId, ...safeSchedule } = schedule;
  return clone(safeSchedule);
}

function normalizeOwnedEmbeds(section, users, adminUsername) {
  const usersById = new Map(users.map((user) => [user.id, user]));
  const configuredAdmin = users.find(
    (user) => user.isAdmin
      && normalizeUsername(user.username) === normalizeUsername(adminUsername),
  );
  const fallbackOwner = configuredAdmin
    ?? users.find((user) => user.isAdmin && !user.disabled)
    ?? users.find((user) => user.isAdmin)
    ?? users[0]
    ?? null;
  const saved = [];
  for (const stored of Array.isArray(section?.saved) ? section.saved : []) {
    if (!stored || typeof stored !== 'object' || typeof stored.id !== 'string' || !stored.id) continue;
    const ownerUserId = usersById.has(stored.ownerUserId)
      ? stored.ownerUserId
      : fallbackOwner?.id;
    if (!ownerUserId) continue;
    saved.push({ ...clone(stored), ownerUserId });
  }
  const ownerByEmbedId = new Map(saved.map((embed) => [embed.id, embed.ownerUserId]));
  const schedules = [];
  for (const stored of Array.isArray(section?.schedules) ? section.schedules : []) {
    if (!stored || typeof stored !== 'object' || typeof stored.id !== 'string' || !stored.id) continue;
    const ownerUserId = ownerByEmbedId.get(stored.embedId);
    if (!ownerUserId) continue;
    const owner = usersById.get(ownerUserId);
    schedules.push({
      ...clone(stored),
      ownerUserId,
      enabled: userCanManageEmbeds(owner) ? Boolean(stored.enabled) : false,
    });
  }
  return { ...clone(section ?? {}), saved, schedules };
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())) {
    throw new Error('El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.');
  }
  return username.trim();
}

function validatePassword(password, minimum = 8) {
  if (typeof password !== 'string' || password.length < minimum || password.length > 128) {
    throw new Error(`La contraseña debe tener entre ${minimum} y 128 caracteres.`);
  }
  return password;
}

function validateDisplayName(displayName, fallback) {
  if (displayName === undefined) return fallback;
  if (typeof displayName !== 'string') throw new Error('El nombre visible del cliente no es válido.');
  const clean = displayName.trim();
  if (!clean || clean.length > 80) throw new Error('El nombre visible debe tener entre 1 y 80 caracteres.');
  return clean;
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return [];
  return [...new Set(permissions.filter((permission) => dashboardPermissions.includes(permission)))];
}

function validateDelegation(actor, permissions, wantsAdmin) {
  if (actor?.isAdmin) return;
  if (wantsAdmin) throw new Error('Solo un administrador puede conceder acceso total.');
  const unauthorized = permissions.find((permission) => !actor?.permissions.includes(permission));
  if (unauthorized) throw new Error('No puedes conceder permisos que tu cuenta no posee.');
}

export class SettingsStore {
  constructor({ dataDir, guildId, defaults, adminUsername, adminPassword, encryptionSecret }) {
    this.filePath = path.join(dataDir, 'bll-store.json');
    this.tempPath = `${this.filePath}.tmp`;
    this.dataDir = dataDir;
    this.guildId = guildId;
    this.defaults = clone(defaults);
    this.adminUsername = adminUsername;
    this.adminPassword = adminPassword;
    this.claimKeyEncryptionKey = deriveClaimKeyEncryptionKey(encryptionSecret);
    this.data = null;
    this.mutationData = null;
    this.writeQueue = Promise.resolve();
    this.claimKeyOperationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, users: [], guilds: {}, audit: [] };
    }

    this.data.version = Math.max(Number(this.data.version) || 1, 5);
    this.data.users ??= [];
    this.data.clients ??= [];
    this.data.guilds ??= {};
    this.data.audit ??= [];
    for (const user of this.data.users) {
      user.sessionVersion ??= 1;
      user.permissions = user.isAdmin
        ? [...dashboardPermissions]
        : normalizePermissions(user.permissions);
    }
    const occupiedUsernames = new Set(
      this.data.users.map((user) => normalizeUsername(user.username)),
    );
    const clients = [];
    for (const stored of this.data.clients.slice(0, CLIENT_MAX_ACCOUNTS)) {
      const client = normalizeStoredClient(stored);
      if (!client) continue;
      const normalized = normalizeUsername(client.username);
      if (occupiedUsernames.has(normalized)) continue;
      occupiedUsernames.add(normalized);
      clients.push(client);
    }
    this.data.clients = clients;
    const existingGuild = this.data.guilds[this.guildId];
    const existing = existingGuild ?? {};
    const existingClaimKey = existing.claimKey ?? {};
    const claimKeyCredentials = [];
    const claimKeyUsernames = new Set();
    for (const stored of Array.isArray(existingClaimKey.credentials) ? existingClaimKey.credentials : []) {
      const credential = normalizeStoredClaimCredential(stored, this.claimKeyEncryptionKey);
      if (!credential) continue;
      const normalized = normalizeUsername(credential.username);
      if (claimKeyUsernames.has(normalized)) continue;
      claimKeyUsernames.add(normalized);
      claimKeyCredentials.push(credential);
      if (claimKeyCredentials.length >= CLAIM_KEY_MAX_CREDENTIALS) break;
    }
    this.data.guilds[this.guildId] = {
      security: normalizeSecuritySettings(existing.security ?? this.defaults.security, {
        legacy: Boolean(existingGuild && !existing.security),
      }),
      antiRaid: { ...clone(this.defaults.antiRaid), ...(existing.antiRaid ?? {}) },
      antiNuke: {
        ...clone(this.defaults.antiNuke),
        ...(existing.antiNuke ?? {}),
        snapshot: {
          ...clone(this.defaults.antiNuke.snapshot),
          ...(existing.antiNuke?.snapshot ?? {}),
          channels: Array.isArray(existing.antiNuke?.snapshot?.channels) ? existing.antiNuke.snapshot.channels : [],
          roles: Array.isArray(existing.antiNuke?.snapshot?.roles) ? existing.antiNuke.snapshot.roles : [],
          emojis: Array.isArray(existing.antiNuke?.snapshot?.emojis) ? existing.antiNuke.snapshot.emojis : [],
        },
        incidents: Array.isArray(existing.antiNuke?.incidents) ? existing.antiNuke.incidents.slice(0, 50) : [],
      },
      autoMod: {
        ...clone(this.defaults.autoMod),
        ...(existing.autoMod ?? {}),
        sanctionSeverity: normalizeSanctionSeverity(existing.autoMod),
        strikes: Array.isArray(existing.autoMod?.strikes) ? existing.autoMod.strikes.slice(0, 500) : [],
      },
      tickets: { ...clone(this.defaults.tickets), ...(existing.tickets ?? {}) },
      claimKey: {
        ...clone(this.defaults.claimKey),
        ...existingClaimKey,
        credentials: claimKeyCredentials,
        publishedPanels: normalizeClaimKeyPanels(existingClaimKey.publishedPanels),
      },
      clientPortal: normalizeClientPortal(existing.clientPortal, this.defaults.clientPortal),
      restorePoints: normalizeRestorePoints(existing.restorePoints),
      embeds: {
        ...clone(this.defaults.embeds),
        ...(existing.embeds ?? {}),
        saved: Array.isArray(existing.embeds?.saved) ? existing.embeds.saved : [],
        schedules: Array.isArray(existing.embeds?.schedules) ? existing.embeds.schedules : [],
      },
    };
    const initializedGuild = this.data.guilds[this.guildId];
    if (
      !existingGuild
      && isSecurityProfileId(initializedGuild.security.profile)
      && !guildMatchesSecurityProfile(initializedGuild, initializedGuild.security.profile)
    ) {
      initializedGuild.security = {
        ...initializedGuild.security,
        profile: 'custom',
        previousProfile: initializedGuild.security.profile,
        activatedBy: 'Configuración inicial personalizada',
      };
    }

    if (this.data.users.length === 0) {
      const username = validateUsername(this.adminUsername);
      const password = validatePassword(this.adminPassword, 2);
      const credentials = await hashPassword(password);
      this.data.users.push({
        id: randomUUID(),
        username,
        passwordHash: credentials.hash,
        passwordSalt: credentials.salt,
        sessionVersion: 1,
        permissions: [...dashboardPermissions],
        isAdmin: true,
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.addAudit(username, 'Sistema', 'Administrador inicial creado');
    }

    this.data.guilds[this.guildId].embeds = normalizeOwnedEmbeds(
      this.data.guilds[this.guildId].embeds,
      this.data.users,
      this.adminUsername,
    );

    await this.persist();
  }

  async persist(data = this.data) {
    await writeFile(this.tempPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(this.tempPath, this.filePath);
  }

  async mutate(mutator, { shouldPersist = () => true } = {}) {
    let result;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const draft = clone(this.data);
      this.mutationData = draft;
      try {
        result = await mutator(draft);
        if (!shouldPersist(result)) return;
        await this.persist(draft);
        this.data = draft;
      } finally {
        this.mutationData = null;
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  addAudit(actor, module, action) {
    const data = this.mutationData ?? this.data;
    const actorId = typeof actor === 'object' && typeof actor?.id === 'string' ? actor.id : null;
    data.audit.unshift({
      id: randomUUID(),
      actor: actorName(actor),
      actorId,
      module,
      action,
      at: new Date().toISOString(),
    });
    data.audit = data.audit.slice(0, 100);
  }

  getGuildSettings(guildId = this.guildId) {
    const settings = this.data.guilds[guildId] ?? this.data.guilds[this.guildId];
    return clone(settings);
  }

  getAudit(limit = 12) {
    return clone(this.data.audit.slice(0, limit));
  }

  async recordAudit(actor, module, action) {
    return this.mutate(() => {
      this.addAudit(actor, module, action);
      return true;
    });
  }

  async recordPublishedPanel(guildId, channelId, messageId, actor) {
    return this.mutate((data) => {
      const tickets = data.guilds[guildId].tickets;
      const panels = Array.isArray(tickets.publishedPanels) ? tickets.publishedPanels : [];
      tickets.publishedPanels = [
        ...panels.filter((panel) => panel.messageId !== messageId),
        { channelId, messageId },
      ].slice(-25);
      this.addAudit(actor, 'Tickets', `Panel publicado en el canal ${channelId}`);
      return clone(tickets.publishedPanels);
    });
  }

  async replacePublishedPanels(guildId, panels) {
    return this.mutate((data) => {
      data.guilds[guildId].tickets.publishedPanels = clone(panels).slice(-25);
      return clone(data.guilds[guildId].tickets.publishedPanels);
    });
  }

  getClaimKeyAdminView(guildId = this.guildId) {
    const section = this.data.guilds[guildId]?.claimKey;
    if (!section) throw new Error('La configuración Claim Key no está disponible.');
    return publicClaimKeyView(section);
  }

  isClaimKeyPublishedPanel(guildId, channelId, messageId) {
    const panels = this.data.guilds[guildId]?.claimKey?.publishedPanels ?? [];
    return panels.some((panel) => panel.channelId === channelId && panel.messageId === messageId);
  }

  enqueueClaimKeyOperation(operation) {
    const result = this.claimKeyOperationQueue.then(operation, operation);
    this.claimKeyOperationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async updateClaimKeySettings(guildId, patch, actor) {
    const safePatch = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (CLAIM_KEY_SETTING_KEYS.has(key)) safePatch[key] = clone(value);
    }
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');
      Object.assign(section, safePatch);
      this.addAudit(actor, 'Claim Key', 'Configuración actualizada');
      return publicClaimKeyView(section);
    });
  }

  async addClaimKeyCredentials(guildId, credentials, actor) {
    if (!Array.isArray(credentials) || credentials.length < 1 || credentials.length > CLAIM_KEY_MAX_IMPORT) {
      throw new Error(`Añade entre 1 y ${CLAIM_KEY_MAX_IMPORT} credenciales por petición.`);
    }
    const normalizedCredentials = credentials.map(normalizeClaimCredentialInput);
    const incomingUsernames = new Set();
    for (const credential of normalizedCredentials) {
      const normalized = normalizeUsername(credential.username);
      if (incomingUsernames.has(normalized)) {
        throw new Error(`El usuario “${credential.username}” está repetido en la importación.`);
      }
      incomingUsernames.add(normalized);
    }

    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');
      const existingUsernames = new Set(section.credentials.map((item) => normalizeUsername(item.username)));
      const duplicate = normalizedCredentials.find((item) => existingUsernames.has(normalizeUsername(item.username)));
      if (duplicate) throw new Error(`El usuario “${duplicate.username}” ya existe en el inventario.`);
      if (section.credentials.length + normalizedCredentials.length > CLAIM_KEY_MAX_CREDENTIALS) {
        throw new Error(`El inventario permite un máximo de ${CLAIM_KEY_MAX_CREDENTIALS} credenciales.`);
      }
      const createdAt = new Date().toISOString();
      const created = normalizedCredentials.map(({ username, password }) => ({
        id: randomUUID(),
        username,
        secret: encryptCredentialSecret(password, this.claimKeyEncryptionKey),
        status: 'available',
        createdAt,
        claimedBy: null,
      }));
      section.credentials.push(...created);
      this.addAudit(actor, 'Claim Key', `${created.length} credencial(es) añadida(s) al inventario`);
      return publicClaimKeyView(section);
    });
  }

  async deleteClaimKeyCredential(guildId, credentialId, actor) {
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');
      const index = section.credentials.findIndex((credential) => credential.id === credentialId);
      if (index < 0) throw new Error('Credencial no encontrada.');
      const credential = section.credentials[index];
      if (credential.claimedBy || credential.status === 'claimed') {
        throw new Error('Las credenciales reclamadas no se pueden eliminar desde esta acción.');
      }
      section.credentials.splice(index, 1);
      this.addAudit(actor, 'Claim Key', `Credencial disponible eliminada: ${credential.username}`);
      return publicClaimKeyView(section);
    });
  }

  async resetClaimKeyClaims(guildId, actor) {
    return this.enqueueClaimKeyOperation(() => this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');

      section.enabled = false;
      let resetCount = 0;
      for (const credential of section.credentials) {
        if (credential.claimedBy || credential.status === 'claimed') {
          credential.status = 'available';
          credential.claimedBy = null;
          resetCount += 1;
        }
      }

      this.addAudit(
        actor,
        'Claim Key',
        `Reinicio global de reclamaciones: ${resetCount} registro(s); entregas pausadas`,
      );
      return { view: publicClaimKeyView(section), resetCount };
    }));
  }

  async claimCredential(guildId, discordUser) {
    return this.enqueueClaimKeyOperation(
      () => this.claimCredentialWithinOperation(guildId, discordUser),
    );
  }

  async deliverClaimCredential(guildId, discordUser, deliver) {
    if (typeof deliver !== 'function') throw new Error('La entrega de Claim Key no es válida.');
    return this.enqueueClaimKeyOperation(async () => {
      const result = await this.claimCredentialWithinOperation(guildId, discordUser);
      if (result.status !== 'claimed') return result;
      try {
        await deliver(result);
        return result;
      } catch (cause) {
        await this.rollbackClaimCredentialWithinOperation(guildId, result, discordUser);
        const error = new Error(
          'No se pudo completar la entrega privada. La credencial fue devuelta al inventario.',
          { cause },
        );
        error.code = 'CLAIM_KEY_DM_FAILED';
        error.reason = String(cause?.code) === '50007'
          ? 'dm_closed'
          : cause?.code === 'CLAIM_KEY_DM_INVALID'
            ? 'invalid_payload'
            : 'delivery_error';
        throw error;
      }
    });
  }

  async rollbackClaimCredentialWithinOperation(guildId, result, discordUser) {
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      const credential = section?.credentials.find((item) => (
        item.id === result.credentialId
        && item.claimedBy?.userId === result.userId
        && item.claimedBy?.claimedAt === result.claimedAt
      ));
      if (!credential) return false;
      credential.status = 'available';
      credential.claimedBy = null;
      const auditIdentity = String(discordUser?.tag || discordUser?.username || result.userId);
      this.addAudit(auditIdentity, 'Claim Key', `Entrega privada revertida para el Discord ID ${result.userId}`);
      return true;
    });
  }

  async claimCredentialWithinOperation(guildId, discordUser) {
    const userId = typeof discordUser?.id === 'string' ? discordUser.id.trim() : '';
    if (!userId) throw new Error('No se pudo identificar la cuenta de Discord.');
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section?.enabled) return { status: 'disabled' };
      if (section.credentials.some((credential) => credential.claimedBy?.userId === userId)) {
        return { status: 'already_claimed' };
      }
      const credential = section.credentials.find((item) => !item.claimedBy && item.status !== 'claimed');
      if (!credential) return { status: 'out_of_stock' };

      // El descifrado ocurre antes de modificar el inventario: una clave corrupta nunca consume stock.
      const password = decryptCredentialSecret(credential.secret, this.claimKeyEncryptionKey);
      const claimedAt = new Date().toISOString();
      credential.status = 'claimed';
      credential.claimedBy = {
        userId,
        username: String(discordUser.username ?? '').slice(0, 128),
        globalName: String(discordUser.globalName ?? '').slice(0, 128),
        tag: String(discordUser.tag ?? '').slice(0, 128),
        claimedAt,
      };
      const auditIdentity = credential.claimedBy.tag || credential.claimedBy.username || userId;
      this.addAudit(auditIdentity, 'Claim Key', `Acceso asignado al Discord ID ${userId}`);
      return {
        status: 'claimed',
        credentialId: credential.id,
        userId,
        username: credential.username,
        password,
        claimedAt,
      };
    }, {
      shouldPersist: (result) => result.status === 'claimed',
    });
  }

  async recordClaimKeyPublishedPanel(guildId, channelId, messageId, actor) {
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');
      section.publishedPanels = normalizeClaimKeyPanels([
        ...(section.publishedPanels ?? []).filter((panel) => panel.messageId !== messageId),
        { channelId, messageId },
      ]);
      this.addAudit(actor, 'Claim Key', `Panel publicado en el canal ${channelId}`);
      return clone(section.publishedPanels);
    });
  }

  async replaceClaimKeyPublishedPanels(guildId, panels) {
    return this.mutate((data) => {
      const section = data.guilds[guildId]?.claimKey;
      if (!section) throw new Error('La configuración Claim Key no está disponible.');
      section.publishedPanels = normalizeClaimKeyPanels(panels);
      return clone(section.publishedPanels);
    });
  }

  getUserEmbeds(guildId, ownerUserId) {
    const section = this.data.guilds[guildId]?.embeds;
    const owner = this.data.users.find((user) => user.id === ownerUserId);
    if (
      !section
      || typeof ownerUserId !== 'string'
      || !ownerUserId
      || !userCanManageEmbeds(owner)
    ) {
      return { saved: [], schedules: [] };
    }
    const saved = section.saved
      .filter((embed) => embed.ownerUserId === ownerUserId)
      .map(publicSavedEmbed);
    const embedIds = new Set(saved.map((embed) => embed.id));
    const schedules = section.schedules
      .filter((schedule) => schedule.ownerUserId === ownerUserId && embedIds.has(schedule.embedId))
      .map(publicEmbedSchedule);
    return { saved, schedules };
  }

  getUserEmbed(guildId, embedId, ownerUserId) {
    const owner = this.data.users.find((user) => user.id === ownerUserId);
    if (!userCanManageEmbeds(owner)) return null;
    const embed = this.data.guilds[guildId]?.embeds?.saved.find(
      (item) => item.id === embedId && item.ownerUserId === ownerUserId,
    );
    return embed ? publicSavedEmbed(embed) : null;
  }

  async saveEmbed(guildId, embed, actor) {
    const ownerUserId = requireEmbedOwnerId(actor);
    return this.mutate((data) => {
      const currentActor = requireCurrentEmbedManager(data, ownerUserId);
      const list = data.guilds[guildId].embeds.saved;
      const index = embed.id ? list.findIndex((item) => item.id === embed.id) : -1;
      if (embed.id && (index < 0 || list[index].ownerUserId !== ownerUserId)) {
        throw new Error('Embed no encontrado.');
      }
      const ownedCount = list.filter((item) => item.ownerUserId === ownerUserId).length;
      if (index < 0 && ownedCount >= EMBED_MAX_PER_USER) {
        throw new Error(`Has alcanzado el límite de ${EMBED_MAX_PER_USER} embeds guardados.`);
      }
      const now = new Date().toISOString();
      const value = {
        ...clone(embed),
        id: index >= 0 ? embed.id : randomUUID(),
        ownerUserId,
        updatedAt: now,
      };
      if (index >= 0) list[index] = { ...list[index], ...value };
      else list.push({ ...value, createdAt: now });
      this.addAudit(currentActor, 'Embeds', `${index >= 0 ? 'Embed actualizado' : 'Embed creado'}: ${value.name}`);
      return publicSavedEmbed(index >= 0 ? list[index] : list.at(-1));
    });
  }

  async deleteEmbed(guildId, id, actor) {
    const ownerUserId = requireEmbedOwnerId(actor);
    return this.mutate((data) => {
      const currentActor = requireCurrentEmbedManager(data, ownerUserId);
      const section = data.guilds[guildId].embeds;
      const embed = section.saved.find(
        (item) => item.id === id && item.ownerUserId === ownerUserId,
      );
      if (!embed) throw new Error('Embed no encontrado.');
      section.saved = section.saved.filter(
        (item) => item.id !== id || item.ownerUserId !== ownerUserId,
      );
      section.schedules = section.schedules.filter(
        (item) => item.embedId !== id || item.ownerUserId !== ownerUserId,
      );
      this.addAudit(currentActor, 'Embeds', `Embed eliminado: ${embed.name}`);
      return true;
    });
  }

  async saveSchedule(guildId, schedule, actor) {
    const ownerUserId = requireEmbedOwnerId(actor);
    return this.mutate((data) => {
      const currentActor = requireCurrentEmbedManager(data, ownerUserId);
      const section = data.guilds[guildId].embeds;
      const embed = section.saved.find(
        (item) => item.id === schedule.embedId && item.ownerUserId === ownerUserId,
      );
      if (!embed) throw new Error('Embed no encontrado.');
      const index = section.schedules.findIndex((item) => item.embedId === schedule.embedId);
      if (index >= 0 && section.schedules[index].ownerUserId !== ownerUserId) {
        throw new Error('Embed no encontrado.');
      }
      const value = {
        ...clone(schedule),
        id: index >= 0 ? section.schedules[index].id : randomUUID(),
        ownerUserId,
      };
      if (index >= 0) section.schedules[index] = value;
      else section.schedules.push(value);
      this.addAudit(currentActor, 'Embeds', `Programación actualizada: ${embed.name}`);
      return publicEmbedSchedule(value);
    });
  }

  async deleteSchedule(guildId, embedId, actor) {
    const ownerUserId = requireEmbedOwnerId(actor);
    return this.mutate((data) => {
      const currentActor = requireCurrentEmbedManager(data, ownerUserId);
      const section = data.guilds[guildId].embeds;
      const embed = section.saved.find(
        (item) => item.id === embedId && item.ownerUserId === ownerUserId,
      );
      if (!embed) throw new Error('Embed no encontrado.');
      section.schedules = section.schedules.filter(
        (item) => item.embedId !== embedId || item.ownerUserId !== ownerUserId,
      );
      this.addAudit(currentActor, 'Embeds', `Programación eliminada: ${embed.name}`);
      return true;
    });
  }

  async deleteOrphanedSchedule(guildId, scheduleId) {
    return this.mutate((data) => {
      const section = data.guilds[guildId].embeds;
      const schedule = section.schedules.find((item) => item.id === scheduleId);
      if (!schedule) return false;
      const hasOwnedEmbed = section.saved.some(
        (embed) => embed.id === schedule.embedId && embed.ownerUserId === schedule.ownerUserId,
      );
      if (hasOwnedEmbed) return false;
      section.schedules = section.schedules.filter((item) => item.id !== scheduleId);
      return true;
    }, {
      shouldPersist: (deleted) => deleted,
    });
  }

  async reserveScheduleRun(guildId, expectedSchedule, now = Date.now()) {
    return this.mutate((data) => {
      const section = data.guilds[guildId].embeds;
      const schedule = section.schedules.find((item) => item.id === expectedSchedule?.id);
      if (
        !schedule
        || !schedule.enabled
        || schedule.nextRunAt > now
        || schedule.embedId !== expectedSchedule.embedId
        || schedule.ownerUserId !== expectedSchedule.ownerUserId
        || schedule.channelId !== expectedSchedule.channelId
        || schedule.intervalMinutes !== expectedSchedule.intervalMinutes
      ) return null;
      const owner = data.users.find((user) => user.id === schedule.ownerUserId);
      const embed = section.saved.find(
        (item) => item.id === schedule.embedId && item.ownerUserId === schedule.ownerUserId,
      );
      if (!embed || !userCanManageEmbeds(owner)) return null;
      schedule.nextRunAt = now + schedule.intervalMinutes * 60_000;
      schedule.lastError = '';
      return {
        schedule: publicEmbedSchedule(schedule),
        embed: publicSavedEmbed(embed),
      };
    }, {
      shouldPersist: (reservation) => reservation !== null,
    });
  }

  async updateScheduleRun(guildId, id, patch) {
    return this.mutate((data) => {
      const schedule = data.guilds[guildId].embeds.schedules.find((item) => item.id === id);
      if (!schedule) return null;
      Object.assign(schedule, clone(patch));
      return publicEmbedSchedule(schedule);
    });
  }

  /* --- Puntos de restauración del servidor --- */

  getRestorePoints(guildId = this.guildId) {
    const points = this.data.guilds[guildId]?.restorePoints ?? [];
    // La lista omite el contenido: un punto completo puede pesar cientos de
    // kilobytes y el panel solo necesita la ficha para elegir.
    return points.map((point) => ({
      id: point.id,
      name: point.name,
      createdAt: point.createdAt,
      createdBy: point.createdBy,
      guildName: point.guildName,
      channels: point.channels.length,
      roles: point.roles.length,
    }));
  }

  getRestorePoint(guildId, pointId) {
    const point = (this.data.guilds[guildId]?.restorePoints ?? []).find((item) => item.id === pointId);
    return point ? clone(point) : null;
  }

  async createRestorePoint(guildId, point, actor) {
    return this.mutate((data) => {
      const guild = data.guilds[guildId];
      if (!guild) throw new Error('El servidor no está disponible.');
      if (!Array.isArray(guild.restorePoints)) guild.restorePoints = [];
      if (guild.restorePoints.length >= RESTORE_POINT_MAX) {
        throw new Error(
          `Solo se pueden guardar ${RESTORE_POINT_MAX} puntos. Elimina uno antes de crear otro.`,
        );
      }
      const stored = {
        id: randomUUID(),
        name: storedText(point.name, `Punto ${guild.restorePoints.length + 1}`, 80),
        createdAt: new Date().toISOString(),
        createdBy: actorName(actor).slice(0, 64),
        guildName: storedText(point.guildName, 'Servidor', 120),
        channels: clone(point.channels ?? []).slice(0, RESTORE_POINT_MAX_CHANNELS),
        roles: clone(point.roles ?? []).slice(0, RESTORE_POINT_MAX_ROLES),
      };
      guild.restorePoints.unshift(stored);
      this.addAudit(
        actor,
        'Restauración',
        `Punto de restauración creado: ${stored.name} (${stored.channels.length} canales, ${stored.roles.length} roles)`,
      );
      return {
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        createdBy: stored.createdBy,
        guildName: stored.guildName,
        channels: stored.channels.length,
        roles: stored.roles.length,
      };
    });
  }

  async deleteRestorePoint(guildId, pointId, actor) {
    return this.mutate((data) => {
      const guild = data.guilds[guildId];
      const points = Array.isArray(guild?.restorePoints) ? guild.restorePoints : [];
      const index = points.findIndex((item) => item.id === pointId);
      if (index < 0) throw new Error('Punto de restauración no encontrado.');
      const [removed] = points.splice(index, 1);
      this.addAudit(actor, 'Restauración', `Punto de restauración eliminado: ${removed.name}`);
      return true;
    });
  }

  async replaceAntiNukeSnapshot(guildId, snapshot) {
    return this.mutate((data) => {
      data.guilds[guildId].antiNuke.snapshot = clone(snapshot);
      return clone(snapshot);
    });
  }

  async syncAntiNukeMemberRoles(guildId, memberId, roleIds) {
    return this.mutate((data) => {
      const roles = data.guilds[guildId].antiNuke.snapshot.roles;
      const memberships = new Set(roleIds);
      for (const role of roles) {
        role.memberIds = (role.memberIds ?? []).filter((id) => id !== memberId);
        if (memberships.has(role.id)) role.memberIds.push(memberId);
      }
      return true;
    });
  }

  async recordAntiNukeIncident(guildId, incident) {
    return this.mutate((data) => {
      const incidents = data.guilds[guildId].antiNuke.incidents;
      const value = { id: randomUUID(), ...clone(incident), createdAt: new Date().toISOString() };
      incidents.unshift(value);
      data.guilds[guildId].antiNuke.incidents = incidents.slice(0, 50);
      return clone(value);
    });
  }

  async recordAutoModStrike(guildId, userId, rule, windowHours) {
    return this.mutate((data) => {
      const autoMod = data.guilds[guildId].autoMod;
      if (!autoMod.enabled || autoMod.responseMode === 'passive') {
        return { skipped: true };
      }
      const now = Date.now();
      const windowMs = windowHours * 3_600_000;
      const profileActivatedAt = Date.parse(data.guilds[guildId].security?.activatedAt ?? '');
      autoMod.strikes = autoMod.strikes.filter((item) => now - item.lastAt <= windowMs);
      let strike = autoMod.strikes.find((item) => item.userId === userId);
      if (strike && Number.isFinite(profileActivatedAt) && strike.lastAt < profileActivatedAt) {
        strike.count = 0;
        strike.finalizedAt = null;
      }
      if (!strike) {
        strike = { userId, count: 0, lastAt: now, lastRule: rule, finalizedAt: null };
        autoMod.strikes.push(strike);
      }
      strike.count += 1;
      strike.lastAt = now;
      strike.lastRule = rule;
      autoMod.strikes = autoMod.strikes
        .sort((left, right) => right.lastAt - left.lastAt)
        .slice(0, 500);
      return clone(strike);
    }, {
      shouldPersist: (result) => !result.skipped,
    });
  }

  async markAutoModFinalized(guildId, userId) {
    return this.mutate((data) => {
      const strike = data.guilds[guildId].autoMod.strikes.find((item) => item.userId === userId);
      if (!strike) return null;
      strike.finalizedAt = Date.now();
      return clone(strike);
    });
  }

  async clearAutoModStrikes(guildId, actor) {
    return this.mutate((data) => {
      const currentActor = data.users.find((user) => user.id === actor?.id);
      if (!can(currentActor, 'automod')) {
        throw new Error('Tu usuario ya no tiene permiso para administrar AutoMod.');
      }
      data.guilds[guildId].autoMod.strikes = [];
      this.addAudit(currentActor, 'AutoMod', 'Historial de sanciones progresivas reiniciado');
      return true;
    });
  }

  getSecurityState(guildId = this.guildId) {
    const security = this.data.guilds[guildId]?.security;
    if (!security) throw new Error('El Centro de Seguridad no está disponible.');
    return publicSecuritySettings(security);
  }

  async applySecurityProfile(guildId, profileId, actor) {
    if (!isSecurityProfileId(profileId)) {
      throw new Error('El perfil de seguridad seleccionado no es válido.');
    }
    if (!actor?.id || typeof actor.id !== 'string') {
      throw new Error('No se pudo identificar al operador de seguridad.');
    }
    const profile = getSecurityProfile(profileId);
    const patches = securityProfilePatches(profileId);
    return this.mutate((data) => {
      const currentActor = data.users.find((user) => user.id === actor.id);
      const requiredPermissions = ['antiraid', 'antinuke', 'automod'];
      if (!requiredPermissions.every((permission) => can(currentActor, permission))) {
        throw new Error('Necesitas permisos de Anti-Raid, Anti-Nuke y AutoMod para cambiar el perfil global.');
      }
      const guild = data.guilds[guildId];
      if (!guild) throw new Error('El servidor no tiene configuración de seguridad.');
      const previous = normalizeSecuritySettings(guild.security ?? this.defaults.security);
      const now = new Date().toISOString();
      guild.antiRaid = { ...guild.antiRaid, ...patches.antiRaid };
      guild.antiNuke = { ...guild.antiNuke, ...patches.antiNuke };
      guild.autoMod = { ...guild.autoMod, ...patches.autoMod };
      guild.security = {
        ...previous,
        profile: profileId,
        previousProfile: isSecurityProfileId(previous.profile)
          ? previous.profile
          : previous.previousProfile,
        activatedAt: now,
        activatedBy: currentActor.username,
        activatedByUserId: currentActor.id,
        updatedAt: now,
      };
      this.addAudit(currentActor, 'Seguridad', `Perfil ${profile.name} activado`);
      return {
        security: publicSecuritySettings(guild.security),
        antiRaid: clone(guild.antiRaid),
        antiNuke: clone(guild.antiNuke),
        autoMod: clone(guild.autoMod),
      };
    });
  }

  async updateGuildSection(guildId, section, patch, actor) {
    const modules = {
      antiRaid: 'Anti-Raid',
      antiNuke: 'Anti-Nuke',
      autoMod: 'AutoMod',
      tickets: 'Tickets',
    };
    const securityPermissions = {
      antiRaid: 'antiraid',
      antiNuke: 'antinuke',
      autoMod: 'automod',
    };
    if (!modules[section]) throw new Error('Sección inválida.');
    return this.mutate((data) => {
      data.guilds[guildId] ??= clone(this.data.guilds[this.guildId]);
      let auditActor = actor;
      if (securityPermissions[section]) {
        const currentActor = data.users.find((user) => user.id === actor?.id);
        if (!can(currentActor, securityPermissions[section])) {
          throw new Error(`Tu usuario ya no tiene permiso para administrar ${modules[section]}.`);
        }
        auditActor = currentActor;
        const security = normalizeSecuritySettings(
          data.guilds[guildId].security ?? this.defaults.security,
        );
        const now = new Date().toISOString();
        data.guilds[guildId].security = {
          ...security,
          profile: 'custom',
          previousProfile: isSecurityProfileId(security.profile)
            ? security.profile
            : security.previousProfile,
          activatedAt: now,
          activatedBy: currentActor.username,
          activatedByUserId: currentActor.id,
          updatedAt: now,
        };
      }
      data.guilds[guildId][section] = { ...data.guilds[guildId][section], ...clone(patch) };
      this.addAudit(auditActor, modules[section], 'Configuración actualizada');
      return clone(data.guilds[guildId][section]);
    });
  }

  getClientPortal(guildId = this.guildId, includeDisabled = false) {
    const section = this.data.guilds[guildId]?.clientPortal;
    if (!section) throw new Error('El portal de clientes no está disponible.');
    return publicClientPortal(section, includeDisabled);
  }

  async updateClientPortal(guildId, portal, actor, expectedUpdatedAt) {
    if (!portal || typeof portal !== 'object' || !Array.isArray(portal.downloads)) {
      throw new Error('La configuración del portal de clientes no es válida.');
    }
    if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
      throw new Error('Recarga Admin Clients antes de guardar el catálogo.');
    }
    if (portal.downloads.length > CLIENT_PORTAL_MAX_DOWNLOADS) {
      throw new Error(`El catálogo admite un máximo de ${CLIENT_PORTAL_MAX_DOWNLOADS} descargas.`);
    }
    return this.mutate((data) => {
      const current = data.guilds[guildId]?.clientPortal;
      if (!current) throw new Error('El portal de clientes no está disponible.');
      if (current.updatedAt !== expectedUpdatedAt) {
        throw clientConflictError('El catálogo cambió en otra sesión. Recarga la página antes de volver a guardar.');
      }
      const updatedAt = nextUpdatedAt(current.updatedAt);
      const normalized = normalizeClientPortal({ ...portal, updatedAt }, current);
      if (normalized.downloads.length !== portal.downloads.length) {
        throw new Error('El catálogo contiene una descarga o URL no válida.');
      }
      data.guilds[guildId].clientPortal = normalized;
      this.addAudit(actor, 'Clientes', `Catálogo actualizado: ${normalized.downloads.length} descarga(s)`);
      return publicClientPortal(normalized, true);
    });
  }

  getClientByUsername(username) {
    if (typeof username !== 'string') return null;
    const normalized = normalizeUsername(username);
    return this.data.clients.find((client) => normalizeUsername(client.username) === normalized) ?? null;
  }

  getClientById(id) {
    return this.data.clients.find((client) => client.id === id) ?? null;
  }

  listClients() {
    return this.data.clients.map(publicClient);
  }

  async createClient(input, actor) {
    const username = validateUsername(input.username);
    const displayName = validateDisplayName(input.displayName, username);
    const password = validatePassword(input.password);
    if (this.getUserByUsername(username) || this.getClientByUsername(username)) {
      throw new Error('Ese nombre de usuario ya está en uso.');
    }
    if (this.data.clients.length >= CLIENT_MAX_ACCOUNTS) {
      throw new Error(`El portal admite un máximo de ${CLIENT_MAX_ACCOUNTS} clientes.`);
    }
    const credentials = await hashPassword(password);
    return this.mutate((data) => {
      const normalized = normalizeUsername(username);
      const duplicate = data.users.some((user) => normalizeUsername(user.username) === normalized)
        || data.clients.some((client) => normalizeUsername(client.username) === normalized);
      if (duplicate) throw new Error('Ese nombre de usuario ya está en uso.');
      if (data.clients.length >= CLIENT_MAX_ACCOUNTS) {
        throw new Error(`El portal admite un máximo de ${CLIENT_MAX_ACCOUNTS} clientes.`);
      }
      const now = new Date().toISOString();
      const client = {
        id: randomUUID(),
        username,
        displayName,
        passwordHash: credentials.hash,
        passwordSalt: credentials.salt,
        sessionVersion: 1,
        disabled: Boolean(input.disabled),
        createdAt: now,
        updatedAt: now,
      };
      data.clients.push(client);
      this.addAudit(actor, 'Clientes', `Cliente ${username} creado`);
      return publicClient(client);
    });
  }

  async updateClient(id, input, actor, expectedUpdatedAt) {
    if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
      throw new Error('Recarga las cuentas de clientes antes de guardar cambios.');
    }
    const target = this.getClientById(id);
    if (!target) throw new Error('Cliente no encontrado.');
    if (target.updatedAt !== expectedUpdatedAt) {
      throw clientConflictError('La cuenta cambió en otra sesión. Recarga Admin Clients antes de volver a guardar.');
    }
    const username = input.username === undefined ? target.username : validateUsername(input.username);
    const displayName = validateDisplayName(input.displayName, target.displayName);
    const passwordCredentials = input.password ? await hashPassword(validatePassword(input.password)) : null;
    return this.mutate((data) => {
      const client = data.clients.find((item) => item.id === id);
      if (!client) throw new Error('Cliente no encontrado.');
      if (client.updatedAt !== expectedUpdatedAt) {
        throw clientConflictError('La cuenta cambió en otra sesión. Recarga Admin Clients antes de volver a guardar.');
      }
      const normalized = normalizeUsername(username);
      const duplicate = data.users.some((user) => normalizeUsername(user.username) === normalized)
        || data.clients.some((item) => item.id !== id && normalizeUsername(item.username) === normalized);
      if (duplicate) throw new Error('Ese nombre de usuario ya está en uso.');
      const nextDisabled = input.disabled === undefined ? client.disabled : Boolean(input.disabled);
      const invalidateSessions = Boolean(passwordCredentials)
        || nextDisabled !== client.disabled
        || username !== client.username;
      client.username = username;
      client.displayName = displayName;
      client.disabled = nextDisabled;
      if (passwordCredentials) {
        client.passwordHash = passwordCredentials.hash;
        client.passwordSalt = passwordCredentials.salt;
      }
      if (invalidateSessions) client.sessionVersion += 1;
      client.updatedAt = nextUpdatedAt(client.updatedAt);
      this.addAudit(actor, 'Clientes', `Cliente ${client.username} actualizado`);
      return publicClient(client);
    });
  }

  async changeClientPassword(id, password, actor) {
    const credentials = await hashPassword(validatePassword(password));
    return this.mutate((data) => {
      const client = data.clients.find((item) => item.id === id);
      if (!client) throw new Error('Cliente no encontrado.');
      client.passwordHash = credentials.hash;
      client.passwordSalt = credentials.salt;
      client.sessionVersion += 1;
      client.updatedAt = nextUpdatedAt(client.updatedAt);
      this.addAudit(actor, 'Clientes', `Contraseña actualizada: ${client.username}`);
      return client.sessionVersion;
    });
  }

  async deleteClient(id, actor, expectedUpdatedAt) {
    if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
      throw new Error('Recarga las cuentas de clientes antes de eliminar esta cuenta.');
    }
    return this.mutate((data) => {
      const index = data.clients.findIndex((client) => client.id === id);
      if (index < 0) throw new Error('Cliente no encontrado.');
      if (data.clients[index].updatedAt !== expectedUpdatedAt) {
        throw clientConflictError('La cuenta cambió en otra sesión. Recarga Admin Clients antes de eliminarla.');
      }
      const [client] = data.clients.splice(index, 1);
      this.addAudit(actor, 'Clientes', `Cliente ${client.username} eliminado`);
      return publicClient(client);
    });
  }

  getUserByUsername(username) {
    if (typeof username !== 'string') return null;
    const normalized = normalizeUsername(username);
    return this.data.users.find((user) => normalizeUsername(user.username) === normalized) ?? null;
  }

  getUserById(id) {
    return this.data.users.find((user) => user.id === id) ?? null;
  }

  listUsers() {
    return this.data.users.map(publicUser);
  }

  async createUser(input, actor) {
    const username = validateUsername(input.username);
    const password = validatePassword(input.password);
    const permissions = normalizePermissions(input.permissions);
    const isAdmin = Boolean(input.isAdmin);
    validateDelegation(actor, permissions, isAdmin);
    if (this.getUserByUsername(username) || this.getClientByUsername(username)) {
      throw new Error('Ese nombre de usuario ya está en uso.');
    }
    const credentials = await hashPassword(password);

    return this.mutate((data) => {
      const normalized = normalizeUsername(username);
      const duplicate = data.users.some((user) => normalizeUsername(user.username) === normalized)
        || data.clients.some((client) => normalizeUsername(client.username) === normalized);
      if (duplicate) throw new Error('Ese nombre de usuario ya está en uso.');
      const user = {
        id: randomUUID(),
        username,
        passwordHash: credentials.hash,
        passwordSalt: credentials.salt,
        sessionVersion: 1,
        permissions: isAdmin ? [...dashboardPermissions] : permissions,
        isAdmin,
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.users.push(user);
      this.addAudit(actor, 'Usuarios', `Usuario ${username} creado`);
      return publicUser(user);
    });
  }

  async updateUser(id, input, actor) {
    const target = this.getUserById(id);
    if (!target) throw new Error('Usuario no encontrado.');
    if (!actor?.isAdmin) {
      if (target.isAdmin) throw new Error('Solo un administrador puede editar otra cuenta administradora.');
      if (target.id === actor?.id) throw new Error('Usa la sección Mi cuenta para modificar tu propio acceso.');
      if (input.isAdmin !== undefined) throw new Error('Solo un administrador puede cambiar el nivel administrativo.');
    }
    const nextPermissions = input.permissions === undefined
      ? target.permissions
      : normalizePermissions(input.permissions);
    validateDelegation(actor, nextPermissions, Boolean(input.isAdmin));
    const passwordCredentials = input.password ? await hashPassword(validatePassword(input.password)) : null;

    return this.mutate((data) => {
      const user = data.users.find((item) => item.id === id);
      if (!user) throw new Error('Usuario no encontrado.');
      const nextUsername = input.username === undefined ? user.username : validateUsername(input.username);
      const duplicate = data.users.some(
        (item) => item.id !== id && normalizeUsername(item.username) === normalizeUsername(nextUsername),
      ) || data.clients.some(
        (client) => normalizeUsername(client.username) === normalizeUsername(nextUsername),
      );
      if (duplicate) throw new Error('Ese nombre de usuario ya está en uso.');

      const nextAdmin = input.isAdmin === undefined ? user.isAdmin : Boolean(input.isAdmin);
      const nextDisabled = input.disabled === undefined ? user.disabled : Boolean(input.disabled);
      if (user.isAdmin && (!nextAdmin || nextDisabled)) {
        const activeAdmins = data.users.filter((item) => item.isAdmin && !item.disabled);
        if (activeAdmins.length <= 1) throw new Error('No puedes desactivar o degradar al último administrador.');
      }

      user.username = nextUsername;
      user.isAdmin = nextAdmin;
      user.disabled = nextDisabled;
      if (input.permissions !== undefined) user.permissions = nextPermissions;
      if (nextAdmin) user.permissions = [...dashboardPermissions];
      if (passwordCredentials) {
        user.passwordHash = passwordCredentials.hash;
        user.passwordSalt = passwordCredentials.salt;
        user.sessionVersion += 1;
      }
      if (!userCanManageEmbeds(user)) {
        for (const guild of Object.values(data.guilds)) {
          for (const schedule of guild.embeds?.schedules ?? []) {
            if (schedule.ownerUserId === user.id) schedule.enabled = false;
          }
        }
      }
      user.updatedAt = new Date().toISOString();
      this.addAudit(actor, 'Usuarios', `Usuario ${user.username} actualizado`);
      return publicUser(user);
    });
  }

  async changeOwnPassword(id, password, actor) {
    const credentials = await hashPassword(validatePassword(password));
    return this.mutate((data) => {
      const user = data.users.find((item) => item.id === id);
      if (!user) throw new Error('Usuario no encontrado.');
      user.passwordHash = credentials.hash;
      user.passwordSalt = credentials.salt;
      user.sessionVersion += 1;
      user.updatedAt = new Date().toISOString();
      this.addAudit(actor, 'Usuarios', 'Contraseña propia actualizada');
      return user.sessionVersion;
    });
  }

  async deleteUser(id, actor) {
    return this.mutate((data) => {
      const index = data.users.findIndex((user) => user.id === id);
      if (index === -1) throw new Error('Usuario no encontrado.');
      const user = data.users[index];
      if (!actor?.isAdmin && user.isAdmin) {
        throw new Error('Solo un administrador puede eliminar otra cuenta administradora.');
      }
      if (user.isAdmin && !user.disabled) {
        const activeAdmins = data.users.filter((item) => item.isAdmin && !item.disabled);
        if (activeAdmins.length <= 1) throw new Error('No puedes eliminar al último administrador.');
      }
      let removedEmbeds = 0;
      for (const guild of Object.values(data.guilds)) {
        if (!guild.embeds) continue;
        const previousCount = guild.embeds.saved.length;
        guild.embeds.saved = guild.embeds.saved.filter((embed) => embed.ownerUserId !== user.id);
        guild.embeds.schedules = guild.embeds.schedules.filter(
          (schedule) => schedule.ownerUserId !== user.id,
        );
        removedEmbeds += previousCount - guild.embeds.saved.length;
      }
      data.users.splice(index, 1);
      this.addAudit(
        actor,
        'Usuarios',
        `Usuario ${user.username} eliminado${removedEmbeds ? ` junto con ${removedEmbeds} embed(s)` : ''}`,
      );
      return publicUser(user);
    });
  }
}

export function can(user, permission) {
  return Boolean(user && !user.disabled && (user.isAdmin || user.permissions.includes(permission)));
}

export function toPublicUser(user) {
  return user ? publicUser(user) : null;
}

export function toPublicClient(client) {
  return client ? publicClient(client) : null;
}
