process.env.DEV_AUTH_ENABLED = 'true';

if (!process.env.DEV_USER_ID || !process.env.DEV_GUILD_ID) {
  console.error('Set DEV_USER_ID and DEV_GUILD_ID before using the temporary development login.');
  process.exitCode = 1;
} else {
  const { issueDevelopmentCode } = require('../api/devAuth');
  const { loadConfig } = require('../bot/utils');
  const { startServer } = require('../api/server');
  const challenge = issueDevelopmentCode();
  const config = loadConfig();
  console.log(`\nTemporary local sign-in code: ${challenge.code}`);
  console.log('It expires in 10 minutes and works once. Do not share it.\n');
  startServer(config);
}
