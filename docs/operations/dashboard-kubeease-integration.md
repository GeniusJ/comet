# Dashboard KubeEase 接口提取

提取日期：2026-10-21。本文从用户提供的 KE Skill 和本地工具中整理接口，供 Dashboard 接入发布、流水线日志、应用状态和容器日志使用。Dashboard 已按这些接口实现接入，并通过模拟 HTTP/WebSocket 服务验证。真实 KE 的认证、流水线参数、环境列表、运行记录和详情结构已完成只读验证；实际流水线节点日志已完成只读取回；发布和实际容器日志尚未验证，未触发真实发布。

## 来源与能力

源目录：`/Users/yanghuajun/Documents/jiushi-sdd-framework/.agents/skills/`。

| 来源                                                      | 可提取内容                                   |
| --------------------------------------------------------- | -------------------------------------------- |
| `/Users/yanghuajun/Downloads/SKILL.md`、`ke-app/SKILL.md` | KE 子技能路由与能力分类                      |
| `ke-app-pipeline/SKILL.md`                                | 认证、流水线参数、触发、记录、状态、节点日志 |
| `ke-app-status/SKILL.md`                                  | 环境选择、应用状态、Pod 定位                 |
| `ke-app-status/docs/app-status-response.md`               | 工作负载、Pod、容器字段                      |
| `ke-app-status/scripts/hosts-config.js`                   | 本地凭证格式与读取逻辑                       |
| `ke-app-status/scripts/pod-log-client.js`                 | 容器日志 WebSocket 协议                      |

这些能力通过 KE HTTP/WebSocket 服务调用，无需依赖本地 `kubectl` 或 kubeconfig。流水线操作主要以 Skill 中的 API 说明提供，并非一个现成的独立 `ke` CLI；容器日志有 Node.js 辅助脚本。

## 配置映射

现有仓库绑定配置可以继续使用：

```yaml
ke_pipeline:
  base_url: 'http://pro.kubeease.cn'
  tenant: 'jstest'
  project: 'jstytest'
  application: 'core'
  environment: ''
  pipeline: 'coreceshiqianyi'
  action: 'run'
  arguments: {}
```

| 配置                 | 接口参数或用途                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `base_url`           | KE 服务地址，以下路径均相对此地址                                    |
| `tenant`             | `tenantName`                                                         |
| `project`            | `projectName`，指 KE 空间，与 Dashboard 本地项目目录区别             |
| `tenant` + `project` | `group = tenant-project`，本例为 `jstest-jstytest`；`namespace` 同值 |
| `application`        | `applicationName` / `appName`                                        |
| `environment`        | 应用状态中的 `envName`，容器日志中的 `cluster`                       |
| `pipeline`           | `pipelineName`                                                       |
| `action`             | 当前需求为 `run`                                                     |
| `arguments`          | 本次运行参数的显式覆盖值，需与参数定义、默认值一起确认               |

流水线接口路径不包含 `environment`。应用状态和容器日志必须指定环境；为空时应列出可用环境供用户选择。`arguments: {}` 不代表跳过参数准备、直接空参发布。

## 认证

HTTP 请求携带：

```http
leo-user-token: <访问令牌>
leo-user: {"userId":"<用户 ID>","userName":"<用户账号>"}
```

令牌管理页面为 `{baseUrl}/mine/access-token`。使用 `leo-user-token` 请求 `GET /user-center/v4/auth/userinfo`，从 `rtnData.userId`、`rtnData.userName` 构造 `leo-user` JSON 字符串。

源工具使用按服务地址区分的 `.hosts.json`：

```json
{
  "defaultHost": "http://pro.kubeease.cn",
  "hosts": {
    "http://pro.kubeease.cn": {
      "leoUserToken": "<访问令牌>",
      "leoUser": "{\"userId\":\"<用户 ID>\",\"userName\":\"<用户账号>\"}"
    }
  }
}
```

文档约定优先读取 `ke-app/.hosts.json`，否则读取具体子技能的 `.hosts.json`。用户提供的实际技能根目录是 `.agents/skills/`，原文中的 `.cursor/skills/` 需要按实际位置适配。当前本机存在 `ke-app-pipeline/.hosts.json`；已由服务端读取该文件完成认证的只读验证，未输出或复制凭证值。

Dashboard 应由服务端读取所选 `base_url` 对应的凭证，不将令牌保存到仓库绑定 JSON、发送给浏览器或写入日志。接入时不需要复制 Skill 的凭证迁移、删除旧 `.env` 或自动修改 `.gitignore` 操作。

HTTP 业务响应通常以 `rtnCode === "000000"` 表示成功，负载在 `rtnData`；适配器应同时处理 HTTP 错误和业务失败。

## 流水线发布与日志

以下用 `P = /pipeline/v1/group/{group}/pipelines/{pipelineName}` 缩写公共路径。路径段、查询参数须分别编码。

| 动作               | 方法与路径                                                                      | 关键响应                                                   |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 获取参数定义与历史 | `GET {P}/view`                                                                  | `rtnData.argumentHistory`、`rtnData.data.meta_data.global` |
| 触发运行           | `POST {P}/runtimes/create`                                                      | 创建响应的运行标识结构待实测核对                           |
| 查询运行记录       | `GET {P}/runtimes/list?sortBy=-createTimestamp&page=1&pageSize=1`               | `rtnData.data[]`，`name` 为 `runtimeName`                  |
| 查询指定运行       | `GET {P}/runtimes/{runtimeName}/view?a=1`                                       | `rtnData.currentPhase`、`rtnData.stages[]`                 |
| 查询节点日志       | `GET {P}/runtimes/{runtimeName}/logs/view?podName={podName}&containerName=main` | 说明中的日志字段为 `rtnData.data`                          |

### 参数准备

1. 读取流水线详情。有历史时取 `argumentHistory[0].global_args` 为默认参数，否则由 `data.meta_data.global[]` 的 `name`、`value` 构造。
2. 用参数定义的 `desc` 展示名称，提交键仍用 `name`；无定义时展示键本身。
3. 建议将仓库配置中的 `arguments` 作为显式覆盖值，合并后在页面展示供用户编辑、确认。此合并优先级是 Dashboard 接入建议。
4. Skill 约定以下内部参数不展示，提交时使用空字符串或接口要求的 `"{}"`：

```text
hide-value_wf-mutation-nacos-id
hide-value_wf-mutation-task
ke-nick-name
review
wf-front-url
wf-mutation-database-id
wf-mutation-nacos-id
wf-zendao-release-id
```

原说明存在冲突：文字要求上述参数置空，请求示例却将 `wf-front-url` 设为 `"false"`、`ke-nick-name` 设为具体用户名。当前实现遵循文字约定：前两个 `hide-value_` 参数使用 `"{}"`，其余使用空字符串，且不接受页面覆盖；未复制示例个人值。此默认行为还需在真实发布中核验。

确认后的请求结构：

```json
{
  "deadline": 86400,
  "globalArguments": {
    "url": "<确认后的仓库地址>",
    "branch": "<确认后的发布分支>"
  },
  "review": ""
}
```

上例只展示请求结构，完整 `globalArguments` 还需按流水线定义、内部参数要求构造。发布分支与本地开发分支分别处理，不能自动切换本地分支或直接取代发布参数。

### 状态与日志关联

真实服务的运行记录以每项 `data.name` 提供 `runtimeName`；适配器同时兼容 Skill 所述的直接 `name` 字段。运行记录的 `phase`：`1` 运行中、`2` 成功、`3` 失败、`4` 暂停。运行详情的整体状态在 `currentPhase`；节点包括 `phase`、`message`、`podName`、`displayName`。

触发后应绑定确切的 `runtimeName`，后续状态、节点和日志全部关联这次运行。运行记录查询可以展示历史，但不能把“最新一条”直接当作刚触发的运行，以免并发发布时串记录。创建接口是否直接返回运行名，需要实测确认。

节点日志的 `podName` 取运行详情的阶段节点，`containerName` 按 Skill 固定为 `main`。如果错误信息只有退出码，应读取节点日志再判断原因。

## 环境、应用与容器状态

可用环境：

```http
GET /user-center/v4/tenants/{tenantName}/projects/list?statistics=false&searchValue={projectName}
```

从空间记录的 `projectClusterList[]` 读取 `envName`，只展示 `proxyStatus === "CONNECTED"` 的环境。查询是模糊匹配，需核对所选空间；不要自动遍历不同环境猜测目标应用。

应用状态：

```http
GET /amp/v4/namespace/{namespace}/env/{envName}/applications/{appName}/appstatus/view?canary=false
```

读取 `rtnData.workloads[]`，展示工作负载的 `name`、`kind`、`replicas`、`readyReplicas` 和 `pods[]`。Pod 视图说明提供 `name`、`status`、`podIp`、`updated`、`unstructured` 等字段，容器名可从 `unstructured.spec.containers[].name` 获取；应列出真实容器供选择。

响应说明一处称 Pod 是原生 Kubernetes 对象，字段表又描述了带 `unstructured` 的 KE 包装视图，因此实际解析结构需用响应样例或只读调用核对。不要只凭“原生 Pod”这一描述假设所有字段路径。

## 容器日志 WebSocket

`pod-log-client.js` 使用 SockJS 的原始 WebSocket transport：

```text
ws(s)://{host}/amp/v4/ws/pods/log/{随机3位数字}/{随机8位字母数字}/websocket?token={编码后的令牌}
```

HTTP 地址对应 `ws`，HTTPS 地址对应 `wss`。连接在 Dashboard 服务端建立，避免向浏览器或普通日志暴露带令牌的连接地址。

连接后发送数组，其中一项为 JSON 字符串：

```js
JSON.stringify([
  JSON.stringify({
    tailLines: 500,
    cluster: '<envName>',
    podName: '<所选 Pod>',
    containerName: '<所选容器>',
    tenantName: 'jstest',
    projectName: 'jstytest',
    timestamps: true,
    sinceTime: '',
    allContainers: false,
    previous: false,
  }),
]);
```

`previous: true` 表示查询上次容器实例的日志，可用于重启排查。原脚本默认最近 500 行、空闲超时 15 秒、总时长 60 秒。

收包时忽略 `o` 打开帧；`a[...]` 数据帧先解析外层数组，再解析各项 JSON 字符串，提取 `Data ?? data`。移植时需补充心跳 `h`、关闭帧、解析失败、连接失败、取消、输出大小上限和日志截断提示。

不能直接 import 原脚本：它在顶层读取 CLI 参数、连接网络、调用 `process.exit`，并在缺少 `ws` 时自动运行 `npm install --no-save ws`。应只提取协议，改成显式依赖、无导入副作用的适配器。

## 接入边界与待验证项

Dashboard 的 Kubernetes 页面可以继续以当前工作目录绑定的工程为列表，使用每个工程的 `ke_pipeline` 定位 KE 流水线和应用；发布前展示参数，日志区分别提供流水线节点日志和应用容器日志。网络与凭证适配放在 `platform/`，工程配置、参数准备与运行关联放在 `domains/dashboard/`。

后续真实服务验证项：

- 核对上述内部参数冲突、创建运行响应标识，以及日志与应用状态实际响应结构。运行记录已经按真实响应的 `data.name` 适配。
- 适配凭证路径。现有 `hosts-config.js` 从子技能根拼接 `../../ke-app/.hosts.json`，按当前目录结构会指向 `.agents/ke-app/`，与兄弟技能目录 `.agents/skills/ke-app/` 不符。
- 配置或选择应用环境；环境留空时不猜测容器日志目标。
- 模拟服务已验证鉴权、参数确认、单次运行关联、日志帧、取消及输出上限；真实发布独立验证。

真实凭证仅在服务端读取并用于只读验证，未输出令牌值、触发发布或修改外部技能目录。回滚、审核、远程终端和文件传输不属于本次发布与日志接入范围。

## Dashboard 运行配置

使用 `COMET_KE_HOSTS_FILE` 指定本机凭证文件。未指定时，按顺序查找 `~/.config/comet/kubeease-hosts.json`，再查找当前工作目录 `.agents/skills/`、`.cursor/skills/` 中 `ke-app`、`ke-app-pipeline`、`ke-app-status` 的 `.hosts.json`。只读取匹配 `base_url` 的令牌，不跨主机回退；不自动迁移或改写凭证。

发布准备会生成绑定当前工作目录、工程和配置的确认标识，有效期 10 分钟，最多提交一次。参数编辑后在确认请求中提交；参数键集合必须与准备结果一致。配置变化、过期或重复确认均需重新准备。请求结果不确定时先核对运行记录，不能自动重试发布。

容器日志用 KE 的 SockJS WebSocket transport；当前单次查询总时长 30 秒、日志空闲 5 秒后返回快照，最多展示 128 KiB。心跳不延长日志空闲截止。页面可定时请求后续快照，关闭页面或切换环境会取消查询。

日志展示前会遮蔽当前 KE 令牌、链接中的常见令牌/密钥参数及 Authorization 值；日志仍只在本机 Dashboard 查询。
