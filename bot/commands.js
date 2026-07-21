const { SlashCommandBuilder } = require('discord.js');

const duration = option => option.setName('duration').setDescription('How far back to clip, for example 30s or 2m');
const title = option => option.setName('title').setDescription('Optional clip title').setMaxLength(80);

const commands = [
  new SlashCommandBuilder().setName('record').setDescription('Control the server voice recorder')
    .addSubcommand(command => command.setName('start').setDescription('Start recording in your current voice channel'))
    .addSubcommand(command => command.setName('stop').setDescription('Stop recording and clear the temporary buffer'))
    .addSubcommand(command => command.setName('status').setDescription('Show recorder health and recent activity'))
    .addSubcommand(command => command.setName('join').setDescription('Legacy alias for /record start'))
    .addSubcommand(command => command.setName('leave').setDescription('Legacy alias for /record stop')),
  new SlashCommandBuilder().setName('clipthat').setDescription('Save a recent voice-channel moment')
    .addStringOption(duration)
    .addStringOption(title),
  new SlashCommandBuilder().setName('clip').setDescription('Legacy alias for /clipthat')
    .addStringOption(duration)
    .addStringOption(title),
  new SlashCommandBuilder().setName('clips').setDescription("Browse this server's clip library")
    .addSubcommand(command => command.setName('recent').setDescription('Show recent clips'))
    .addSubcommand(command => command.setName('list').setDescription('Legacy alias for /clips recent'))
    .addSubcommand(command => command.setName('open').setDescription('Open a clip in Clip Vault').addStringOption(option => option.setName('clip').setDescription('Search by clip title').setRequired(true).setAutocomplete(true)))
    .addSubcommand(command => command.setName('edit').setDescription('Legacy alias for /clips open').addStringOption(option => option.setName('id').setDescription('Clip ID').setRequired(true))),
  new SlashCommandBuilder().setName('settings').setDescription('View recording settings and open server management'),
  new SlashCommandBuilder().setName('privacy').setDescription('Control whether Clip Vault may include your voice')
    .addSubcommand(command => command.setName('status').setDescription('Show your recording preference in this server'))
    .addSubcommand(command => command.setName('allow').setDescription('Allow your voice to be included in future clips'))
    .addSubcommand(command => command.setName('block').setDescription('Exclude your voice and clear it from the current buffer'))
].map(command => command.setDMPermission(false).toJSON());

module.exports = commands;
