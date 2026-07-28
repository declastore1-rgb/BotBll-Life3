import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from './auth.js';

export const dashboardPermissions = Object.freeze(['antiraid', 'tickets', 'embeds', 'users']);

const clone = (value) => structuredClone(value);
const normalizeUsername = (username) => username.trim().toLowerCase();
const actorName = (actor) => typeof actor === 'string' ? actor : actor?.username ?? 'Sistema';

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
  constructor({ dataDir, guildId, defaults, adminUsername, adminPassword }) {
    this.filePath = path.join(dataDir, 'bll-store.json');
    this.tempPath = `${this.filePath}.tmp`;
    this.dataDir = dataDir;
    this.guildId = guildId;
    this.defaults = clone(defaults);
    this.adminUsername = adminUsername;
    this.adminPassword = adminPassword;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, users: [], guilds: {}, audit: [] };
    }

    this.data.users ??= [];
    this.data.guilds ??= {};
    this.data.audit ??= [];
    for (const user of this.data.users) {
      user.sessionVersion ??= 1;
      user.permissions = normalizePermissions(user.permissions);
    }
    const existing = this.data.guilds[this.guildId] ?? {};
    this.data.guilds[this.guildId] = {
      antiRaid: { ...clone(this.defaults.antiRaid), ...(existing.antiRaid ?? {}) },
      tickets: { ...clone(this.defaults.tickets), ...(existing.tickets ?? {}) },
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

  async persist() {
    await writeFile(this.tempPath, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(this.tempPath, this.filePath);
  }

  async mutate(mutator) {
    let result;
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      result = await mutator(this.data);
      await this.persist();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  addAudit(actor, module, action) {
    this.data.audit.unshift({ id: randomUUID(), actor: actorName(actor), module, action, at: new Date().toISOString() });
    this.data.audit = this.data.audit.slice(0, 100);
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

  async updateGuildSection(guildId, section, patch, actor) {
    if (!['antiRaid', 'tickets'].includes(section)) throw new Error('Sección inválida.');
    return this.mutate((data) => {
      data.guilds[guildId] ??= clone(this.data.guilds[this.guildId]);
      data.guilds[guildId][section] = { ...data.guilds[guildId][section], ...clone(patch) };
      this.addAudit(actor, section === 'antiRaid' ? 'Anti-Raid' : 'Tickets', 'Configuración actualizada');
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
