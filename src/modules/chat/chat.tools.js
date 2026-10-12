'use strict';

const logger = require('../../core/logger');
const { AppError } = require('../../core/errors');
const conversation = require('./tools/conversation');
const projects = require('./tools/projects');
const languages = require('./tools/languages');
const files = require('./tools/files');
const exportFormats = require('./tools/exportFormats');
const {
  fail,
  MAX_PROJECTS_PER_CALL,
  MAX_DOWNLOADS_PER_TURN,
  MAX_KEYS_PER_CALL,
} = require('./tools/shared');

/**
 * The tools the assistant may call.
 *
 * The security position of this module is the whole design, so it is stated
 * plainly rather than left to be inferred.
 *
 * **The model never authorises anything.** Every handler resolves access itself,
 * in ordinary backend code, against the authenticated account carried in the
 * context. It does this on every call, and it does it through the same
 * functions the HTTP routes use. A model can name any namespace or project it
 * likes, including ones invented by text inside a locale file; naming one it is
 * not entitled to simply fails, with the same message and the same status the
 * REST API would give.
 *
 * That is the answer to prompt injection here. There is no instruction, however
 * well crafted, that turns into access, because access is not decided anywhere
 * the model can reach.
 *
 * **Arguments are validated before they are used.** The model writes them, so
 * they are untrusted input exactly like a request body, and they go through a
 * strict schema for the same reason. An argument the schema does not declare
 * fails rather than reaching a service.
 *
 * **A failure is a result, not an exception.** A tool that refuses returns a
 * value the model can read and explain, because the person asked a question and
 * deserves an answer rather than a stack trace. Only errors the application
 * raised deliberately are described; anything else becomes a generic message,
 * matching how the HTTP error handler behaves.
 *
 * **Nothing here writes without a check that a person could have passed.** Every
 * mutating tool requires the same role the equivalent endpoint requires.
 */

/**
 * Every tool, in the order the model is shown them.
 *
 * The definitions live in `./tools/` by area; this list is the whole of what a
 * model can invoke. A name outside it resolves to nothing.
 */
const TOOLS = [
  conversation.switchNamespace,
  projects.listProjects,
  projects.createProject,
  files.uploadFile,
  files.listFiles,
  languages.checkProjectLanguages,
  projects.getProjectDescription,
  projects.updateProjectDescription,
  projects.listPlatforms,
  projects.updateProjectAi,
  languages.addLanguages,
  exportFormats.listExportFormats,
  exportFormats.createExportFormat,
  files.createFile,
  files.addKeys,
  files.exportFile,
  conversation.findChat,
  conversation.stop,
];

/** Tools by name, so a lookup cannot reach a prototype member. */
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * The tool catalogue in the shape a provider adapter expects.
 *
 * @returns {Array<{name: string, description: string, parameters: object}>}
 */
function listToolDefinitions() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Validates and runs one tool call.
 *
 * Everything a model can get wrong ends as a readable result rather than an
 * exception: an unknown tool, arguments that do not fit, a refusal from an
 * access check. The one case that does not is a genuine defect, which is logged
 * in full and reported generically, exactly as the HTTP error handler does.
 *
 * @param {object} call Tool call from the model.
 * @param {object} context Tool context, carrying the authenticated account.
 * @returns {Promise<object>} Tool result, safe to send back to the model.
 */
async function dispatchTool(call, context) {
  const tool = TOOLS_BY_NAME.get(call.name);

  if (tool === undefined) {
    return fail(`There is no tool called "${call.name}".`, {
      available: TOOLS.map((entry) => entry.name),
    });
  }

  const parsed = tool.schema.safeParse(call.arguments ?? {});
  if (!parsed.success) {
    return fail('The arguments for that tool were not usable.', {
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'arguments',
        message: issue.message,
      })),
    });
  }

  try {
    return await tool.handler(parsed.data, context);
  } catch (error) {
    if (error instanceof AppError) return fail(error.message);

    logger.error('A chat tool failed unexpectedly.', {
      tool: call.name,
      accountId: context.actor.id,
      message: error.message,
      stack: error.stack,
    });
    return fail('That action could not be completed.');
  }
}

module.exports = {
  listToolDefinitions,
  dispatchTool,
  TOOLS,
  MAX_PROJECTS_PER_CALL,
  MAX_DOWNLOADS_PER_TURN,
  MAX_KEYS_PER_CALL,
};
