// MCP Prompts（ADR 0015 第 6 节）：引导 AI 按推荐工作流调用 Dowel MCP 工具的模板。
// - 按令牌 scope 注册：design_tables / refactor_column 需要 write；review_unpublished_changes / review_canvas_history 只需 read。
// - 渲染回调里零数据库 / 项目存在性查询：只做参数校验与模板拼装，`prompts/get` 不能用来探测未授权项目是否存在
//   （项目权限在 AI 随后调用工具时才按白名单 ∩ 当前角色判断）。
// - 覆写 `prompts/get`：先按本令牌自维护的 Map 判断（Map.prototype.has，拦截 toString / __proto__ / constructor 等
//   原型属性名与只读令牌越权取写类 prompt），非法一律 ProtocolError(InvalidParams)，文本经 scrubSecrets 脱敏。
// - 模板文案随 scope 动态生成：只有带 verify scope 时才建议 verify_migration；始终说明发布版本、连接 / 执行目标库
//   与恢复画布历史保留给人工在 Dowel 界面操作。
import {
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  MCP_HISTORY_MAX_LIMIT,
  MCP_PROMPTS,
  type McpPromptMeta,
  type McpPromptName,
} from '@dowel/api';
import {
  type GetPromptResult,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { McpPrincipal } from './mcp-tokens.ts';
import { scrubSecrets } from './secrets.ts';

type PromptArgs = Record<string, string | undefined>;

interface RegisteredPrompt {
  meta: McpPromptMeta;
  schema: z.ZodObject;
  render: (args: PromptArgs) => string;
}

/** 由共享元数据生成参数 schema（MCP prompt 参数一律是字符串） */
const promptArgsSchema = (meta: McpPromptMeta): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (const arg of meta.arguments) {
    let s = z.string().trim().max(arg.maxLength);
    if (arg.required) s = s.min(1);
    if (arg.numeric) s = s.regex(/^\d+$/, `${arg.name} must be a non-negative decimal integer`);
    const described = s.describe(arg.description);
    shape[arg.name] = arg.required ? described : described.optional();
  }
  return z.object(shape);
};

/** 把用户给的值作为 JSON 字符串字面量嵌进模板（避免引号 / 换行打乱指令结构） */
const lit = (v: string) => JSON.stringify(v);

const BOUNDARIES =
  'Boundaries: publishing versions, connecting to or executing migrations against target databases, and restoring canvas history are reserved for humans in the Dowel UI. Never try to do them through MCP or any other channel; when the work is ready, ask a human to review and publish it in Dowel.';

const numbered = (steps: (string | false | null | undefined)[]) =>
  steps
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');

const renderers = (scopes: ReadonlySet<string>): Record<McpPromptName, (args: PromptArgs) => string> => {
  const canVerify = scopes.has('verify');
  const canWrite = scopes.has('write');
  const verifyStep = (what: string) =>
    canVerify
      ? `Run \`verify_migration\` (${what}) to replay the up/down migration on a shadow database and fix anything it reports.`
      : null;

  return {
    design_tables: (a) => {
      const project = lit(a.project!);
      const section = a.section ? lit(a.section) : null;
      return [
        `Design new tables in the Dowel project ${project} for the following requirements:`,
        '',
        '<requirements>',
        a.requirements!,
        '</requirements>',
        '',
        'Workflow:',
        numbered([
          `Call \`get_model\` with \`project: ${project}\` (summary) to learn the dialect, the derived lowest \`target\` version, \`capabilities\`, existing schemas, tables, enums, sequences and canvas sections. Note \`seq\`. Use \`q\` to find tables that already cover part of the requirements, and \`get_table\` for every existing table you will reference.`,
          'Call `list_mutators` with `names: ["defineTable", "addForeignKey"]` to check their exact argument schemas.',
          `Draft ONE \`apply_changes\` call with \`baseSeq\` = that \`seq\`: one \`defineTable\` per new table (columns, primary key, uniques, checks, indexes, comments), referring to its own columns by name and to other new objects by qualified name or \`$ref:<alias>\`; add the foreign keys between new tables (and any circular ones) with \`addForeignKey\` at the end of the same call. Pass a short \`summary\` stating the intent so humans can review and undo it as one canvas-history entry. Run it with \`dryRun: true\` first; errors report \`index\`, \`path\` and \`mutator\`.`,
          'Commit the call without `dryRun`, then check `diagnostics` in the response: fix every validation error and every compatibility error against the target version with follow-up `apply_changes` calls (judge warnings case by case).',
          section
            ? `Put the new tables into the canvas section ${section} with \`manage_sections\` (\`add_tables\` with the table IDs from \`refs\`; if no section with that ID or name exists, \`create\` it with those \`tables\`).`
            : 'Optionally group the new tables into a canvas section with `manage_sections`.',
          'Check the generated SQL with `preview_migration` (default `latest` → `head`).',
          verifyStep('from `latest` to `head`'),
          'Report the created tables, keys and relations, the remaining diagnostics and any open questions.',
        ]),
        '',
        BOUNDARIES,
      ].join('\n');
    },

    refactor_column: (a) => {
      const project = lit(a.project!);
      const table = lit(a.table!);
      const column = lit(a.column!);
      return [
        `Refactor the column ${column} of table ${table} in the Dowel project ${project}.`,
        '',
        '<change>',
        a.change!,
        '</change>',
        '',
        'Workflow:',
        numbered([
          `Call \`get_table\` with \`project: ${project}, table: ${table}\`. Find the column by name or ID and note its column ID, \`ver\` and the working \`seq\`. List everything that uses it: primary key / uniques / checks / foreign keys (in both directions) / indexes / partition keys, and \`dependentOpaques\` (views, functions, triggers, policies whose \`deps\` reference the table or the column).`,
          'Read the full DDL of those dependents with `get_objects` (`ids`) and decide whether the change breaks them (type changes, dropped columns, expressions using the column).',
          'Call `list_mutators` with `names: ["alterColumn"]` and build ONE `apply_changes` call with `baseSeq` = that `seq`: `alterColumn` addressed by the column ID (never by name) for the rename / type / nullability / default change; in the same call adjust dependent check expressions (`setCheckExpr`) or other keys when needed. Opaque objects that depend on the column by ID are re-normalized automatically; dependencies hidden inside function bodies are not — flag them for a human. Pass a short `summary`, run with `dryRun: true` first, then commit.',
          'Check `diagnostics` in the response and fix every validation / compatibility error.',
          'Inspect `preview_migration` (default `latest` → `head`) for data-loss or locking risks: narrowing types, NOT NULL on existing rows without a default, table rewrites, drop + add instead of rename.',
          verifyStep('from `latest` to `head`'),
          'Report the change, the affected dependents and the remaining risks.',
        ]),
        '',
        BOUNDARIES,
      ].join('\n');
    },

    review_unpublished_changes: (a) => {
      const project = lit(a.project!);
      return [
        `Review the working-copy changes in the Dowel project ${project} that are not yet published as a version.`,
        '',
        'Workflow:',
        numbered([
          `Call \`list_versions\` with \`project: ${project}, limit: 5\` to find the latest published version.`,
          'Call `get_model` with `diagnostics: true` to read the working `seq`, the derived lowest `target` version and the full validation / compatibility diagnostics.',
          'Call `preview_migration` (default `latest` → `head`) and read the up/down SQL and `warnings`.',
          'Call `list_history` (grouped) and walk back to the entry that carries the latest published `version`; for each edit session after it, call `get_history_diff` (`seq`, plus `from` = `seqFrom` when `stepCount` > 1) to see who changed what and why (`opSummary`).',
          'Review for: destructive or lossy steps (DROP, type narrowing, removed enum values, NOT NULL without default), rename vs drop + add, table rewrites and long locks, foreign keys without supporting indexes, cascade rules, default / collation changes, down-migration reversibility, and silent issues the diagnostics do not catch.',
          verifyStep('from `latest` to `head`'),
          canWrite
            ? 'Report findings ordered by severity with a concrete fix for each. Only change the model with `apply_changes` if the user explicitly asks you to.'
            : 'Report findings ordered by severity with a concrete fix for each (this token is read-only; a human applies the fixes).',
        ]),
        '',
        BOUNDARIES,
      ].join('\n');
    },

    review_canvas_history: (a) => {
      const project = lit(a.project!);
      const listArgs = [
        `project: ${project}`,
        'grouped: true',
        `limit: ${a.limit ?? '20'}`,
        ...(a.beforeSeq !== undefined ? [`beforeSeq: ${a.beforeSeq}`] : []),
      ].join(', ');
      return [
        `Review the canvas history of the Dowel project ${project} (read-only).`,
        '',
        'Workflow:',
        numbered([
          `Call \`list_history\` with \`${listArgs}\`. Each entry is one edit session (\`seqFrom\`..\`seq\`, \`stepCount\`, \`ops\`) or one single step; \`version\` marks published versions and \`via: "mcp"\` marks AI edits.`,
          `For each entry worth a closer look, call \`get_history_diff\` with \`seq\` (plus \`from\` = \`seqFrom\` when \`stepCount\` > 1; at most ${CANVAS_HISTORY_GROUP_MAX_STEPS} steps): \`objects\` lists the net added / removed / modified objects and \`diff\` the migration-style steps. Start with \`includeSql: false\`; use \`includeSteps: true\` to expand a group into single steps.`,
          'Continue with `beforeSeq` = `nextBeforeSeq` if the user wants older history.',
          'Summarize each session: who, when, what changed (net), the stated intent (`opSummary`) and whether it is published. Point out suspicious changes (accidental drops, reverted work, large unexplained batches).',
        ]),
        '',
        'Canvas history is read-only through MCP. To go back to an earlier state, a human uses the canvas history panel in the Dowel UI.',
        BOUNDARIES,
      ].join('\n');
    },
  };
};

const argError = (name: string, error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') ||
  `Invalid arguments for prompt ${name}`;

/** 按令牌 scope 注册 MCP Prompts，并覆写 prompts/get（见文件头） */
export const registerMcpPrompts = (server: McpServer, principal: McpPrincipal): void => {
  const render = renderers(principal.scopes);
  const registered = new Map<string, RegisteredPrompt>();

  const build = (entry: RegisteredPrompt, args: PromptArgs): GetPromptResult => ({
    description: entry.meta.description,
    messages: [{ role: 'user', content: { type: 'text', text: scrubSecrets(entry.render(args)) } }],
  });

  for (const meta of MCP_PROMPTS) {
    if (!principal.scopes.has(meta.requiredScope)) continue;
    const entry: RegisteredPrompt = { meta, schema: promptArgsSchema(meta), render: render[meta.name] };
    if (meta.name === 'review_canvas_history') {
      entry.schema = entry.schema.refine(
        (v) => {
          const limit = (v as PromptArgs).limit;
          return limit === undefined || (Number(limit) >= 1 && Number(limit) <= MCP_HISTORY_MAX_LIMIT);
        },
        { message: `limit must be between 1 and ${MCP_HISTORY_MAX_LIMIT}`, path: ['limit'] },
      );
    }
    registered.set(meta.name, entry);
    server.registerPrompt(
      meta.name,
      { description: meta.description, argsSchema: promptArgsSchema(meta) },
      (args) => build(entry, args as PromptArgs),
    );
  }

  server.server.setRequestHandler('prompts/get', (request) => {
    const name = request.params.name;
    const entry = registered.has(name) ? registered.get(name) : undefined;
    if (!entry) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, scrubSecrets(`Prompt ${name} not found`));
    }
    const parsed = entry.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, scrubSecrets(argError(name, parsed.error)));
    }
    return build(entry, parsed.data as PromptArgs);
  });
};
