---
summary: "DeepSeek setup (auth + model selection)"
title: "DeepSeek"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

[DeepSeek](https://www.deepseek.com) provides powerful AI models with an OpenAI-compatible API.

| Property | Value                      |
| -------- | -------------------------- |
| Provider | `deepseek`                 |
| Auth     | `DEEPSEEK_API_KEY`         |
| API      | OpenAI-compatible          |
| Base URL | `https://api.deepseek.com` |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/deepseek-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice deepseek-api-key
    ```

    This will prompt for your API key and set `deepseek/deepseek-flash` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider deepseek
    ```

    To inspect the plugin's static catalog without requiring a running Gateway,
    use:

    ```bash
    openclaw models list --all --provider deepseek
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If the Gateway runs as a daemon (launchd/systemd), make sure `DEEPSEEK_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

| Model ref                    | Name                | Input       | Context   | Max output | Notes                                          |
| ---------------------------- | ------------------- | ----------- | --------- | ---------- | ---------------------------------------------- |
| `deepseek/deepseek-flash`    | DeepSeek-V4.1-Flash | text, image | 1,000,000 | 384,000    | Default model; multimodal and thinking-capable |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro     | text        | 1,000,000 | 384,000    | Legacy V4 Pro route                            |
| `deepseek/deepseek-chat`     | DeepSeek Chat       | text        | 131,072   | 8,192      | Legacy non-thinking compatibility surface      |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner   | text        | 131,072   | 65,536     | Legacy reasoning-enabled compatibility surface |

DeepSeek uses peak/off-peak pricing. OpenClaw's static cost estimate uses the
peak USD rates (`$0.30` uncached input, `$0.006` cached input, and `$1.20`
output per million tokens) so estimates do not understate the maximum charge.
DeepSeek currently bills half those rates during off-peak hours.

<Tip>
V4 models support DeepSeek's `thinking` control. OpenClaw also replays
DeepSeek `reasoning_content` on follow-up turns so thinking sessions with tool
calls can continue.
Use `/think xhigh` or `/think max` with DeepSeek V4 models to request DeepSeek's
maximum `reasoning_effort`.
</Tip>

## Thinking and tools

DeepSeek V4 thinking sessions have a stricter replay contract than most
OpenAI-compatible providers: after a thinking-enabled turn uses tools, DeepSeek
expects replayed assistant messages from that turn to include
`reasoning_content` on follow-up requests. OpenClaw handles this inside the
DeepSeek plugin, so normal multi-turn tool use works with
`deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro`.

If you switch an existing session from another OpenAI-compatible provider to a
DeepSeek V4 model, older assistant tool-call turns may not have native
DeepSeek `reasoning_content`. OpenClaw fills that missing field on replayed
assistant messages for DeepSeek V4 thinking requests so the provider can accept
the history without requiring `/new`.

When thinking is disabled in OpenClaw (including the UI **None** selection),
OpenClaw sends DeepSeek `thinking: { type: "disabled" }` and strips replayed
`reasoning_content` from the outgoing history. This keeps disabled-thinking
sessions on the non-thinking DeepSeek path.

Use `deepseek/deepseek-flash` for the current default path. The older
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids are provider-side
compatibility aliases for V4.1 Flash; new configuration should use
`deepseek-flash` directly.

## Live testing

The direct live model suite includes DeepSeek V4 in the modern model set. To
run only the DeepSeek V4 direct-model checks:

```bash
OPENCLAW_LIVE_PROVIDERS=deepseek \
OPENCLAW_LIVE_MODELS="deepseek/deepseek-flash,deepseek/deepseek-v4-pro" \
pnpm test:live src/agents/models.profiles.live.test.ts
```

That live check verifies both V4 models can complete and that thinking/tool
follow-up turns preserve the replay payload DeepSeek requires.

## Config example

```json5
{
  env: { DEEPSEEK_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-flash" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
