# finch-multi-agent

Run a job as a team of sub-agents — inside the conversation you are already in.

You describe what you want in plain language. Finch splits it into subtasks, starts one
worker Session per subtask, and runs them in parallel. Each worker hands its result back as
an **artifact** — an immutable, content-hashed snapshot — instead of pasting it into someone
else's chat. A versioned run report and an explicit handoff graph keep the whole thing
auditable after the fact.

There is no extra window to learn: the tool runs in the current conversation, every task is
tied to its own Session, and the answer comes back where you asked.

## What it is good for

- **Parallel research** — one worker per source, topic, competitor or document, then one
  synthesis step.
- **Multi-module review** — one reviewer per file, package, or subsystem, each with its own
  fresh context window.
- **Batch processing** — translate, summarise, or classify a pile of items in parallel.
- **Multi-stage drafting** — outline → sections → editorial pass, where each stage consumes
  the previous stage's artifact through an explicit handoff.

It is **not** a fit for small jobs, tightly coupled work, or anything that needs fast
back-and-forth — a single agent is cheaper and faster there.

## How you use it

Just ask, the way you normally would:

> Split this into parallel sub-agents: research the three competitors in `docs/market/`,
> one worker each, then have a fourth worker compare them into a single positioning brief.

> Review each of these four packages in its own sub-agent, then collect the findings.

> Translate these six pages at the same time and merge them into one file.

Finch plans the subtasks, starts them, tells you which are still running, and reads the
results back when you ask for the final answer. You never have to say "use
`multi_agent_run`".

## What you get back

- **One Session per task — all of them, right away.** Every worker Session is created the
  moment you dispatch, including the ones that must wait for an upstream worker. They all
  nest under the conversation you asked in and share a batch label, so the batch stays
  together in your session list instead of scattering across it.
- **Titles that say who is doing what.** Each worker's session title reads
  `<role> · <what it is doing>` — “竞品调研 · 摸清三家定价”, not “定价情况”. You can tell
  what a worker is up to from the session list alone.
- **One call, live progress.** Dispatching waits for the batch and reports progress while it
  waits, so you are not watching an agent wake up every minute to ask “done yet?”. If a batch
  outlives one call, the assistant keeps waiting on it rather than handing the job back to you
  — you only hear about it when it is actually done.
- **Real deliverables.** The finished answer is assembled from the workers' published
  artifacts, with the artifact ids and content hashes listed so you can tell whether two
  results are byte-identical.

## Changing course mid-run

From your side there are only ever two steps: you ask, you get the answer. The planning,
parallel execution and waiting all happen inside one continuous chain of tool calls, and
Finch keeps waiting on the workers rather than handing the job back to you to babysit.

If you interrupt with a new direction — "actually, drop the Cursor research and look at
Cline instead" — the run bends instead of restarting. The affected subtasks are stopped,
their replacements are queued into the **same** run, and anything that was waiting on them
carries on with the new result. Workers you didn't touch are never disturbed, and the
shared report keeps its history.

## A team, not a batch

The first release fanned out a fixed set of subtasks. Real work is not like that: you look at
what came back before deciding what to do next, roles wait to be activated, and people ask each
other for things. So a run is now a **collaboration graph you can keep editing while it runs**.

- **Plan as you go.** `dispatch` the first step, read the result, then `add` the next one to the
  *same* run. Nothing needs to be guessed up front, and the scope, report and handoff history
  carry on.
- **Roles that wait to be activated.** Give a task `hold: true` and its worker Session is
  created and grouped under this conversation but does not start until you `start` it — the
  standing team, started on demand.
- **Redirect in one call.** Re-using a task id in `add` replaces that task: the old turn is
  stopped and anything depending on it picks up the new result. `drop` stops work without
  replacing it.
- **Workers ask each other for things.** A worker that cannot finish without a peer's output
  ends its turn with `NEED: <task id>` instead of guessing. The run turns that into a dependency
  edge: the peer's artifact is delivered to that worker and it carries on in the same
  conversation. If the peer has not produced yet, the task is parked and resumes on its own.
- **Stuck work comes back to you, not into a hang.** When something needs a decision — a
  requested role nobody created, a failed upstream, an unanswered card — the wait returns early
  and says what is stuck and why.
- **Everything stays under the originating conversation.** Every worker Session is created
  inside a tool call, so it does not matter whether a task was planned up front, added an hour
  later, or created to answer another worker's request: it is all grouped under the Session you
  asked in.

### The project-team example

A product build with a planner, an architect, a frontend dev, a backend dev and QA — with the
conversation as the project manager:

1. `dispatch` the planner, architect, frontend and backend as parallel tasks.
2. QA is declared with `hold: true`, so its Session exists but does not burn a turn yet.
3. QA needs everyone's requirements, so instead of guessing a dependency graph up front, it is
   simply started once the others are in — or it starts, finds it is missing something, and ends
   its turn with `NEED: architect`. Either way the run gets it the material and lets it finish.
4. If the architect's contract changes, `add` a replacement task with the same id: QA's edge
   stays intact and it consumes the new contract.

## Choosing models

By default every worker uses your normal app default model, and you can ask for a specific
one in plain language: *"use Opus for the reasoning tasks, a fast model for the rest."*
Finch looks up your actually-enabled models first, maps what you said onto a real
`provider:model` key, and assigns it per task. If a name doesn't match anything, it says so
instead of quietly using the default.

Set a standing preference under **Settings → Default worker model**: the row shows the chosen
model and its provider, and opens a submenu grouped provider → model. Pick "Follow app
default" to go back.

## Notes

- Run state is kept in a local SQLite database inside the mini tool's own storage folder —
  nothing leaves your machine, and no network access is requested.
- Workers run with automatic permission handling so an unattended run does not stall; a
  genuinely dangerous operation still waits for you.
- Requires Finch 1.7.0 or newer.

---

# finch-multi-agent（中文）

把一件事交给一支子智能体小队——就在你当前这个对话里完成。

你用自然语言说明想要什么，Finch 会把它拆成子任务，为每个子任务启动一个 worker 会话并行执行。
每个 worker 交出的是**产物**（不可变、带内容哈希的快照），而不是往别人的对话里粘贴一段回复。
整轮任务的报告以带版本号的文档维护，交接关系也被显式记录下来，事后可以完整追溯。

没有额外的窗口要学：工具就在当前对话里执行，每个任务绑定自己的会话，答案回到你提问的地方。

## 适合什么场景

- **并行调研** —— 每个来源 / 主题 / 竞品 / 文档一个 worker，最后再汇总一步。
- **多模块审查** —— 每个文件、包或子系统一个 reviewer，各自拥有全新的上下文窗口。
- **批量处理** —— 并行翻译、摘要、分类一批条目。
- **多阶段起草** —— 提纲 → 分节 → 统稿，每一阶段通过显式交接消费上一阶段的产物。

它**不适合**小任务、强耦合的工作，以及需要快速来回确认的事情——那些场景单智能体更快也更省。

## 怎么用

像平常一样提要求就行：

> 把这件事拆给多个子智能体并行做：调研 `docs/market/` 里的三家竞品，每家一个 worker，
> 再由第四个 worker 把它们综合成一份定位简报。

> 这四个包各用一个子智能体审查，然后把结论收集起来。

> 这六页同时翻译，最后合并成一个文件。

Finch 会自己规划子任务、派发执行、告诉你哪些还在跑，并在你要最终答案时把结果读回来。
你不需要说出 `multi_agent_run` 这个名字。

## 能拿到什么

- **每个任务一个会话，而且一开始就建好。** 发起的那一刻，所有 worker 会话（包括要等上游的）
  就都创建好了，统一挂在当前对话下面、带上同一批次的标签，因此这批会话会稳稳聚在一起，
  而不会散落在会话列表各处。
- **标题说清谁在干什么。** 每个 worker 的会话标题都写成「角色 · 在做什么」——
  「竞品调研 · 摸清三家定价」，而不是「定价情况」。光看会话列表就知道它在忙什么。
- **一次调用，进度实时。** dispatch 会自己等完整批并实时汇报进度，不用看着 agent 每分钟
  醒一次问「好了吗」。如果一批活超出了一次调用的等待窗口，助手会接着继续等，
  而不是把活退回给你——真正跑完了它才来汇报。
- **真正的产出。** 最终答案由各个 worker 发布的产物拼装而成，并列出产物 id 与内容哈希，
  因此可以判断两份结果是否逐字节一致。

## 中途改方向

对你来说永远只有两步：提问 → 拿到结果。规划、并行执行、等待都在一条连续的调用链里完成，
Finch 会一直盯到出结果，而不是把活退回给你看着。

如果你中途插话改方向——比如「Cursor 那路别查了，换成 Cline」——这一轮会跟着拐弯，而不是重开：
受影响的子任务被掐掉，替代任务排进**同一轮**，原本在等它的下游直接改用新结果。
你没碰过的 worker 完全不受影响，整轮报告的来龙去脉也还在。

## 它是一支团队，不是一批批处理

第一版是一次性扇出固定的一组子任务。真实的活儿不是这样：你得先看到回来的东西，再决定
下一步做什么；有的角色要等人到齐才开工；人和人之间还会互相要东西。所以现在一轮任务
是一个**跑着也能继续改的协作图**。

- **边跑边排。** 先 dispatch 第一步，看完结果再用 `add` 把第二步排进**同一轮**。
  不必一开始就猜完整条流水线，范围、报告、交接历史都留着。
- **按需激活的角色。** 任务加 `hold: true`，它的 worker 会话会建好、归到当前会话下，但
  不跑，直到你用 `start` 放行——一支随时可调动的常备团队。
- **一次调用完成改派。** `add` 里复用同一个任务 id 就是替换：旧回合被掐掉，依赖它的下游
  自动改用新结果。`drop` 则是不替换地停掉。
- **worker 之间互相要东西。** 拿不到别人的产出才能继续时，worker 会在回合末尾写一行
  `NEED: <任务 id>`，而不是瞎猜。整轮任务把它变成一条依赖边：对方的产物会被交到它手上，
  它在**同一个会话里**接着做；对方还没产出就先挂起，等对方交付后自动继续。
- **卡住的事会回到你面前，而不是挂着。** 出现需要决策的情况——索要的角色没人创建、上游
  失败、有卡片没人答——`wait` 会提前返回，并说明什么卡住了、为什么。
- **全部归在发起它的那个会话下。** 每个 worker 会话都在工具调用内创建，所以无论任务是
  一开始就排的、一小时后追加上去的，还是为了回应另一个 worker 的索要才建的，
  都归在同一个对话下面。

### 项目团队这个例子

一个产品开发团队：产品规划、架构师、前端、后端、测试，主会话是项目经理：

1. `dispatch` 把产品、架构、前端、后端作为并行任务派出去。
2. 测试用 `hold: true` 声明，会话建好但先不烧回合。
3. 测试需要所有人提出的需求——与其一开始就猜一张依赖图，不如等大家交卷后再 `start` 它；
   或者让它先跑，发现自己缺东西，用 `NEED: architect` 结束这一轮。两种情况整轮任务都会
   把材料交给它并让它跑完。
4. 如果架构的接口定义变了，用 `add` 复用同一个 id 替换那个任务：测试的依赖边还在，
   它直接用上新的接口定义。

## 模型选择

默认情况下所有 worker 都用你应用里的默认模型。你也可以用自然语言指定：
"推理类任务用 Opus，其余用快一点的模型"。Finch 会先查你**真正启用的**模型列表，
把你说的名字映射成真实的 `provider:model` 键，再按任务分配。如果名字匹配不上，
它会明说，而不是悄悄用默认模型。

想固定一个偏好，就在 **设置 → 默认工作模型** 里选：这一行会显示当前选的模型和它的 provider，
点开是「provider → 模型」的两级子菜单；选「跟随应用默认」即可还原。

## 说明

- 任务状态保存在小程序自己存储目录下的本地 SQLite 数据库里——数据不出本机，也不申请网络权限。
- worker 采用自动权限处理，避免无人值守时卡住；真正危险的操作仍然会等你确认。
- 需要 Finch 1.7.0 或更高版本。
