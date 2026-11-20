# Dowel Execute GitHub Action

用于在 GitHub Actions 流水线里，通过 Dowel 项目 CI 令牌把指定环境执行（或预演）到目标版本。

这是一个只用 `bash` 和 `curl` 实现的复合 Action（不依赖第三方 Action），令牌通过 `curl --config -` 从标准输入传入，不会出现在命令行参数或日志里。

## 用法示例

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
