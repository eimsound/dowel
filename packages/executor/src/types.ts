// 执行器的输入输出类型。执行器是纯库：只依赖 core 和 engines，不依赖服务端；
// 平台库里的东西（版本链、环境缓存）由调用方整理成 ChainVersion 传进来，需要写平台库时用 hooks 回调。
import type { Dialect, Model } from '@dowel/core';
import type { Db, RunDirection, ScriptStep } from '@dowel/engines';

/** 执行器真正“执行”的方向（不含 mark：标记不执行任何 SQL，见 mark.ts） */
export type MigrationDirection = Exclude<RunDirection, 'mark'>;

/** 平台库里版本链上的一个版本（已冻结） */
export interface ChainVersion {
  id: string;
  /** 链上的序号：第一个版本是 0（v0 基线）或 1（空白项目） */
  number: number;
  parentId: string | null;
  name: string;
  /** 发布时的完整模型：执行后读回的结构必须等于它 */
  model: Model;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  checksum: string;
  /** 影子库闭环验证通过（verified_at 非空）；未验证的版本拒绝执行 */
  verified: boolean;
  publishedAt: string;
  publishedBy: string | null;
  /**
   * 冻结时项目的 schema 范围（null = 全部；dowel 永远排除）。读这个版本的结构（漂移检查、读回校验、判断“空库”）用它，
   * 不用项目当前的范围——范围之后改了，旧版本的比较结果也不能变。
   */
  scope: string[] | null;
  /**
   * 平台库里已作废（ADR 0013，retired_at 非空）。执行器拒绝任何升级（up）到已作废版本的迁移、拒绝标记到已作废版本；
   * 回滚已作废版本（down）和经最近公共祖先切回活跃主链不受影响。不给 = 未作废。
   */
  retired?: boolean;
}

/** 差异列表里的一项：由 plan(线上结构, 版本模型) 的一步转成，表示“要让线上结构回到这个版本，需要做什么” */
export interface DiffItem {
  kind: string;
  target: string;
  sql: string;
}

/** 将要执行的一次迁移（baseline 不执行 SQL，只写历史） */
export interface Migration {
  /** 执行哪个版本的脚本：up 是它的升级脚本，down 是它的回滚脚本，baseline 是写入基线的那个版本 */
  version: ChainVersion;
  direction: MigrationDirection;
  /** 执行前的版本（第一次执行到空库时为 null） */
  from: ChainVersion | null;
  /** 执行后的版本：读回的结构必须等于它的模型 */
  to: ChainVersion;
  steps: ScriptStep[];
}

export type ExecutorEvent =
  | { type: 'phase'; phase: 'lock' | 'integrity' | 'drift' }
  /** 检查都通过了，这是接下来要做的事（baseline = 先写入基线） */
  | {
      type: 'plan';
      baseline: boolean;
      migrations: {
        versionId: string;
        number: number;
        name: string;
        direction: MigrationDirection;
        steps: number;
      }[];
    }
  | {
      type: 'migration';
      status: 'start' | 'step' | 'done';
      /** 第几个迁移（从 1 开始）/ 一共几个 */
      index: number;
      total: number;
      versionId: string;
      number: number;
      name: string;
      direction: MigrationDirection;
      /** step 事件：刚执行完第几步（从 1 开始）/ 这个迁移一共几步 */
      step?: number;
      steps?: number;
      /** 从上一次失败的断点接着跑 */
      resumed?: boolean;
    };

export interface ExecuteOptions {
  /** 目标库（连接池）；执行器会独占其中一个连接来持有项目锁和执行迁移 */
  db: Db;
  /** 目标库方言；缺省自动取 chain[0].model.dialect 或 'pg' */
  dialect?: Dialect;
  projectId: string;
  projectName: string | null;
  /** 本 Dowel 实例的唯一标识，写进历史 */
  instanceId: string;
  /**
   * 平台库里完整的版本树（按 number 升序，含已作废的版本）：父子关系看 parentId，
   * 路线沿 parent_id 经最近公共祖先规划（先 down 再 up，见 version-tree.ts 的 routeBetween）
   */
  chain: ChainVersion[];
  /** 目标版本 ID */
  to: string;
  /**
   * 期望的路线形状：给了而实际路线不一样就拒绝（空操作不受影响）——
   * up = 只升级（“执行”接口、CI 令牌），实际要先回滚再升级时报 switch_required，实际是回滚时报 wrong_direction；
   * down = 只回滚（“回滚”接口），否则 wrong_direction；
   * switch = 先回滚到最近公共祖先再升级（ADR 0013 混合切换，Web 端显式确认），否则 wrong_direction。
   */
  direction?: 'up' | 'down' | 'switch';
  executedBy: string | null;
  via?: 'web' | 'ci';
  /** 等项目锁的时间，默认 30 秒 */
  lockTimeoutMs?: number;
  /**
   * 迁移会话的超时（P5a，来自执行策略）：执行每个迁移的步骤时设置 `statement_timeout` / `lock_timeout`（毫秒，0 = 不限），
   * 事务步骤和非事务步骤都生效；读回校验、写历史不受它约束（步骤做完就恢复成不限）。不给 = 不设置（执行器本身没有默认值）。
   * 因超时失败的步骤报 `step_timeout`（details.timeout 说明是哪一种），断点续跑的语义不变。
   */
  timeouts?: { statementMs: number; lockMs: number };
  onEvent?: (e: ExecutorEvent) => void | Promise<void>;
  /**
   * 执行申请的绑定（P5b，ADR 0006）：在目标库的项目锁里、写任何东西之前核对——
   * 目标库历史里的当前版本必须等于 from，要执行的迁移（版本、方向、顺序）和每个版本的校验和必须和提交时一致，
   * 否则抛 request_stale，什么都不写。平台库的缓存可能落后于目标库，所以这一步必须在锁里、按目标库的历史做。
   */
  expect?: ExecuteExpect;
  /**
   * 每个迁移（含基线）开始前调用：平台库在这里登记“这个版本即将在这个环境执行”并再确认版本没被改过。
   * 抛错就中止执行（此时这个迁移还没有对目标库做任何事）。
   */
  beforeMigration?: (m: Migration) => void | Promise<void>;
  /**
   * 对目标库做第一次**会留下痕迹的写入**之前调用（同步）：事务型迁移是在发出 COMMIT 之前（回滚的事务什么都不留下），
   * 含非事务步骤的迁移是在第一个非事务步骤执行 / 第一个事务段提交之前，写基线是在提交之前。
   * 建 `dowel` schema、写项目行、开始记录不算——那不是这个版本的脚本留下的东西。
   * 调用方据此区分“目标库没被改动的失败”（登记可以撤销，版本还能修脚本）和“已经改动”（版本算执行过），
   * 不管失败是什么类型的错误。
   */
  onTouch?: (m: Migration) => void;
  /** 每个迁移成功提交后调用（更新平台库里的缓存）；这里抛错会被忽略（目标库已经提交，不能回头） */
  afterMigration?: (m: Migration) => void | Promise<void>;
  /**
   * 只预演、不执行：做完全部执行前检查（锁、完整性、认领、漂移、已验证、实例级语句、历史表能不能写），
   * 通过就返回将要做的事（result.dryRun），**不写目标库**（连 dowel schema 都不建，不升级历史格式），
   * 也不调用 beforeMigration / onTouch / afterMigration（平台库的登记一概不写）。检查失败照常抛 ExecutorError。
   */
  dryRun?: boolean;
}

/** 执行申请绑定的起点和迁移（见 ExecuteOptions.expect） */
export interface ExecuteExpect {
  from: string | null;
  migrations: { versionId: string; direction: MigrationDirection; checksum: string }[];
}

/** 预演里的一个迁移：要执行的脚本和哪些步骤不在事务里 */
export interface DryRunMigration {
  versionId: string;
  number: number;
  name: string;
  direction: MigrationDirection;
  steps: { sql: string; transactional: boolean }[];
  /** 不能放进事务的步骤数（含这些步骤的迁移不是原子的，中途失败要从断点续跑） */
  nonTransactional: number;
  /** 预演用的那一份版本链里这个版本的校验和（执行申请绑定它，P5b） */
  checksum: string;
}

/** 预演的结果：通过了全部检查，真执行时会做什么 */
export interface DryRunPlan {
  /** 目标库还没有这个项目的历史：baseline = 结构等于基线，只写基线；empty = 空库，执行第一个版本建库；null = 已有历史 */
  firstRun: 'baseline' | 'empty' | null;
  /** 会先写入基线（库里的结构等于第一个版本） */
  baseline: boolean;
  /** 执行前 / 执行后的版本 */
  from: { id: string; number: number; name: string } | null;
  to: { id: string; number: number; name: string } | null;
  /** 路线经过的最近公共祖先：switch（先回滚再升级）时是回滚段的终点、升级段的起点；其他情况为 null */
  lca: { id: string; number: number; name: string } | null;
  migrations: DryRunMigration[];
  /** 上一次停在中途：会从哪个迁移的哪一步之后接着跑 */
  resume: { versionId: string; direction: MigrationDirection; afterStep: number } | null;
  /** 会在目标库里新建 dowel schema（第一次执行） */
  createsHistory: boolean;
  /** 通过了的检查（界面逐项列出） */
  checks: ('lock' | 'integrity' | 'claim' | 'drift' | 'verified' | 'instance_level' | 'history_writable')[];
}

export interface ExecuteResult {
  /** switch = 先回滚到最近公共祖先再升级（ADR 0013） */
  direction: 'up' | 'down' | 'switch' | 'none';
  /** switch 路线经过的最近公共祖先；其他情况为 null / undefined */
  lca?: { id: string; number: number; name: string } | null;
  /** 本次是否写入了基线 */
  baseline: boolean;
  /** 本次真正执行（或写入基线）的迁移，按顺序 */
  ran: { versionId: string; number: number; direction: MigrationDirection; runId: number }[];
  /** 执行前目标库历史里的当前版本（没有执行过为 null） */
  from?: string | null;
  /** 结束时环境的当前版本 */
  current: string | null;
  /** dryRun 时有值：将要做的事（没有写入任何东西） */
  dryRun?: DryRunPlan;
}
