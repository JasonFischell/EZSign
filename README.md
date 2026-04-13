# EZSign

EZSign is a Chrome extension starter for Gmail-centric signature workflows. It searches Gmail for messages that likely contain documents needing a signature, surfaces matching attachments in a side panel, and queues them for a future signing backend.

The current scaffold is intentionally lightweight:

- No build step is required.
- The extension loads as an unpacked Manifest V3 project from `/extension`.
- Gmail search uses the Gmail API instead of scraping Gmail's DOM.
- A Gmail content script adds a small launcher button so the workflow feels native inside `mail.google.com`.

## What Is Included

- A Manifest V3 extension scaffold in [extension/manifest.json](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/manifest.json)
- A background service worker that handles OAuth, Gmail search, and a local signing queue
- A Gmail content script that opens the extension side panel
- A side panel UI for OAuth, searching, and reviewing candidate files
- Project docs for setup and architecture in [docs/setup.md](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/docs/setup.md) and [docs/architecture.md](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/docs/architecture.md)

## Important Product Decision

The browser extension should not be the system of record for a "validated signature."

For a real validated signing flow, the extension should only:

- identify relevant Gmail messages and attachments
- hand selected files to a signing service
- bring signed results back into the user's workflow

The signing backend should handle:

- signer identity verification
- audit trail creation
- tamper-evident document hashing
- certificate or provider-backed signing
- completed file storage and retrieval

That separation keeps the Chrome extension small and keeps trust-sensitive logic on infrastructure you control.

## Start Here

1. Install Git for Windows and a current Node.js LTS release on this machine. Neither `git` nor `node` is currently available on PATH here.
2. Create a GitHub repository and connect this folder once Git is installed.
3. Create a Google Cloud project, enable the Gmail API, and create a Chrome Extension OAuth client.
4. Replace the placeholder OAuth client ID in [extension/manifest.json](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/manifest.json).
5. Load `/extension` as an unpacked extension in Chrome.
6. Use demo data first, then connect Gmail once OAuth is configured.

Detailed steps live in [docs/setup.md](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/docs/setup.md).

## Recommended MVP Scope

Keep the first release narrow:

- Gmail read-only access
- PDF-first document support
- manual review before sending a file to signing
- one signing provider or one internal signing API
- queue and status tracking for signature requests

## Official References

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3)
- [Chrome `identity` API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Chrome `sidePanel` API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Gmail API `users.messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail API attachments](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)
- [Google Workspace add-ons quickstart](https://developers.google.com/workspace/add-ons/quickstart/cats-quickstart)
