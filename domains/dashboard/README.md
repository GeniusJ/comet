# Comet Dashboard

本目录包含 `comet dashboard` 本地仪表盘：后端采集当前仓库的
`openspec/changes`、Git 与验证状态，并支持管理项目设置、插件生命周期、个人记忆和
项目知识记录；前端是位于 `web/` 的 React + Tailwind CSS 应用。

## 启动

在仓库根目录运行：

```powershell
pnpm build
node .\bin\comet.js dashboard . --port 4399 --no-open
```

然后打开：

```text
http://localhost:4399/
```

停止服务：回到运行命令的终端按 `Ctrl+C`。

## 添加和切换项目

使用顶部项目选择框切换项目。点击旁边的 **＋ 添加项目**，可输入项目的绝对路径，
也可通过 **选择文件夹** 打开运行 Dashboard 的电脑上的系统文件夹选择器。
添加后立即切换，项目保存在本地项目索引中，重启后仍可选择；不会安装 Skill 或修改项目文件。
没有图形桌面或无法打开选择器时，仍可手动输入路径。

Use the project selector in the header to switch projects. Click **＋ 添加项目** to enter an
absolute path or open the server machine's native folder picker with **选择文件夹**.
Adding a project switches to it immediately and saves it in the local project index for future
sessions, without installing Skills or changing project files. Manual entry remains available
when a native picker cannot run.

## 项目维护与 Git 工程

点击左侧 **项目管理 → 仓库管理**，在右侧页面维护当前选中工作目录下的多个 Git 工程。
首次进入会扫描 `engineering/backed/` 和 `engineering/frontend/` 的直接子目录，
勾选已有 Git 仓库后纳入管理，不拉取或改动本地代码。可暂不添加，之后通过 **扫描本地仓库** 再次选择。
无法直接绑定的仓库会显示原因，已绑定仓库不重复列出。
已绑定仓库以分页列表展示，支持关键词、前后端类型和自定义标签组合筛选；多选标签时匹配同时具有这些标签的仓库。
点击 **新增仓库** 或列表中的 **编辑绑定** 打开弹窗，设置工程名、类型、分支和标签；标签随绑定保存。
在弹窗中点击 **保存并拉取** 获取代码：

- 后端默认保存到 `<项目目录>/engineering/backed/<工程名>`。
- 前端默认保存到 `<项目目录>/engineering/frontend/<工程名>`。
- 首次拉取执行克隆，之后仅快进更新；留空分支使用仓库默认分支或本地当前分支。
- 仓库有未提交文件、分支不符或 origin 不匹配时停止更新，分叉分支不会自动合并。
- **解除绑定** 只移除记录，保留本地代码。已有代码时若需更改工程名或类型，请先自行安排目录，再重新绑定。

绑定保存在各项目的 `.comet/dashboard-repositories.json`，切换项目后独立维护。
支持 HTTPS、SSH 和本地绝对路径，认证使用运行 Dashboard 的电脑上已有的 Git 配置；
不要在地址中填写账号密码或令牌。

Open **项目管理 → 仓库管理** in the sidebar to manage multiple Git repositories
on the main page for the currently selected working directory. On first entry, select existing repositories
from the immediate subdirectories of `engineering/backed/` and `engineering/frontend/` to save bindings
without fetching or changing local code. Skip initialization or scan again later with **扫描本地仓库**.
Repositories that cannot be bound show a reason; existing bindings are excluded from the scan.
The paginated repository list supports combined keyword, type and custom tag filters; selected tags must all match.
Use **新增仓库** or a row's **编辑绑定** to open a dialog and set the name, type, optional branch and tags.
Tags persist with the binding. Choose
**保存并拉取** to clone into `engineering/frontend/<name>` or `engineering/backed/<name>`
under that project's directory. Later pulls only fast-forward the current branch; dirty
workspaces, mismatched branches or origins, and divergent history stop the update.
A blank branch uses the remote default on clone and the local current branch on updates.
Removing a binding keeps local code. Bindings are stored separately for each project in
`.comet/dashboard-repositories.json`. HTTPS, SSH and absolute local paths are supported,
using the server machine's existing Git authentication without credentials in repository URLs.

## Kubernetes 工程与日志

在仓库新增/编辑弹窗的 **Kubernetes 发布** 页签中，分别启用 KubeEase 流水线和
Kubernetes 运行环境配置。左侧 **项目管理 → Kubernetes** 展示当前工作目录的全部已绑定工程，
可按工程名、标签、集群、命名空间或流水线查找，也可从列表直接编辑配置。
配置随仓库绑定保存在 `.comet/dashboard-repositories.json`，切换工作目录后独立维护。

工程配置中的 `ke_pipeline` 用于发布、流水线日志及 KE 应用的状态和容器日志，无需安装 `kubectl`。
发布前先读取历史默认参数，并应用仓库配置中的 `arguments`，在弹窗中编辑、确认后触发一次运行。
发布成功后关联具体运行记录；也可手动选择历史记录和节点查看日志。未返回运行标识时会提示核对记录，避免重复发布。
`environment` 留空时，查看状态与容器日志需先选择可用 KE 环境。支持 Pod、容器、最近行数和上次容器日志选择。
容器日志为最长 30 秒、空闲 5 秒结束的快照；可自动刷新，每次最多展示 128 KiB。

两类日志均支持文本搜索、自动换行，以及通过本机 Codex CLI 对当前日志快照提问和连续追问。
AI 分析的使用方式、快照范围和本机依赖见[日志 AI 分析说明](../../docs/operations/dashboard-log-ai-analysis.md)。

服务端按 KE 地址读取本地凭证，优先使用环境变量 `COMET_KE_HOSTS_FILE` 指定的 `.hosts.json`；
未指定时依次查找 `~/.config/comet/kubeease-hosts.json` 和当前工作目录 `.agents/skills/`、`.cursor/skills/` 中
`ke-app`、`ke-app-pipeline`、`ke-app-status` 的 `.hosts.json`。文件结构见[KE 接入说明](../../docs/operations/dashboard-kubeease-integration.md)。
令牌不存入工程绑定配置，也不发送给浏览器；日志中的常见令牌链接与 Authorization 值会遮蔽后展示。保留独立的本地 Kubernetes 查询配置，供已配置 kubeconfig 的工程使用；同时配置 KE 时优先通过 KE 查询。

KubeEase supplies releases, pipeline logs, application status and container logs without requiring local `kubectl`.
Review and edit prepared parameters before confirming a single release. Inspect the exact submitted run or select a historical run and stage.
Choose a connected KE environment when one is not configured, then select a Pod and container, including previous container logs.
Container logs are bounded snapshots with optional refresh and a 128 KiB display limit.
The server reads host-specific credentials from `COMET_KE_HOSTS_FILE`, or from the local configuration locations described above;
tokens remain on the server, and common token-bearing URLs and Authorization values in logs are redacted before display.
Independent kubeconfig targets remain supported, with KE taking precedence when both are configured.

## Demo 模式

如果只是预览页面效果，不读取当前仓库真实数据，在 URL 后加 `?demo`：

```text
http://localhost:4399/?demo
```

Demo 数据来自 `web/demo.js`，适合检查首屏、侧边栏、卡片和响应式布局。

## 常用选项

```powershell
node .\bin\comet.js dashboard . --port 4399
node .\bin\comet.js dashboard . --port 4399 --no-open
node .\bin\comet.js dashboard . --json
```

- `--port 4399`：指定 HTTP 端口；如果端口被占用，Dashboard 会尝试后续端口。
- `--no-open`：只启动服务，不自动打开浏览器。
- `--json`：只输出一次 Dashboard snapshot，适合脚本检查，不启动浏览器服务。

## 产物分组

Dashboard 将关键产物按来源分为三组展示：

| 分组            | 产物                                                           | 说明                                                       |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| **OpenSpec**    | proposal, design, tasks, deltaSpec                             | 变更目录内的规格文件                                       |
| **Superpowers** | designDoc, plan, verifyReport                                  | 通过 `.comet.yaml` 路径指针引用的 `docs/superpowers/` 文件 |
| **Comet**       | .comet.yaml, handoff, checkpoint, brainstorm, subagentProgress | `.comet/` 中间产物                                         |

部分产物根据变更状态显示不同标记：

- **已生成**：文件存在，可预览
- **未生成**：预期产物但尚未创建
- **无需生成**：当前模式/阶段不适用（如 subagent-progress 在 `executing-plans` 模式下）

## 开发提示

Dashboard 后端是 `domains/dashboard/*.ts`，前端是 `web/` 下的 React 应用，通过 Vite 构建：

```powershell
pnpm build:dashboard
```

修改 `domains/dashboard/web/` 后，如果通过 `bin/comet.js` 启动，需要先运行
`pnpm build`，因为 CLI 入口读取的是 `dist/` 下的构建产物；完整构建会同时编译
后端 TypeScript、Classic runtime 与 React/Tailwind 前端。
