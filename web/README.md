# Claude Router for claude.ai

A Chrome extension that suggests a Claude model family (Haiku, Sonnet, Opus or
Fable) for the prompt you are typing on claude.ai. It shows a small label above
the text box and nothing more: you change the model yourself in claude.ai's
model picker.

It uses the same classifier as the VS Code extension
(`src/core/classifier.ts`). Everything runs in the page; the extension asks for
no permissions and makes no network requests.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `web` folder.
4. Open or reload claude.ai and start typing.

## After changing the classifier

`classifier.js` is generated. Rebuild it from the repository root, then click
the reload icon for the extension in `chrome://extensions`:

```bash
npm run build:web
```

## Limits

- It only sees the text you type or paste. Attached files are not counted, so
  the size of the prompt itself stands in for context size.
- It finds the text box generically (any editable field on claude.ai), and
  places the label just above it. A claude.ai redesign could move or hide the
  label.
- It works in Chrome and other Chromium browsers, not in the Claude desktop or
  mobile apps.
