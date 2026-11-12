import { z } from 'zod';
import { AppError } from '../../../core/errors';
import * as namespaceService from '../../namespaces/namespace.service';
import * as projectService from '../../projects/project.service';
import { langCodeSchema } from '../../files/file.schemas';
import type { AccountInstance, FileInstance, ProjectInstance } from '../../../infrastructure/database/models';
import type { JsonSchema } from '../../../infrastructure/ai/types';
import type { ToolContext, ToolResult } from '../chat.types';

/** One argument: the zod schema that validates it and the JSON Schema the model sees. */
type ArgumentField = readonly [z.ZodType, JsonSchema];

/** The zod shape of a set of argument fields. */
type ArgumentShape<F extends Record<string, ArgumentField>> = { -readonly [K in keyof F]: F[K][0] };

/** A tool's declared arguments, for the model and for validation. */
interface ToolArguments<T> {
  parameters: JsonSchema;
  schema: z.ZodType<T>;
}

/** The validated arguments a tool's handler receives. */
type ArgumentsOf<A> = A extends ToolArguments<infer T> ? T : never;

/** A chat tool: what the model is shown, how its arguments are checked, and what it does. */
interface ChatTool<T> extends ToolArguments<T> {
  name: string;
  description: string;
  handler(args: T, context: ToolContext): Promise<ToolResult>;
}

/** A tool as the dispatcher holds it, whatever its arguments. */
interface RegisteredTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  schema: z.ZodType<unknown>;
  handler(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/** What a tool resolves its target to. */
interface ProjectAccess {
  project: ProjectInstance;
  namespace: AccountInstance;
  role: string;
}

/** What a file tool resolves its target to. */
interface FileAccess extends ProjectAccess {
  file: FileInstance;
}

/** An access check that either succeeded or produced a refusal for the model. */
type AccessResult<A> = { access: A; failure: null } | { access: null; failure: ToolResult };


/**
 * What every chat tool shares: result shapes, argument pieces, ceilings and the
 * access checks. The security position these serve is stated in
 * `../chat.tools.js`.
 */

/** Locale lists a tool accepts, bounded like every other language list. */
const targetLangsSchema = z
  .array(langCodeSchema)
  .min(1, 'Name at least one language.')
  .max(50, 'Name 50 languages or fewer.');

/**
 * A project or file identifier as a model writes it.
 *
 * Either type is accepted because models disagree about which to send; the
 * resolver decides whether it names anything.
 */
const idSchema = z.union([z.number(), z.string()]);

/**
 * Declares a tool's arguments once, for the model and for validation.
 *
 * Each field pairs the zod schema that validates it with the JSON Schema the
 * model is shown, so the two cannot drift apart. A field is required exactly
 * when its zod schema is not optional, and an undeclared argument fails.
 *
 * @param {Object<string, Array>} fields Argument name to `[zod schema, JSON Schema]`.
 * @param {Function} [refine] Adds rules across fields to the strict object schema.
 * @returns {ToolArguments} The JSON Schema and the strict zod schema.
 */
function defineArguments<F extends Record<string, ArgumentField>>(
  fields: F,
  refine: (schema: z.ZodType<z.output<z.ZodObject<ArgumentShape<F>>>>) => z.ZodType<z.output<z.ZodObject<ArgumentShape<F>>>> = (schema) => schema,
): ToolArguments<z.output<z.ZodObject<ArgumentShape<F>>>> {
  const names = Object.keys(fields);
  const pick = (index: 0 | 1) => Object.fromEntries(names.map((name) => [name, fields[name][index]]));

  return {
    parameters: {
      type: 'object',
      properties: pick(1),
      ...(names.length === 0
        ? {}
        : { required: names.filter((name) => !fields[name][0].isOptional()) }),
      additionalProperties: false,
    },
    schema: refine(z.object(pick(0) as ArgumentShape<F>).strict()),
  };
}

/**
 * Declares one chat tool.
 *
 * It returns the tool unchanged. It exists so the handler's arguments are typed
 * from the same zod schema that validates them.
 *
 * @param tool The tool.
 * @returns The same tool.
 */
function defineTool<T>(tool: ChatTool<T>): ChatTool<T> {
  return tool;
}

/** A tool that takes no arguments. */
const NO_ARGUMENTS = Object.freeze(defineArguments({}));

/** A tool that takes one project and nothing else. */
const PROJECT_ONLY = Object.freeze(
  defineArguments({
    project_id: [idSchema, { type: 'integer', description: 'Project identifier.' }],
  }),
);

/** Projects one call may touch, so "all at once" cannot become unbounded work. */
const MAX_PROJECTS_PER_CALL = 25;

/**
 * Languages one call may add, matching the bound the argument schema applies.
 *
 * An inferred set has to obey the same ceiling a named one does, or "all
 * languages" would be a way around the limit rather than a convenience.
 */
const MAX_LANGS_PER_CALL = 50;

/**
 * Downloads one turn may offer.
 *
 * A model that has just listed twenty files could otherwise answer with twenty
 * buttons, which is not an answer. Reaching the ceiling is a refusal it can read
 * and narrow, exactly like the project ceiling above.
 */
const MAX_DOWNLOADS_PER_TURN = 5;

/**
 * Keys one call may add by naming them.
 *
 * Matching the ceiling the retranslate endpoint applies, since both spend
 * provider quota per key. There is no such limit on an attached document: a
 * file is how somebody adds a thousand strings, and the refusal says so rather
 * than leaving them to discover it.
 */
const MAX_KEYS_PER_CALL = 200;

/**
 * Wraps a successful result.
 *
 * @param {object} body Result fields.
 * @returns {object} Tool result.
 */
function ok(body: Record<string, unknown>): ToolResult {
  return { ok: true, ...body };
}

/**
 * Wraps a refusal the model should read out to the person.
 *
 * @param {string} error What went wrong.
 * @param {object} [body] Extra fields, for example what to do instead.
 * @returns {object} Tool result.
 */
function fail(error: string, body: Record<string, unknown> = {}): ToolResult {
  return { ok: false, error, ...body };
}

/**
 * Runs a step, turning a refusal the application raised into a result.
 *
 * Anything else is a defect and is rethrown for the dispatcher to log.
 *
 * @param {Function} step Work to run, synchronous or not.
 * @param {object} [body] Extra fields for the refusal, usually an instruction.
 * @returns {Promise<{value: *, failure: object|null}>}
 */
async function attempt<T>(step: () => T | Promise<T>, body: Record<string, unknown> = {}): Promise<{ value: T; failure: null } | { value: undefined; failure: ToolResult }> {
  try {
    return { value: await step(), failure: null };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { value: undefined, failure: fail(error.message, body) };
  }
}

/**
 * The summary of a project a result carries.
 *
 * @param {object} project Project instance or client safe project.
 * @returns {{id: number, name: string}}
 */
function projectRef(project: { id: number; name: string; }): { id: number; name: string; } {
  return { id: project.id, name: project.name };
}

/**
 * The summary of a file a result carries.
 *
 * @param {object} file File instance.
 * @returns {{id: string, filename: string, status: string}}
 */
function fileRef(file: FileInstance): { id: string; filename: string; status: string; } {
  return { id: file.id, filename: file.filename, status: file.status };
}

/**
 * Asserts the caller may change things in a namespace.
 *
 * @param {object} namespace Namespace being changed.
 * @param {string} role Role the caller holds in it.
 * @returns {object|null} A failure result, or null when the caller may proceed.
 */
function requireAdmin(namespace: AccountInstance, role: string): ToolResult | null {
  try {
    namespaceService.assertAdmin(namespace, role);
    return null;
  } catch (error) {
    return fail((error as Error).message);
  }
}

/**
 * Resolves access and reports the failure as a result.
 *
 * Resolved from the authenticated account, never from anything the model said
 * about who it is or what it may reach. An identifier belonging to somebody
 * else answers "does not exist", so this cannot be used to discover one.
 *
 * @param {Function} resolve Resolver call returning the access.
 * @param {string} unreachable Message for a failure the application did not raise.
 * @param {boolean} admin Whether changing things is asked for, not only seeing them.
 * @returns {Promise<{access: object|null, failure: object|null}>}
 */
async function resolveAccess<A extends ProjectAccess>(resolve: () => Promise<A>, unreachable: string, admin: boolean): Promise<AccessResult<A>> {
  let access: A;
  try {
    access = await resolve();
  } catch (error) {
    return { access: null, failure: fail(error instanceof AppError ? error.message : unreachable) };
  }

  const denied = admin ? requireAdmin(access.namespace, access.role) : null;
  return denied === null ? { access, failure: null } : { access: null, failure: denied };
}

/**
 * Resolves a project the caller may see, or may change when `admin` is set.
 *
 * @param {object} context Tool context.
 * @param {number|string} projectId Identifier the model supplied.
 * @param {{admin?: boolean}} [options] Whether ADMIN is required in an organization.
 * @returns {Promise<{access: object|null, failure: object|null}>}
 */
function resolveProject(context: ToolContext, projectId: number | string, { admin = false }: { admin?: boolean; } = {}): Promise<AccessResult<ProjectAccess>> {
  return resolveAccess(
    () => namespaceService.resolveProjectAccess(context.actor, projectId),
    'That project could not be reached.',
    admin,
  );
}

/**
 * Resolves a file the caller may see, or may change when `admin` is set.
 *
 * Through the same resolver the file routes use, which walks the file up to its
 * project and its namespace.
 *
 * @param {object} context Tool context.
 * @param {number|string} fileId Identifier the model supplied.
 * @param {{admin?: boolean}} [options] Whether ADMIN is required in an organization.
 * @returns {Promise<{access: object|null, failure: object|null}>}
 */
function resolveFile(context: ToolContext, fileId: number | string, { admin = false }: { admin?: boolean; } = {}): Promise<AccessResult<FileAccess>> {
  return resolveAccess(
    () => namespaceService.resolveFileAccess(context.actor, fileId),
    'That file could not be reached.',
    admin,
  );
}

/**
 * Every project the caller can see, across every namespace they belong to.
 *
 * Gathering an identifier here says only that the caller can see the project.
 * Whether they may change it is decided per project by the handler, through the
 * same resolver the REST routes use.
 *
 * @param {object} context Tool context.
 * @returns {Promise<Array<number>>} Project identifiers.
 */
async function reachableProjectIds(context: ToolContext): Promise<Array<number>> {
  const namespaces = await namespaceService.listAccessibleNamespaces(context.actor);
  const identifiers: number[] = [];

  for (const namespace of namespaces) {
    const projects = await projectService.listProjects(namespace.id);
    for (const project of projects) identifiers.push(project.id);
  }

  return identifiers;
}

/**
 * Collects the projects one call should act on.
 *
 * Two ways in, and the difference is only how the identifiers are gathered:
 * named in the arguments, or every project in the scope the tool sweeps when
 * `all_projects` is set. Neither is a permission.
 *
 * @param {object} args Validated arguments.
 * @param {object} options How to gather and what to say.
 * @param {Function} options.all Gathers every project in the sweep.
 * @param {string} options.ask Instruction when no project was named.
 * @returns {Promise<{identifiers: Array<number|string>, failure: object|null}>}
 */
async function collectProjectTargets(args: { all_projects?: boolean; project_ids?: Array<number | string> }, { all, ask }: { all: () => Promise<Array<number | string>>; ask: string; }): Promise<{ identifiers: Array<number | string>; failure: ToolResult | null; }> {
  const identifiers = args.all_projects === true ? await all() : (args.project_ids ?? []);

  if (identifiers.length === 0) {
    return {
      identifiers: [],
      failure: fail('No project was named.', { instruction: ask }),
    };
  }

  if (identifiers.length > MAX_PROJECTS_PER_CALL) {
    return {
      identifiers: [],
      failure: fail(`That is more than ${MAX_PROJECTS_PER_CALL} projects for one call.`, {
        instruction: 'Ask the person to narrow the request to fewer projects.',
      }),
    };
  }

  return { identifiers, failure: null };
}

/**
 * Refuses a set of named keys that is empty or past the ceiling.
 *
 * @param {number} count Keys named.
 * @param {object} instructions What to tell the model.
 * @param {string} instructions.empty Instruction when no key was named.
 * @param {string} instructions.noun What the person should attach instead, such as "keys".
 * @returns {object|null} A failure result, or null when the count is usable.
 */
function checkKeyCount(count: number, { empty, noun }: { empty: string; noun: string; }): ToolResult | null {
  if (count === 0) {
    return fail('No keys were named.', { instruction: empty });
  }

  if (count > MAX_KEYS_PER_CALL) {
    return fail(`That is more than ${MAX_KEYS_PER_CALL} keys for one call.`, {
      instruction: `Ask the person to attach the ${noun} as a JSON file instead, which has no such limit.`,
    });
  }

  return null;
}

export type { ArgumentsOf, ToolArguments, ChatTool, RegisteredTool, ProjectAccess, FileAccess, AccessResult };
export {
  targetLangsSchema,
  idSchema,
  defineArguments,
  defineTool,
  NO_ARGUMENTS,
  PROJECT_ONLY,
  MAX_PROJECTS_PER_CALL,
  MAX_LANGS_PER_CALL,
  MAX_DOWNLOADS_PER_TURN,
  MAX_KEYS_PER_CALL,
  ok,
  fail,
  attempt,
  projectRef,
  fileRef,
  requireAdmin,
  resolveProject,
  resolveFile,
  reachableProjectIds,
  collectProjectTargets,
  checkKeyCount,
};
