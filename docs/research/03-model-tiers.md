# 03 - Model tiers and current pricing

**Prices checked 2026-11-04** (USD per 1M tokens, list price, standard processing, no batch discount). Sources are the official pricing pages fetched that day unless marked otherwise. Model names below are exactly as the vendors list them; several are new since mid-2026, so treat any name not in the "verified" column as something to re-check in the provider's model list before launch.

## 1. Price table by provider

| Provider | Model ID (as listed) | Input | Output | Cached input | Context | Tools | Notes |
|---|---|---|---|---|---|---|---|
| Anthropic | Claude Fable 5.1 | 10 | 50 | 0.25 | 1M | yes | Top of the range; Mythos 5.1 is priced the same |
| Anthropic | Claude Opus 5.5 | 4 | 20 | 0.20 | 1M | yes | Cheaper than Fable; fast mode 8/40 |
| Anthropic | Claude Sonnet 5.5 | 2 | 10 | 0.10 | 1M | yes | |
| Anthropic | Claude Haiku 5.5 | 0.10 (prompt <=100k), 0.50 (>100k) | 0.50 / 2.50 | 0.01 / 0.05 | 1M (via OpenRouter) | yes | Long prompts cost 5x; keep worker prompts under 100k |
| OpenAI | GPT-6 Astra | 10 | 50 | 1.00 | ~1.05M (via OpenRouter) | yes | Prices apply to contexts under 272K |
| OpenAI | GPT-6.1 Sol | 2 | 10 | 0.10 | ~1.05M | yes | |
| OpenAI | GPT-6.1 Terra | 1 | 5 | 0.05 | ~1.05M | yes | |
| OpenAI | GPT-6 Luna | 0.10 | 0.50 | 0.01 | ~1.05M | yes | OpenAI's cheapest text model on the page |
| Google | Gemini 4 Argon (`gemini-4-argon`) | 2.00 until 2026-11-30, then **4.00** | 10.00, then **20.00** | 0.10, then 0.20 | 1M (via OpenRouter) | yes | Introductory price ends soon |
| Google | Gemini 3.8 / 3.6 Flash | 0.75 until 2026-12-31, then **1.50** | 3.75, then **7.50** | n/v | 1M | yes | |
| Google | Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | 0.30 | 2.50 | n/v | 1M | yes | |
| Google | Gemini 3.1 Flash-Lite | 0.25 | 1.50 | n/v | 1M | yes | Cheapest Gemini text model listed |
| DeepSeek | `deepseek-v4-pro` (V4-Pro-0813) | 0.66 off-peak / 1.32 peak | 1.98 / 3.96 | 0.022 / 0.044 | 1M, 384K max output | yes | Peak = 01-04 and 06-10 UTC, Mon-Fri; off-peak is half price |
| DeepSeek | `deepseek-flash` (V4.1-Flash-1017) | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 1M | yes | Vision supported on Flash only |
| BytePlus ModelArk | `seed-2-0-pro-260328` (Doubao Seed) | 0.50 (<=128K), 1.00 (<=256K) | 3.00 / 6.00 | 0.10 / 0.20 | 256K | yes | |
| BytePlus ModelArk | `seed-2-0-lite-260428` | 0.25 / 0.50 | 2.00 / 4.00 | 0.05 / 0.10 | 256K | yes | |
| BytePlus ModelArk | `seed-2-0-mini-260428` | 0.10 / 0.20 | 0.40 / 0.80 | 0.02 / 0.04 | 256K | yes | |
| BytePlus ModelArk | `dola-seed-2-1-turbo` | 0.50 | 2.50 | 0.10 | 256K | yes | Newest Seed line on the page |
| BytePlus ModelArk | `deepseek-v4-1-flash-economy-261017` | 0.12 off-peak / 0.24 peak | 0.48 / 0.96 | 0.002 / 0.005 | n/v | yes | Peak = Mon-Fri 09-12 and 14-18 UTC+8 |
| BytePlus ModelArk | `glm-5-3-flash-260828` (Z.ai) | 0.15 | 0.50 | 0.03 | n/v | yes | |
| Alibaba Model Studio (international) | `qwen3.8-max` | 2.00 | 6.00 | discount via context cache | 1M | yes | |
| Alibaba Model Studio | `qwen3.7-plus` | 0.40 (<=256K), 1.20 (to 1M) | 1.60 / 4.80 | cache discount | 1M | yes | A "limited-time 20% off" banner is shown |
| Alibaba Model Studio | `qwen3.8-flash` | 0.15 | 0.47 | cache discount | 1M | yes | |
| Alibaba Model Studio | `qwen3.7-flash` | 0.03 (<=32K), 0.10 (<=256K), 0.20 (to 1M) | 0.13 / 0.40 / 0.80 | cache discount | 1M | yes | Cheapest model found anywhere |
| OpenRouter (aggregator) | pass-through of the above, e.g. `anthropic/claude-haiku-5.5` | same as vendor for Anthropic and OpenAI rows | same | varies | per model | yes (flag on each model) | Also hosts Kimi (k2.6 about 0.65/3.41; k3.1-pro about 2/10), GLM, Qwen; its catalogue prices diverge from vendor pages for some models (see section 4) |

## 2. Endpoints (OpenAI-style chat completions with tool calling)

| Provider | Base URL | Chat completions + tools | Verified how |
|---|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/` (compat layer) | Yes, but it is documented as a testing layer: strict schema is ignored, no prompt caching, and **Opus 5.5, Sonnet 5.5, Fable 5.1 reject forced tool use (`tool_choice` required or a named function) with a 400** | Official doc, 2026-11-04 |
| OpenAI | `https://api.openai.com/v1` | Yes (native) | Standard endpoint; not re-fetched today |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | Yes | Official doc, 2026-11-04 |
| DeepSeek | `https://api.deepseek.com` (also `/anthropic` for Anthropic format) | Yes; also a Responses API | Official pricing page |
| BytePlus ModelArk | `https://ark.ap-southeast.bytepluses.com/api/v3` (eu-west: `ark.eu-west.bytepluses.com`) | Yes (function-calling doc exists) | Third-party doc (Portkey); URL not confirmed on BytePlus's own page |
| Volcengine Ark (China) | `https://ark.cn-beijing.volces.com/api/v3` | Expected yes | **From memory, not verified**; I priced only the BytePlus (USD) page |
| Alibaba Qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (China: `dashscope.aliyuncs.com/compatible-mode/v1`) | Yes ("change only key, base URL and model name") | Doc confirms compatibility; exact URL from memory |
| OpenRouter | `https://openrouter.ai/api/v1` | Yes; each model lists `tools` in its supported parameters | Official quickstart |

## 3. Recommended three-tier mapping

Reference cost of one typical call (10k input, 1k output): Opus 5.5 about $0.060; Sonnet 5.5 about $0.030; Haiku 5.5 about $0.0015. Frontier is roughly 40x economy, so the executive/worker split matters far more than any single provider choice.

| Tier | Used by | Primary | Fallback 1 | Fallback 2 | Why |
|---|---|---|---|---|---|
| **Frontier** | Executives, board-level decisions, planning and reflection stages of the cognitive loop | Claude Opus 5.5 ($4/$20) | Gemini 4 Argon ($2-4/$10-20) | GPT-6 Astra ($10/$50) | Opus 5.5 is a fifth the cost of Fable 5.1 at the same 1M context; reserve Fable 5.1 as an optional "CEO override" for rare, expensive decisions |
| **Standard** | Managers, complex worker stages (drafting, code, analysis, review) | Claude Sonnet 5.5 ($2/$10) | GPT-6.1 Sol ($2/$10) | DeepSeek V4 Pro ($0.66-1.32/$1.98-3.96) | Equal price across the two US vendors gives clean failover; DeepSeek is the cost fallback |
| **Economy** | Workers, routing, classification, extraction, simple tool calls | Claude Haiku 5.5 ($0.10/$0.50) | GPT-6 Luna ($0.10/$0.50) | DeepSeek `deepseek-flash` ($0.15-0.30/$0.60-1.20) | Same price points; a second vendor protects against outages |
| Economy-bulk (optional) | High-volume, low-stakes loops (log triage, summaries) | Qwen3.7-Flash ($0.03/$0.13) | Seed 2.0 Mini ($0.10/$0.40) | GLM-5.3-Flash ($0.15/$0.50) | Roughly 3x cheaper than the economy primary; quality must be tested on our tasks first |

Routing rules worth shipping: escalate a worker call one tier on schema-validation failure or low self-confidence; cap Haiku prompts below 100k tokens; pin prompt-cache keys per agent (cache reads are 5-20x cheaper); use native SDKs for Anthropic (the compat layer has no caching); send non-urgent bulk work to batch endpoints (50% off at Anthropic, OpenAI, Google); schedule DeepSeek and ModelArk-DeepSeek bulk jobs for off-peak hours.

## 4. What I could not verify, and risks

- **Freshness**: all prices come from pages cached 2026-11-03/04; vendors change prices often. Ship them as `checked_at: 2026-11-04` with an `effective_from/to` field so scheduled changes (Argon on 2026-12-01, Gemini 3.x Flash on 2027-01-01) are modelled, not hard-coded.
- **Gemini cached-input prices** for Flash and Flash-Lite, and Gemini context windows, were not read from the official page (1M comes from OpenRouter's catalogue).
- **OpenAI context windows and cached-input details** are from the vendor page plus OpenRouter; OpenAI's developer docs page was not fetched.
- **OpenRouter catalogue anomalies**: some entries look mis-scraped or promotional (for example an input of 0.006 for GLM-5.2 or output 16 for Kimi K3), and some differ from vendor pages (Gemini 3.5 Flash at 1.5/9). OpenRouter's platform fee on credits was not verified; query `/api/v1/models` at runtime instead of hard-coding aggregator prices.
- **Volcengine (China) pricing in RMB** was not checked; the USD BytePlus page was used. Kimi is not on the BytePlus page I read; Kimi K2.x/K3 prices come only from OpenRouter.
- **Quality**: no benchmarking was done; tier choices are price/capability judgement from vendor positioning. Run a small eval on AgentCo's own tasks before locking the economy primary.
- Forced tool use is unsupported on the top Claude models through the OpenAI-compat layer, so design prompts that do not rely on `tool_choice: required` there.

## Sources
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/api/openai-sdk
- https://openai.com/api/pricing/ (resolves to the business pricing page)
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/openai
- https://api-docs.deepseek.com/quick_start/pricing
- https://docs.byteplus.com/en/docs/modelark/model-pricing
- https://portkey.ai/docs/integrations/llms/byteplus.md (BytePlus base URLs)
- https://www.alibabacloud.com/help/en/model-studio/model-pricing
- https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/docs/quickstart
