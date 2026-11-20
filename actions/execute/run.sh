#!/usr/bin/env bash
# Dowel CI 执行脚本（仅依赖 bash + curl，JSON 解析优先用 jq，缺省回退 node）。
# 令牌通过 curl --config - 经标准输入传入，不出现在命令行参数和日志里。
set -euo pipefail

# 转义 GitHub Actions 工作流指令里的特殊字符（防止换行注入额外指令）
escape_gha() {
  local s="$1"
  s="${s//'%'/'%25'}"
  s="${s//$'\r'/'%0D'}"
  s="${s//$'\n'/'%0A'}"
  printf '%s' "$s"
}

fail_input() {
  local msg="$1"
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::[invalid_input] %s\n' "$(escape_gha "$msg")"
  else
    printf '错误 [invalid_input]: %s\n' "$msg" >&2
  fi
  exit 1
}

url="${DOWEL_URL:-}"
token="${DOWEL_TOKEN:-}"
project="${DOWEL_PROJECT:-}"
env_name="${DOWEL_ENVIRONMENT:-}"
target_to="${DOWEL_TO:-}"
dry_run="${DOWEL_DRY_RUN:-false}"
lock_timeout="${DOWEL_LOCK_TIMEOUT:-30}"

[[ -n "$url" ]] || fail_input "缺少输入 url（DOWEL_URL）"
[[ -n "$token" ]] || fail_input "缺少输入 token（DOWEL_TOKEN）"
[[ -n "$project" ]] || fail_input "缺少输入 project（DOWEL_PROJECT，格式 owner/slug）"
[[ -n "$env_name" ]] || fail_input "缺少输入 environment（DOWEL_ENVIRONMENT）"
[[ -n "$target_to" ]] || fail_input "缺少输入 to（DOWEL_TO，例如 latest 或 v5）"

if ! [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then
  fail_input "url 必须是以 http:// 或 https:// 开头的有效地址"
fi

# 严格拒绝引号、反斜杠、空白与控制字符，彻底防止 curl --config - 配置注入
if ! [[ "$token" =~ ^[A-Za-z0-9._~:/+=@-]+$ ]]; then
  fail_input "token 含有非法字符（不能包含空白、引号、反斜杠或换行）"
fi

if [[ "$project" != */* ]]; then
  fail_input "project 必须是 owner/slug 格式：$project"
fi
owner="${project%%/*}"
slug="${project#*/}"
if [[ -z "$owner" || -z "$slug" || "$slug" == */* ]]; then
  fail_input "project 必须是两段 owner/slug 格式：$project"
fi

case "$dry_run" in
  true|false) ;;
  *) fail_input "dry-run 必须是 true 或 false，收到：$dry_run" ;;
esac

# 禁止前导零（避免 bash (( )) 按八进制解析 08/09 或拼出非法 JSON 010）
if ! [[ "$lock_timeout" =~ ^(0|[1-9][0-9]*)$ ]] || (( lock_timeout < 0 || lock_timeout > 30 )); then
  fail_input "lock-timeout 必须是 0～30 的十进制整数（不含前导零），收到：$lock_timeout"
fi

if ! [[ "$target_to" =~ ^([Ll][Aa][Tt][Ee][Ss][Tt]|[Vv]?[0-9]{1,9})$ ]]; then
  fail_input "to 必须是 latest、v<序号> 或 <序号>，收到：$target_to"
fi

# 路径段百分号编码（纯 bash，不依赖外部工具）
urlencode() {
  local str="$1"
  local i c hex out=""
  local LC_ALL=C
  for (( i = 0; i < ${#str}; i++ )); do
    c="${str:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

write_output() {
  local key="$1"
  local val="$2"
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  if [[ "$val" == *$'\n'* || "$val" == *$'\r'* ]]; then
    local rand=""
    rand="$(od -An -tx1 -N8 /dev/urandom 2>/dev/null | tr -d ' \n' || true)"
    local delim="DOWEL_EOF_${rand:-$$_${RANDOM}}"
    {
      printf '%s<<%s\n' "$key" "$delim"
      printf '%s\n' "$val"
      printf '%s\n' "$delim"
    } >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$key" "$val" >> "$GITHUB_OUTPUT"
  fi
}

# 读取 JSON 响应里的字段（逐行输出，避免空字段在 IFS 拆分时错位；优先 jq，没有 jq 时回退到 node）
parse_response() {
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '
      if type != "object" then error("not object") else . end |
      def clean: tostring | gsub("[\r\n]+"; " ");
      [
        (.ok // false | clean),
        (.code // "" | clean),
        (if .reached and (.reached.number != null) then ("v" + (.reached.number | tostring)) else "" end),
        (.noop // false | clean),
        (.error // "" | clean),
        (if .migrations then (.migrations | length | tostring) else "0" end),
        (if .from and (.from.number != null) then ("v" + (.from.number | tostring)) else "" end)
      ] | .[]
    ' "$file" 2>/dev/null || return 1
  elif command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("node:fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!d || typeof d !== "object" || Array.isArray(d)) process.exit(1);
      const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");
      const lines = [
        String(Boolean(d.ok)),
        clean(d.code),
        d.reached && d.reached.number != null ? `v${d.reached.number}` : "",
        String(Boolean(d.noop)),
        clean(d.error),
        String(Array.isArray(d.migrations) ? d.migrations.length : 0),
        d.from && d.from.number != null ? `v${d.from.number}` : "",
      ];
      process.stdout.write(lines.join("\n") + "\n");
    ' "$file" 2>/dev/null || return 1
  else
    return 1
  fi
}

base="${url%/}"
endpoint="${base}/api/ci/projects/$(urlencode "$owner")/$(urlencode "$slug")/environments/$(urlencode "$env_name")/execute"
payload="$(printf '{"to":"%s","dryRun":%s,"lockTimeoutSeconds":%s}' "$target_to" "$dry_run" "$lock_timeout")"

resp_file="$(mktemp)"
err_file="$(mktemp)"
cleanup() {
  rm -f "$resp_file" "$err_file"
}
trap cleanup EXIT

# 经标准输入传 header，避免令牌出现在进程列表里；仅允许 http/https 协议并用 -- 终止选项解析
http_code=""
if ! http_code="$(
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\nheader = "Accept: application/json"\n' "$token" \
  | curl -sS -X POST \
      --proto '=http,https' \
      --config - \
      --data "$payload" \
      --output "$resp_file" \
      --write-out '%{http_code}' \
      -- "$endpoint" 2>"$err_file"
)"; then
  curl_err="$(cat "$err_file")"
  write_output "ok" "false"
  write_output "code" "network_error"
  write_output "reached" ""
  write_output "noop" "false"
  write_output "response" ""
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::[network_error] %s\n' "$(escape_gha "无法连接 Dowel 服务：${curl_err}")"
  else
    printf '错误 [network_error]: 无法连接 Dowel 服务：%s\n' "$curl_err" >&2
  fi
  exit 1
fi

body="$(cat "$resp_file")"
ok_val="false"
code_val=""
reached_val=""
noop_val="false"
error_val=""
count_val="0"
from_val=""

if parsed="$(parse_response "$resp_file")"; then
  {
    IFS= read -r ok_val || true
    IFS= read -r code_val || true
    IFS= read -r reached_val || true
    IFS= read -r noop_val || true
    IFS= read -r error_val || true
    IFS= read -r count_val || true
    IFS= read -r from_val || true
  } <<< "$parsed"
else
  code_val="invalid_response"
  error_val="服务端返回了无法解析的响应（HTTP ${http_code}）"
fi

write_output "ok" "$ok_val"
write_output "code" "$code_val"
write_output "reached" "$reached_val"
write_output "noop" "$noop_val"
write_output "response" "$body"

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 && "$ok_val" == "true" ]]; then
  if [[ "$dry_run" == "true" ]]; then
    if [[ "$noop_val" == "true" ]]; then
      printf 'Dowel 预演通过：%s / %s 已在 %s（无需执行）\n' "$project" "$env_name" "${reached_val:-$target_to}"
    else
      printf 'Dowel 预演通过：%s / %s 将从 %s 执行到 %s（共 %s 个迁移）\n' \
        "$project" "$env_name" "${from_val:-(无)}" "${reached_val:-$target_to}" "$count_val"
    fi
  else
    if [[ "$noop_val" == "true" ]]; then
      printf 'Dowel 执行完成：%s / %s 已在 %s（无需执行）\n' "$project" "$env_name" "${reached_val:-$target_to}"
    else
      printf 'Dowel 执行完成：%s / %s %s -> %s（共 %s 个迁移）\n' \
        "$project" "$env_name" "${from_val:-(无)}" "${reached_val:-$target_to}" "$count_val"
    fi
  fi
  exit 0
fi

err_code="${code_val:-http_${http_code}}"
err_msg="${error_val:-请求失败（HTTP ${http_code}）}"
extra=""
if [[ -n "$reached_val" ]]; then
  extra="（环境当前停在 ${reached_val}）"
fi
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  printf '::error::[%s] %s\n' "$(escape_gha "$err_code")" "$(escape_gha "${err_msg}${extra}")"
else
  printf '错误 [%s] (HTTP %s): %s%s\n' "$err_code" "$http_code" "$err_msg" "$extra" >&2
fi
exit 1
