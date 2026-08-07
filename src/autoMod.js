import { Events } from 'discord.js';
import { isSanctionable, ruleSeverity } from './securityProfiles.js';

const INVITE_PATTERN = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-z0-9-]+/iu;
const LINK_PATTERN = /(?:https?:\/\/|www\.|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,})(?:[^\s<]*)/giu;
const DOMAIN_PATTERN = /^(?:https?:\/\/)?(?:www\.)?([^/:\s?#]+).*$/iu;
const graphemeSegmenter = new Intl.Segmenter('es', { granularity: 'grapheme' });
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

function normalize(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDomains(content) {
  const matches = content.match(LINK_PATTERN) ?? [];
  return matches.map((match) => normalize(match).match(DOMAIN_PATTERN)?.[1]).filter(Boolean);
}

function domainAllowed(domain, allowedDomains) {
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function countEmojis(content) {
  return [...graphemeSegmenter.segment(content)]
    .filter((item) => EMOJI_PATTERN.test(item.segment)).length;
}

/*
 * Gravedad de cada infracción.
 *
 * high: riesgo real para el servidor o sus miembros (contenido prohibido,
 *       captación hacia otros servidores, enlaces sin autorizar, ficheros
 *       ejecutables). Puede acabar en sanción.
 * low:  ruido o mala educación (mayúsculas, avalancha de emojis). Se retira
 *       el mensaje, pero nunca justifica por sí solo un timeout o un ban.
 */


export class AutoMod {
  constructor(client, store, antiRaid) {
    this.client = client;
    this.store = store;
    this.antiRaid = antiRaid;
    this.messageQueues = new Map();
  }

  settings(guildId) {
    return this.store.getGuildSettings(guildId).autoMod;
  }

  start() {
    this.client.on(Events.MessageCreate, (message) => this.onMessage(message).catch(console.error));
  }

  onMessage(message) {
    if (!message.guild || message.author.bot) return Promise.resolve();
    const key = `${message.guild.id}:${message.author.id}`;
    const previous = this.messageQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.processMessage(message));
    this.messageQueues.set(key, operation);
    const cleanup = () => {
      if (this.messageQueues.get(key) === operation) this.messageQueues.delete(key);
    };
    operation.then(cleanup, cleanup);
    return operation;
  }

  status(guildId) {
    const guildSettings = this.store.getGuildSettings(guildId);
    const settings = guildSettings.autoMod;
    const now = Date.now();
    const profileActivatedAt = Date.parse(guildSettings.security?.activatedAt ?? '');
    const activeStrikes = settings.strikes.filter(
      (item) => now - item.lastAt <= settings.strikeWindowHours * 3_600_000
        && (!Number.isFinite(profileActivatedAt) || item.lastAt >= profileActivatedAt),
    );
    return {
      enabled: settings.enabled,
      responseMode: settings.responseMode,
      sanctionSeverity: settings.sanctionSeverity,
      activeStrikes: activeStrikes.length,
      blockedWords: settings.blockedWords.length,
      finalAction: settings.finalAction,
    };
  }

  isIgnored(message, settings) {
    if (settings.ignoredChannelIds.includes(message.channelId)) return true;
    return message.member?.roles.cache.some((role) => settings.ignoredRoleIds.includes(role.id)) ?? false;
  }

  detect(message, settings) {
    const content = message.content ?? '';
    const normalized = normalize(content);
    const blockedWord = settings.blockedWords.find((word) => {
      const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(normalize(word))}(?:$|[^\\p{L}\\p{N}_])`, 'iu');
      return pattern.test(normalized);
    });
    if (blockedWord) return this.flag('palabras prohibidas', 'Se detectó contenido incluido en la lista bloqueada.');
    if (settings.blockInvites && INVITE_PATTERN.test(content)) {
      return this.flag('invitaciones no autorizadas', 'Se detectó una invitación de Discord.');
    }
    if (settings.blockUnauthorizedLinks) {
      const unauthorized = extractDomains(content).find(
        (domain) => !domainAllowed(domain, settings.allowedDomains),
      );
      if (unauthorized) return this.flag('enlaces no autorizados', `Dominio bloqueado: ${unauthorized}`);
    }

    const letters = [...content].filter((character) => /\p{L}/u.test(character));
    if (letters.length >= settings.capsMinimumLength) {
      const uppercase = letters.filter(
        (character) => character === character.toLocaleUpperCase('es')
          && character !== character.toLocaleLowerCase('es'),
      ).length;
      const percentage = Math.round((uppercase / letters.length) * 100);
      if (percentage > settings.maxCapsPercent) {
        return this.flag('exceso de mayúsculas', `${percentage}% de letras mayúsculas.`);
      }
    }

    const emojiCount = countEmojis(content);
    if (emojiCount > settings.maxEmojis) {
      return this.flag('flood de emojis', `${emojiCount} emojis en un solo mensaje.`);
    }

    if (settings.blockSuspiciousFiles) {
      const suspicious = message.attachments.find((attachment) => {
        const normalizedName = attachment.name
          ?.normalize('NFKC')
          .trim()
          .replace(/[.\s]+$/gu, '')
          .toLocaleLowerCase('es') ?? '';
        const extension = normalizedName.split('.').pop() ?? '';
        return settings.suspiciousExtensions.includes(extension);
      });
      if (suspicious) return this.flag('archivo sospechoso', `Extensión bloqueada en ${suspicious.name}.`);
    }
    return null;
  }

  flag(rule, detail) {
    return { rule, detail, severity: ruleSeverity(rule) };
  }

  async warn(message, settings, strike) {
    const warning = await message.channel.send({
      content: `<@${message.author.id}> ${settings.warningMessage} Advertencia **${strike.count}/${settings.finalStrike}**.`,
      allowedMentions: { users: [message.author.id], roles: [], parse: [] },
    }).catch(() => null);
    if (warning) setTimeout(() => warning.delete().catch(() => null), 12_000).unref();
  }

  async warnPassive(message, settings, note) {
    const warning = await message.channel.send({
      content: `<@${message.author.id}> ${settings.warningMessage} ${note}`,
      allowedMentions: { users: [message.author.id], roles: [], parse: [] },
    }).catch(() => null);
    if (warning) setTimeout(() => warning.delete().catch(() => null), 12_000).unref();
  }

  /*
   * Retirada sin sanción: el mensaje ya se borró, aquí solo se avisa y se
   * registra. Se usa tanto en el nivel Pasivo como para las infracciones
   * leves de los niveles superiores.
   */
  async handlePassiveDetection(message, detection, settings) {
    const sanctionSeverity = settings.sanctionSeverity ?? 'all';
    const minorInStricter = sanctionSeverity === 'high' && detection.severity === 'low';
    const note = minorInStricter
      ? 'Falta leve: el mensaje se retiró sin añadir sanción.'
      : 'Modo Pasivo: no se añadió ninguna sanción.';
    await this.warnPassive(message, settings, note);
    await this.antiRaid.log(
      message.guild,
      minorInStricter ? 'AutoMod · Falta leve retirada' : 'AutoMod · Prevención sin sanción',
      `<@${message.author.id}>: **${detection.rule}**. ${detection.detail}\n${
        minorInStricter
          ? 'Clasificada como leve, por lo que no genera strike en este nivel.'
          : 'El contenido fue retirado sin añadir strikes ni sanciones.'
      }`,
      0xfee75c,
    );
  }

  async applyProgressiveAction(message, detection, settings, strike) {
    const currentSettings = this.settings(message.guild.id);
    if (!currentSettings.enabled) {
      return { applied: false, cancelled: true, finalStrike: currentSettings.finalStrike };
    }
    if (
      currentSettings.responseMode === 'passive'
      || !isSanctionable(detection.severity, currentSettings.sanctionSeverity ?? 'all')
    ) {
      await this.handlePassiveDetection(message, detection, currentSettings);
      return { applied: false, cancelled: true, finalStrike: currentSettings.finalStrike };
    }
    settings = currentSettings;
    const reason = `AutoMod: ${detection.rule} (${strike.count}/${settings.finalStrike})`;
    if (strike.count >= settings.finalStrike) {
      const antiRaidSettings = this.antiRaid.settings(message.guild.id);
      const applied = await this.antiRaid.applyAction(message.member, reason, {
        ...antiRaidSettings,
        sourceModule: 'automod',
        responseMode: settings.responseMode,
        action: settings.finalAction,
        timeoutMinutes: settings.timeoutMinutes,
      });
      return { applied, cancelled: false, finalStrike: settings.finalStrike };
    }
    if (strike.count >= settings.timeoutStrike && message.member?.moderatable) {
      const applied = await message.member
        .timeout(settings.timeoutMinutes * 60_000, `BLL ${reason}`)
        .then(() => true)
        .catch(() => false);
      if (!applied) await this.warn(message, settings, strike);
      return { applied, cancelled: false, finalStrike: settings.finalStrike };
    }
    await this.warn(message, settings, strike);
    return { applied: false, cancelled: false, finalStrike: settings.finalStrike };
  }

  async processMessage(message) {
    let settings = this.settings(message.guild.id);
    if (!settings.enabled || this.isIgnored(message, settings)) return;
    if (this.antiRaid.isTrusted(message.guild, message.author.id)) return;
    const detection = this.detect(message, settings);
    if (!detection) return;

    await message.delete().catch(() => null);
    settings = this.settings(message.guild.id);
    if (!settings.enabled) return;
    // El borrado ocurre siempre; el strike solo si el nivel permite sancionar
    // esta gravedad. Así el nivel Pasivo nunca sanciona y el Equilibrado
    // reserva las sanciones para lo grave.
    if (
      settings.responseMode === 'passive'
      || !isSanctionable(detection.severity, settings.sanctionSeverity ?? 'all')
    ) {
      await this.handlePassiveDetection(message, detection, settings);
      return;
    }
    const strike = await this.store.recordAutoModStrike(
      message.guild.id,
      message.author.id,
      detection.rule,
      settings.strikeWindowHours,
    );
    if (strike.skipped) {
      const currentSettings = this.settings(message.guild.id);
      if (currentSettings.enabled && currentSettings.responseMode === 'passive') {
        await this.handlePassiveDetection(message, detection, currentSettings);
      }
      return;
    }
    const alreadyFinalized = Boolean(
      strike.finalizedAt
      && Date.now() - strike.finalizedAt <= settings.strikeWindowHours * 3_600_000,
    );
    const outcome = alreadyFinalized
      ? { applied: false, cancelled: false, finalStrike: settings.finalStrike }
      : await this.applyProgressiveAction(message, detection, settings, strike);
    if (outcome.cancelled) return;
    if (outcome.applied && strike.count >= outcome.finalStrike) {
      await this.store.markAutoModFinalized(message.guild.id, message.author.id);
    }
    const progression = alreadyFinalized
      ? 'La sanción final ya había sido aplicada; la infracción quedó registrada.'
      : `Advertencia ${strike.count}/${outcome.finalStrike}.`;
    await this.antiRaid.log(
      message.guild,
      outcome.applied ? 'AutoMod · Usuario sancionado' : 'AutoMod · Mensaje bloqueado',
      `<@${message.author.id}>: **${detection.rule}**. ${detection.detail}\n${progression}`,
      outcome.applied ? 0xed4245 : 0xfee75c,
    );
  }
}
