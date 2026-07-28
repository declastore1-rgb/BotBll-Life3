import {
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { AntiRaid } from './antiRaid.js';
import { commands } from './commands.js';
import { config } from './config.js';
import {
  buildPanel,
  closeTicket,
  createTicket,
  showServerInfo,
  ticketIds,
} from './tickets.js';

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

const antiRaid = new AntiRaid(client);
antiRaid.start();

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(config.guildId);
    await readyClient.application.commands.set([]);
    await guild.commands.set(commands);

    readyClient.user.setPresence({
      status: 'online',
      activities: [
        {
          name: config.streamName,
          type: ActivityType.Streaming,
          url: config.streamUrl,
        },
      ],
    });

    console.log(`✅ ${readyClient.user.tag} conectado en ${guild.name}.`);
    console.log('✅ Comandos registrados: /panel create y /antiraid status.');
    console.log('✅ Presencia configurada como Transmitiendo.');
  } catch (error) {
    console.error('No se pudo completar la inicializacion:', error);
    process.exitCode = 1;
    readyClient.destroy();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inCachedGuild()) return;
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: 'Necesitas el permiso Administrador para usar este comando.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === 'panel' && interaction.options.getSubcommand() === 'create') {
        const channel = interaction.options.getChannel('canal') ?? interaction.channel;
        if (!channel?.isTextBased()) {
          await interaction.reply({ content: 'Selecciona un canal de texto válido.', flags: MessageFlags.Ephemeral });
          return;
        }
        await channel.send(buildPanel());
        await interaction.reply({ content: `Panel creado correctamente en ${channel}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'antiraid' && interaction.options.getSubcommand() === 'status') {
        const status = antiRaid.status(interaction.guildId);
        const embed = new EmbedBuilder()
          .setColor(status.enabled ? 0x57f287 : 0xed4245)
          .setTitle('BLL $ LIFE · Estado Anti-Raid')
          .setDescription(
            status.enabled
              ? '🟢 La protección está activa.'
              : '🔴 La protección está desactivada.',
          )
          .addFields(
            { name: 'Modo raid', value: status.raidMode ? `Activo hasta <t:${Math.floor(status.raidModeUntil / 1_000)}:R>` : 'Inactivo', inline: true },
            { name: 'Sanción', value: status.action, inline: true },
            { name: 'Entradas', value: status.joins, inline: true },
            { name: 'Edad mínima', value: status.minimumAge, inline: true },
            { name: 'Spam', value: status.spam, inline: true },
            { name: 'Menciones', value: String(status.mentions), inline: true },
            { name: 'Acciones destructivas', value: status.destructive, inline: true },
          )
          .setFooter({ text: 'Copyright Team Bll $ Life' })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (!interaction.isButton()) return;
    if (interaction.customId === ticketIds.create) await createTicket(interaction);
    else if (interaction.customId === ticketIds.info) await showServerInfo(interaction);
    else if (interaction.customId === ticketIds.close) await closeTicket(interaction);
  } catch (error) {
    console.error('Error procesando una interaccion:', error);
    const response = { content: 'Ocurrió un error al procesar la acción.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => null);
    else await interaction.reply(response).catch(() => null);
  }
});

process.on('unhandledRejection', (error) => console.error('Promesa rechazada:', error));
process.on('uncaughtException', (error) => console.error('Excepción no controlada:', error));

client.login(config.token).catch((error) => {
  console.error('No se pudo iniciar sesión. Verifica DISCORD_TOKEN:', error.message);
  process.exitCode = 1;
});
