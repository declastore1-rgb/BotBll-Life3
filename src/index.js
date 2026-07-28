import {
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { AntiRaid } from './antiRaid.js';
import { commands } from './commands.js';
import { config, defaultGuildSettings } from './config.js';
import { SettingsStore } from './store.js';
import {
  buildPanel,
  closeTicket,
  createTicket,
  handleExtraButton,
  showServerInfo,
  ticketIds,
} from './tickets.js';
import { createWebServer } from './web.js';

const store = new SettingsStore({
  dataDir: config.dataDir,
  guildId: config.guildId,
  defaults: defaultGuildSettings,
  adminUsername: config.adminUsername,
  adminPassword: config.adminPassword,
});
await store.init();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
  ],
});

const antiRaid = new AntiRaid(client, store);
antiRaid.start();
const webServer = createWebServer({ client, store, antiRaid });

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(config.guildId);
    await readyClient.application.commands.set([]);
    await guild.commands.set(commands);
    readyClient.user.setPresence({
      status: 'online',
      activities: [{ name: config.streamName, type: ActivityType.Streaming, url: config.streamUrl }],
    });
    console.log(`✅ ${readyClient.user.tag} conectado en ${guild.name}.`);
    console.log('✅ Comandos registrados: /panel create y /antiraid status.');
    console.log('✅ Presencia configurada como Transmitiendo.');
  } catch (error) {
    console.error('No se pudo completar la inicialización:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inCachedGuild()) return;
      const tickets = store.getGuildSettings(interaction.guildId).tickets;
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
      if (!tickets.commandRoleId || !member?.roles?.cache.has(tickets.commandRoleId)) {
        await interaction.reply({
          content: `Solo el rol <@&${tickets.commandRoleId}> puede utilizar este comando.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { roles: [] },
        });
        return;
      }

      if (interaction.commandName === 'panel' && interaction.options.getSubcommand() === 'create') {
        if (!tickets.enabled) {
          await interaction.reply({ content: 'El sistema de tickets está desactivado.', flags: MessageFlags.Ephemeral });
          return;
        }
        const channel = interaction.options.getChannel('canal') ?? interaction.channel;
        if (!channel?.isTextBased()) {
          await interaction.reply({ content: 'Selecciona un canal de texto válido.', flags: MessageFlags.Ephemeral });
          return;
        }
        const message = await channel.send(buildPanel(tickets));
        await store.recordPublishedPanel(
          interaction.guildId,
          channel.id,
          message.id,
          interaction.user.tag,
        );
        await interaction.reply({ content: `Panel creado correctamente en ${channel}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'antiraid' && interaction.options.getSubcommand() === 'status') {
        const status = antiRaid.status(interaction.guildId);
        const embed = new EmbedBuilder()
          .setColor(status.enabled ? 0x57f287 : 0xed4245)
          .setTitle('BLL $ LIFE · Estado Anti-Raid')
          .setDescription(status.enabled ? 'La protección está activa.' : 'La protección está desactivada.')
          .addFields(
            { name: 'Modo raid', value: status.raidMode ? `Activo hasta <t:${Math.floor(status.raidModeUntil / 1_000)}:R>` : 'Inactivo', inline: true },
            { name: 'Sanción', value: status.action, inline: true },
            { name: 'Entradas', value: status.joins, inline: true },
            { name: 'Edad mínima', value: status.minimumAge, inline: true },
            { name: 'Spam', value: status.spam, inline: true },
            { name: 'Menciones', value: String(status.mentions), inline: true },
            { name: 'Acciones destructivas', value: status.destructive, inline: true },
          )
          .setFooter({ text: tickets.footerText })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (!interaction.isButton()) return;
    if (interaction.customId === ticketIds.create) await createTicket(interaction, store);
    else if (interaction.customId === ticketIds.info) await showServerInfo(interaction, store);
    else if (interaction.customId === ticketIds.close) await closeTicket(interaction, store);
    else if (interaction.customId.startsWith(ticketIds.extraPrefix)) {
      await handleExtraButton(interaction, store);
    }
  } catch (error) {
    console.error('Error procesando una interacción:', error);
    const response = { content: 'Ocurrió un error al procesar la acción.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null);
    else await interaction.reply(response).catch(() => null);
  }
});

async function shutdown(signal) {
  console.log(`Cerrando por ${signal}...`);
  client.destroy();
  webServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => console.error('Promesa rechazada:', error));
process.on('uncaughtException', (error) => console.error('Excepción no controlada:', error));

client.login(config.token).catch((error) => {
  console.error('No se pudo iniciar sesión. Verifica DISCORD_TOKEN:', error.message);
  webServer.close(() => { process.exitCode = 1; });
});
