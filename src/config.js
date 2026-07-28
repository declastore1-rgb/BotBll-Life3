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

const action = (process.env.ANTIRAID_ACTION ?? 'ban').toLowerCase();
if (!['ban', 'kick', 'timeout'].includes(action)) {
  throw new Error('ANTIRAID_ACTION debe ser ban, kick o timeout.');
}

export const config = Object.freeze({
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: required('GUILD_ID'),
  ticketCategoryId: process.env.TICKET_CATEGORY_ID?.trim() || null,
  supportRoleId: process.env.SUPPORT_ROLE_ID?.trim() || null,
  logChannelId: process.env.LOG_CHANNEL_ID?.trim() || null,
  streamName: process.env.STREAM_NAME?.trim() || 'BLL $ LIFE',
  streamUrl: process.env.STREAM_URL?.trim() || 'https://www.twitch.tv/blllife',
  antiRaid: Object.freeze({
    enabled: boolean('ANTIRAID_ENABLED', true),
    action,
    trustedUserIds: new Set(
      (process.env.TRUSTED_USER_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    joinThreshold: integer('JOIN_THRESHOLD', 8, 2),
    joinWindowMs: integer('JOIN_WINDOW_SECONDS', 10) * 1_000,
    raidModeMs: integer('RAID_MODE_MINUTES', 10) * 60_000,
    minAccountAgeMs: integer('MIN_ACCOUNT_AGE_HOURS', 24, 0) * 3_600_000,
    massMentionThreshold: integer('MASS_MENTION_THRESHOLD', 5, 2),
    spamMessageThreshold: integer('SPAM_MESSAGE_THRESHOLD', 7, 3),
    spamWindowMs: integer('SPAM_WINDOW_SECONDS', 5) * 1_000,
    destructiveThreshold: integer('DESTRUCTIVE_THRESHOLD', 3, 2),
    destructiveWindowMs: integer('DESTRUCTIVE_WINDOW_SECONDS', 10) * 1_000,
    timeoutMs: integer('TIMEOUT_MINUTES', 60) * 60_000,
  }),
});
