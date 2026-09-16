# tvision

**给 DeepSeek Harness 智能体的字符型窗口管理器。** 带投影的重叠窗口、Borland 式菜单栏、功能键提示条、鼠标拖拽、五套配色皮肤——以普通的 dsh profile bundle 形式安装，不是 fork。

```
  File  View  Agent  Tools  Window  Help                        dsh tvision
╔╡                        Conversation                        ═╞═╗┌┤    Project     ─├─┐
║> You                                                            ║  o src/parser.ts   │
║  why is the first token so slow?                                ║  o src/stream.ts   │
║                                                                 ║  o README.md       │
║| Agent · 1.4s                                                   ║                    │
║  The parser buffers the whole document before it emits          ║                    │
║  anything, which is why the first token never arrives until     ║                    │
║  the whole file is read.                                        ║                    │
║                                                                 ║                    │
║~ bash  npm test -- parser                                       ║┌┤     Tasks      ─├─┐
║  ok ▸                                                           ║  ✓ Find why it is  │
║                                                                 ║  ▸ Make the parser │
║─────────────────────────────────────────────────────────────────║  · Update the test │
║dsh> refactor it so it streams                                   ║                    │
╚═════════════════════════════════════════════════════════════════╝  ░ ░ ░ ░ ░ ░ ░ ░ ░ ░
             │ F10 menu │ 3 win │ ████░░ 62% │ ↑12.4k ↓3.1k │ deepseek-flash
F1 Help      F2 New       F3 Open      F4 Tools     F5 Focus     F6 Next      F7 Project
```

[English](README.md) | 中文

---

## 不需要智能体就能先看看

不需要 API key、不需要 profile、不需要联网。demo 用一段脚本化的智能体驱动真实的桌面：

```sh
npm install
npm run build
node lib/demo.js                 # Turbo Vision 蓝
node lib/demo.js --skin amber    # P3 琥珀单色
node lib/demo.js --list-skins
```

随便输入点什么按回车就会重放脚本；`F1` 列出按键，`F10` 打开菜单。

---

## 作为 dsh profile 安装

需要 Node `^22.19 || >=24` 与 `dsh` CLI。

```sh
dsh plugin --profile tvision add @dsh-tvision/dsh-tvision
dsh --profile tvision                                    # 在当前目录开启会话
dsh --profile tvision --resume <session-id>              # 恢复历史会话
dsh --profile tvision --skin amber --no-mouse            # 启动选项
```

在环境变量（或启动目录 / `$DSH_HOME` 下的 `.env`）里设置 `DEEPSEEK_API_KEY`。本地或自建端点无需改代码——把 `DEEPSEEK_BASE_URL` 指过去，或在 `$DSH_HOME/settings.yaml` 里设置 `llm-deepseek.baseURL`。

> **状态。** 桌面能挂载、能绘制、能接收输入、能流式渲染对话、能弹出审批对话框。一次真实的模型回合尚未在本机端到端跑通；具体哪些接通了、哪些没有，见[设计文档的范围一节](docs/DESIGN.md#6-what-is-not-finished)。

---

## 按键

### 全局

| 按键 | 作用 |
|---|---|
| `F1` | 帮助——完整按键表与鼠标说明 |
| `F2` | 新会话 |
| `F3` | 会话窗口 |
| `F4` | 展开 / 折叠全部工具卡片 |
| `F5` | 聚焦输入行 |
| `F6` | 下一个窗口 |
| `F7` | 项目窗口 |
| `F8` | 任务窗口 |
| `F9` | 切换皮肤 |
| `F10` | 菜单栏 |
| `Ctrl+Q` | 退出 |
| `Ctrl+C` | 取消当前回合 |
| `Ctrl+O` | 展开 / 折叠工具卡片 |
| `Ctrl+R` | 显示 / 隐藏思考过程 |
| `Ctrl+Z` | 缩放当前窗口 |
| `Ctrl+L` | 重绘屏幕 |

### 菜单

`F10` 进入菜单栏，`←`/`→` 在栏上移动，`↓` 拉下列表。`Alt` + 带下划线的字母可直接打开对应菜单；在已打开的列表里按同样的字母会直接执行该项。

### 输入行

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Alt+Enter` | 插入换行而不发送 |
| `Tab` | 补全 `/命令` 或 `@文件` |
| `↑` / `↓` | 浏览输入历史 |
| `Ctrl+A` / `Ctrl+E` | 行首 / 行尾 |
| `Ctrl+U` / `Ctrl+K` | 删到行首 / 行尾 |
| `Ctrl+W` | 删除前一个词 |

### 对话区

| 按键 | 作用 |
|---|---|
| `PageUp` / `PageDown` | 翻页 |
| `↑` / `↓` | 滚动一行 |
| `Home` / `End` | 跳到开头 / 结尾 |

向上滚动离开末尾后，新输出不会再把你拽回底部；按 `End` 恢复跟随。

### 鼠标

拖标题栏移动窗口 · 拖右下角 `⋮` 缩放 · 点 `≡` 关闭 · 点 `▲` 或双击标题最大化 · 滚轮滚动指针底下的任何东西，包括功能键提示条。

---

## 皮肤

| `--skin` | |
|---|---|
| `tvision` | Turbo Vision——Borland 蓝：深蓝桌面上的青色窗口框 |
| `phosphor` | P1 绿色 CRT——单一色相，层级全靠亮度 |
| `amber` | P3 琥珀——更暖，长时间看更舒服 |
| `slate` | 现代深色——只要窗口管理器，不要怀旧戏服 |
| `ansi` | 终端自带的十六色，继承而非强加 |

每套皮肤是完整的约 55 个语义角色，而不是换一组颜色：因此在某套皮肤下能看清的控件，在其他皮肤下同样能看清。

---

## 为什么这样做

一句话：**智能体天然适合字符型 IDE。** 它的活动本来就是文件编辑、shell 命令、diff、任务列表、子代理——这正是当年 Borland 那套界面为之而生的东西，只是少了调试器。

这不是「加了个边框的聊天 TUI」，而是一个窗口管理器：

- **带投影的重叠窗口**：层次在你读一个字之前就已经可见。
- **活动窗口用双线框，非活动用单线框**：隔着房间也能看出键盘要去哪。
- **菜单栏浮于所有窗口之上**：没有任何能力只是「键盘圈的传说」。
- **功能键提示条由键位表生成**：所以它不会说谎。
- **固定单行的输入行**：会自己长高的输入框会把整段对话推上推下。
- **模态对话框就是普通窗口**：审批提示因此白拿同一套键盘、鼠标与焦点逻辑。

对话区左侧有一个字符的装订线——`>` 是你、`|` 是智能体、`·` 是思考、`~` 是工具、`!` 是错误——于是对话的形状先于文字可见。工具调用折叠时占一行，展开后是带框的实体，diff 按增删着色。

完整的设计推理、架构说明与「刻意没做完的部分」，见 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 开发

```sh
npm install
npm run typecheck     # tsc --noEmit
npm test              # 411 个测试
npm run build         # 打包到 lib/
npm run demo          # 跑 demo
```

测试值得单独说一句。`tests/compositor.spec.ts` 把画好的帧重放进**真实的终端模拟器**（xterm.js headless），然后逐单元格比对结果网格——这是唯一能抓住「转义字符串看着对、屏幕上却是错的」那类 bug 的办法。`tests/snapshot.spec.ts` 把整屏帧**以 ASCII 形式**签入仓库，所以 review diff 时能直接看到整个界面：

```sh
Tvision_SNAPSHOT=refresh npx vitest run tests/snapshot.spec.ts
```

### 目录结构

```
src/kit/        cell · text · styles · screen · painter · widget · wm · input · skin
src/session/    保留式文档模型
src/views/      transcript · dialogs
src/widgets/    frame · menubar · statusbar
src/app/        app · composer · questions · events
src/term/       真实终端
```

`kit/` 不 import 它上面的任何东西，也不知道「智能体」是什么；它本身就是一个通用的字符窗口库。

---

## 致谢

MIT。实现是原创的；**集成方式**参考了 `deepseek-harness` 上游移除、后被恢复为 [`@dsh-tui/dsh-tui`](https://github.com/dsh-tui/dsh-tui)（MIT，DeepSeek 与 OpenGuardrails）的开源终端前端——Cordis 插件的组织方式、会话事件折叠的职责划分、审批与提问的 waterfall 接缝、以及测试基建的思路都以其为范本。也正是因为读了它，才发现它自带的两处 API 漂移。

界面的形态则要归功于 Turbo Vision（Borland）、Midnight Commander 与 [moc](https://github.com/jonsafari/mocp)。
