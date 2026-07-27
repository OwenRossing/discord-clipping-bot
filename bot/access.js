const { PermissionFlagsBits } = require('discord.js');
const db = require('../api/db');
const { isPlatformOwner } = require('../api/platformAccess');

function isBotAdmin(guild, member) {
  return isPlatformOwner(member.id)
    || guild.ownerId === member.id
    || member.permissions?.has(PermissionFlagsBits.ManageGuild)
    || Boolean(db.prepare('SELECT 1 FROM server_admins WHERE guild_id=? AND user_id=?').get(guild.id, member.id));
}

module.exports = { isBotAdmin };
