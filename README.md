# Enhancements for SillyTavern

## Multi-agent story writer

In **Extensions → Enhancements → Multi-agent story writer**, enable **Story agents**. The feature uses SillyTavern's **Chat Completion** connection, including Custom API connections. It starts disabled.

Write a chat message and press Send or Enter. Choose the specialists for that response, then select **Run selected agents**. You can also send without agents or cancel while keeping your draft. Regeneration, swipes and continuation also offer the agent picker before their API request.

The progress window shows queued, working, finished and failed agents, with elapsed time. Expand a finished agent to read its notes. These are the specialist's deliverable; the activity label is configurable and is not a transcript of hidden model reasoning. **Show latest agent notes** reopens the window for the current session.

Each selected agent receives the assembled story context, including character instructions, active lore and conversation text, and produces recommendations independently. When all selected agents finish, their notes are combined into one system message for the normal writer request. Only the story reply appears in the chat. Images and tool-call metadata are excluded from specialist requests.

### Agent slots

Five initial slots cover Scenario, Characters, World, Style and Intimacy / NSFW. The intimacy slot starts deselected. Add or remove slots, up to ten, and configure:

- Name and activity label.
- Specialist prompt, including SillyTavern macros such as `{{char}}`.
- Model name on the current API connection; blank uses the current chat model.
- Maximum output tokens and temperature.

All agents use the same API provider/connection as the final writer. A model override must exist on that connection. The normal writer retains the chat's model, sampling, streaming and prefill settings. Specialist calls bypass Enhancements' structured prefill and banned-word enforcement; those remain active for the final writer. Enhanced TTS instructions remain in the final story context.

**Agents at once** limits parallel requests (default two). Set it to one for a provider that permits only one active request. Disable **Choose agents before each response** to automatically use the slots selected by default.

### Failures, context and cost

If an agent fails, choose to write with successful notes, write without agents, or cancel. Cancellation aborts outstanding requests and prevents the final writer from starting. A per-agent timeout defaults to 120 seconds.

The notes added to the final request are capped by **Max note characters per agent** (default 2,000); the progress window retains the complete returned notes. Prompts are recounted before sending. If space is needed, old complete conversation turns are removed while system lore and the latest user turn are preserved. If those still exceed the context, the window offers writing without agents or cancelling. Set the chat context size within the limits of every model you use.

Each selected agent adds one API request, plus the normal final writer request. Four specialists usually mean five requests per response. They run independently and do not exchange notes with one another.

### Install on Kaggle

Copy this extension folder's `index.js`, `manifest.json`, and `features/` into your SillyTavern installation's `public/scripts/extensions/third-party/enhancements/`, replacing the existing Enhancements files. Reload SillyTavern in the browser, then enable Story agents. Keep the updated extension in whatever dataset or source you use to persist your SillyTavern installation.

No change to `kaggle/launcher.py`, extra server, or new API key is required. The extension calls SillyTavern's authenticated chat-completion route, which uses your existing server-side credentials. This feature currently supports Chat Completion; Text Completion connections continue using the normal response flow.

### Checks

Run the mocked API and regression tests:

```powershell
node --test tests/*.test.mjs
```

The optional browser smoke check requires Playwright with Chromium installed:

```powershell
node tests/story-agents-browser.mjs
```

It uses local mocked responses and writes screenshots to `tests/artifacts/`. To use a Playwright install outside this folder, set `STORY_PLAYWRIGHT_MODULE` to its absolute `index.mjs` path.
