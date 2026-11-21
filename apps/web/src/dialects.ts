// 前端多方言 UI 规格表：集中管理显示名、能力开关、URL 占位符、默认主键列与版本号格式化。
import { type ColumnSpec, type Dialect, getDialect, hasDialect, type Model } from '@dowel/core';

export interface DialectUiSpec {
  id: Dialect;
  name: string;
  shortName: string;
  implemented: boolean;
  defaultSchema: string;
  schemas: boolean;
  enums: boolean;
  sequences: boolean;
  partitioning: boolean;
  requiresExternalShadow: boolean;
  comments: boolean;
  urlPlaceholder: string;
  shadowPlaceholder: string;
  defaultColumnType: string;
  defaultPkColumn: (id: string) => ColumnSpec & { id: string };
  /** 新建默认表时是否同时创建主键约束 */
  autoPrimaryKey: boolean;
}

const capsOf = (d: Dialect) => (hasDialect(d) ? getDialect(d).capabilities : null);

export const DIALECT_UI_SPECS: Record<Dialect, DialectUiSpec> = {
  pg: {
    id: 'pg',
    name: 'PostgreSQL',
    shortName: 'PG',
    implemented: hasDialect('pg'),
    defaultSchema: capsOf('pg')?.defaultSchema ?? 'public',
    schemas: capsOf('pg')?.schemas ?? true,
    enums: capsOf('pg')?.enums ?? true,
    sequences: capsOf('pg')?.sequences ?? true,
    partitioning: capsOf('pg')?.partitioning ?? true,
    requiresExternalShadow: capsOf('pg')?.requiresExternalShadow ?? true,
    comments: capsOf('pg')?.comments ?? true,
    urlPlaceholder: 'postgres://user:password@host:5432/db',
    shadowPlaceholder: 'postgres://user:password@shadow-host:5432/empty_db',
    defaultColumnType: 'text',
    defaultPkColumn: (id) => ({ id, name: 'id', type: 'bigint', notNull: true, identity: { always: false } }),
    autoPrimaryKey: false,
  },
  sqlite: {
    id: 'sqlite',
    name: 'SQLite',
    shortName: 'SQLite',
    implemented: hasDialect('sqlite'),
    defaultSchema: capsOf('sqlite')?.defaultSchema ?? 'main',
    schemas: capsOf('sqlite')?.schemas ?? false,
    enums: capsOf('sqlite')?.enums ?? false,
    sequences: capsOf('sqlite')?.sequences ?? false,
    partitioning: capsOf('sqlite')?.partitioning ?? false,
    requiresExternalShadow: capsOf('sqlite')?.requiresExternalShadow ?? false,
    comments: capsOf('sqlite')?.comments ?? false,
    urlPlaceholder: 'sqlite:///data/app.db',
    shadowPlaceholder: '',
    defaultColumnType: 'TEXT',
    defaultPkColumn: (id) => ({
      id,
      name: 'id',
      type: 'INTEGER',
      notNull: true,
      ext: { sqlite: { autoincrement: true } },
    }),
    autoPrimaryKey: true,
  },
  mysql: {
    id: 'mysql',
    name: 'MySQL',
    shortName: 'MySQL',
    implemented: hasDialect('mysql'),
    defaultSchema: capsOf('mysql')?.defaultSchema ?? 'default',
    schemas: capsOf('mysql')?.schemas ?? false,
    enums: capsOf('mysql')?.enums ?? false,
    sequences: capsOf('mysql')?.sequences ?? false,
    partitioning: capsOf('mysql')?.partitioning ?? false,
    requiresExternalShadow: capsOf('mysql')?.requiresExternalShadow ?? true,
    comments: capsOf('mysql')?.comments ?? true,
    urlPlaceholder: 'mysql://user:password@host:3306/db',
    shadowPlaceholder: 'mysql://user:password@shadow-host:3306/empty_db',
    defaultColumnType: 'varchar(255)',
    defaultPkColumn: (id) => ({ id, name: 'id', type: 'bigint', notNull: true }),
    autoPrimaryKey: true,
  },
  mssql: {
    id: 'mssql',
    name: 'SQL Server',
    shortName: 'MSSQL',
    implemented: hasDialect('mssql'),
    defaultSchema: capsOf('mssql')?.defaultSchema ?? 'dbo',
    schemas: capsOf('mssql')?.schemas ?? true,
    enums: capsOf('mssql')?.enums ?? false,
    sequences: capsOf('mssql')?.sequences ?? true,
    partitioning: capsOf('mssql')?.partitioning ?? false,
    requiresExternalShadow: capsOf('mssql')?.requiresExternalShadow ?? true,
    comments: capsOf('mssql')?.comments ?? true,
    urlPlaceholder: 'mssql://user:password@host:1433/db',
    shadowPlaceholder: 'mssql://user:password@shadow-host:1433/empty_db',
    defaultColumnType: 'nvarchar(255)',
    defaultPkColumn: (id) => ({ id, name: 'id', type: 'bigint', notNull: true }),
    autoPrimaryKey: true,
  },
};

export const DIALECT_UI_LIST: readonly DialectUiSpec[] = [
  DIALECT_UI_SPECS.pg,
  DIALECT_UI_SPECS.sqlite,
  DIALECT_UI_SPECS.mysql,
  DIALECT_UI_SPECS.mssql,
];

export const dialectUiSpec = (dialect?: string | null): DialectUiSpec =>
  DIALECT_UI_SPECS[(dialect as Dialect) ?? 'pg'] ?? DIALECT_UI_SPECS.pg;

export const defaultSchemaOf = (model: Pick<Model, 'dialect'>): string =>
  dialectUiSpec(model.dialect).defaultSchema;

export const formatEngineVersion = (
  dialect: string | undefined,
  engineVersion: string | null,
  engineMajor: number | null,
  full = false,
): string | null => {
  const ver = engineVersion ?? (engineMajor !== null ? String(engineMajor) : null);
  if (!ver) return null;
  const spec = dialectUiSpec(dialect);
  return `${full ? spec.name : spec.shortName} ${ver}`;
};
