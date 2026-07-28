import { Events } from 'discord.js';

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
    const settings = this.settings(guildId);
    const now = Date.now();
    const activeStrikes = settings.strikes.filter(
      (item) => now - item.lastAt <= settings.strikeWindowHours * 3_600_000,
    );
    return {
      enabled: settings.enabled,
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
    if (blockedWord) return { rule: 'palabras prohibidas', detail: 'Se detectó contenido incluido en la lista bloqueada.' };
    if (settings.blockInvites && INVITE_PATTERN.test(content)) {
      return { rule: 'invitaciones no autorizadas', detail: 'Se detectó una invitación de Discord.' };
    }
    if (settings.blockUnauthorizedLinks) {
      const unauthorized = extractDomains(content).find(
        (domain) => !domainAllowed(domain, settings.allowedDomains),
      );
      if (unauthorized) return { rule: 'enlaces no autorizados', detail: `Dominio bloqueado: ${unauthorized}` };
    }

    const letters = [...content].filter((character) => /\p{L}/u.test(character));
    if (letters.length >= settings.capsMinimumLength) {
      const uppercase = letters.filter(
        (character) => character === character.toLocaleUpperCase('es')
          && character !== character.toLocaleLowerCase('es'),
      ).length;
      const percentage = Math.round((uppercase / letters.length) * 100);
      if (percentage > settings.maxCapsPercent) {
        return { rule: 'exceso de mayúsculas', detail: `${percentage}% de letras mayúsculas.` };
      }
    }

    const emojiCount = countEmojis(content);
    if (emojiCount > settings.maxEmojis) {
      return { rule: 'flood de emojis', detail: `${emojiCount} emojis en un solo mensaje.` };
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
      if (suspicious) return { rule: 'archivo sospechoso', detail: `Extensión bloqueada en ${suspicious.name}.` };
    }
    return null;
  }

  async warn(message, settings, strike) {
    const warning = await message.channel.send({
      content: `<@${message.author.id}> ${settings.warningMessage} Advertencia **${strike.count}/${settings.finalStrike}**.`,
      allowedMentions: { users: [message.author.id], roles: [], parse: [] },
    }).catch(() => null);
    if (warning) setTimeout(() => warning.delete().catch(() => null), 12_000).unref();
  }

  async applyProgressiveAction(message, detection, settings, strike) {
    const reason = `AutoMod: ${detection.rule} (${strike.count}/${settings.finalStrike})`;
    if (strike.count >= settings.finalStrike) {
      const antiRaidSettings = this.antiRaid.settings(message.guild.id);
      return this.antiRaid.applyAction(message.member, reason, {
        ...antiRaidSettings,
        action: settings.finalAction,
        timeoutMinutes: settings.timeoutMinutes,
      });
    }
    if (strike.count >= settings.timeoutStrike && message.member?.moderatable) {
      const timedOut = await message.member
        .timeout(settings.timeoutMinutes * 60_000, `BLL ${reason}`)
        .then(() => true)
        .catch(() => false);
      if (!timedOut) await this.warn(message, settings, strike);
      return timedOut;
    }
    await this.warn(message, settings, strike);
    return false;
  }

  async processMessage(message) {
    const settings = this.settings(message.guild.id);
    if (!settings.enabled || this.isIgnored(message, settings)) return;
    if (this.antiRaid.isTrusted(message.guild, message.author.id)) return;
    const detection = this.detect(message, settings);
    if (!detection) return;

    await message.delete().catch(() => null);
    const strike = await this.store.recordAutoModStrike(
      message.guild.id,
      message.author.id,
      detection.rule,
      settings.strikeWindowHours,
    );
    const alreadyFinalized = Boolean(
      strike.finalizedAt
      && Date.now() - strike.finalizedAt <= settings.strikeWindowHours * 3_600_000,
    );
    const applied = alreadyFinalized
      ? false
      : await this.applyProgressiveAction(message, detection, settings, strike);
    if (applied && strike.count >= settings.finalStrike) {
      await this.store.markAutoModFinalized(message.guild.id, message.author.id);
    }
    const progression = alreadyFinalized
      ? 'La sanción final ya había sido aplicada; la infracción quedó registrada.'
      : `Advertencia ${strike.count}/${settings.finalStrike}.`;
    await this.antiRaid.log(
      message.guild,
      applied ? 'AutoMod · Usuario sancionado' : 'AutoMod · Mensaje bloqueado',
      `<@${message.author.id}>: **${detection.rule}**. ${detection.detail}\n${progression}`,
      applied ? 0xed4245 : 0xfee75c,
    );
  }
}
