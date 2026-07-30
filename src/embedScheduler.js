import { buildCustomEmbed } from './embeds.js';

export class EmbedScheduler {
  constructor(client, store, guildId) {
    this.client = client;
    this.store = store;
    this.guildId = guildId;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(console.error), 30_000);
    this.timer.unref();
    setTimeout(() => this.tick().catch(console.error), 5_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()) {
    if (this.running || !this.client.isReady()) return;
    this.running = true;
    try {
      const section = this.store.getGuildSettings(this.guildId).embeds;
      const guild = this.client.guilds.cache.get(this.guildId);
      if (!guild) return;
      for (const schedule of section.schedules.filter((item) => item.enabled && item.nextRunAt <= now)) {
        const embed = section.saved.find((item) => item.id === schedule.embedId);
        const nextRunAt = now + schedule.intervalMinutes * 60_000;
        if (!embed) {
          await this.store.deleteOrphanedSchedule(this.guildId, schedule.id);
          continue;
        }
        try {
          const channel = guild.channels.cache.get(schedule.channelId)
            ?? await guild.channels.fetch(schedule.channelId);
          if (!channel?.isTextBased() || channel.isThread()) throw new Error('Canal no disponible');
          // La reserva revalida owner, permisos y configuración justo antes de publicar.
          const reservation = await this.store.reserveScheduleRun(
            this.guildId,
            schedule,
            now,
          );
          if (!reservation) continue;
          await channel.send({ embeds: [buildCustomEmbed(reservation.embed)] });
          await this.store.updateScheduleRun(this.guildId, schedule.id, {
            lastRunAt: now,
            lastError: '',
          });
        } catch (error) {
          await this.store.updateScheduleRun(this.guildId, schedule.id, {
            nextRunAt,
            lastError: error.message,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
