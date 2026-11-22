# CI 流水线集成

仓库内置的 [actions/execute](https://github.com/eimsound/dowel/tree/main/actions/execute) 用于在 CI/CD 流水线中通过项目 CI 令牌将指定环境预演或执行到目标版本。它由纯 `bash` 与 `curl` 实现（JSON 解析优先使用 `jq`，未安装 `jq` 时自动回退到 `node`），无第三方 Action 依赖。令牌经 `curl --config -` 从标准输入传入，不出现在命令行参数与进程列表中。

## 兼容平台 {#compatible-platforms}

- **GitHub Actions 与兼容运行器**：GitHub Actions、自建 **Gitea Actions**、**Forgejo Actions** 与 **GitHub Enterprise Server** 可直接以复合 Action 方式引用（内网运行器可将仓库镜像至内网后按内部路径引用）。
- **任意 Shell 流水线**：GitLab CI、Jenkins、Drone、Woodpecker、Buildkite 等可直接执行 `bash actions/execute/run.sh`，通过环境变量传入参数。

## 在任意 CI 中运行 `run.sh` {#run-sh}

```bash
DOWEL_URL="https://dowel.internal.example.com" \
DOWEL_TOKEN="$DOWEL_TOKEN" \
DOWEL_PROJECT="acme/shop" \
DOWEL_ENVIRONMENT="staging" \
DOWEL_TO="latest" \
DOWEL_DRY_RUN="false" \
DOWEL_LOCK_TIMEOUT="30" \
DOWEL_CONNECT_TIMEOUT="15" \
DOWEL_TIMEOUT="1800" \
bash actions/execute/run.sh
```

环境变量与下方 Action 输入一一对应：`DOWEL_URL`、`DOWEL_TOKEN`、`DOWEL_PROJECT`、`DOWEL_ENVIRONMENT`、`DOWEL_TO`、`DOWEL_DRY_RUN`、`DOWEL_LOCK_TIMEOUT`、`DOWEL_CONNECT_TIMEOUT`、`DOWEL_TIMEOUT`。

## 在 Actions 工作流中使用 {#github-actions}

> 引用外部或内部 Action 时建议固定到完整的 40 位提交哈希（commit SHA），避免直接引用可变分支名。

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
          dry-run: 'true'

      - name: 执行迁移
        id: migrate
        uses: eimsound/dowel/actions/execute@<40-char-commit-sha> # v1.0.0
        with:
          url: ${{ vars.DOWEL_URL }}
          token: ${{ secrets.DOWEL_TOKEN }}
          project: acme/shop
          environment: staging
          to: latest
          lock-timeout: '30'

      - name: 打印结果
        run: |
          echo "reached=${{ steps.migrate.outputs.reached }}"
          echo "noop=${{ steps.migrate.outputs.noop }}"
```

## 输入与环境变量 {#inputs}

| Action 输入       | 环境变量                | 必填 | 默认值  | 说明                                                              |
| ----------------- | ----------------------- | ---- | ------- | ----------------------------------------------------------------- |
| `url`             | `DOWEL_URL`             | 是   | —       | Dowel 服务地址（仅允许 `http://` 或 `https://`）                  |
| `token`           | `DOWEL_TOKEN`           | 是   | —       | 项目 CI 令牌（`dwl_…`，建议保存在 Secrets 中）                    |
| `project`         | `DOWEL_PROJECT`         | 是   | —       | 项目路径 `owner/slug`（两段格式）                                 |
| `environment`     | `DOWEL_ENVIRONMENT`     | 是   | —       | 目标环境名，例如 `staging`                                        |
| `to`              | `DOWEL_TO`              | 是   | —       | 目标版本：`latest`、`v5` 或 `5`                                   |
| `dry-run`         | `DOWEL_DRY_RUN`         | 否   | `false` | 设为 `true` 时只执行检查并返回计划，不写入目标库                  |
| `lock-timeout`    | `DOWEL_LOCK_TIMEOUT`    | 否   | `30`    | 等待执行锁的最大秒数（`0`–`30`）                                  |
| `connect-timeout` | `DOWEL_CONNECT_TIMEOUT` | 否   | `15`    | 建立 HTTP 连接的超时秒数（`1`–`3600`）                            |
| `timeout`         | `DOWEL_TIMEOUT`         | 否   | `1800`  | 整次 HTTP 请求的最长耗时秒数（`0`–`86400`，`0` 表示不限制总时长） |

## 输出 {#outputs}

| 输出名     | 说明                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `ok`       | 执行或预演是否成功（`true` / `false`）                                                     |
| `code`     | 失败时的机器可读错误码（例如 `drift`、`rollback_not_allowed`、`lock_timeout`），成功时为空 |
| `reached`  | 结束时环境停在的版本号（例如 `v5`），没有版本时为空                                        |
| `noop`     | 环境是否已经在目标版本而未运行任何迁移（`true` / `false`）                                 |
| `response` | 服务端返回的完整 JSON 响应文本                                                             |

## 失败行为与超时约定 {#failure-behavior}

- 参数校验不通过时返回 `invalid_input`，在发送请求前以退出码 `1` 中止。
- 任意服务端检查拒绝或迁移失败时，脚本输出对应错误码与原因（在 GitHub Actions 环境使用 `::error::[code] …` 标出）并以退出码 `1` 退出。
- 建连或整次请求超时、网络不可达时返回 `code=network_error` 并退出。由于 `POST /api/ci/.../execute` 支持 `to: "latest"`、可能含非事务或隐式提交步骤并会产生审计与 Webhook，脚本**绝不自动重试**；超时后应先调用只读接口或查看目标库状态再决定是否重新执行。
- 完整的 HTTP 接口字段及错误码说明见 [CI HTTP API](api.md#error-codes)。
