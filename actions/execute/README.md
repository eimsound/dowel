# Dowel Execute Action / CI 脚本

用于在 CI/CD 流水线里，通过 Dowel 项目 CI 令牌把指定环境执行（或预演）到目标版本。

这是一个只用 `bash` 和 `curl` 实现的复合 Action 与独立脚本（不依赖第三方 Action，JSON 解析优先用 `jq`、缺省回退 `node`），令牌通过 `curl --config -` 从标准输入传入，不会出现在命令行参数或日志里。

## 兼容平台

- **GitHub Actions** 与内网自建 Actions：**Gitea Actions**、**Forgejo Actions**、**GitHub Enterprise Server** 均可直接按复合 Action 方式引用（自建实例可将仓库镜像到内网后按内部地址引用）。
- **任意 CI 系统**（GitLab CI、Jenkins、Drone、Woodpecker、Buildkite 等）：直接执行 `bash actions/execute/run.sh`，通过环境变量传入参数即可。

## 在任意 CI 中直接调用 `run.sh`

```bash
DOWEL_URL="https://dowel.internal.example.com" \
DOWEL_TOKEN="$DOWEL_TOKEN" \
DOWEL_PROJECT="acme/shop" \
DOWEL_ENVIRONMENT="staging" \
DOWEL_TO="latest" \
DOWEL_DRY_RUN="false" \
DOWEL_LOCK_TIMEOUT="30" \
bash actions/execute/run.sh
```

环境变量与下方输入表一一对应：`DOWEL_URL`、`DOWEL_TOKEN`、`DOWEL_PROJECT`、`DOWEL_ENVIRONMENT`、`DOWEL_TO`、`DOWEL_DRY_RUN`（默认 `false`）、`DOWEL_LOCK_TIMEOUT`（默认 `30`）。

## Actions 用法示例（GitHub / Gitea / Forgejo / GHES）

> **安全建议**：引用 Action 时始终固定到完整的 40 位提交哈希（并在注释里写明版本标签），不要直接引用可变分支名。

```yaml
name: Migrate Staging

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - name: 预演迁移
        uses: eimsound/dowel/actions/execute@<40-char-commit-sha> # v1.0.0
        with:
          url: ${{ vars.DOWEL_URL }}
          token: ${{ secrets.DOWEL_TOKEN }}
          project: acme/shop
          environment: staging
          to: latest
          dry-run: "true"

      - name: 执行迁移
        id: migrate
        uses: eimsound/dowel/actions/execute@<40-char-commit-sha> # v1.0.0
        with:
          url: ${{ vars.DOWEL_URL }}
          token: ${{ secrets.DOWEL_TOKEN }}
          project: acme/shop
          environment: staging
          to: latest
          lock-timeout: "30"

      - name: 打印结果
        run: |
          echo "reached=${{ steps.migrate.outputs.reached }}"
          echo "noop=${{ steps.migrate.outputs.noop }}"
```

## 输入

| 名称           | 必填 | 默认值  | 说明                                                 |
| -------------- | ---- | ------- | ---------------------------------------------------- |
| `url`          | 是   | —       | Dowel 服务地址，例如 `https://dowel.example.com`     |
| `token`        | 是   | —       | 项目 CI 令牌（`dwl_…`），放到 GitHub Secrets 中传入  |
| `project`      | 是   | —       | 项目路径 `owner/slug`                                |
| `environment`  | 是   | —       | 目标环境名，例如 `staging`                           |
| `to`           | 是   | —       | 目标版本，必须显式指定：`latest`、`v5` 或 `5`        |
| `dry-run`      | 否   | `false` | 设为 `true` 时只做执行前检查并返回计划，不写入目标库 |
| `lock-timeout` | 否   | `30`    | 等待执行锁的最长秒数（`0`～`30`）                    |

## 输出

| 名称       | 说明                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `ok`       | `true` 或 `false`                                                                         |
| `code`     | 失败时的机器可读错误码（例如 `drift`、`prerequisite_behind`、`lock_timeout`），成功时为空 |
| `reached`  | 结束时环境停在的版本（例如 `v5`），没有版本时为空                                         |
| `noop`     | 环境是否已经在目标版本、未执行任何迁移（`true` / `false`）                                |
| `response` | 服务端返回的完整 JSON 响应体                                                              |

## 失败行为

- 任意检查未通过或执行失败时，脚本输出错误码与原因（在 GitHub Actions 里用 `::error::[code] …` 标出），并以退出码 `1` 失败。
- 完整的接口契约与错误码表见 [docs/api.md](../../docs/api.md)。
