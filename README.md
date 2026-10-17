# dsh-weknora — 把 WeKnora 知识库放进 DeepSeek Harness

一个 DSH 组合包（bundle）：在 **DSH 左侧菜单新增「知识库」入口**，打开后是一套完整的
[WeKnora](https://github.com/Tencent/WeKnora) 知识库管理面板——浏览知识库、管理文章（上传 / 导入 /
撰写 / 编辑 / 重新解析 / 删除）、查看解析分块并直接编辑、语义检索，以及**使用 WeKnora 里配置好的
智能体**进行带引用的问答。同一份配置还会注册成 DSH Agent 的四个工具，让 DSH 里的对话可以直接
检索和引用你的知识库。

```
左侧菜单                       主区域
┌──────────────┐   ┌────────────────────────────────────────────────┐
│ 新会话        │   │ 知识库  WeKnora                [刷新] [设置]      │
│ 插件          │   ├────────────────────────────────────────────────┤
│ ▶ 知识库 ◀────┼──▶│ (知识库) (检索) (智能体)                          │
│ 工作区        │   │ 2 个知识库 · 4 篇文章      [+ 新建知识库]        │
│              │   │ ┌────────────┐ ┌────────────┐                 │
│              │   │ │ 产品文档    │ │ 售后 FAQ    │                 │
│              │   │ └────────────┘ └────────────┘                 │
└──────────────┘   └────────────────────────────────────────────────┘
```

---

## 1. 能力一览

### 左侧「知识库」面板

| 区域 | 能力 |
| --- | --- |
| 知识库 | 列表 / 置顶分组 / 名称与文档搜索、新建知识库（文档 / FAQ / Wiki）、删除知识库、卡片统计 |
| 文章管理 | 上传文件（多选，multipart 直传）、从 URL 导入、手工撰写 Markdown、编辑手工文章、删除、重新解析、分页 |
| 文档详情 | 解析分块按 Markdown 渲染、**编辑分块**（乐观并发 `expected_revision`）、原文件预览（PDF / 图片 / 文本编码嗅探）、复制 / 发送到对话 |
| 检索 | 多知识库范围选择、`POST /knowledge-search` 命中片段与分数、rerank 诊断 |
| 智能体 | 列出 WeKnora 中配置的智能体、选择范围、流式（SSE）提问、工具调用计数、引用来源、复制 / 发送到对话、多轮会话与「新对话」 |
| 设置 | 服务地址 / API Key / 租户 ID / 访问令牌 / 默认智能体、「测试连接」，保存在本机且**不会随对话发给模型** |

### DSH Agent 工具

同一次配置注册四个模型可调用工具，DSH 里任何会话都能用它们：

| 工具 | 作用 |
| --- | --- |
| `weknora_list_knowledge_bases` | 列出凭据可见的知识库（id / 名称 / 文档数） |
| `weknora_search` | 混合检索，返回原文片段与 `knowledge_id`，用于让模型基于证据回答 |
| `weknora_read_document` | 按顺序拼回一篇文档的分块，支持翻页 |
| `weknora_ask` | 交给 **WeKnora 中配置的智能体**回答，返回答案、引用与可续聊的 `session_id` |

工具名可用 `toolPrefix` 改名（同时挂两套部署时有用）。

---

## 2. 安装

DSH 的 profile 由应用管理，安装走官方插件入口：

1. 打开 DeepSeek Harness → 左侧「**插件**」→「**添加插件**」；
2. 粘贴本目录的绝对路径，确认安装；
3. 安装器会把它加入当前 profile 的 `dsh.profile.bundles` 并启用；
4. **刷新页面**（macOS 上 `Cmd+R`），左侧出现「知识库」入口。

> 说明：本包用 `dsh.bundle.patch` 声明组合包、用 `dsh.client` 声明浏览器侧 bundle。
> `client.js` 是纯 JS（不是构建产物），没有安装期构建步骤。

也可以从命令行安装（非 desktop profile）：

```sh
dsh plugin --profile web add /path/to/dsh-weknora
```

---

## 3. 配置

首次打开面板会直接显示「设置」。填写后保存，配置写到：

```
$DSH_HOME/weknora/config.json     # 默认 ~/.dsh/weknora/config.json，权限 0600
```

面板、宿主代理和 Agent 工具**共用这一份配置**，因此只需要配一次。按优先级：

1. 面板保存的设置（上面的文件）；
2. 环境变量 `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` / `WEKNORA_TENANT_ID` /
   `WEKNORA_AGENT_ID` / `WEKNORA_KNOWLEDGE_BASE_IDS` / `WEKNORA_TOOL_PREFIX`；
3. profile 的 `cordis.patch.yml` 里传给插件的 `config`。

字段：

| 字段 | 说明 |
| --- | --- |
| 服务地址 | WeKnora 部署地址，例如 `http://192.168.1.20:8080`；可带反向代理前缀，误带 `/api/v1` 会自动去掉 |
| API Key | `X-API-Key`。读需要 `retrieve`；写文章/编辑分块需要 `ingest`；`weknora_ask` 需要 `chat` |
| 租户 ID | 只填**数字空间 ID**（如 `7`）；空间级 Key 留空，平台级 Key 才需要 |
| 访问令牌 | 可选，JWT 替代 API Key（`Authorization: Bearer`） |
| 默认智能体 | 可选，`weknora_ask` 与智能体面板的默认选中项；留空则用面板里选的智能体 |

profile 级兜底写法：

```yaml
- id: weknora
  config:
    baseUrl: http://192.168.1.20:8080
    apiKey: !!js process.env.WEKNORA_API_KEY
    tenantId: '7'
    agentId: agent-1
    knowledgeBaseIds: [kb-123]
    toolPrefix: weknora
```

---

## 4. 架构

本包分两半，浏览器永远不直接跨域请求 WeKnora：

- **`index.js`（宿主侧，Node）**
  - 在 DSH web server 上认领前缀路由 `/weknora`，把 `/weknora/<path>` 转发到
    `服务地址 + /<path>`，在**服务端**补上 `X-API-Key` / `Authorization` / `X-Tenant-ID`；
  - 识别 `text/event-stream` 并**逐块透传**，所以智能体回答是流式的；
  - 本地路由：`GET/PUT /weknora/__config`（设置）、`POST /weknora/__test`（测试连接）；
  - 通过 `ctx.tools.register()` 注册四个 Agent 工具，工具执行时读取同一份设置。
- **`client.js`（浏览器侧，纯 JS）**
  - 向侧边栏 `sidebar.panellist` 注册「知识库」入口，并向 `main` 注册同 id 的面板；
  - 所有网络调用都走同源 `/weknora` 前缀，页面里没有 API Key。

安全边界：

- API Key 只存在于宿主进程和 `0600` 配置文件；`GET /__config` 只返回 `hasApiKey` / `hasToken` 标志；
- 允许的逐请求覆盖头：`x-weknora-base` / `x-weknora-key` / `x-weknora-token` / `x-weknora-tenant`；
- 租户 ID 在面板保存前、宿主转发前都会校验，避免 WeKnora 返回难懂的 `Invalid X-Tenant-ID header`；
- Markdown 渲染器不使用 `dangerouslySetInnerHTML`，上游文本一律作为 React 文本节点转义，链接只放行
  `http` / `https` / `mailto`，图片只显示 alt 文本。

---

## 5. 开发与测试

```sh
# 单元 + 集成测试（宿主路由、工具、浏览器 bundle 的 SSR 渲染）
node --test test/*.test.mjs

# 端到端：mock WeKnora + 隔离的 DSH profile + 无头 Chromium
node test/e2e/mock-weknora.mjs 19090 &
DSH_HOME=$PWD/.dsh-test node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile weknora-test --port 19402 --no-open
python3 test/e2e/panel.py "http://127.0.0.1:19402/?token=<printed-token>"
```

`test/e2e/panel.py` 会验证：侧边栏入口、设置「测试连接」、知识库列表与新建/删除、文章表格、
新建文章、重新解析、删除、multipart 上传、WeKnora 智能体流式问答与引用、检索命中，并截图到
`test/e2e/screenshots/`。

`test/e2e/desktop.py` 则用来检查**正在运行的桌面应用**：它复用桌面窗口自己的登录 Cookie，
在无头浏览器里加载 `127.0.0.1:19387`，确认侧边栏入口、真实知识库与真实智能体列表都渲染出来
（只读，不会改动 WeKnora 数据）。Cookie 可用 `sqlite3` 从
`~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` 读出后作为参数传入。

宿主半边的测试覆盖：设置落盘与权限、非法设置拒绝、凭据注入、multipart 原样转发、SSE 透传，
以及四个工具对真实 HTTP mock 的执行与渲染。

---

## 6. 兼容性

- 面向 DSH `0.2.0-rc.2` 开发与验证（`sidebar.panellist` / `main` 插槽、`ctx.tools.register()`）。
- 面向 WeKnora `0.7.x` 的 REST 形状开发；接口在小版本间有增删，面板对可选字段都做了回退读取。
- 插件自身没有运行时 npm 依赖，只使用 Node 内置模块与浏览器原生 API。

## License

MIT
