import path from 'node:path';

const integer = (name, fallback, minimum = 1) => {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} debe ser un numero entero mayor o igual que ${minimum}.`);
  }
  return value;
};

const boolean = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
};

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno obligatoria ${name}.`);
  return value;
};

const antiRaidAction = (process.env.ANTIRAID_ACTION ?? 'ban').toLowerCase();
if (!['ban', 'kick', 'timeout'].includes(antiRaidAction)) {
  throw new Error('ANTIRAID_ACTION debe ser ban, kick o timeout.');
}

const sessionSecret = required('DASHBOARD_SESSION_SECRET');
if (sessionSecret.length < 32) {
  throw new Error('DASHBOARD_SESSION_SECRET debe tener al menos 32 caracteres.');
}

export const defaultGuildSettings = Object.freeze({
  antiRaid: Object.freeze({
    enabled: boolean('ANTIRAID_ENABLED', true),
    action: antiRaidAction,
    trustedUserIds: (process.env.TRUSTED_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    joinThreshold: integer('JOIN_THRESHOLD', 8, 2),
    joinWindowSeconds: integer('JOIN_WINDOW_SECONDS', 10),
    raidModeMinutes: integer('RAID_MODE_MINUTES', 10),
    minAccountAgeHours: integer('MIN_ACCOUNT_AGE_HOURS', 24, 0),
    massMentionThreshold: integer('MASS_MENTION_THRESHOLD', 5, 2),
    spamMessageThreshold: integer('SPAM_MESSAGE_THRESHOLD', 7, 3),
    spamWindowSeconds: integer('SPAM_WINDOW_SECONDS', 5),
    spamWarningEnabled: true,
    spamWarningMessage: 'Baja la intensidad o serás sancionado si continúas.',
    spamEscalationMinutes: 10,
    duplicateMessageThreshold: 4,
    maxLinksPerMessage: 4,
    destructiveThreshold: integer('DESTRUCTIVE_THRESHOLD', 3, 2),
    destructiveWindowSeconds: integer('DESTRUCTIVE_WINDOW_SECONDS', 10),
    timeoutMinutes: integer('TIMEOUT_MINUTES', 60),
  }),
  antiNuke: Object.freeze({
    enabled: true,
    autoRestore: true,
    removeDangerousRoles: true,
    emergencyMode: false,
    actionThreshold: 2,
    actionWindowSeconds: 15,
    snapshot: { channels: [], roles: [], emojis: [], capturedAt: null },
    incidents: [],
  }),
  autoMod: Object.freeze({
    enabled: true,
    blockInvites: true,
    blockUnauthorizedLinks: false,
    blockSuspiciousFiles: true,
    blockedWords: [],
    allowedDomains: [],
    suspiciousExtensions: ['exe', 'scr', 'bat', 'cmd', 'com', 'msi', 'ps1', 'jar', 'vbs', 'js'],
    maxCapsPercent: 75,
    capsMinimumLength: 12,
    maxEmojis: 10,
    warningMessage: 'Tu mensaje incumple las reglas. Si continúas recibirás una sanción progresiva.',
    timeoutStrike: 2,
    finalStrike: 3,
    strikeWindowHours: 24,
    timeoutMinutes: 30,
    finalAction: 'ban',
    ignoredChannelIds: [],
    ignoredRoleIds: [],
    strikes: [],
  }),
  tickets: Object.freeze({
    enabled: true,
    categoryId: process.env.TICKET_CATEGORY_ID?.trim() || '',
    supportRoleId: process.env.SUPPORT_ROLE_ID?.trim() || '',
    logChannelId: process.env.LOG_CHANNEL_ID?.trim() || '',
    commandRoleId: process.env.COMMAND_ROLE_ID?.trim() || '1523180563723190394',
    panelTitle: 'BLL $ LIFE - Ticket',
    panelDescription:
      '🇪🇸 · ¡Hola! Usa los botones de abajo para abrir un ticket de soporte o ver información adicional del servidor.\n\n' +
      '🇺🇸 · Hello! Use the buttons below to open a support ticket or view additional server information.\n\n' +
      '🇧🇷 · Olá! Use os botões abaixo para abrir um ticket de suporte ou visualizar informações adicionais do servidor.',
    footerText: 'Copyright Team Bll $ Life',
    embedColor: '#2B2D31',
    panelImageUrl: '',
    createButtonLabel: 'Abrir ticket',
    createButtonStyle: 'primary',
    createButtonColor: '#5865F2',
    createButtonEmoji: { type: 'unicode', name: '🎫' },
    infoButtonLabel: 'Información',
    infoButtonStyle: 'secondary',
    infoButtonColor: '#4E5058',
    infoButtonEmoji: { type: 'unicode', name: 'ℹ️' },
    extraButtons: [],
    publishedPanels: [],
  }),
  embeds: Object.freeze({
    saved: [],
    schedules: [],
  }),
});

export const config = Object.freeze({
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  streamName: process.env.STREAM_NAME?.trim() || 'BLL $ LIFE',
  streamUrl: process.env.STREAM_URL?.trim() || 'https://www.twitch.tv/blllife',
  port: integer('PORT', 3000, 1),
  dataDir: path.resolve(process.env.DATA_DIR?.trim() || './data'),
  sessionSecret,
  adminUsername: process.env.DASHBOARD_ADMIN_USERNAME?.trim() || 'Linox',
  adminPassword: required('DASHBOARD_ADMIN_PASSWORD'),
  secureCookies:
    process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT),
});
