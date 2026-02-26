# PowPow — Multi-Channel AI Gateway

PowPow is an AI gateway that connects multiple AI models (OpenAI, Anthropic, Gemini, etc.)
to multiple messaging channels (Telegram, Discord, Slack, WhatsApp, and more).

This project is built for **educational purposes** — to learn, enhance, and experiment
with AI gateway architecture.

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env file and fill in your keys
cp .env.example .env

# 3. Run the gateway
node powpow.mjs gateway
```

## Supported AI Providers
- OpenAI (GPT-4, GPT-4o, etc.)
- Anthropic (Claude)
- Google Gemini
- OpenRouter
- AWS Bedrock
- Local models via node-llama-cpp

## Supported Channels
- Telegram
- Discord
- Slack
- WhatsApp
- LINE
- Lark/Feishu
- iMessage
- Mattermost
- IRC
- MS Teams
- Signal
- Google Chat
- Twitch
- Zalo

## Project Structure

```
src/        — Core gateway (TypeScript)
apps/       — Native clients (iOS, macOS, Android)
extensions/ — Plugin extensions
packages/   — Compatibility shims (clawdbot, moltbot)
ui/         — Web UI (Lit Web Components)
skills/     — AI skill definitions
```

## Author
Kannan — Educational fork for learning AI gateway architecture.
