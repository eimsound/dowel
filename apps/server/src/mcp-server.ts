import {
  MCP_MAX_OPS,
  MCP_SUMMARY_MAX,
  MCP_TOOLS,
  type McpApplyErrorLocation,
  type McpDiagnostics,
  type McpToolErrorCode,
  type McpToolName,
  type Role,
} from '@dowel/api';
import {
  all,
  type Check,
  childrenOf,
  type Column,
  columnsOf,
  diagnoseModel,
  type ForeignKey,
  getDialect,
  type Index,
  macros,
  type Model,
  mutators,
  type Obj,
  PlanError,
  type PrimaryKey,
  type Table,
  type Unique,
} from '@dowel/core';
import type { Versions } from '@dowel/sync';
// Dowel MCP 服务端实现（M3-C，ADR 0014）：基于 @modelcontextprotocol/server 的无状态 McpServer。
// - 每个请求按当前 `McpPrincipal` 构建独立的 McpServer：实时生效项目权限 ∩ 令牌 scope ∩ 可选项目白名单。
// - tools/list 仅暴露令牌 scope 允许的工具；tools/call 对越权或缺少 scope 的调用返回结构化 tool error（isError: true）。
// - 严禁连目标库：list_environments 仅读平台库缓存字段（带缓存时间与 source: 'platform_cache'）；
//   verify_migration 仅使用影子库并按用户扣减 connectionLimiter 配额；所有错误文本经 scrubSecrets 脱敏。
import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type Tool,
} from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { z } from 'zod';

import pkg from '../package.json' with { type: 'json' };
import { audit, auditIn } from './audit.ts';
import { type Action, can, userActor } from './authz.ts';
import { inList } from './db.ts';
import { iso, loadVersionRefs, projectPlanOptions, sanitizeSummary, versionRef } from './envs.ts';
import { groupBySlug } from './groups.ts';
import type { McpPrincipal } from './mcp-tokens.ts';
import {
  effectiveProjectRole,
  loadRoleContext,
  type ProjectRow,
  projectRow,
  projectRows,
  visibleProjects,
} from './roles.ts';
import { MCP_DISALLOWED_MUTATORS } from './rooms.ts';
import type { AppContext, Env } from './routes/context.ts';
import { scrubSecrets } from './secrets.ts';
import { ShadowError } from './shadow.ts';
import {
  buildDdlSql,
  buildMigrationPreview,
  findVersion,
  listProjectVersions,
  resolveModelRef,
  versionDetailOf,
} from './versions.ts';

const MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA = 200;

const MCP_INSTRUCTIONS = [
  'Dowel is a collaborative database schema modeling and frozen-migration platform (single main trunk per project).',
  'Recommended workflow:',
  '1. Discover accessible projects via `list_projects` (or `dowel://projects`).',
  '2. Read the current model summary or inspect specific tables with `get_model` / `get_table`, noting `seq`.',
  '3. Propose edits with `apply_changes` using that `baseSeq` and `$ref:<alias>` placeholders for new object IDs (`refs` returns `{ [alias]: uuid }`); run `dryRun: true` first when unsure. Each call is committed atomically as ONE canvas-history entry (one `seq`); pass a short `summary` describing the intent so humans can review and undo it as a unit.',
  '   Prefer the compile-time macros: `defineTable` creates a whole table (columns, keys, checks, indexes, FKs, comments, ext, partitions) and may refer to its own columns by name; `alterColumn` patches one existing column declaratively. Macros mix freely with primitive mutators in the same call and share the same `$ref` aliases; they expand into at most 500 primitive sub-ops per call (`opCount`).',
  '   Strict object-ID rule: editing or dropping existing objects (including `alterColumn.id`) only accepts existing object IDs or `$ref:<alias>` of objects created earlier in the same call — never names. Only references inside `defineTable` (schema, typeRef, refTable, refColumns, default.nextval, partitions[].schema) and its own columns may be resolved by (qualified) name; ambiguous names are rejected.',
  '   Circular foreign keys: create every table with `defineTable` first, then add the remaining FKs with `addForeignKey` at the end of the same call. Errors report the input `index` plus, for macros, `path` (e.g. `defineTable(orders).foreignKeys[0]`) and the expanded `mutator`.',
  '   Every response (including `dryRun`) carries `diagnostics`: full model validation errors plus static compatibility errors / warnings against the lowest cached target environment version. They never block the write, but fix them before asking a human to publish.',
  '4. Inspect mutator signatures with `list_mutators`, export DDL with `get_ddl`, and preview up/down migration SQL with `preview_migration`.',
  '5. Validate migrations against a shadow database using `verify_migration` (requires `verify` scope).',
  'Note: Publishing versions and executing migrations against target databases are intentionally reserved for humans in the Dowel UI.',
].join('\n');

const toJsonSchema = (schema: z.ZodType): Tool['inputSchema'] => {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return { ...json, type: 'object' } as Tool['inputSchema'];
};

const toolError = (
  code: McpToolErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): CallToolResult => {
  const safe = scrubSecrets(message);
  return {
    isError: true,
    content: [{ type: 'text', text: safe }],
    structuredContent: { code, message: safe, ...extra },
  };
};

const toolOk = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const sanitizeUnknown = (value: unknown): unknown => {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeUnknown(v);
    return out;
  }
  return value;
};

interface ResolvedProject {
  row: ProjectRow;
  role: Role;
  path: string;
}

/** 按项目 ID 或 `owner/project`（含历史重定向）解析项目，并严格按白名单 ∩ 当前角色鉴权 */
const resolveMcpProject = async (
  ctx: AppContext,
  principal: McpPrincipal,
  ref: string,
  action: Action | null,
): Promise<
  | { ok: true; project: ResolvedProject }
  | { ok: false; code: 'project_not_found' | 'forbidden'; message: string }
> => {
  const { db } = ctx;
  let row: ProjectRow | null = null;
  const slash = ref.indexOf('/');
  if (slash > 0 && slash < ref.length - 1 && ref.indexOf('/', slash + 1) === -1) {
    const owner = ref.slice(0, slash);
    const slug = ref.slice(slash + 1);
    const group = await groupBySlug(db, owner);
    if (group) {
      row = (await projectRows(db, { groupId: group.id })).find((x) => x.slug === slug) ?? null;
    }
    if (!row) {
      const [redirect] = await db.query<{ projectId: string }>(
        'select project_id as "projectId" from project_redirects where owner_slug = $1 and project_slug = $2',
        [owner, slug],
      );
      if (redirect) row = await projectRow(db, redirect.projectId);
    }
  } else {
    row = await projectRow(db, ref);
  }

  if (!row) {
    return { ok: false, code: 'project_not_found', message: `项目不存在或无权访问：${ref}` };
  }
  if (principal.projectIds !== null && !principal.projectIds.includes(row.id)) {
    return { ok: false, code: 'project_not_found', message: `项目不存在或无权访问：${ref}` };
  }

  const role = await effectiveProjectRole(db, principal.user, row.id);
  if (!role) {
    return { ok: false, code: 'project_not_found', message: `项目不存在或无权访问：${ref}` };
  }

  if (action && !can(userActor(principal.user), action, { kind: 'project', role })) {
    return {
      ok: false,
      code: 'forbidden',
      message: `你在该项目中的当前角色（${role}）无权执行此操作（${action}）`,
    };
  }

  return {
    ok: true,
    project: { row, role, path: `${row.groupSlug}/${row.slug}` },
  };
};

const verOf = (versions: Versions, id: string): number => {
  const v = versions[id];
  return typeof v === 'number' ? v : 0;
};

const withVer = <T extends Obj>(obj: T, versions: Versions): T & { ver: number } => ({
  ...obj,
  ver: verOf(versions, obj.id),
});

const listVisibleAllowlistedProjects = async (
  ctx: AppContext,
  principal: McpPrincipal,
  groupFilter?: string,
) => {
  const { db } = ctx;
  const rc = await loadRoleContext(db, principal.user);
  const allVisible = await visibleProjects(db, rc);
  const allowSet = principal.projectIds === null ? null : new Set(principal.projectIds);
  const filtered = allVisible.filter((p) => {
    if (allowSet && !allowSet.has(p.id)) return false;
    if (groupFilter && p.group.slug !== groupFilter && p.group.id !== groupFilter) return false;
    return true;
  });

  const latestMap = new Map<string, { id: string; number: number; name: string }>();
  if (filtered.length > 0) {
    const pids = filtered.map((p) => p.id);
    const vRows = await db.query<{ projectId: string; id: string; number: number; name: string }>(
      `select project_id as "projectId", id, number, name
         from versions
        where project_id in (${inList(pids)})
          and retired_at is null
        order by number desc`,
      pids,
    );
    for (const v of vRows) {
      if (!latestMap.has(v.projectId)) {
        latestMap.set(v.projectId, { id: v.id, number: v.number, name: v.name });
      }
    }
  }

  return filtered.map((p) => ({
    id: p.id,
    path: `${p.group.slug}/${p.slug}`,
    name: p.name,
    dialect: p.dialect,
    role: p.role,
    latestVersion: latestMap.get(p.id) ?? null,
  }));
};

const summarizeOrReadModel = async (
  ctx: AppContext,
  project: ResolvedProject,
  opts: { schema?: string; detail: 'summary' | 'full' },
) => {
  await ctx.refresher.flush(project.row.branch);
  const { model, versions, seq } = await ctx.rooms.state(project.row.branch);
  const schemasAll = all(model, 'schema');
  const schemaById = new Map(schemasAll.map((s) => [s.id, s]));

  let schemaIdFilter: string | null = null;
  let schemaFilterMissing = false;
  if (opts.schema !== undefined) {
    const matchSchema = schemasAll.find((s) => s.id === opts.schema || s.name === opts.schema);
    if (!matchSchema) schemaFilterMissing = true;
    else schemaIdFilter = matchSchema.id;
  }

  if (schemaFilterMissing) {
    return {
      project: { id: project.row.id, path: project.path, name: project.row.name },
      seq,
      dialect: model.dialect,
      detail: opts.detail,
      truncated: false,
      counts: {
        schemas: 0,
        tables: 0,
        columns: 0,
        constraints: 0,
        indexes: 0,
        enums: 0,
        sequences: 0,
        extensions: 0,
        opaques: 0,
      },
      schemas: [],
      tables: [],
      enums: [],
      sequences: [],
      extensions: [],
      opaques: [],
      ...(opts.detail === 'full' ? { objects: {} } : {}),
    };
  }

  const schemas = schemaIdFilter ? schemasAll.filter((s) => s.id === schemaIdFilter) : schemasAll;
  const tables = all(model, 'table').filter((t) => !schemaIdFilter || t.parent === schemaIdFilter);
  const tableIds = new Set(tables.map((t) => t.id));
  const columns = all(model, 'column').filter((c) => tableIds.has(c.parent));
  const pks = all(model, 'primaryKey').filter((k) => tableIds.has(k.parent));
  const uniques = all(model, 'unique').filter((u) => tableIds.has(u.parent));
  const checks = all(model, 'check').filter((c) => tableIds.has(c.parent));
  const fks = all(model, 'foreignKey').filter((f) => tableIds.has(f.parent));
  const indexes = all(model, 'index').filter((i) => tableIds.has(i.parent));
  const enums = all(model, 'enum').filter((e) => !schemaIdFilter || e.parent === schemaIdFilter);
  const sequences = all(model, 'sequence').filter((s) => !schemaIdFilter || s.parent === schemaIdFilter);
  const extensions = schemaIdFilter ? [] : all(model, 'extension');
  const opaques = all(model, 'opaque').filter((o) => !schemaIdFilter || o.parent === schemaIdFilter);

  const counts = {
    schemas: schemas.length,
    tables: tables.length,
    columns: columns.length,
    constraints: pks.length + uniques.length + checks.length + fks.length,
    indexes: indexes.length,
    enums: enums.length,
    sequences: sequences.length,
    extensions: extensions.length,
    opaques: opaques.length,
  };

  const schemaName = (id: string) => schemaById.get(id)?.name ?? id;
  const columnCountByTable = new Map<string, number>();
  for (const c of columns) columnCountByTable.set(c.parent, (columnCountByTable.get(c.parent) ?? 0) + 1);
  const constraintCountByTable = new Map<string, number>();
  for (const k of [...pks, ...uniques, ...checks, ...fks]) {
    constraintCountByTable.set(k.parent, (constraintCountByTable.get(k.parent) ?? 0) + 1);
  }
  const indexCountByTable = new Map<string, number>();
  for (const ix of indexes) indexCountByTable.set(ix.parent, (indexCountByTable.get(ix.parent) ?? 0) + 1);

  const tableSummaries = tables.map((t) => ({
    id: t.id,
    schemaId: t.parent,
    schema: schemaName(t.parent),
    name: t.name,
    ver: versions[t.id] ?? 0,
    columnCount: columnCountByTable.get(t.id) ?? 0,
    constraintCount: constraintCountByTable.get(t.id) ?? 0,
    indexCount: indexCountByTable.get(t.id) ?? 0,
    partitionBy: t.partitionBy,
    partitionOf: t.partitionOf,
  }));

  if (opts.detail === 'full') {
    if (!schemaIdFilter && tables.length > MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA) {
      return {
        project: { id: project.row.id, path: project.path, name: project.row.name },
        seq,
        dialect: model.dialect,
        detail: 'full' as const,
        truncated: true,
        totalTables: tables.length,
        maxTablesWithoutSchemaFilter: MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA,
        message: `模型包含 ${tables.length} 张表（超过 ${MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA} 上限）；请传入 schema 过滤全量对象，或使用 get_table 查看单表详情。`,
        counts,
        schemas: schemas.map((s) => ({ id: s.id, name: s.name, ver: versions[s.id] ?? 0 })),
        tables: tableSummaries.slice(0, MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA),
      };
    }

    const objects: Record<string, Obj & { ver: number }> = {};
    for (const obj of [
      ...schemas,
      ...tables,
      ...columns,
      ...pks,
      ...uniques,
      ...checks,
      ...fks,
      ...indexes,
      ...enums,
      ...sequences,
      ...extensions,
      ...opaques,
    ]) {
      objects[obj.id] = withVer(obj, versions);
    }

    return {
      project: { id: project.row.id, path: project.path, name: project.row.name },
      seq,
      dialect: model.dialect,
      detail: 'full' as const,
      truncated: false,
      counts,
      objects,
    };
  }

  return {
    project: { id: project.row.id, path: project.path, name: project.row.name },
    seq,
    dialect: model.dialect,
    detail: 'summary' as const,
    counts,
    schemas: schemas.map((s) => ({ id: s.id, name: s.name, ver: versions[s.id] ?? 0 })),
    tables: tableSummaries,
    enums: enums.map((e) => ({
      id: e.id,
      schemaId: e.parent,
      schema: schemaName(e.parent),
      name: e.name,
      ver: versions[e.id] ?? 0,
      valueCount: e.values.length,
    })),
    sequences: sequences.map((s) => ({
      id: s.id,
      schemaId: s.parent,
      schema: schemaName(s.parent),
      name: s.name,
      ver: versions[s.id] ?? 0,
    })),
    extensions: extensions.map((x) => ({ id: x.id, name: x.name, ver: versions[x.id] ?? 0 })),
    opaques: opaques.map((o) => ({
      id: o.id,
      schemaId: o.parent,
      schema: schemaName(o.parent),
      name: o.name,
      objType: o.objType,
      ver: verOf(versions, o.id),
    })),
  };
};

interface CachedEnvQueryRow {
  id: string;
  name: string;
  production: boolean;
  current_version_id: string | null;
  last_drift_check: unknown;
  drift_status: 'unknown' | 'in_sync' | 'drifted' | 'error';
  drift_summary: unknown;
  engine_version: string | null;
  engine_version_num: number | null;
  created_at: unknown;
}

/** 仅从平台库读取环境缓存状态，绝不查 url_enc / shadow_url_enc，也绝不连接目标库 */
const readCachedEnvironments = async (ctx: AppContext, pid: string) => {
  const { db } = ctx;
  const rows = await db.query<CachedEnvQueryRow>(
    `select id, name, production, current_version_id, last_drift_check, drift_status,
            drift_summary, engine_version, engine_version_num, created_at
       from environments
      where project_id = $1
      order by created_at`,
    [pid],
  );
  const refs = await loadVersionRefs(db, pid);
  const curVersionIds = [
    ...new Set(rows.map((r) => r.current_version_id).filter((id): id is string => id !== null)),
  ];
  const executedAtByVid = new Map<string, string | null>();
  if (curVersionIds.length > 0) {
    const vExecRows = await db.query<{ id: string; executed_at: unknown }>(
      `select id, executed_at from versions where id in (${inList(curVersionIds)})`,
      curVersionIds,
    );
    for (const r of vExecRows) executedAtByVid.set(r.id, iso(r.executed_at));
  }

  return {
    source: 'platform_cache' as const,
    environments: rows.map((r) => {
      const refRow = r.current_version_id ? refs.get(r.current_version_id) : undefined;
      return {
        id: r.id,
        name: r.name,
        production: r.production,
        currentVersion: refRow ? versionRef(refRow) : null,
        currentVersionExecutedAt: r.current_version_id
          ? (executedAtByVid.get(r.current_version_id) ?? null)
          : null,
        drift: {
          status: r.drift_status,
          checkedAt: iso(r.last_drift_check),
          summary: sanitizeSummary(r.drift_summary as Parameters<typeof sanitizeSummary>[0]),
        },
        lastDriftCheck: iso(r.last_drift_check),
        engineVersion: r.engine_version ?? null,
        engineVersionNum: r.engine_version_num ?? null,
        createdAt: iso(r.created_at),
      };
    }),
  };
};

/** apply_changes 的写后静态自检：只读平台库缓存的环境数值版本（绝不连目标库）；计算失败时返回 diagnostics: null + diagnosticsError */
const computeDiagnostics = async (
  ctx: AppContext,
  projectId: string,
  model: Model,
): Promise<{ diagnostics: McpDiagnostics | null; diagnosticsError?: string }> => {
  try {
    const rows = await ctx.db.query<{ engine_version_num: number | string | null }>(
      'select engine_version_num from environments where project_id = $1',
      [projectId],
    );
    const nums = rows.map((r) => (r.engine_version_num === null ? null : Number(r.engine_version_num)));
    return { diagnostics: sanitizeUnknown(diagnoseModel(model, nums)) as McpDiagnostics };
  } catch (e) {
    return {
      diagnostics: null,
      diagnosticsError: scrubSecrets(e instanceof Error ? e.message : String(e)),
    };
  }
};

const PRIMITIVE_MUTATOR_DESCRIPTION =
  'Primitive schema mutator (one atomic edit; existing objects are addressed strictly by object ID).';

/**
 * apply_changes 可用的操作目录：复合宏（defineTable / alterColumn）排在最前，随后是普通 mutator；
 * paste / batch 一律隐藏（ADR 0015 第 2、3 节）。list_mutators 与 dowel://mutators 共用。
 */
const listMutatorCatalog = (names?: string[]) => {
  const registry = mutators as Record<string, { args: z.ZodType }>;
  const macroRegistry = macros as Record<string, { args: z.ZodType; description: string }>;
  const targetNames = names?.length
    ? names
    : [
        ...Object.keys(macroRegistry),
        ...Object.keys(registry).filter((n) => !MCP_DISALLOWED_MUTATORS.has(n)),
      ];
  const items: {
    name: string;
    kind: 'macro' | 'mutator';
    description: string;
    argsSchema: Record<string, unknown>;
  }[] = [];
  const unknown: string[] = [];
  for (const name of targetNames) {
    if (Object.hasOwn(macroRegistry, name)) {
      const m = macroRegistry[name]!;
      items.push({ name, kind: 'macro', description: m.description, argsSchema: toJsonSchema(m.args) });
      continue;
    }
    const entry =
      !MCP_DISALLOWED_MUTATORS.has(name) && Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (!entry) {
      unknown.push(name);
      continue;
    }
    items.push({
      name,
      kind: 'mutator',
      description: PRIMITIVE_MUTATOR_DESCRIPTION,
      argsSchema: toJsonSchema(entry.args),
    });
  }
  return { mutators: items, ...(unknown.length ? { unknown } : {}) };
};

interface ToolSpec<S extends z.ZodType> {
  name: McpToolName;
  description: string;
  schema: S;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run: (args: z.infer<S>) => Promise<CallToolResult>;
}

const varStr = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

/** 为单次 MCP HTTP 请求构造绑定到指定令牌主体的无状态 McpServer */
export const createMcpServer = (
  ctx: AppContext,
  principal: McpPrincipal,
  honoCtx: Context<Env>,
): McpServer => {
  const server = new McpServer({ name: 'dowel', version: pkg.version }, { instructions: MCP_INSTRUCTIONS });

  const registeredSpecs = new Map<string, ToolSpec<z.ZodType>>();
  const addTool = <S extends z.ZodType>(spec: ToolSpec<S>) => {
    registeredSpecs.set(spec.name, spec as unknown as ToolSpec<z.ZodType>);
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: fromJsonSchema(toJsonSchema(spec.schema) as JsonSchemaType),
        annotations: spec.annotations,
      },
      async (parsedArgs: unknown) => spec.run(parsedArgs as z.infer<S>),
    );
  };

  addTool({
    name: 'list_projects',
    description: 'List visible projects permitted by this token (optionally filtered by group slug or id).',
    schema: z.object({
      group: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) =>
      toolOk({ projects: await listVisibleAllowlistedProjects(ctx, principal, args.group) }),
  });

  addTool({
    name: 'get_model',
    description:
      'Read working-trunk model (`seq`, `dialect`, and summary or full objects with per-object `ver`). For >200 tables in `detail="full"`, pass `schema` filter.',
    schema: z.object({
      project: z.string().min(1),
      schema: z.string().min(1).optional(),
      detail: z.enum(['summary', 'full']).default('summary'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_model.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      return toolOk(
        await summarizeOrReadModel(ctx, resolved.project, { schema: args.schema, detail: args.detail }),
      );
    },
  });

  addTool({
    name: 'get_table',
    description:
      'Inspect a single table (by id, `schema.name`, or unique `name`) with columns, constraints, indexes, partitions, IDs, `ver`, and working `seq`.',
    schema: z.object({
      project: z.string().min(1),
      table: z.string().min(1),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_table.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      await ctx.refresher.flush(row.branch);
      const { model, versions, seq } = await ctx.rooms.state(row.branch);

      const schemas = all(model, 'schema');
      const tables = all(model, 'table');
      let matched: Table | undefined;
      const byId = model.objects[args.table];
      if (byId?.kind === 'table') matched = byId;

      if (!matched) {
        const dot = args.table.indexOf('.');
        if (dot > 0 && dot < args.table.length - 1) {
          const schemaName = args.table.slice(0, dot);
          const tableName = args.table.slice(dot + 1);
          const s = schemas.find((item) => item.name === schemaName);
          if (s) matched = tables.find((t) => t.parent === s.id && t.name === tableName);
        }
      }
      if (!matched) {
        const byName = tables.filter((t) => t.name === args.table);
        if (byName.length === 1) {
          matched = byName[0];
        } else if (byName.length > 1) {
          const schemaMap = new Map(schemas.map((s) => [s.id, s.name]));
          const candidates = byName.map((t) => `${schemaMap.get(t.parent) ?? t.parent}.${t.name}`);
          return toolError(
            'invalid_arguments',
            `表名 ${args.table} 在多个 schema 中重名，请指定 schema.name：${candidates.join(', ')}`,
          );
        }
      }
      if (!matched) {
        return toolError('table_not_found', `表不存在：${args.table}`);
      }

      const parentSchema = model.objects[matched.parent];
      const pks: PrimaryKey[] = childrenOf(model, matched.id, 'primaryKey');
      const uniques: Unique[] = childrenOf(model, matched.id, 'unique');
      const checks: Check[] = childrenOf(model, matched.id, 'check');
      const fks: ForeignKey[] = childrenOf(model, matched.id, 'foreignKey');
      const indexes: Index[] = childrenOf(model, matched.id, 'index');
      const columns: Column[] = columnsOf(model, matched.id);
      const partitions = tables.filter((t) => t.partitionOf?.parent === matched.id);

      return toolOk({
        seq,
        dialect: model.dialect,
        schema:
          parentSchema?.kind === 'schema'
            ? { id: parentSchema.id, name: parentSchema.name, ver: versions[parentSchema.id] ?? 0 }
            : null,
        table: withVer(matched, versions),
        columns: columns.map((c) => withVer(c, versions)),
        primaryKey: pks[0] ? withVer(pks[0], versions) : null,
        uniques: uniques.map((u) => withVer(u, versions)),
        checks: checks.map((c) => withVer(c, versions)),
        foreignKeys: fks.map((f) => withVer(f, versions)),
        indexes: indexes.map((ix) => withVer(ix, versions)),
        partitions: partitions.map((p) => withVer(p, versions)),
      });
    },
  });

  addTool({
    name: 'get_ddl',
    description:
      "Generate full DDL SQL for the project's working `head`, `latest` version, `vN`, or version ID.",
    schema: z.object({
      project: z.string().min(1),
      version: z.string().min(1).default('head'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_ddl.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      const modelRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.version,
        defaultRef: 'head',
      });
      if (!modelRef.ok) return toolError(modelRef.code, modelRef.message);
      const sql = await buildDdlSql(ctx.db, {
        pid: row.id,
        dialect: modelRef.model.dialect,
        model: modelRef.model,
      });
      return toolOk({ version: modelRef.label, dialect: modelRef.model.dialect, sql });
    },
  });

  addTool({
    name: 'list_versions',
    description: 'List published immutable schema versions for a project (newest first).',
    schema: z.object({
      project: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.list_versions.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const versions = await listProjectVersions(ctx.db, resolved.project.row.id, args.limit);
      return toolOk({ versions });
    },
  });

  addTool({
    name: 'get_version',
    description:
      'Read a published version detail (frozen up/down steps, checksum, verified status) by ID, `vN`, or `latest`.',
    schema: z.object({
      project: z.string().min(1),
      version: z.string().min(1),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_version.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      const v = await findVersion(ctx.db, row.id, args.version);
      if (!v) return toolError('version_not_found', `版本不存在：${args.version}`);
      return toolOk({ version: await versionDetailOf(ctx.db, row.id, v) });
    },
  });

  addTool({
    name: 'preview_migration',
    description:
      'Plan migration up/down SQL and warnings between two states (`from` defaults to `latest` or `empty` if none; `to` defaults to `head`).',
    schema: z.object({
      project: z.string().min(1),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(
        ctx,
        principal,
        args.project,
        MCP_TOOLS.preview_migration.action,
      );
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      const toRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.to,
        defaultRef: 'head',
      });
      if (!toRef.ok) return toolError(toRef.code, toRef.message);

      const fromRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.from,
        like: toRef.model,
        defaultRef: 'latest_or_empty',
      });
      if (!fromRef.ok) return toolError(fromRef.code, fromRef.message);

      const preview = await buildMigrationPreview(ctx.db, {
        pid: row.id,
        dialect: toRef.model.dialect,
        from: fromRef.model,
        to: toRef.model,
      });
      return toolOk({
        from: fromRef.label,
        to: toRef.label,
        dialect: toRef.model.dialect,
        upSql: preview.upSql,
        downSql: preview.downSql,
        upSteps: preview.up,
        downSteps: preview.down,
        warnings: preview.warnings,
      });
    },
  });

  addTool({
    name: 'list_environments',
    description:
      'List project environments from platform cache only (`source: "platform_cache"`, includes cache timestamps; never connects to target databases or exposes URLs).',
    schema: z.object({
      project: z.string().min(1),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(
        ctx,
        principal,
        args.project,
        MCP_TOOLS.list_environments.action,
      );
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      return toolOk(await readCachedEnvironments(ctx, resolved.project.row.id));
    },
  });

  addTool({
    name: 'list_mutators',
    description:
      'List the operations accepted by `apply_changes`: compile-time macros first (`kind: "macro"`: `defineTable`, `alterColumn`), then primitive mutators (`kind: "mutator"`), each with a description and JSON Schema arguments.',
    schema: z.object({
      names: z.array(z.string().min(1)).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => toolOk(listMutatorCatalog(args.names)),
  });

  addTool({
    name: 'verify_migration',
    description:
      'Verify planned migration between `from` and `to` using a shadow database (rate-limited per user, never touches target DBs; requires `verify` scope).',
    schema: z.object({
      project: z.string().min(1),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      env: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(
        ctx,
        principal,
        args.project,
        MCP_TOOLS.verify_migration.action,
      );
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;

      const toRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.to,
        defaultRef: 'head',
      });
      if (!toRef.ok) return toolError(toRef.code, toRef.message);

      const fromRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.from,
        like: toRef.model,
        defaultRef: 'latest_or_empty',
      });
      if (!fromRef.ok) return toolError(fromRef.code, fromRef.message);

      let resolvedEnvId: string | undefined;
      let resolvedEnvName: string | undefined;
      if (args.env !== undefined) {
        const [envRow] = await ctx.db.query<{ id: string; name: string }>(
          'select id, name from environments where project_id = $1 and (id = $2 or name = $2)',
          [row.id, args.env],
        );
        if (!envRow) return toolError('environment_not_found', `环境不存在：${args.env}`);
        resolvedEnvId = envRow.id;
        resolvedEnvName = envRow.name;
      }

      const needsExternalShadow = getDialect(toRef.model.dialect).capabilities.requiresExternalShadow;
      const gate = needsExternalShadow ? ctx.connectionLimiter.attempt(principal.user.id) : null;
      if (gate && !gate.allowed) {
        return toolError('rate_limited', `影子库验证请求太频繁，请在 ${gate.retryAfterSeconds} 秒后重试`);
      }

      const planOpts = await projectPlanOptions(ctx.db, row.id, toRef.model.dialect);
      let shadowHandle: Awaited<ReturnType<typeof ctx.shadows.forProject>>;
      try {
        shadowHandle = await ctx.shadows.forProject(row.id, resolvedEnvId);
      } catch (e) {
        if (e instanceof ShadowError) {
          if (e.preConnect && gate?.allowed) gate.refund();
          await audit(
            ctx.db,
            honoCtx,
            {
              action: 'model.verify',
              actorKind: 'user',
              actorId: principal.user.id,
              targetKind: 'project',
              targetId: row.id,
              projectId: row.id,
              data: {
                via: 'mcp',
                mcpToken: { id: principal.tokenId, name: principal.tokenName, prefix: principal.prefix },
                projectId: row.id,
                from: fromRef.label,
                to: toRef.label,
                env: resolvedEnvName ?? null,
                ok: false,
                shadow: null,
              },
            },
            ctx.security,
          );
          return toolError('shadow_unavailable', e.message);
        }
        throw e;
      }

      try {
        const report = await shadowHandle.shadow.verify(fromRef.model, toRef.model, planOpts);
        await audit(
          ctx.db,
          honoCtx,
          {
            action: 'model.verify',
            actorKind: 'user',
            actorId: principal.user.id,
            targetKind: 'project',
            targetId: row.id,
            projectId: row.id,
            data: {
              via: 'mcp',
              mcpToken: { id: principal.tokenId, name: principal.tokenName, prefix: principal.prefix },
              projectId: row.id,
              from: fromRef.label,
              to: toRef.label,
              env: resolvedEnvName ?? null,
              ok: report.ok,
              shadow: shadowHandle.label,
            },
          },
          ctx.security,
        );
        return toolOk({
          ok: report.ok,
          shadow: shadowHandle.label,
          from: fromRef.label,
          to: toRef.label,
          report: sanitizeUnknown(report),
        });
      } catch (e) {
        if (e instanceof ShadowError) {
          await audit(
            ctx.db,
            honoCtx,
            {
              action: 'model.verify',
              actorKind: 'user',
              actorId: principal.user.id,
              targetKind: 'project',
              targetId: row.id,
              projectId: row.id,
              data: {
                via: 'mcp',
                mcpToken: { id: principal.tokenId, name: principal.tokenName, prefix: principal.prefix },
                projectId: row.id,
                from: fromRef.label,
                to: toRef.label,
                env: resolvedEnvName ?? null,
                ok: false,
                shadow: shadowHandle.label,
              },
            },
            ctx.security,
          );
          return toolError('shadow_unavailable', e.message);
        }
        throw e;
      }
    },
  });

  addTool({
    name: 'apply_changes',
    description:
      'Atomically validate and apply 1..100 ops to the working trunk based on `baseSeq`, committed as ONE canvas-history entry (single `seq`, `opCount` = expanded primitive sub-ops, at most 500). Ops are primitive mutators or the compile-time macros `defineTable` (whole table in one op; may use its own column names and resolve new references by qualified name) and `alterColumn` (declarative patch of an existing column). Edits and drops address existing objects strictly by object ID (or a `$ref:<alias>` created earlier in the same call), never by name; for circular FKs, define the tables first and add the remaining FKs with `addForeignKey`. Use `$ref:<alias>` in primitive args for new UUIDv7 IDs; `refs` maps each `alias` to its generated ID. Optional `summary` (<= 500 chars) records the intent in canvas history and audit. Set `dryRun: true` to simulate without committing. Errors carry the input `index` and, for macros, `path` (e.g. `defineTable(orders).foreignKeys[0]`) and the expanded `mutator`. Responses include `diagnostics` (validation + static target-version compatibility; never blocks the write) and `noop: true` when nothing changed.',
    schema: z.object({
      project: z.string().min(1),
      baseSeq: z.number().int().min(0),
      ops: z
        .array(
          z.object({
            name: z.string().min(1),
            args: z.unknown(),
          }),
        )
        .min(1)
        .max(MCP_MAX_OPS),
      summary: z.string().trim().min(1).max(MCP_SUMMARY_MAX).optional(),
      dryRun: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.apply_changes.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      const summary = args.summary ? scrubSecrets(args.summary).trim() || undefined : undefined;

      const res = await ctx.rooms.applyMcpOps(row.branch, {
        userId: principal.user.id,
        tokenId: principal.tokenId,
        user: principal.user.name,
        baseSeq: args.baseSeq,
        dryRun: args.dryRun,
        ops: args.ops,
        ...(summary ? { summary } : {}),
        onBeforeCommit: async (tx, info) => {
          await auditIn(
            tx,
            honoCtx,
            {
              action: 'model.mutate',
              actorKind: 'user',
              actorId: principal.user.id,
              targetKind: 'project',
              targetId: row.id,
              projectId: row.id,
              data: {
                via: 'mcp',
                mcpToken: { id: principal.tokenId, name: principal.tokenName, prefix: principal.prefix },
                projectId: row.id,
                seq: info.seq,
                opCount: info.opCount,
                ops: args.ops.map((o) => o.name),
                ...(summary ? { summary } : {}),
              },
            },
            ctx.security,
          );
        },
      });

      if (!res.ok) {
        const location: McpApplyErrorLocation = {
          ...(res.index !== undefined ? { index: res.index } : {}),
          ...(res.path !== undefined ? { path: res.path } : {}),
          ...(res.mutator !== undefined ? { mutator: res.mutator } : {}),
        };
        return toolError(res.code, res.message, { ...location, currentSeq: res.currentSeq });
      }

      // 写后静态自检在房间锁释放之后计算（#17），只读平台库缓存的环境版本，绝不连目标库；
      // 已提交的写入绝不因诊断失败而报错
      const diag = await computeDiagnostics(ctx, row.id, res.model);

      return toolOk({
        dryRun: res.dryRun,
        seq: res.seq,
        opCount: res.opCount,
        refs: res.refs,
        changed: res.changed,
        ...diag,
        ...(res.noop ? { noop: true } : {}),
      });
    },
  });

  // 覆写 tools/list 与 tools/call：按令牌 scope 过滤可见列表，并对缺少 scope / 校验失败返回结构化 toolError
  server.server.setRequestHandler('tools/list', () => ({
    tools: [...registeredSpecs.values()]
      .filter((spec) => principal.scopes.has(MCP_TOOLS[spec.name].scope))
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: toJsonSchema(spec.schema),
        annotations: spec.annotations,
      })),
  }));

  server.server.setRequestHandler('tools/call', async (request) => {
    const toolName = request.params.name;
    const spec = registeredSpecs.get(toolName);
    if (!spec) {
      return server.server.projectCallToolResult(
        toolError('invalid_arguments', `未知工具：${toolName}`),
        undefined,
      );
    }
    const neededScope = MCP_TOOLS[spec.name].scope;
    if (!principal.scopes.has(neededScope)) {
      return server.server.projectCallToolResult(
        toolError('scope_required', `当前 MCP 令牌缺少所需权限范围：${neededScope}`),
        undefined,
      );
    }
    const parsed = spec.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return server.server.projectCallToolResult(
        toolError('invalid_arguments', msg || '参数校验失败'),
        undefined,
      );
    }
    try {
      const result = await spec.run(parsed.data);
      return server.server.projectCallToolResult(result, undefined);
    } catch (e) {
      if (e instanceof PlanError) {
        return server.server.projectCallToolResult(toolError('invalid', e.message), undefined);
      }
      if (e instanceof ShadowError) {
        return server.server.projectCallToolResult(toolError('shadow_unavailable', e.message), undefined);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return server.server.projectCallToolResult(toolError('internal', msg), undefined);
    }
  });

  // ───── MCP Resources（全部受 read scope 与相同项目权限制约） ─────

  const resolveProjectOrThrow = async (owner: string, project: string, action: Action) => {
    const resolved = await resolveMcpProject(ctx, principal, `${owner}/${project}`, action);
    if (!resolved.ok) {
      if (resolved.code === 'project_not_found') {
        throw new ResourceNotFoundError(scrubSecrets(resolved.message));
      }
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, scrubSecrets(resolved.message));
    }
    return resolved.project;
  };

  server.registerResource(
    'projects',
    'dowel://projects',
    { title: 'Visible Dowel Projects', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify({ projects: await listVisibleAllowlistedProjects(ctx, principal) }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'mutators',
    'dowel://mutators',
    { title: 'Supported Schema Mutators', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(listMutatorCatalog(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'project-model',
    new ResourceTemplate('dowel://projects/{owner}/{project}/model', { list: undefined }),
    { title: 'Project Working Model Summary', mimeType: 'application/json' },
    async (uri, variables) => {
      const p = await resolveProjectOrThrow(
        varStr(variables.owner),
        varStr(variables.project),
        'project.read',
      );
      const data = await summarizeOrReadModel(ctx, p, { detail: 'summary' });
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'project-ddl',
    new ResourceTemplate('dowel://projects/{owner}/{project}/ddl', { list: undefined }),
    { title: 'Project Head DDL', mimeType: 'application/sql' },
    async (uri, variables) => {
      const p = await resolveProjectOrThrow(varStr(variables.owner), varStr(variables.project), 'ddl.read');
      const modelRef = await resolveModelRef(ctx.db, ctx.rooms, ctx.refresher, {
        pid: p.row.id,
        branch: p.row.branch,
        schemas: p.row.schemas,
        ref: 'head',
        defaultRef: 'head',
      });
      if (!modelRef.ok) throw new ResourceNotFoundError(scrubSecrets(modelRef.message));
      const sql = await buildDdlSql(ctx.db, {
        pid: p.row.id,
        dialect: modelRef.model.dialect,
        model: modelRef.model,
      });
      return {
        contents: [{ uri: uri.toString(), mimeType: 'application/sql', text: sql }],
      };
    },
  );

  server.registerResource(
    'project-versions',
    new ResourceTemplate('dowel://projects/{owner}/{project}/versions', { list: undefined }),
    { title: 'Project Versions', mimeType: 'application/json' },
    async (uri, variables) => {
      const p = await resolveProjectOrThrow(
        varStr(variables.owner),
        varStr(variables.project),
        'project.read',
      );
      const versions = await listProjectVersions(ctx.db, p.row.id);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify({ versions }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'project-environments',
    new ResourceTemplate('dowel://projects/{owner}/{project}/environments', { list: undefined }),
    { title: 'Project Environments (Platform Cache)', mimeType: 'application/json' },
    async (uri, variables) => {
      const p = await resolveProjectOrThrow(
        varStr(variables.owner),
        varStr(variables.project),
        'environment.read',
      );
      const envs = await readCachedEnvironments(ctx, p.row.id);
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(envs, null, 2) },
        ],
      };
    },
  );

  return server;
};
