const { MessageFlags } = require('discord.js');

function ephemeral(options = {}) {
  return { ...options, flags:MessageFlags.Ephemeral };
}

function interactionCode(error) {
  return Number(error?.code || error?.rawError?.code || 0);
}

async function respondToInteractionError(interaction, error, logger = console.error) {
  const code = interactionCode(error);
  logger(error?.stack || error?.message || String(error));
  if (code === 10062 || code === 10015) {
    logger(JSON.stringify({ event:'interaction_expired', interactionId:interaction?.id || null, command:interaction?.commandName || null, code }));
    return;
  }
  try {
    if (interaction?.isAutocomplete?.()) {
      if (!interaction.responded) await interaction.respond([]);
      return;
    }
    const content = `Something went wrong: ${error?.message || 'Please try again.'}`;
    if (interaction?.deferred || interaction?.replied) await interaction.editReply({ content, components:[] });
    else await interaction.reply(ephemeral({ content }));
  } catch (responseError) {
    logger(JSON.stringify({ event:'interaction_error_response_failed', interactionId:interaction?.id || null, command:interaction?.commandName || null, code:interactionCode(responseError), error:responseError?.message || String(responseError) }));
  }
}

function runInteraction(interaction, handler, logger) {
  return Promise.resolve().then(() => handler(interaction)).catch(error => respondToInteractionError(interaction, error, logger));
}

module.exports = { ephemeral, interactionCode, respondToInteractionError, runInteraction };
