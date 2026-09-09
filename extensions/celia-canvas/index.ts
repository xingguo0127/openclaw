import { definePluginEntry, injectMessageBySessionKey } from "./api.js";

// nodeSendToSession 从 gateway 进程全局单例读取，无需 bind_broadcaster 预热
// 由 server-node-session-runtime.ts 在 gateway 启动时写入同一 Symbol key
const NODE_SEND_KEY = Symbol.for("openclaw.gateway.nodeSendToSession");
type NodeSendFn = (sessionKey: string, event: string, payload: unknown) => void;

const getNodeSend = (): NodeSendFn | undefined =>
  (globalThis as Record<PropertyKey, unknown>)[NODE_SEND_KEY] as NodeSendFn | undefined;

// ─────────────────────────────────────────────────────────────
// push_card 延迟推送：staging 双索引 Map
//
// 工具执行点只 staging，真正 nodeSend + injectMessageBySessionKey 推迟到 llm_output
// hook 按 lastAssistant.content 的物理顺序分组。多 turn 模型（Gemini）中间 turn
// content 没有 text 时，cards 进 orphaned 队列等下一个 turn 第一个 text anchor。
//
// 协议：canvas.card.push WS payload 加可选字段 anchorTextIndex: number
//   - 有值：客户端按 anchor 把卡绑到本 turn 内第 N 条 AI text bubble 之后浮现
//   - 缺省：客户端立即显示（兼容历史与 agent_end 兜底）
// ─────────────────────────────────────────────────────────────

type StagedCard = { sessionKey: string; cardJson: string; stagedAt: number };

// 按 toolCallId 索引：llm_output 时按 content 顺序配对
const stagedCardsByToolCallId = new Map<string, StagedCard>();
// 按 sessionKey 索引：orphan 队列，处理跨 turn 无对应 text block 的兜底场景
const orphanedCardsBySession = new Map<string, StagedCard[]>();

// ── 跨 attempt 累积锚点（修复「做事文本→卡→建空间文本→卡」失序）──
//
// llm_output 每个 attempt 触发一次、只带本 attempt 的 content。若每个 attempt 都从
// anchor=0 重数，而客户端 currentTurnAiTextIds 是整轮累积下标，跨 message 的第二段文本
// 对应的卡会被错绑到第一段文本前面。
//
// 修复：anchor 在整轮内累积。base = 本轮此 attempt 之前已发出的 AI text 气泡数，
// 本 attempt 的文本从 base 起继续数。客户端按 onUserMessage 重置累积下标，服务端按
// runId 变化（= 用户新消息开启的新一轮 agent run，params.runId 整轮稳定）重置 base，
// 两边边界对齐。
const textAnchorBaseBySession = new Map<string, number>();
const lastRunIdBySession = new Map<string, string>();

// ── 兜底：不发 llm_output 钩子的 runtime（交互对话走的 embedded/acpx runner）──
//
// 部分 runtime 根本不触发 llm_output / agent_end 等生命周期钩子，导致下面的延迟 flush
// 永不执行、卡片永远 staged 发不出去（cron/cli-runner 会触发，故 dreaming/定时任务的卡正常，
// 而交互对话的卡不显示）。用「本 session 是否见过 llm_output」区分两类 runtime：push_card 时挂
// 一个兜底定时器，窗口内若已被 llm_output 按 anchor flush 掉 → 定时器空跑（不破坏 anchor 定位）；
// 窗口后仍 staged 且本 session 从未见过 llm_output → 判定为不发钩子的 runtime，就地无 anchor 投递。
const llmOutputSeenBySession = new Map<string, boolean>();
const NO_HOOK_FALLBACK_MS = 8000;

function hasNonEmptyText(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" &&
    (block as { text: string }).text.trim().length > 0
  );
}

function isPushCardToolCall(
  block: unknown,
): block is { type: "toolCall"; id: string; name: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "toolCall" &&
    (block as { name?: unknown }).name === "push_card" &&
    typeof (block as { id?: unknown }).id === "string"
  );
}

export default definePluginEntry({
  id: "celia-canvas",
  name: "Celia Canvas",
  description:
    "结构化卡片推送工具 push_card，替代 celia_card bash 补丁。通过 WS 事件发送到客户端，通过 transcript 注入持久化。",
  register(api) {
    // bind_broadcaster 保留作为兼容接口；推送路径已改走 globalThis 单例，无需再手动调用
    api.registerGatewayMethod(
      "celia_canvas.bind_broadcaster",
      async ({ respond }) => {
        respond(true, { ok: true });
      },
      { scope: "operator.write" },
    );

    api.registerTool(
      (ctx) => ({
        name: "push_card",
        label: "推送卡片",
        description:
          "推送结构化卡片到 Celia 客户端（同时持久化到会话记录以便历史重载）。" +
          "Agent 推卡片必须调本工具，不要在 assistant text 中写 [celia_card] 标记（已弃用）。" +
          "推卡前先输出一句自然语言文本（卡片锚定在最近一条文本之后，前面没有文本则卡不显示）。" +
          "设备命令返回 _cardRendered:true 表示客户端已自动渲染，勿再重复推同一内容。" +
          "必须在主 Agent 会话调用：subagent 推卡会落到子会话，主对话看不到。",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "卡片类型。支持的类型清单与各类型 payload 字段以 TOOLS.md「支持的卡片类型」表为准。",
            },
            payload: {
              type: "object",
              description:
                "卡片业务数据，字段按 type 不同，见 TOOLS.md「支持的卡片类型」表。\n" +
                "通用字段 caption?（所有卡可用，强烈推荐）：一句引导/总结文本。客户端会把它渲染成" +
                "紧贴在这张卡正上方的一条文本气泡。caption 与卡是同一次推送的原子单元，" +
                "顺序写死、不会错位——需要「文本+卡」成对出现时，用 caption 而不是单独发一段 assistant 文本。",
            },
          },
          required: ["type", "payload"],
        },
        async execute(
          toolCallId: string,
          params: { type: string; payload: Record<string, unknown> },
        ) {
          const { type, payload } = params;
          const sessionKey = ctx.sessionKey;
          const cardJson = JSON.stringify({ type, ...payload });

          // 不立即 nodeSend / inject。落到 llm_output hook 时按物理顺序分组、再带 anchorTextIndex 推。
          if (sessionKey) {
            const staged: StagedCard = { sessionKey, cardJson, stagedAt: Date.now() };
            stagedCardsByToolCallId.set(toolCallId, staged);
            const orphans = orphanedCardsBySession.get(sessionKey) ?? [];
            orphans.push(staged);
            orphanedCardsBySession.set(sessionKey, orphans);
            api.logger.info(
              `[celia-canvas] push_card staged: toolCallId=${toolCallId} type=${type} sessionKey=${sessionKey} totalStaged=${stagedCardsByToolCallId.size}`,
            );
            // 兜底：不发 llm_output 钩子的 runtime（embedded/acpx）→ 窗口后就地投递。
            // 窗口内被 llm_output flush（发钩子的 runtime）→ staged 已删，定时器空跑，anchor 定位不受影响。
            const fbKey = sessionKey;
            const fbToolCallId = toolCallId;
            const fbCardJson = cardJson;
            setTimeout(() => {
              const stillStaged = stagedCardsByToolCallId.get(fbToolCallId);
              if (!stillStaged) {
                return; // 已被 llm_output 按 anchor flush
              }
              if (llmOutputSeenBySession.get(fbKey)) {
                return; // 发钩子的 runtime：交给正常流程（orphan 等下个 text anchor）
              }
              // 本 session 从未见过 llm_output → 不发钩子的 runtime，就地无 anchor 投递
              stagedCardsByToolCallId.delete(fbToolCallId);
              const pendingOrphans = orphanedCardsBySession.get(fbKey);
              if (pendingOrphans) {
                const idx = pendingOrphans.indexOf(stillStaged);
                if (idx >= 0) {
                  pendingOrphans.splice(idx, 1);
                }
              }
              const nodeSend = getNodeSend();
              if (nodeSend) {
                // Node subscriptions use the canonical agent-prefixed key. Stripping the
                // prefix silently drops live cards because session fanout is exact-match.
                nodeSend(fbKey, "canvas.card.push", { cardJson: fbCardJson });
              }
              void injectMessageBySessionKey(fbKey, `[celia_card]${fbCardJson}`).catch((err) => {
                api.logger.error(`[celia-canvas] fallback inject failed: ${String(err)}`);
              });
              api.logger.info(
                `[celia-canvas] push_card fallback flush (no-hook runtime): toolCallId=${fbToolCallId} sessionKey=${fbKey}`,
              );
            }, NO_HOOK_FALLBACK_MS);
          }

          // 返回 _cardRendered: true 保持和 Agent prompt（TOOLS.md / 各 SKILL）的契约不变 ——
          // 虽然实际推送延后到 llm_output hook，但 Agent 看到此信号即认为推送已落实，
          // 不应重复 push 同张卡。这条契约是改造前后 Agent 行为兼容的关键。
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ok: true, _cardRendered: true }) },
            ],
            details: { ok: true, _cardRendered: true },
          };
        },
      }),
      { name: "push_card" },
    );

    // 主路径：llm_output 按 lastAssistant.content 物理顺序把 staged 卡片分组到对应 text anchor
    api.on("llm_output", (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        api.logger.info("[celia-canvas] llm_output: no sessionKey in ctx, skipping");
        return;
      }
      // 标记：本 session 的 runtime 会发 llm_output → 走正常 anchor flush，push_card 兜底定时器不介入
      llmOutputSeenBySession.set(sessionKey, true);
      // runId 变化 = 新一轮用户消息 → 重置累积锚点基数（对齐客户端 onUserMessage 重置）。
      // 放在 content 判空之前，保证新轮第一个 attempt 即使空 content 也能正确翻篇。
      const runId = (event as { runId?: string }).runId;
      if (runId && lastRunIdBySession.get(sessionKey) !== runId) {
        textAnchorBaseBySession.set(sessionKey, 0);
        lastRunIdBySession.set(sessionKey, runId);
      }
      // 优先用本 attempt 完整 content（含被拆成多条消息的 push_card toolCall），
      // 否则退回 lastAssistant.content（只有最后一条消息，会漏掉 text+push_card 前置消息）。
      const attemptContent = (event as { attemptAssistantContent?: unknown })
        .attemptAssistantContent;
      const last = (event as { lastAssistant?: { content?: unknown } }).lastAssistant;
      const content = Array.isArray(attemptContent)
        ? (attemptContent as unknown[])
        : Array.isArray(last?.content)
          ? (last.content as unknown[])
          : [];
      const blockSummary = content
        .map((b) => {
          const o = b as { type?: unknown; name?: unknown; text?: unknown };
          if (o.type === "text") {
            const t = typeof o.text === "string" ? o.text : (JSON.stringify(o.text) ?? "");
            return `text(${t.slice(0, 20).replace(/\n/g, "\\n")}|len=${t.length})`;
          }
          if (o.type === "toolCall") {
            return `tool(${String(o.name)})`;
          }
          return String(o.type);
        })
        .join(",");
      api.logger.info(
        `[celia-canvas] llm_output: sessionKey=${sessionKey} provider=${(event as { provider?: string }).provider} blocks=[${blockSummary}] stagedCount=${stagedCardsByToolCallId.size} orphans=${(orphanedCardsBySession.get(sessionKey) ?? []).length}`,
      );
      if (content.length === 0) {
        return;
      }

      // 按物理顺序扫描：text(非空) → anchor++；toolCall(push_card) → 绑到当前 anchor。
      // currentAnchor 从本轮累积基数起算（不是每 attempt 从 0），跨 message 与客户端累积下标对齐。
      const anchorBase = textAnchorBaseBySession.get(sessionKey) ?? 0;
      let currentAnchor = anchorBase - 1;
      const groups: { anchor: number; cards: StagedCard[] }[] = [];
      for (const block of content) {
        if (hasNonEmptyText(block)) {
          currentAnchor++;
          groups.push({ anchor: currentAnchor, cards: [] });
        } else if (isPushCardToolCall(block)) {
          const staged = stagedCardsByToolCallId.get(block.id);
          if (staged && groups.length > 0) {
            groups[groups.length - 1].cards.push(staged);
            stagedCardsByToolCallId.delete(block.id);
            const orphans = orphanedCardsBySession.get(staged.sessionKey);
            if (orphans) {
              const idx = orphans.indexOf(staged);
              if (idx >= 0) {
                orphans.splice(idx, 1);
              }
            }
          }
        }
      }

      // 累积基数前进：本 attempt 新增了 groups.length 条 text 气泡（每个非空 text block 一组）。
      // 即使本 attempt 没卡片，也要前进——客户端同样会为这些纯文本气泡推进 currentTurnAiTextIds。
      textAnchorBaseBySession.set(sessionKey, anchorBase + groups.length);

      // 本 turn 之前 turn 留下的 orphan（如 Gemini 中间 toolUse turn 没 text）→
      // 在本 turn 有 anchor 时全部塞到第一个 anchor 前；没 anchor 就继续留着等下一个 turn
      if (groups.length > 0) {
        const orphans = orphanedCardsBySession.get(sessionKey) ?? [];
        const carryOver = orphans.filter((s) => !groups.some((g) => g.cards.includes(s)));
        if (carryOver.length > 0) {
          groups[0].cards.unshift(...carryOver);
          // 从 orphans 清掉已 carry-over 的项
          const remaining = orphans.filter((s) => !carryOver.includes(s));
          if (remaining.length === 0) {
            orphanedCardsBySession.delete(sessionKey);
          } else {
            orphanedCardsBySession.set(sessionKey, remaining);
          }
          // 同时清 toolCallId map（carry-over 已不再有 staging 意义）
          for (const s of carryOver) {
            for (const [id, st] of stagedCardsByToolCallId) {
              if (st === s) {
                stagedCardsByToolCallId.delete(id);
                break;
              }
            }
          }
        }
      }

      // flush：按 anchor 顺序 nodeSend WS + injectMessageBySessionKey transcript
      const nodeSend = getNodeSend();
      const flushedSummary = groups.map((g) => `anchor#${g.anchor}=[${g.cards.length}]`).join(",");
      api.logger.info(`[celia-canvas] llm_output flush: ${flushedSummary || "(empty)"}`);
      for (const g of groups) {
        for (const { cardJson } of g.cards) {
          if (nodeSend) {
            nodeSend(sessionKey, "canvas.card.push", { cardJson, anchorTextIndex: g.anchor });
          }
          void injectMessageBySessionKey(sessionKey, `[celia_card]${cardJson}`).catch((err) => {
            api.logger.error(`[celia-canvas] transcript inject failed: ${String(err)}`);
          });
        }
      }
    });

    // 关于 agent_end：**不要**在这里 flush orphans。
    // 实测 pi-embedded-runner/run/attempt.ts 中 hook 顺序为 agent_end 先于 llm_output（line 2480 vs 2578），
    // 而且都是 per-attempt 触发（一次 agent run 多次 attempt）。若 agent_end flush orphan 会把还没等到
    // 下一个 attempt llm_output 文本 anchor 的卡片提前打掉，导致 anchor=null 失序。
    //
    // 代价：极端 case "Agent 推卡后真的不再说一句话" 时，orphans 沉睡到 session_end 才清，UI 不显示卡片。
    // 实际场景里 LLM 调完 tools 通常会再发起一次 attempt 总结结果，触发文本 anchor + carry-over → 正常 flush。
    //
    // ⚠️ 另有一类 runtime（交互对话走的 embedded/acpx runner）**根本不发 llm_output/agent_end 任何钩子**，
    // 上面整条延迟 flush 都不会执行 → 卡永远 staged。这类由 push_card 里的 NO_HOOK_FALLBACK 定时器兜底
    // （靠 llmOutputSeenBySession 判定），窗口后就地无 anchor 投递。见文件上方 llmOutputSeenBySession 注释。

    // 清理：session 结束 / 用户中断 / 超时 → 丢弃所有 staging
    api.on("session_end", (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return;
      }
      orphanedCardsBySession.delete(sessionKey);
      textAnchorBaseBySession.delete(sessionKey);
      lastRunIdBySession.delete(sessionKey);
      llmOutputSeenBySession.delete(sessionKey);
      for (const [id, staged] of stagedCardsByToolCallId) {
        if (staged.sessionKey === sessionKey) {
          stagedCardsByToolCallId.delete(id);
        }
      }
    });
  },
});
