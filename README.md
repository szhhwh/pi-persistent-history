# pi-persistent-history

Pi 扩展：将输入编辑器的 prompt 历史（用 ↑/↓ 方向键浏览的那段 buffer）持久化到磁盘，跨重启保留；并提供**可交互的配置面板**。

## 安装

```bash
pi install git:git@github.com:szhhwh/pi-persistent-history
# 或临时试用：pi -e git:git@github.com:szhhwh/pi-persistent-history
```

安装后在 TUI 中执行 `/reload`（或重启 pi）即可生效。

## 存储位置

| 内容 | 路径 | 权限 |
|---|---|---|
| 配置 | `~/.pi/agent/prompt-history.config.json` | 0600 |
| 全局历史 | `~/.pi/agent/prompt-history.json` | 0600 |
| 项目级历史 | `~/.pi/agent/prompt-histories/<dir>.json` | 0600 |

文件创建为 0600（目录 0700），加载时还会把已有文件权限收紧。

## 配置面板（GUI）

在交互模式下输入：

```
/history-settings
```

会打开一个**可操作的配置面板**（基于 pi 内置的 `SettingsList` 组件渲染的模态覆盖层）：

- ↑/↓ 选择选项，`Enter` / `Space` 切换布尔/枚举值（`enabled`、`scope`、`dedup`、`recordCommands`）
- 数值选项（`maxEntries`、`maxEntryChars`、`minLength`）按 `Enter` 打开单行文本输入框，`Esc` 取消，非法输入会回退并提示
- 每次修改**即时生效**并写入磁盘， Esc 关闭面板

非交互模式（无 GUI）下 `/history-settings` 会直接打印当前状态文本。

## 搜索历史（Ctrl+R）

在交互模式的输入框中按 **Ctrl+R** 打开一个**独立的小弹窗**，对已有的 prompt 历史做反向增量搜索（类似 bash 的 reverse-i-search）：

- 直接键入即在历史中实时过滤；命中的子串会高亮
- ↑/↓（或再按一次 Ctrl+R）在结果间移动；最上面的框里显示当前搜索词
- 按 **Tab** 在 `project`（当前 scope）与 `all`（全局文件 + 所有项目文件合并去重）两种搜索范围间切换
- `Enter` 把选中的历史条目填入输入框，`Esc` 关闭弹窗

也可以用命令打开同一个弹窗：

```
/history
```

## 其他子命令

```
/history show [n]              列出最近 n 条（默认 10）
/history pick                  TUI 中从列表挑选一条填入编辑器
/history set <key> <value>     改选项（脚本/非交互用，等效面板）
/history remove <substr>       删除包含子串的条目
/history clear [--all] [--yes] 清空当前 scope 的文件（--all 清全部）
/history reload               从磁盘重新加载历史
/history path                 显示存储文件路径
/history help                显示用法
```

## 选项

| 选项 | 取值 | 默认 | 说明 |
|---|---|---|---|
| enabled | on \| off | on | 是否把历史写入磁盘 |
| maxEntries | 正整数 | 500 | 保留条目数上限 |
| maxEntryChars | 正整数 | 100000 | 超过此长度的条目仅留内存、不落盘 |
| scope | global \| project | global | 全局共享 / 按工作目录分别存储 |
| dedup | consecutive \| always \| off | consecutive | 去重策略 |
| recordCommands | on \| off | off | 是否持久化 `/` 和 `!` 输入 |
| minLength | 非负整数 | 0 | 短于此长度的条目不记录 |
| searchRows | 1–50 | 10 | 搜索 dock 固定显示的结果行数（固定高度，输入时布局不跳动） |

## 持久化语义

- 每次写入都会按当前配置重新过滤磁盘文件；收紧 `maxEntryChars` / `minLength` / `recordCommands` 会在下次提交时清除不匹配的条目。
- 写入与磁盘文件做 merge（精确重复折叠、最新在前），因此另一个 pi 进程写入的条目不会被覆盖丢失。
- 原子写入：先写随机名临时文件再 `rename`，避免半写与符号链接植入。
