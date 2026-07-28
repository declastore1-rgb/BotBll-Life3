import { ChannelType, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Administra el panel de tickets.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('create')
        .setDescription('Crea el panel de tickets de BLL $ LIFE.')
        .addChannelOption((option) =>
          option
            .setName('canal')
            .setDescription('Canal donde se publicará el panel.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    ),
  new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('Muestra el estado de la protección anti-raid.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Muestra el estado y los límites activos.'),
    ),
].map((command) => command.toJSON());
