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

export const dashboardPermissions = Object.freeze([
  'antiraid',
  'antinuke',
  'automod',
  'tickets',
  'claimkey',
  'embeds',
  'users',
]);

const CLAIM_KEY_CIPHER = 'aes-256-gcm';
const CLAIM_KEY_CONTEXT = 'bll-claim-key-credentials-v1';
const CLAIM_KEY_MAX_IMPORT = 250;
const CLAIM_KEY_MAX_CREDENTIALS = 5_000;
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
]));
const clone = (value) => structuredClone(value);
const normalizeUsername = (username) => username.trim().toLowerCase();
const actorName = (actor) => typeof actor === 'string' ? actor : actor?.username ?? 'Sistema';

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
  return clone(safeUser);
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

    this.data.version = Math.max(Number(this.data.version) || 1, 2);
    this.data.users ??= [];
    this.data.guilds ??= {};
    this.data.audit ??= [];
    for (const user of this.data.users) {
      user.sessionVersion ??= 1;
      user.permissions = user.isAdmin
        ? [...dashboardPermissions]
        : normalizePermissions(user.permissions);
    }
    const existing = this.data.guilds[this.guildId] ?? {};
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
        strikes: Array.isArray(existing.autoMod?.strikes) ? existing.autoMod.strikes.slice(0, 500) : [],
      },
      tickets: { ...clone(this.defaults.tickets), ...(existing.tickets ?? {}) },
      claimKey: {
        ...clone(this.defaults.claimKey),
        ...existingClaimKey,
        credentials: claimKeyCredentials,
        publishedPanels: normalizeClaimKeyPanels(existingClaimKey.publishedPanels),
      },
      embeds: {
        ...clone(this.defaults.embeds),
        ...(existing.embeds ?? {}),
        saved: Array.isArray(existing.embeds?.saved) ? existing.embeds.saved : [],
        schedules: Array.isArray(existing.embeds?.schedules) ? existing.embeds.schedules : [],
      },
    };

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
    data.audit.unshift({ id: randomUUID(), actor: actorName(actor), module, action, at: new Date().toISOString() });
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
      if (result.status === 'claimed') await deliver(result);
      return result;
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
      this.addAudit(auditIdentity, 'Claim Key', `Acceso entregado al Discord ID ${userId}`);
      return {
        status: 'claimed',
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

  async saveEmbed(guildId, embed, actor) {
    return this.mutate((data) => {
      const list = data.guilds[guildId].embeds.saved;
      const index = embed.id ? list.findIndex((item) => item.id === embed.id) : -1;
      if (index < 0 && list.length >= 100) throw new Error('Has alcanzado el límite de 100 embeds guardados.');
      const now = new Date().toISOString();
      const value = { ...clone(embed), id: index >= 0 ? embed.id : randomUUID(), updatedAt: now };
      if (index >= 0) list[index] = { ...list[index], ...value };
      else list.push({ ...value, createdAt: now });
      this.addAudit(actor, 'Embeds', `${index >= 0 ? 'Embed actualizado' : 'Embed creado'}: ${value.name}`);
      return clone(index >= 0 ? list[index] : list.at(-1));
    });
  }

  async deleteEmbed(guildId, id, actor) {
    return this.mutate((data) => {
      const section = data.guilds[guildId].embeds;
      const embed = section.saved.find((item) => item.id === id);
      if (!embed) throw new Error('Embed no encontrado.');
      section.saved = section.saved.filter((item) => item.id !== id);
      section.schedules = section.schedules.filter((item) => item.embedId !== id);
      this.addAudit(actor, 'Embeds', `Embed eliminado: ${embed.name}`);
      return true;
    });
  }

  async saveSchedule(guildId, schedule, actor) {
    return this.mutate((data) => {
      const list = data.guilds[guildId].embeds.schedules;
      const index = list.findIndex((item) => item.embedId === schedule.embedId);
      const value = { ...clone(schedule), id: index >= 0 ? list[index].id : randomUUID() };
      if (index >= 0) list[index] = value; else list.push(value);
      this.addAudit(actor, 'Embeds', 'Programación actualizada');
      return clone(value);
    });
  }

  async deleteSchedule(guildId, embedId, actor = 'Sistema') {
    return this.mutate((data) => {
      const section = data.guilds[guildId].embeds;
      section.schedules = section.schedules.filter((item) => item.embedId !== embedId);
      this.addAudit(actor, 'Embeds', 'Programación eliminada');
      return true;
    });
  }

  async updateScheduleRun(guildId, id, patch) {
    return this.mutate((data) => {
      const schedule = data.guilds[guildId].embeds.schedules.find((item) => item.id === id);
      if (!schedule) return null;
      Object.assign(schedule, clone(patch));
      return clone(schedule);
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
      const now = Date.now();
      const windowMs = windowHours * 3_600_000;
      autoMod.strikes = autoMod.strikes.filter((item) => now - item.lastAt <= windowMs);
      let strike = autoMod.strikes.find((item) => item.userId === userId);
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
      data.guilds[guildId].autoMod.strikes = [];
      this.addAudit(actor, 'AutoMod', 'Historial de sanciones progresivas reiniciado');
      return true;
    });
  }

  async updateGuildSection(guildId, section, patch, actor) {
    const modules = {
      antiRaid: 'Anti-Raid',
      antiNuke: 'Anti-Nuke',
      autoMod: 'AutoMod',
      tickets: 'Tickets',
    };
    if (!modules[section]) throw new Error('Sección inválida.');
    return this.mutate((data) => {
      data.guilds[guildId] ??= clone(this.data.guilds[this.guildId]);
      data.guilds[guildId][section] = { ...data.guilds[guildId][section], ...clone(patch) };
      this.addAudit(actor, modules[section], 'Configuración actualizada');
      return clone(data.guilds[guildId][section]);
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
    if (this.getUserByUsername(username)) throw new Error('Ese nombre de usuario ya existe.');
    const credentials = await hashPassword(password);

    return this.mutate((data) => {
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
      const duplicate = data.users.find(
        (item) => item.id !== id && normalizeUsername(item.username) === normalizeUsername(nextUsername),
      );
      if (duplicate) throw new Error('Ese nombre de usuario ya existe.');

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
      data.users.splice(index, 1);
      this.addAudit(actor, 'Usuarios', `Usuario ${user.username} eliminado`);
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
