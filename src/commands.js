import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

/*
 * setDefaultMemberPermissions hace que Discord oculte el comando a quien no
 * tenga el permiso nativo. No sustituye a la comprobación del servidor: el
 * bot vuelve a validar rol, permiso y jerarquía antes de ejecutar.
 */
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

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Advierte a un miembro por DM y lo deja registrado.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Miembro que recibe la advertencia.').setRequired(true))
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo de la advertencia.').setMaxLength(400)),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Aísla temporalmente a un miembro.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Miembro a aislar.').setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName('minutos')
        .setDescription('Duración en minutos (máximo 28 días).')
        .setMinValue(1)
        .setMaxValue(40_320)
        .setRequired(true))
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo del aislamiento.').setMaxLength(400)),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa a un miembro del servidor.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Miembro a expulsar.').setRequired(true))
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo de la expulsión.').setMaxLength(400)),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Banea a un usuario, esté o no en el servidor.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Usuario a banear.').setRequired(true))
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo del ban.').setMaxLength(400))
    .addIntegerOption((option) =>
      option
        .setName('borrar_horas')
        .setDescription('Borrar sus mensajes recientes (horas).')
        .setMinValue(0)
        .setMaxValue(168)),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Borra mensajes recientes del canal actual.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName('cantidad')
        .setDescription('Número de mensajes a borrar (1-100).')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true))
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Borrar solo los mensajes de este usuario.')),

  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Ajusta el modo lento de un canal.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) =>
      option
        .setName('segundos')
        .setDescription('Segundos entre mensajes. 0 lo desactiva.')
        .setMinValue(0)
        .setMaxValue(21_600)
        .setRequired(true))
    .addChannelOption((option) =>
      option
        .setName('canal')
        .setDescription('Canal a ajustar. Por defecto, el actual.')
        .addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Cierra o reabre un canal para @everyone.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('canal')
        .setDescription('Canal a cerrar. Por defecto, el actual.')
        .addChannelTypes(ChannelType.GuildText))
    .addBooleanOption((option) =>
      option.setName('abrir').setDescription('Marca para reabrir el canal en lugar de cerrarlo.')),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Muestra la ficha de moderación de un usuario.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName('usuario').setDescription('Usuario a consultar.').setRequired(true)),
].map((command) => command.toJSON());
