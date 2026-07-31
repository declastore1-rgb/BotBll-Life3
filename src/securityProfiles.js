const PROFILE_IDS = Object.freeze(['lite', 'intermediate', 'emergency']);
const RESPONSE_MODES = Object.freeze(['passive', 'balanced', 'strict']);
const clone = (value) => structuredClone(value);

const profiles = Object.freeze({
  lite: Object.freeze({
    id: 'lite',
    name: 'Lite · Pasivo',
    tone: 'lite',
    tagline: 'Observa, bloquea lo evidente y avisa antes de escalar.',
    description: 'Mantiene vigilancia con límites amplios. Elimina contenido claramente riesgoso y restaura daños, pero no sanciona automáticamente a miembros ni ejecutores.',
    safeguards: Object.freeze([
      'Sin bans, kicks ni timeouts automáticos',
      'Advertencias y bloqueo de contenido evidente',
      'Restauración estructural sin represalias',
      'Umbrales amplios para reducir falsos positivos',
    ]),
    moduleSummary: Object.freeze({
      antiRaid: 'Vigilancia pasiva, advertencias y umbrales amplios.',
      antiNuke: 'Detecta y restaura; no retira roles ni sanciona.',
      autoMod: 'Elimina riesgos claros y avisa sin crear strikes.',
    }),
    settings: Object.freeze({
      antiRaid: Object.freeze({
        enabled: true,
        responseMode: 'passive',
        lockdownNewJoins: false,
        blockUnauthorizedBots: true,
        action: 'timeout',
        joinThreshold: 20,
        joinWindowSeconds: 15,
        raidModeMinutes: 5,
        minAccountAgeHours: 0,
        massMentionThreshold: 12,
        spamMessageThreshold: 12,
        spamWindowSeconds: 8,
        spamWarningEnabled: true,
        spamEscalationMinutes: 15,
        duplicateMessageThreshold: 7,
        maxLinksPerMessage: 8,
        destructiveThreshold: 6,
        destructiveWindowSeconds: 30,
        timeoutMinutes: 10,
      }),
      antiNuke: Object.freeze({
        enabled: true,
        responseMode: 'passive',
        autoRestore: true,
        removeDangerousRoles: false,
        emergencyMode: false,
        actionThreshold: 5,
        actionWindowSeconds: 30,
      }),
      autoMod: Object.freeze({
        enabled: true,
        responseMode: 'passive',
        blockInvites: true,
        blockUnauthorizedLinks: false,
        blockSuspiciousFiles: true,
        maxCapsPercent: 95,
        capsMinimumLength: 30,
        maxEmojis: 30,
        timeoutStrike: 5,
        finalStrike: 10,
        strikeWindowHours: 12,
        timeoutMinutes: 10,
        finalAction: 'timeout',
      }),
    }),
  }),
  intermediate: Object.freeze({
    id: 'intermediate',
    name: 'Intermedio · Equilibrado',
    tone: 'intermediate',
    tagline: 'Prevención activa con respuesta progresiva.',
    description: 'Equilibra seguridad y tolerancia. Advierte primero, aplica timeout ante reincidencia y neutraliza acciones estructurales repetidas.',
    safeguards: Object.freeze([
      'Advertencia antes de sancionar spam',
      'Timeout progresivo para reducir falsos positivos',
      'Restauración y retirada de roles peligrosos',
      'Límites recomendados para comunidades activas',
    ]),
    moduleSummary: Object.freeze({
      antiRaid: 'Detección activa y timeout ante reincidencia.',
      antiNuke: 'Restaura y neutraliza después de dos acciones.',
      autoMod: 'Strikes progresivos con timeout como sanción final.',
    }),
    settings: Object.freeze({
      antiRaid: Object.freeze({
        enabled: true,
        responseMode: 'balanced',
        lockdownNewJoins: false,
        blockUnauthorizedBots: true,
        action: 'timeout',
        joinThreshold: 8,
        joinWindowSeconds: 10,
        raidModeMinutes: 10,
        minAccountAgeHours: 24,
        massMentionThreshold: 5,
        spamMessageThreshold: 7,
        spamWindowSeconds: 5,
        spamWarningEnabled: true,
        spamEscalationMinutes: 10,
        duplicateMessageThreshold: 4,
        maxLinksPerMessage: 4,
        destructiveThreshold: 3,
        destructiveWindowSeconds: 10,
        timeoutMinutes: 60,
      }),
      antiNuke: Object.freeze({
        enabled: true,
        responseMode: 'balanced',
        autoRestore: true,
        removeDangerousRoles: true,
        emergencyMode: false,
        actionThreshold: 2,
        actionWindowSeconds: 15,
      }),
      autoMod: Object.freeze({
        enabled: true,
        responseMode: 'balanced',
        blockInvites: true,
        blockUnauthorizedLinks: false,
        blockSuspiciousFiles: true,
        maxCapsPercent: 75,
        capsMinimumLength: 12,
        maxEmojis: 10,
        timeoutStrike: 2,
        finalStrike: 4,
        strikeWindowHours: 24,
        timeoutMinutes: 30,
        finalAction: 'timeout',
      }),
    }),
  }),
  emergency: Object.freeze({
    id: 'emergency',
    name: 'Emergencia · Bloqueo total',
    tone: 'emergency',
    tagline: 'Respuesta inmediata para un ataque en curso.',
    description: 'Activa todas las defensas, bloquea nuevas entradas, reduce los umbrales y aplica neutralización estricta. Debe utilizarse solo durante una amenaza real.',
    safeguards: Object.freeze([
      'Bloqueo de nuevas entradas mientras siga activo',
      'Neutralización desde la primera acción destructiva',
      'Anti-Nuke con restauración y retirada de privilegios',
      'AutoMod estricto con sanción final por ban',
    ]),
    moduleSummary: Object.freeze({
      antiRaid: 'Lockdown de entradas y sanción inmediata.',
      antiNuke: 'Neutralización y restauración desde la primera acción.',
      autoMod: 'Todos los filtros activos y escalado estricto.',
    }),
    settings: Object.freeze({
      antiRaid: Object.freeze({
        enabled: true,
        responseMode: 'strict',
        lockdownNewJoins: true,
        blockUnauthorizedBots: true,
        action: 'ban',
        joinThreshold: 4,
        joinWindowSeconds: 10,
        raidModeMinutes: 30,
        minAccountAgeHours: 72,
        massMentionThreshold: 3,
        spamMessageThreshold: 5,
        spamWindowSeconds: 5,
        spamWarningEnabled: false,
        spamEscalationMinutes: 30,
        duplicateMessageThreshold: 3,
        maxLinksPerMessage: 2,
        destructiveThreshold: 2,
        destructiveWindowSeconds: 15,
        timeoutMinutes: 1_440,
      }),
      antiNuke: Object.freeze({
        enabled: true,
        responseMode: 'strict',
        autoRestore: true,
        removeDangerousRoles: true,
        emergencyMode: true,
        actionThreshold: 1,
        actionWindowSeconds: 60,
      }),
      autoMod: Object.freeze({
        enabled: true,
        responseMode: 'strict',
        blockInvites: true,
        blockUnauthorizedLinks: true,
        blockSuspiciousFiles: true,
        maxCapsPercent: 65,
        capsMinimumLength: 8,
        maxEmojis: 6,
        timeoutStrike: 2,
        finalStrike: 3,
        strikeWindowHours: 72,
        timeoutMinutes: 1_440,
        finalAction: 'ban',
      }),
    }),
  }),
});

export const securityProfileIds = PROFILE_IDS;
export const securityResponseModes = RESPONSE_MODES;

export const defaultSecuritySettings = Object.freeze({
  profile: 'intermediate',
  previousProfile: null,
  activatedAt: null,
  activatedBy: 'Sistema',
  activatedByUserId: null,
  updatedAt: null,
});

export function isSecurityProfileId(value) {
  return typeof value === 'string' && PROFILE_IDS.includes(value);
}

export function isSecurityResponseMode(value) {
  return typeof value === 'string' && RESPONSE_MODES.includes(value);
}

export function getSecurityProfile(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error('El perfil de seguridad seleccionado no es válido.');
  return clone(profile);
}

export function listSecurityProfiles() {
  return PROFILE_IDS.map((profileId) => {
    const { settings: _settings, ...profile } = profiles[profileId];
    return clone(profile);
  });
}

export function normalizeSecuritySettings(value, { legacy = false } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const profile = legacy
    ? 'custom'
    : isSecurityProfileId(source.profile) || source.profile === 'custom'
      ? source.profile
      : defaultSecuritySettings.profile;
  const previousProfile = isSecurityProfileId(source.previousProfile)
    ? source.previousProfile
    : null;
  return {
    profile,
    previousProfile,
    activatedAt: typeof source.activatedAt === 'string' ? source.activatedAt : null,
    activatedBy: typeof source.activatedBy === 'string' && source.activatedBy
      ? source.activatedBy.slice(0, 64)
      : legacy ? 'Migración v5' : defaultSecuritySettings.activatedBy,
    activatedByUserId: typeof source.activatedByUserId === 'string'
      ? source.activatedByUserId
      : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

export function securityProfilePatches(profileId) {
  return clone(getSecurityProfile(profileId).settings);
}
