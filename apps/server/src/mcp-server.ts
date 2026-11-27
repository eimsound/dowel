import {
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  type CanvasSection,
  MAX_SECTION_ID_LENGTH,
  MCP_HISTORY_DIFF_MAX_ITEMS,
  MCP_HISTORY_MAX_LIMIT,
  MCP_HISTORY_OBJECTS_MAX_ITEMS,
  MCP_HISTORY_OP_SUMMARY_MAX_CHARS,
  MCP_HISTORY_SQL_MAX_CHARS,
  MCP_MAX_OPS,
  MCP_OBJECTS_DDL_BUDGET,
  MCP_SUMMARY_MAX,
  MCP_TOOLS,
  type McpApplyErrorLocation,
  type McpDiagnostics,
  mcpManageSectionsInputSchema,
  type McpToolErrorCode,
  type McpToolName,
  resolveSectionActions,
  type Role,
} from '@dowel/api';
import {
  all,
  type Check,
  childrenOf,
  type Column,
  columnsOf,
  deepEqual,
  describeTarget,
  diagnoseModel,
  type Enum,
  type Extension,
  type ForeignKey,
  getDialect,
  type Index,
  macros,
  type Model,
  mutators,
  newId,
  type Obj,
  type Opaque,
  OpaqueType,
  PlanError,
  type PrimaryKey,
  type Sequence,
  type Table,
  type Unique,
} from '@dowel/core';
import { planDiff } from '@dowel/executor';
import type { Versions } from '@dowel/sync';
// Dowel MCP 服务端实现（M3-C，ADR 0014）：基于 @modelcontextprotocol/server 的无状态 McpServer。
// - 每个请求按当前 `McpPrincipal` 构建独立的 McpServer：实时生效项目权限 ∩ 令牌 scope ∩ 可选项目白名单。
// - tools/list 仅暴露令牌 scope 允许的工具；tools/call 对越权或缺少 scope 的调用返回结构化 tool error（isError: true）。
// - prompts/list 只列令牌 scope 允许的 Prompt（见 mcp-prompts.ts）；永不注册恢复历史 / 发布版本 / 执行迁移类工具（ADR 0015 第 6 节）。
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
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import pkg from '../package.json' with { type: 'json' };
import { audit, auditIn } from './audit.ts';
import { type Action, can, userActor } from './authz.ts';
import { inList } from './db.ts';
import { iso, loadVersionRefs, projectPlanOptions, sanitizeSummary, versionRef } from './envs.ts';
import { groupBySlug } from './groups.ts';
import { registerMcpPrompts } from './mcp-prompts.ts';
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
  '2. Read the current model summary or inspect specific tables with `get_model` / `get_table`, noting `seq`. Narrow large models with `get_model` filters (`schema`, `section` — a section ID, `$none` or a unique name — and `q`); add `diagnostics: true` for validation / compatibility diagnostics. Read enums, sequences, extensions and opaque objects (views, functions, triggers, policies…) with full DDL and resolved `deps` via `get_objects`.',
  '3. Propose edits with `apply_changes` using that `baseSeq` and `$ref:<alias>` placeholders for new object IDs (`refs` returns `{ [alias]: uuid }`); run `dryRun: true` first when unsure. Each call is committed atomically as ONE canvas-history entry (one `seq`); pass a short `summary` describing the intent so humans can review and undo it as a unit.',
  '   Prefer the compile-time macros: `defineTable` creates a whole table (columns, keys, checks, indexes, FKs, comments, ext, partitions) and may refer to its own columns by name; `alterColumn` patches one existing column declaratively. Macros mix freely with primitive mutators in the same call and share the same `$ref` aliases; they expand into at most 500 primitive sub-ops per call (`opCount`).',
  '   Strict object-ID rule: editing or dropping existing objects (including `alterColumn.id`) only accepts existing object IDs or `$ref:<alias>` of objects created earlier in the same call — never names. Only reference slots may be resolved by (qualified) name: inside `defineTable` (schema, typeRef, refTable, refColumns, default.nextval, partitions[].schema) and its own columns, plus the references `typeRef` / `default.nextval` of `alterColumn`; ambiguous names are rejected. `alterColumn.ext` replaces the whole column ext (null clears it); on SQL Server an explicit default-constraint name is kept unless `ext.mssql` sets `defaultName` / `defaultNameMode`.',
  '   Circular foreign keys: create every table with `defineTable` first, then add the remaining FKs with `addForeignKey` at the end of the same call. Errors report the input `index` plus, for macros, `path` (e.g. `defineTable(orders).foreignKeys[0]`) and the expanded `mutator`.',
  '   Every response (including `dryRun`) carries `diagnostics`: full model validation errors plus static compatibility errors / warnings against the lowest cached target environment version. They never block the write, but fix them before asking a human to publish.',
  '4. Inspect mutator signatures with `list_mutators`, export DDL with `get_ddl`, and preview up/down migration SQL with `preview_migration`.',
  '5. Validate migrations against a shadow database using `verify_migration` (requires `verify` scope).',
  '6. Canvas sections are a pure layout layer (never part of the schema, migrations or versions). `get_model` lists them (`sections`, plus `sectionId` per table) together with dialect `capabilities` and the derived lowest `target` version. Adjust them incrementally with `manage_sections` (create / rename / recolor / delete / add_tables / remove_tables; `$ref:<alias>` refers to a section created earlier in the same call). Pixel positions are laid out automatically and cannot be written via MCP.',
  '7. Browse canvas history read-only with `list_history` (grouped into edit sessions by default) and inspect one entry or a whole group with `get_history_diff` (net object changes + migration-style diff). History cannot be restored via MCP.',
  '8. Prompts (`prompts/list`) offer guided workflows: `review_unpublished_changes` and `review_canvas_history` (read), plus `design_tables` and `refactor_column` (write scope only).',
  'Note: Publishing versions, executing migrations against target databases and restoring canvas history are intentionally reserved for humans in the Dowel UI.',
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

/** 只读平台库缓存的环境数值版本号（绝不读连接串、绝不连目标库或影子库） */
const readEnvVersionNums = async (ctx: AppContext, projectId: string): Promise<(number | null)[]> => {
  const rows = await ctx.db.query<{ engine_version_num: number | string | null }>(
    'select engine_version_num from environments where project_id = $1',
    [projectId],
  );
  return rows.map((r) => {
    if (r.engine_version_num === null) return null;
    const n = Number(r.engine_version_num);
    return Number.isFinite(n) ? n : null;
  });
};

/** get_model 的方言 / 目标版本上下文（ADR 0015 第 5 节）：只读平台缓存，不连目标库 */
const readTargetContext = async (ctx: AppContext, projectId: string, model: Model) => {
  const nums = await readEnvVersionNums(ctx, projectId);
  const info = describeTarget(model.dialect, nums);
  return {
    capabilities: getDialect(model.dialect).capabilities,
    target: {
      label: info?.label ?? null,
      features: info?.features ?? null,
      source: 'platform_cache' as const,
      environments: { total: nums.length, withCachedVersion: nums.filter((n) => n !== null).length },
    },
  };
};

/** 表级不透明对象（trigger / policy / exclusion）的 parent 是表 ID，其余是 schema ID；统一解析所属 schema 与表 */
export const opaqueOwner = (model: Model, o: Opaque) => {
  const parent = Object.hasOwn(model.objects, o.parent) ? model.objects[o.parent] : undefined;
  if (parent?.kind === 'table') {
    return {
      parentKind: 'table' as const,
      schemaId: parent.parent,
      tableId: parent.id as string | null,
      tableName: parent.name as string | null,
    };
  }
  return { parentKind: 'schema' as const, schemaId: o.parent, tableId: null, tableName: null };
};

/** 分区子表沿 partitionOf 链找到顶层根表（防环） */
const rootTableOf = (model: Model, table: Table): Table => {
  let cur: Table = table;
  const seen = new Set<string>();
  while (cur.partitionOf && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent: Obj | undefined = Object.hasOwn(model.objects, cur.partitionOf.parent)
      ? model.objects[cur.partitionOf.parent]
      : undefined;
    if (parent?.kind !== 'table') break;
    cur = parent;
  }
  return cur;
};

/**
 * 表 → 板块 ID：基于全模型（不受 schema / section / q 过滤影响）的存活顶层表构造，
 * 分区子表经根表继承板块（跨 schema 的分区子表同样继承）
 */
const sectionIndexOf = (model: Model, rawSections: readonly CanvasSection[]) => {
  const liveTop = new Set(
    all(model, 'table')
      .filter((t) => !t.partitionOf)
      .map((t) => t.id),
  );
  const sectionOfTop = new Map<string, string>();
  for (const sec of rawSections)
    for (const id of sec.tables) if (liveTop.has(id) && !sectionOfTop.has(id)) sectionOfTop.set(id, sec.id);
  return (table: Table): string | null => {
    const root = rootTableOf(model, table);
    return root.partitionOf ? null : (sectionOfTop.get(root.id) ?? null);
  };
};

/** get_model 的 `section` 过滤：精确板块 ID → `$none`（未分配板块的表）→ 大小写不敏感的唯一板块名 */
const resolveSectionFilter = (
  rawSections: readonly CanvasSection[],
  input: string,
):
  | { ok: true; filter: { kind: 'section'; section: CanvasSection } | { kind: 'none' } }
  | { ok: false; code: McpToolErrorCode; message: string; extra?: Record<string, unknown> } => {
  const byId = rawSections.find((s) => s.id === input);
  if (byId) return { ok: true, filter: { kind: 'section', section: byId } };
  if (input === SECTION_NONE) return { ok: true, filter: { kind: 'none' } };
  const lower = input.toLowerCase();
  const byName = rawSections.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, filter: { kind: 'section', section: byName[0]! } };
  if (byName.length > 1) {
    const candidates = byName.map((s) => s.id);
    return {
      ok: false,
      code: 'invalid_arguments',
      message: `板块名 ${input} 不唯一，请改用板块 ID：${candidates.join(', ')}`,
      extra: { candidates: byName.map((s) => ({ id: s.id, name: s.name })) },
    };
  }
  return { ok: false, code: 'section_not_found', message: `板块不存在：${input}` };
};

/** get_model 的 `section` 取值：未分配给任何板块的表 */
const SECTION_NONE = '$none';
/** get_model：表摘要里 matchedColumns 最多列多少个 */
const MAX_MATCHED_COLUMNS = 10;

type ModelReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: McpToolErrorCode; message: string; extra?: Record<string, unknown> };

const summarizeOrReadModel = async (
  ctx: AppContext,
  project: ResolvedProject,
  opts: {
    schema?: string;
    detail: 'summary' | 'full';
    q?: string;
    section?: string;
    diagnostics?: boolean;
  },
): Promise<ModelReadResult> => {
  await ctx.refresher.flush(project.row.branch);
  const { model, versions, seq, sections: rawSections } = await ctx.rooms.canvasState(project.row.branch);

  let sectionFilter: { kind: 'section'; section: CanvasSection } | { kind: 'none' } | null = null;
  if (opts.section !== undefined) {
    const r = resolveSectionFilter(rawSections, opts.section);
    if (!r.ok) return r;
    sectionFilter = r.filter;
  }

  const context = await readTargetContext(ctx, project.row.id, model);
  const diag = opts.diagnostics ? await computeDiagnostics(ctx, project.row.id, model) : {};
  const schemasAll = all(model, 'schema');
  const schemaById = new Map(schemasAll.map((s) => [s.id, s]));
  const qLower = opts.q?.toLowerCase();
  const filtered = qLower !== undefined || sectionFilter !== null;

  let schemaIdFilter: string | null = null;
  let schemaFilterMissing = false;
  if (opts.schema !== undefined) {
    const matchSchema = schemasAll.find((s) => s.id === opts.schema || s.name === opts.schema);
    if (!matchSchema) schemaFilterMissing = true;
    else schemaIdFilter = matchSchema.id;
  }
  const filterEcho = filtered
    ? {
        filter: {
          schema: schemaIdFilter,
          section: sectionFilter
            ? sectionFilter.kind === 'none'
              ? SECTION_NONE
              : sectionFilter.section.id
            : null,
          q: opts.q ?? null,
        },
      }
    : {};

  if (schemaFilterMissing) {
    return {
      ok: true,
      data: {
        project: { id: project.row.id, path: project.path, name: project.row.name },
        seq,
        dialect: model.dialect,
        ...context,
        detail: opts.detail,
        truncated: false,
        ...filterEcho,
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
        sections: [],
        ...(opts.detail === 'full' ? { objects: {} } : {}),
        ...diag,
      },
    };
  }

  const schemaName = (id: string) => schemaById.get(id)?.name ?? id;
  const sectionIdOf = sectionIndexOf(model, rawSections);
  const includes = (text: string | null | undefined) =>
    qLower !== undefined && typeof text === 'string' && text.toLowerCase().includes(qLower);

  // 1. 表：schema ∩ section ∩ q
  const schemaTables = all(model, 'table').filter((t) => !schemaIdFilter || t.parent === schemaIdFilter);
  const sectionTables = sectionFilter
    ? schemaTables.filter((t) => {
        const sid = sectionIdOf(t);
        return sectionFilter.kind === 'none' ? sid === null : sid === sectionFilter.section.id;
      })
    : schemaTables;
  const columnsByTable = new Map<string, Column[]>();
  for (const c of all(model, 'column')) {
    const list = columnsByTable.get(c.parent);
    if (list) list.push(c);
    else columnsByTable.set(c.parent, [c]);
  }
  const matchedColumnsOf = new Map<string, string[]>();
  let tables = sectionTables;
  if (qLower !== undefined) {
    const hit = new Set<string>();
    for (const t of sectionTables) {
      const cols = (columnsByTable.get(t.id) ?? []).filter((c) => includes(c.name)).map((c) => c.name);
      if (cols.length) matchedColumnsOf.set(t.id, cols.slice(0, MAX_MATCHED_COLUMNS));
      if (includes(t.name) || includes(schemaName(t.parent)) || includes(t.comment) || cols.length) {
        hit.add(t.id);
      }
    }
    // 顶层分区父表命中时连带保留它的全部分区子表（仍受 schema / section 过滤约束）
    const hitRoots = new Set(
      sectionTables.filter((t) => hit.has(t.id) && !t.partitionOf && t.partitionBy).map((t) => t.id),
    );
    if (hitRoots.size) {
      for (const t of sectionTables) {
        if (t.partitionOf && hitRoots.has(rootTableOf(model, t).id)) hit.add(t.id);
      }
    }
    tables = sectionTables.filter((t) => hit.has(t.id));
  }

  const tableIds = new Set(tables.map((t) => t.id));
  const columns = all(model, 'column').filter((c) => tableIds.has(c.parent));
  const pks = all(model, 'primaryKey').filter((k) => tableIds.has(k.parent));
  const uniques = all(model, 'unique').filter((u) => tableIds.has(u.parent));
  const checks = all(model, 'check').filter((c) => tableIds.has(c.parent));
  const fks = all(model, 'foreignKey').filter((f) => tableIds.has(f.parent));
  const indexes = all(model, 'index').filter((i) => tableIds.has(i.parent));

  // 2. schema 级对象：schema 过滤；传 section 时不返回无关对象（full 模式保留被命中表的列引用到的枚举 / 序列）
  const referencedIds = new Set<string>();
  if (opts.detail === 'full' && filtered) {
    for (const c of columns) {
      if (c.typeRef) referencedIds.add(c.typeRef);
      if (c.default && 'nextval' in c.default) referencedIds.add(c.default.nextval);
    }
    const columnIds = new Set(columns.map((c) => c.id));
    for (const s of all(model, 'sequence'))
      if (s.ownedBy && columnIds.has(s.ownedBy)) referencedIds.add(s.id);
  }
  const keepSchemaLevel = (o: Enum | Sequence | Extension): boolean => {
    if (schemaIdFilter && o.parent !== schemaIdFilter) return referencedIds.has(o.id);
    if (referencedIds.has(o.id)) return true;
    if (sectionFilter) return false;
    if (qLower !== undefined) {
      return includes(o.name) || includes(`${schemaName(o.parent)}.${o.name}`) || includes(o.comment);
    }
    return true;
  };
  const enums = all(model, 'enum').filter(keepSchemaLevel);
  const sequences = all(model, 'sequence').filter(keepSchemaLevel);
  const extensions = all(model, 'extension').filter(keepSchemaLevel);

  // 3. 不透明对象：按所属 schema（表级的按所在表的 schema）过滤；传 section 时只保留挂在命中表上的表级对象
  const opaques = all(model, 'opaque').filter((o) => {
    const owner = opaqueOwner(model, o);
    if (schemaIdFilter && owner.schemaId !== schemaIdFilter) return false;
    if (sectionFilter && !(owner.tableId !== null && tableIds.has(owner.tableId))) return false;
    if (qLower !== undefined) {
      const qualified =
        owner.tableName !== null
          ? `${schemaName(owner.schemaId)}.${owner.tableName}.${o.name}`
          : `${schemaName(owner.schemaId)}.${o.name}`;
      return includes(o.name) || includes(qualified) || includes(o.comment);
    }
    return true;
  });

  const schemas = schemaIdFilter ? schemasAll.filter((s) => s.id === schemaIdFilter) : schemasAll;

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

  const columnCountByTable = new Map<string, number>();
  for (const c of columns) columnCountByTable.set(c.parent, (columnCountByTable.get(c.parent) ?? 0) + 1);
  const constraintCountByTable = new Map<string, number>();
  for (const k of [...pks, ...uniques, ...checks, ...fks]) {
    constraintCountByTable.set(k.parent, (constraintCountByTable.get(k.parent) ?? 0) + 1);
  }
  const indexCountByTable = new Map<string, number>();
  for (const ix of indexes) indexCountByTable.set(ix.parent, (indexCountByTable.get(ix.parent) ?? 0) + 1);

  // 画布板块（纯布局层）：只保留（schema 过滤后）模型里仍存活的顶层表，消除已删表留下的孤儿 ID；
  // 传 section 时只返回该板块，`$none` 返回空列表
  const schemaTopIds = new Set(schemaTables.filter((t) => !t.partitionOf).map((t) => t.id));
  const visibleSections =
    sectionFilter === null
      ? rawSections
      : sectionFilter.kind === 'none'
        ? []
        : rawSections.filter((s) => s.id === sectionFilter.section.id);
  const liveSections: CanvasSection[] = visibleSections.map((sec) => ({
    ...sec,
    tables: sec.tables.filter((id) => schemaTopIds.has(id)),
  }));
  const sectionSummaries = liveSections.map((sec) => ({
    id: sec.id,
    name: sec.name,
    color: sec.color,
    tableCount: sec.tables.length,
  }));

  const tableSummaries = tables.map((t) => {
    const matchedColumns = matchedColumnsOf.get(t.id);
    return {
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
      sectionId: sectionIdOf(t),
      ...(matchedColumns ? { matchedColumns } : {}),
    };
  });

  const enumSummaries = enums.map((e) => ({
    id: e.id,
    schemaId: e.parent,
    schema: schemaName(e.parent),
    name: e.name,
    ver: versions[e.id] ?? 0,
    valueCount: e.values.length,
    values: e.values,
    comment: e.comment ?? null,
  }));
  const sequenceSummaries = sequences.map((s) => ({
    id: s.id,
    schemaId: s.parent,
    schema: schemaName(s.parent),
    name: s.name,
    ver: versions[s.id] ?? 0,
    nameMode: s.nameMode,
    ownedBy: s.ownedBy,
    options: s.options,
    comment: s.comment ?? null,
  }));
  const extensionSummaries = extensions.map((x) => ({
    id: x.id,
    schemaId: x.parent,
    schema: schemaName(x.parent),
    name: x.name,
    ver: versions[x.id] ?? 0,
    comment: x.comment ?? null,
  }));
  const opaqueSummaries = opaques.map((o) => {
    const owner = opaqueOwner(model, o);
    return {
      id: o.id,
      schemaId: owner.schemaId,
      schema: schemaName(owner.schemaId),
      parentKind: owner.parentKind,
      tableId: owner.tableId,
      table: owner.tableName,
      name: o.name,
      objType: o.objType,
      ver: verOf(versions, o.id),
      comment: o.comment ?? null,
    };
  });

  const head = {
    project: { id: project.row.id, path: project.path, name: project.row.name },
    seq,
    dialect: model.dialect,
    ...context,
  };

  if (opts.detail === 'full') {
    if (!schemaIdFilter && tables.length > MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA) {
      return {
        ok: true,
        data: {
          ...head,
          detail: 'full' as const,
          truncated: true,
          ...filterEcho,
          totalTables: tables.length,
          maxTablesWithoutSchemaFilter: MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA,
          message: `模型包含 ${tables.length} 张表（超过 ${MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA} 上限）；请传入 schema / section / q 过滤全量对象，或使用 get_table 查看单表详情。`,
          counts,
          schemas: schemas.map((s) => ({ id: s.id, name: s.name, ver: versions[s.id] ?? 0 })),
          tables: tableSummaries.slice(0, MAX_FULL_MODEL_TABLES_WITHOUT_SCHEMA),
          enums: enumSummaries,
          sequences: sequenceSummaries,
          extensions: extensionSummaries,
          opaques: opaqueSummaries,
          sections: sectionSummaries,
          ...diag,
        },
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
      ok: true,
      data: {
        ...head,
        detail: 'full' as const,
        truncated: false,
        ...filterEcho,
        counts,
        objects,
        // 板块不混进 objects（objects 保持纯 @dowel/core IR 对象）
        sections: liveSections,
        ...diag,
      },
    };
  }

  return {
    ok: true,
    data: {
      ...head,
      detail: 'summary' as const,
      ...filterEcho,
      counts,
      schemas: schemas.map((s) => ({ id: s.id, name: s.name, ver: versions[s.id] ?? 0 })),
      tables: tableSummaries,
      enums: enumSummaries,
      sequences: sequenceSummaries,
      extensions: extensionSummaries,
      opaques: opaqueSummaries,
      sections: sectionSummaries,
      ...diag,
    },
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
    const nums = await readEnvVersionNums(ctx, projectId);
    return { diagnostics: sanitizeUnknown(diagnoseModel(model, nums)) as McpDiagnostics };
  } catch (e) {
    return {
      diagnostics: null,
      diagnosticsError: scrubSecrets(e instanceof Error ? e.message : String(e)),
    };
  }
};

// ───── get_objects（ADR 0015 第 6 节：非表对象的完整只读上下文） ─────

type ContextObject = Enum | Sequence | Extension | Opaque;
const CONTEXT_KINDS: readonly ContextObject['kind'][] = ['extension', 'enum', 'sequence', 'opaque'];
const isContextObject = (o: Obj | undefined): o is ContextObject =>
  o !== undefined && (CONTEXT_KINDS as readonly string[]).includes(o.kind);

/** 依赖 / 引用对象的可读名：schema 级对象 `schema.name`，列 `schema.table.column`，其余子对象 `table.name` */
const qualifiedNameOf = (model: Model, o: Obj): string => {
  const get = (id: string) => (Object.hasOwn(model.objects, id) ? model.objects[id] : undefined);
  if (o.kind === 'schema') return o.name;
  if (o.kind === 'opaque') {
    const owner = opaqueOwner(model, o);
    const schema = get(owner.schemaId);
    const prefix = schema?.kind === 'schema' ? `${schema.name}.` : '';
    return owner.tableName !== null ? `${prefix}${owner.tableName}.${o.name}` : `${prefix}${o.name}`;
  }
  const parent = get(o.parent);
  if (!parent) return o.name;
  if (parent.kind === 'schema') return `${parent.name}.${o.name}`;
  if (parent.kind === 'table') {
    const schema = get(parent.parent);
    return schema?.kind === 'schema' ? `${schema.name}.${parent.name}.${o.name}` : `${parent.name}.${o.name}`;
  }
  return `${parent.name}.${o.name}`;
};

const readObjects = (
  model: Model,
  versions: Versions,
  args: {
    ids?: string[];
    kind?: ContextObject['kind'];
    objType?: OpaqueType;
    schema?: string;
    q?: string;
    limit: number;
    offset: number;
  },
) => {
  const get = (id: string) => (Object.hasOwn(model.objects, id) ? model.objects[id] : undefined);
  const schemaNameOf = (id: string) => {
    const s = get(id);
    return s?.kind === 'schema' ? s.name : null;
  };
  const schemaIdOf = (o: ContextObject) => (o.kind === 'opaque' ? opaqueOwner(model, o).schemaId : o.parent);

  let schemaFilter: string | null = null;
  let schemaMissing = false;
  if (args.schema !== undefined) {
    const match = all(model, 'schema').find((s) => s.id === args.schema || s.name === args.schema);
    if (match) schemaFilter = match.id;
    else schemaMissing = true;
  }
  const qLower = args.q?.toLowerCase();
  const kind = args.objType ? 'opaque' : args.kind;

  const matches = (o: ContextObject): boolean => {
    if (schemaMissing) return false;
    if (kind && o.kind !== kind) return false;
    if (args.objType && (o.kind !== 'opaque' || o.objType !== args.objType)) return false;
    if (schemaFilter && schemaIdOf(o) !== schemaFilter) return false;
    if (qLower !== undefined) {
      const texts = [o.name, qualifiedNameOf(model, o), o.comment ?? null];
      if (!texts.some((t) => typeof t === 'string' && t.toLowerCase().includes(qLower))) return false;
    }
    return true;
  };

  const missing: string[] = [];
  let candidates: ContextObject[];
  if (args.ids) {
    const seen = new Set<string>();
    candidates = [];
    for (const id of args.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const o = get(id);
      if (!isContextObject(o)) missing.push(id);
      else if (matches(o)) candidates.push(o);
    }
  } else {
    const kindRank = (k: string) => CONTEXT_KINDS.indexOf(k as ContextObject['kind']);
    const sortKey = (o: ContextObject) => {
      const owner = o.kind === 'opaque' ? opaqueOwner(model, o) : null;
      return [schemaNameOf(schemaIdOf(o)) ?? '', owner?.tableName ?? '', o.name, o.id];
    };
    candidates = Object.values(model.objects)
      .filter(isContextObject)
      .filter(matches)
      .sort((a, b) => {
        const kr = kindRank(a.kind) - kindRank(b.kind);
        if (kr !== 0) return kr;
        const ka = sortKey(a);
        const kb = sortKey(b);
        for (let i = 0; i < ka.length; i++) {
          if (ka[i]! < kb[i]!) return -1;
          if (ka[i]! > kb[i]!) return 1;
        }
        return 0;
      });
  }

  const total = candidates.length;
  const page = candidates.slice(args.offset, args.offset + args.limit);
  const nextOffset = args.offset + page.length < total ? args.offset + page.length : null;

  let ddlChars = 0;
  let budgetExceeded = false;
  let omitted = 0;
  const objects = page.map((o) => {
    const schemaId = schemaIdOf(o);
    const common = { ver: verOf(versions, o.id), schemaId, schema: schemaNameOf(schemaId) };
    if (o.kind !== 'opaque') return { ...o, ...common };
    const owner = opaqueOwner(model, o);
    const deps = o.deps.map((id) => {
      const d = get(id);
      return d ? { id, kind: d.kind, name: qualifiedNameOf(model, d) } : { id, kind: null, name: null };
    });
    const ownerFields = { parentKind: owner.parentKind, tableId: owner.tableId, table: owner.tableName };
    const size = o.ddl.reduce((n, stmt) => n + stmt.length, 0);
    if (!budgetExceeded && ddlChars + size <= MCP_OBJECTS_DDL_BUDGET) {
      ddlChars += size;
      return { ...o, ...common, ...ownerFields, deps };
    }
    budgetExceeded = true;
    omitted++;
    const { ddl: _omitted, ...rest } = o;
    return { ...rest, ...common, ...ownerFields, deps, ddlOmitted: true };
  });

  return {
    total,
    offset: args.offset,
    limit: args.limit,
    nextOffset,
    truncated: omitted > 0,
    ...(omitted > 0 ? { ddlOmitted: omitted, ddlBudget: MCP_OBJECTS_DDL_BUDGET } : {}),
    objects,
    ...(args.ids ? { missing } : {}),
    ...(schemaMissing ? { schemaNotFound: args.schema } : {}),
  };
};

// ───── get_history_diff：两次模型之间的 IR 对象净变化 ─────

/** 与画布历史摘要一致的对象标签：schema 级对象只用名字，子对象（列、约束、索引、表级 opaque）为 `表名.名字` */
const historyObjectLabel = (o: Obj, lookup: (id: string) => Obj | undefined): string => {
  if (o.kind === 'schema') return o.name;
  const parent = lookup(o.parent);
  if (!parent || parent.kind === 'schema') return o.name;
  return `${parent.name}.${o.name}`;
};

/** prevModel → targetModel 之间新增 / 删除 / 修改的对象（最多 MCP_HISTORY_OBJECTS_MAX_ITEMS 条） */
const netObjectChanges = (prevModel: Model | null, targetModel: Model) => {
  const prev = prevModel?.objects ?? {};
  const next = targetModel.objects;
  const lookup = (id: string): Obj | undefined =>
    (Object.hasOwn(next, id) ? next[id] : undefined) ?? (Object.hasOwn(prev, id) ? prev[id] : undefined);
  const items: {
    id: string;
    kind: Obj['kind'];
    name: string;
    label: string;
    change: 'added' | 'removed' | 'modified';
  }[] = [];
  for (const [id, o] of Object.entries(next)) {
    const before = Object.hasOwn(prev, id) ? prev[id] : undefined;
    if (!before)
      items.push({ id, kind: o.kind, name: o.name, label: historyObjectLabel(o, lookup), change: 'added' });
    else if (!deepEqual(before, o))
      items.push({
        id,
        kind: o.kind,
        name: o.name,
        label: historyObjectLabel(o, lookup),
        change: 'modified',
      });
  }
  for (const [id, o] of Object.entries(prev)) {
    if (!Object.hasOwn(next, id))
      items.push({ id, kind: o.kind, name: o.name, label: historyObjectLabel(o, lookup), change: 'removed' });
  }
  return {
    total: items.length,
    truncated: items.length > MCP_HISTORY_OBJECTS_MAX_ITEMS,
    items: items.slice(0, MCP_HISTORY_OBJECTS_MAX_ITEMS),
  };
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
      'Read working-trunk model (`seq`, `dialect`, and summary or full objects with per-object `ver`), plus canvas `sections` (pure layout; per-table `sectionId` in summaries, partitions inherit their root table), dialect `capabilities`, and the derived lowest `target` version (platform cache only). Summaries include enum `values`, sequence `options` / `ownedBy`, extension and opaque owners (`parentKind`, `tableId`, `table` for table-level triggers / policies / exclusions). Optional filters (intersected): `schema`; `section` (section ID, `$none` for unsectioned tables, or a unique case-insensitive name); `q` (case-insensitive substring of table / schema / comment / column names — `matchedColumns` lists column hits — and of object names). `diagnostics: true` adds full validation + static compatibility diagnostics (platform cache only, never connects to target DBs). For >200 tables in `detail="full"`, filter by `schema`, `section` or `q`.',
    schema: z.object({
      project: z.string().min(1),
      schema: z.string().min(1).optional(),
      detail: z.enum(['summary', 'full']).default('summary'),
      q: z.string().trim().min(1).max(100).optional(),
      section: z.string().trim().min(1).max(MAX_SECTION_ID_LENGTH).optional(),
      diagnostics: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_model.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const res = await summarizeOrReadModel(ctx, resolved.project, {
        schema: args.schema,
        detail: args.detail,
        q: args.q,
        section: args.section,
        diagnostics: args.diagnostics,
      });
      if (!res.ok) return toolError(res.code, res.message, res.extra);
      return toolOk(res.data);
    },
  });

  addTool({
    name: 'get_table',
    description:
      'Inspect a single table (by id, `schema.name`, or unique `name`) with columns, constraints, indexes, partitions, IDs, `ver`, and working `seq`, plus its canvas `sectionId` (partitions inherit their root table), table-level `opaques` (triggers / policies / exclusion constraints, full objects with `ver`) and `dependentOpaques` (views, functions, etc. elsewhere whose `deps` reference this table or any of its columns).',
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
      const { model, versions, seq, sections: rawSections } = await ctx.rooms.canvasState(row.branch);

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
      const tableId = matched.id;
      const ownIds = new Set([tableId, ...columns.map((c) => c.id)]);
      const opaquesAll = all(model, 'opaque');
      const ownOpaques = opaquesAll.filter((o) => o.parent === tableId);
      const schemaNameOf = (id: string) => {
        const o = Object.hasOwn(model.objects, id) ? model.objects[id] : undefined;
        return o?.kind === 'schema' ? o.name : id;
      };
      const dependentOpaques = opaquesAll
        .filter((o) => o.parent !== tableId && o.deps.some((d) => ownIds.has(d)))
        .map((o) => {
          const owner = opaqueOwner(model, o);
          return {
            id: o.id,
            schemaId: owner.schemaId,
            schema: schemaNameOf(owner.schemaId),
            objType: o.objType,
            name: o.name,
            ver: verOf(versions, o.id),
          };
        });

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
        sectionId: sectionIndexOf(model, rawSections)(matched),
        opaques: ownOpaques.map((o) => withVer(o, versions)),
        dependentOpaques,
      });
    },
  });

  addTool({
    name: 'get_objects',
    description: `Read full IR (with \`ver\`) of non-table objects: enums, sequences, extensions and opaque objects (views, materialized views, functions, procedures, domains, types, aggregates, triggers, policies, exclusion constraints). Look up by \`ids\` (unknown or non-supported IDs are listed in \`missing\`; use \`get_table\` for tables / columns / constraints) or filter by \`kind\`, \`objType\` (implies kind "opaque"), \`schema\` and \`q\` (case-insensitive substring of name, qualified name or comment); results are sorted deterministically and paged with \`limit\` / \`offset\` (\`total\`, \`nextOffset\`). Opaque objects carry their owner (\`parentKind\`, \`tableId\`, \`table\` for table-level ones) and resolved \`deps\` ({ id, kind, name }). DDL text on one page is capped at ${MCP_OBJECTS_DDL_BUDGET} characters: later objects omit \`ddl\` (\`ddlOmitted: true\`, top-level \`truncated: true\`) — fetch them by \`ids\`.`,
    schema: z
      .object({
        project: z.string().min(1),
        ids: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
        kind: z.enum(['enum', 'sequence', 'extension', 'opaque']).optional(),
        objType: OpaqueType.optional(),
        schema: z.string().min(1).optional(),
        q: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      if (!args.ids && !args.kind && !args.objType && !args.q) {
        return toolError('invalid_arguments', '请至少传入 ids，或 kind / objType / q 之一');
      }
      if (args.objType && args.kind && args.kind !== 'opaque') {
        return toolError('invalid_arguments', `objType 只适用于 kind "opaque"（收到 kind "${args.kind}"）`);
      }
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.get_objects.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;
      // 关键出口：读前按需规范化，不透明对象 DDL 里引用的依赖名与当前模型一致（05-implementation.md 4.26）
      await ctx.refresher.flush(row.branch);
      const { model, versions, seq } = await ctx.rooms.canvasState(row.branch);
      const res = readObjects(model, versions, args);
      return toolOk(
        sanitizeUnknown({
          project: resolved.project.path,
          seq,
          dialect: model.dialect,
          ...res,
        }) as Record<string, unknown>,
      );
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
      const modelRef = await resolveModelRef(ctx.db, ctx.refresher, {
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
      const toRef = await resolveModelRef(ctx.db, ctx.refresher, {
        pid: row.id,
        branch: row.branch,
        schemas: row.schemas,
        ref: args.to,
        defaultRef: 'head',
      });
      if (!toRef.ok) return toolError(toRef.code, toRef.message);

      const fromRef = await resolveModelRef(ctx.db, ctx.refresher, {
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

  // ───── 只读画布历史（ADR 0015 第 6 节）：绝不 flush、绝不连影子库 / 目标库、不写审计；恢复只在界面由人工操作 ─────

  addTool({
    name: 'list_history',
    description: `Browse the canvas history of the working trunk, newest first (read-only). Default \`grouped: true\` folds consecutive edits by the same person into edit sessions (\`seqFrom\`..\`seq\`, \`stepCount\`, \`ops\`); \`grouped: false\` lists single steps. Page with \`beforeSeq\` (use \`nextBeforeSeq\`); \`limit\` 1..${MCP_HISTORY_MAX_LIMIT}. Each entry shows who / when / what (\`summary\`, \`changeCount\`, published \`version\`, \`via: "mcp"\` and \`opSummary\` truncated to ${MCP_HISTORY_OP_SUMMARY_MAX_CHARS} chars). Inspect one entry or group with \`get_history_diff\`. Restoring history is reserved for humans in the Dowel UI.`,
    schema: z
      .object({
        project: z.string().min(1),
        beforeSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MCP_HISTORY_MAX_LIMIT).default(20),
        grouped: z.boolean().default(true),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(ctx, principal, args.project, MCP_TOOLS.list_history.action);
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      // 不 flush：历史只读平台库里的提交与快照，不触发规范化，也不会凭空推进 seq
      const list = await ctx.rooms.listHistory(resolved.project.row.branch, {
        beforeSeq: args.beforeSeq,
        limit: args.limit,
        grouped: args.grouped,
      });
      const entries = list.entries.map((e) =>
        e.opSummary && e.opSummary.length > MCP_HISTORY_OP_SUMMARY_MAX_CHARS
          ? {
              ...e,
              opSummary: `${e.opSummary.slice(0, MCP_HISTORY_OP_SUMMARY_MAX_CHARS - 1)}…`,
              opSummaryTruncated: true,
            }
          : e,
      );
      return toolOk(
        sanitizeUnknown({ project: resolved.project.path, ...list, entries }) as Record<string, unknown>,
      );
    },
  });

  addTool({
    name: 'get_history_diff',
    description: `Inspect one canvas-history entry (\`seq\`) or a whole edit-session group (\`from\`..\`seq\`, at most ${CANVAS_HISTORY_GROUP_MAX_STEPS} steps) read-only: the entry metadata (full \`opSummary\`), the net object changes (\`objects\`: added / removed / modified IR objects) and the migration-style \`diff\` between the states before and after (first \`maxItems\` items, \`total\`, \`truncated\`; per-item \`sql\` capped at ${MCP_HISTORY_SQL_MAX_CHARS} chars with \`sqlTruncated\`, omitted with \`includeSql: false\`). \`includeSteps: true\` adds the single steps of the group. Never returns the full model or a diff to the current canvas (use \`get_model\` / \`preview_migration\`); never connects to shadow or target databases. Restoring history is reserved for humans in the Dowel UI.`,
    schema: z
      .object({
        project: z.string().min(1),
        seq: z.number().int().min(0),
        from: z.number().int().min(1).optional(),
        maxItems: z.number().int().min(1).max(MCP_HISTORY_DIFF_MAX_ITEMS).default(30),
        includeSql: z.boolean().default(true),
        includeSteps: z.boolean().default(false),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args) => {
      const { seq, from } = args;
      // 查库前 O(1) 校验区间：1 <= from <= seq 且不超过单组步数上限
      if (
        from !== undefined &&
        (seq === 0 || from > seq || seq - from + 1 > CANVAS_HISTORY_GROUP_MAX_STEPS)
      ) {
        return toolError(
          'invalid_arguments',
          `无效的历史区间：需要 1 <= from <= seq 且最多 ${CANVAS_HISTORY_GROUP_MAX_STEPS} 步`,
        );
      }
      const resolved = await resolveMcpProject(
        ctx,
        principal,
        args.project,
        MCP_TOOLS.get_history_diff.action,
      );
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const branch = resolved.project.row.branch;
      // 不 flush：只读历史提交，不与规范化后的当前模型比较
      const { seq: currentSeq } = await ctx.rooms.model(branch);
      if (seq > currentSeq) {
        return toolError('history_not_found', `修改记录 #${seq} 不存在`, { currentSeq });
      }
      let detail: Awaited<ReturnType<typeof ctx.rooms.historyDetailModels>>;
      let steps: Awaited<ReturnType<typeof ctx.rooms.historySteps>> | undefined;
      try {
        detail = await ctx.rooms.historyDetailModels(branch, seq, from, currentSeq);
        if (args.includeSteps) {
          steps = seq === 0 ? [] : await ctx.rooms.historySteps(branch, from ?? seq, seq, currentSeq);
        }
      } catch (e) {
        if (e instanceof HTTPException && e.status === 404) {
          return toolError('history_not_found', e.message, { currentSeq });
        }
        throw e;
      }
      const { entry, prevModel, targetModel } = detail;

      const planned = prevModel ? planDiff(prevModel, targetModel) : { total: 0, items: [] };
      const diffItems = planned.items.slice(0, args.maxItems).map((item) => {
        if (!args.includeSql) return { kind: item.kind, target: item.target };
        if (item.sql.length > MCP_HISTORY_SQL_MAX_CHARS) {
          return { ...item, sql: `${item.sql.slice(0, MCP_HISTORY_SQL_MAX_CHARS)}…`, sqlTruncated: true };
        }
        return item;
      });

      return toolOk(
        sanitizeUnknown({
          project: resolved.project.path,
          currentSeq,
          entry,
          objects: netObjectChanges(prevModel, targetModel),
          diff: {
            total: planned.total,
            truncated: planned.total > diffItems.length,
            items: diffItems,
          },
          ...(steps ? { steps } : {}),
        }) as Record<string, unknown>,
      );
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

      // 先做不碰影子库的检查（环境存在、连库限速），被拒的调用不会因为解析 head 而触发影子库规范化（ADR 0016）
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

      const needsExternalShadow = getDialect(row.dialect).capabilities.requiresExternalShadow;
      const gate = needsExternalShadow ? ctx.connectionLimiter.attempt(principal.user.id) : null;
      if (gate && !gate.allowed) {
        return toolError('rate_limited', `影子库验证请求太频繁，请在 ${gate.retryAfterSeconds} 秒后重试`);
      }

      // 解析 head 会触发按需规范化：解析失败（版本不存在、等 derive 锁超时 DeriveBusyError 等）时还没做影子库验证，退回限速额度
      const refund = () => {
        if (gate?.allowed) gate.refund();
      };
      let toRef: Awaited<ReturnType<typeof resolveModelRef>>;
      let fromRef: Awaited<ReturnType<typeof resolveModelRef>>;
      try {
        toRef = await resolveModelRef(ctx.db, ctx.refresher, {
          pid: row.id,
          branch: row.branch,
          schemas: row.schemas,
          ref: args.to,
          defaultRef: 'head',
        });
        if (!toRef.ok) {
          refund();
          return toolError(toRef.code, toRef.message);
        }
        fromRef = await resolveModelRef(ctx.db, ctx.refresher, {
          pid: row.id,
          branch: row.branch,
          schemas: row.schemas,
          ref: args.from,
          like: toRef.model,
          defaultRef: 'latest_or_empty',
        });
        if (!fromRef.ok) {
          refund();
          return toolError(fromRef.code, fromRef.message);
        }
      } catch (e) {
        refund();
        throw e;
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
      'Atomically validate and apply 1..100 ops to the working trunk based on `baseSeq`, committed as ONE canvas-history entry (single `seq`, `opCount` = expanded primitive sub-ops, at most 500). Ops are primitive mutators or the compile-time macros `defineTable` (whole table in one op; may use its own column names and resolve new references by qualified name) and `alterColumn` (declarative patch of an existing column addressed by column ID; its `typeRef` / `default.nextval` references may also use `[schema.]name`). Edits and drops address existing objects strictly by object ID (or a `$ref:<alias>` created earlier in the same call), never by name; for circular FKs, define the tables first and add the remaining FKs with `addForeignKey`. Use `$ref:<alias>` in primitive args for new UUIDv7 IDs; `refs` maps each `alias` to its generated ID. Optional `summary` (<= 500 chars) records the intent in canvas history and audit. Set `dryRun: true` to simulate without committing. Errors carry the input `index` and, for macros, `path` (e.g. `defineTable(orders).foreignKeys[0]`) and the expanded `mutator`. Responses include `diagnostics` (validation + static target-version compatibility; never blocks the write) and `noop: true` when nothing changed.',
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

  addTool({
    name: 'manage_sections',
    description:
      'Incrementally adjust canvas sections (pure layout layer: never part of the schema IR, migrations, versions or canvas history `seq`). Applies 1..50 actions atomically on the latest sections: `create` (`ref`, `name`, optional `color` peer-1..peer-8 and `tables`), `rename`, `recolor`, `delete` (tables become ungrouped), `add_tables` (a table already in another section is moved; partitions follow their parent), `remove_tables` (idempotent). Refer to sections by ID or `$ref:<alias>` of an earlier `create`; `refs` maps each alias to the generated ID. Table IDs come from `get_model`. Pixel coordinates cannot be written. Set `dryRun: true` to preview; `noop: true` when nothing changed.',
    schema: mcpManageSectionsInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (args) => {
      const resolved = await resolveMcpProject(
        ctx,
        principal,
        args.project,
        MCP_TOOLS.manage_sections.action,
      );
      if (!resolved.ok) return toolError(resolved.code, resolved.message);
      const { row } = resolved.project;

      const parsed = resolveSectionActions(args.actions, () => `sec-${newId()}`);
      if (!parsed.ok) {
        return toolError(parsed.code, parsed.message, { index: parsed.index });
      }
      const res = await ctx.rooms.manageSections(row.branch, {
        actions: parsed.actions,
        dryRun: args.dryRun,
        onBeforeCommit: async (tx, info) => {
          await auditIn(
            tx,
            honoCtx,
            {
              action: 'sections.update',
              actorKind: 'user',
              actorId: principal.user.id,
              targetKind: 'project',
              targetId: row.id,
              projectId: row.id,
              data: {
                via: 'mcp',
                mcpToken: { id: principal.tokenId, name: principal.tokenName, prefix: principal.prefix },
                projectId: row.id,
                sectionsVer: info.ver,
                opCount: args.actions.length,
                actions: args.actions.map((a) => a.action),
                created: info.created.length,
                deleted: info.deleted.length,
                moved: info.moved.length,
              },
            },
            ctx.security,
          );
        },
      });
      if (!res.ok) {
        return toolError(res.code, res.message, {
          index: res.index,
          ...(res.tableIds ? { tableIds: res.tableIds } : {}),
        });
      }
      return toolOk({
        dryRun: res.dryRun,
        sectionsVer: res.sectionsVer,
        sections: res.sections,
        refs: parsed.refs,
        moved: res.moved,
        ...(res.noop ? { noop: true } : {}),
        ...(res.superseded ? { superseded: true } : {}),
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
      const res = await summarizeOrReadModel(ctx, p, { detail: 'summary' });
      if (!res.ok) throw new ProtocolError(ProtocolErrorCode.InvalidParams, scrubSecrets(res.message));
      const data = res.data;
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
      const modelRef = await resolveModelRef(ctx.db, ctx.refresher, {
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

  // ───── MCP Prompts（read：审查类；write：建表 / 改列；渲染时零数据库查询） ─────
  registerMcpPrompts(server, principal);

  return server;
};
