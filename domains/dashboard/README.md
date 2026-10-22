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

右上角的「中文 / EN」可切换整个 Dashboard 的界面语言，选择保存在当前浏览器中。
切换不会重置当前页面或表单，也不会改写用户内容、文档、日志和报告。
系统诊断、应用原因和仓库生成的知识说明会按界面语言显示，已保存的记录保持原样。
界面语言与 Native / Classic 设置中的产物语言分别配置。

切换页面或打开 Eval 详情时，地址栏保持 Dashboard 根地址。
浏览器历史记录保存所选项目、页面和运行身份，支持刷新以及前进、后退；不保存表单或凭据。
已有的 `?view=eval&project=...&run=...` 链接仍可打开，加载后会清理这些参数。
复制根地址到新标签页会打开默认工作区，不会指定某个评估运行。

侧栏「系统」右侧显示当前 Dashboard 使用的 Comet 版本。检测到 npm 新版本时显示 `new`，
点击后在设置风格的遮罩弹窗中查看目标版本和项目索引中的全部更新对象；确认后执行
`comet update --all-projects --yes --target-version <version>`。页面持续显示命令行输出，
右上角关闭窗口不会中断更新，重新打开可继续查看日志，刷新不会重复执行更新。
失败时可查看退出码并明确重试；更新完成后重新启动
Dashboard 使用新版本。日志保留在当前 Dashboard 进程中，不跨进程保存。

## Eval

在侧栏打开「评估 Eval」，查看当前项目的 CLI 和 Dashboard 评估记录，或选择本地
Skill、`comet/eval.yaml`、SDK `application.json` 创建评估。预览会展示用例来源、
内容身份和环境检查；不会调用模型。正式开始后会调用所选执行 Agent 和可选的独立 Judge。
新建评估默认自动识别目标类型。绝对路径可指向本机其他目录；相对路径基于顶部选中的项目，
与 Dashboard 的启动目录无关。手动更改目标类型会保留已输入的路径。

在「设置 → Eval」保存本机用户级执行模型、端点、凭据、独立 Judge，以及 Skill / SDK 应用
各自的默认预算，供所有项目复用。已有密钥只显示配置状态；留空保留，替换或移除后保存才生效。
新建评估默认展示执行摘要，需要调整时展开「临时覆盖本次配置」。缺少凭据的预检提示可直接打开
Eval 设置，不必手动编辑配置文件。设置页的本地环境检查不会调用模型或验证端点连接。

详情包含用例判定、样本质量、已知费用、报告、执行配置及 SDK 实际覆盖。
运行中的详情在标题下持续展示评估阶段、当前用例、已结束数量、耗时和最近执行活动；
切换结果、用例或产物标签页时仍可看到进度。执行活动只展示状态和工具类别，不包含模型思考或工具参数。
详情页的「评估报告」可直接预览已生成的 Markdown 和 HTML 报告，也可下载，文件名包含运行 ID。
「日志与产物」支持预览和下载日志、JSON 等其他文件；未生成的报告格式不可下载。
执行日志预览每 3 秒更新，支持关闭「跟随最新」以阅读前文；大日志预览显示末尾 256 KB，下载保留完整文件。
同一目标、固定用例与评分规则最多设置一个默认基线；不同目标或用例集各自管理。
完整且证据有效的运行可设为基线；可以替换或取消，历史结果和已启动运行的参照保留。
列表支持筛选进行中、已结束和基线记录；不可设为基线的原因可在「基线规则」及记录的提示中查看。
停止操作会核对进程和实验容器，未完成的结果保留。依赖或凭据缺失时，按预检说明修复
Docker、uv 或用户配置 `~/.comet/eval/.env` 后重新检查。

「只重跑失败用例」会创建新记录，复用原固定输入和评分规则并保留重复次数。
清单或规则已变化时须恢复原输入，或进行完整评估；失败重跑结果不能替换完整基线或 SDK 应用验收。
「常用配置」保存在当前项目的 `.comet/eval/presets.json`，支持保存、应用、更新和删除；不保存凭据、基线或重跑绑定，应用后重新预检。
首次无记录时显示准备步骤；「使用指南」可随时查看环境配置、费用和恢复说明。错误提示会给出对应的处理步骤。

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
