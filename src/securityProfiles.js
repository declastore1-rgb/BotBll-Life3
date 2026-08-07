const PROFILE_IDS = Object.freeze(['lite', 'intermediate', 'emergency']);
const RESPONSE_MODES = Object.freeze(['passive', 'balanced', 'strict']);
/*
 * Alcance de las sanciones automáticas de AutoMod.
 * none: se retira el contenido y nunca se sanciona.
 * high: solo las faltas graves generan strike y sanción.
 * all:  cualquier falta cuenta, sin distinguir gravedad.
 */
const SANCTION_SEVERITIES = Object.freeze(['none', 'high', 'all']);
const clone = (value) => structuredClone(value);

const profiles = Object.freeze({
  lite: Object.freeze({
    id: 'lite',
    name: 'Nivel 1 · Pasivo',
    tone: 'lite',
    tagline: 'Limpia el contenido, pero nunca sanciona a nadie.',
    description: 'Retira el contenido que incumple las reglas y restaura los daños estructurales, sin aplicar jamás un timeout, un kick o un ban automático. Pensado para comunidades tranquilas donde prefieres revisar tú cada caso.',
    safeguards: Object.freeze([
      'Cero sanciones automáticas por diseño',
      'Borra el contenido infractor y avisa en el canal',
      'Restauración estructural sin represalias',
      'Umbrales amplios para reducir falsos positivos',
    ]),
    moduleSummary: Object.freeze({
      antiRaid: 'Solo alerta y registra; no sanciona entradas masivas.',
      antiNuke: 'Detecta y restaura; no retira roles ni sanciona.',
      autoMod: 'Borra la infracción y avisa, sin strikes ni sanciones.',
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
        // Doble garantía: ni el modo de respuesta ni el alcance permiten sancionar.
        sanctionSeverity: 'none',
        blockInvites: true,
        blockUnauthorizedLinks: false,
        blockSuspiciousFiles: true,
        maxCapsPercent: 95,
        capsMinimumLength: 30,
        maxEmojis: 30,
        timeoutStrike: 10,
        finalStrike: 20,
        strikeWindowHours: 12,
        timeoutMinutes: 10,
        finalAction: 'timeout',
      }),
    }),
  }),
  intermediate: Object.freeze({
    id: 'intermediate',
    name: 'Nivel 2 · Equilibrado',
    tone: 'intermediate',
    tagline: 'Sanciona solo lo grave; lo leve se limpia sin castigo.',
    description: 'Distingue la gravedad de cada infracción. Las faltas leves, como el exceso de mayúsculas o la avalancha de emojis, se borran sin sanción. Las graves, como contenido prohibido, invitaciones, enlaces sin autorizar o archivos ejecutables, escalan a timeout progresivo.',
    safeguards: Object.freeze([
      'Las faltas leves nunca generan sanción',
      'Timeout progresivo reservado a lo grave',
      'Restauración y retirada de roles peligrosos',
      'Límites recomendados para comunidades activas',
    ]),
    moduleSummary: Object.freeze({
      antiRaid: 'Detección activa y timeout ante reincidencia.',
      antiNuke: 'Restaura y neutraliza después de dos acciones.',
      autoMod: 'Strikes solo en faltas graves, con timeout final.',
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
        // Solo las faltas graves generan strike y pueden acabar en sanción.
        sanctionSeverity: 'high',
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
    name: 'Nivel 3 · Protegido',
    tone: 'emergency',
    tagline: 'Blindaje máximo para aguantar un ataque en curso.',
    description: 'Todas las defensas al máximo: cierra la entrada al servidor, neutraliza desde la primera acción destructiva, sanciona cualquier infracción sin importar su gravedad y responde con ban a la reincidencia. Pensado para sostener el servidor mientras dura el ataque.',
    safeguards: Object.freeze([
      'Bloqueo de nuevas entradas mientras siga activo',
      'Neutralización desde la primera acción destructiva',
      'Anti-Nuke con restauración y retirada de privilegios',
      'Cualquier infracción sanciona, con ban al reincidir',
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
        // Bajo ataque no se distingue gravedad: todo suma strike.
        sanctionSeverity: 'all',
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
export const sanctionSeverities = SANCTION_SEVERITIES;

export function isSanctionSeverity(value) {
  return typeof value === 'string' && SANCTION_SEVERITIES.includes(value);
}

/*
 * Gravedad de cada infracción de AutoMod.
 *
 * high: riesgo real para el servidor o sus miembros (contenido prohibido,
 *       captación hacia otros servidores, enlaces sin autorizar, ficheros
 *       ejecutables). Puede acabar en sanción.
 * low:  ruido o mala educación (mayúsculas, avalancha de emojis). El mensaje
 *       se retira, pero nunca justifica por sí solo un timeout o un ban.
 *
 * Ante una regla desconocida se asume 'high': es preferible sancionar de más
 * que dejar pasar algo grave por un descuido al añadir un filtro nuevo.
 */
const RULE_SEVERITY = Object.freeze({
  'palabras prohibidas': 'high',
  'invitaciones no autorizadas': 'high',
  'enlaces no autorizados': 'high',
  'archivo sospechoso': 'high',
  'exceso de mayúsculas': 'low',
  'flood de emojis': 'low',
});

export function ruleSeverity(rule) {
  return RULE_SEVERITY[rule] ?? 'high';
}

/* Decide si una infracción puede generar strike y sanción con el nivel dado. */
export function isSanctionable(severity, sanctionSeverity) {
  if (sanctionSeverity === 'none') return false;
  if (sanctionSeverity === 'all') return true;
  return severity === 'high';
}

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
