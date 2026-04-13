# Architecture Notes

## Core Components

### 1. Chrome Extension

Files:

- [extension/manifest.json](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/manifest.json)
- [extension/background/service-worker.js](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/background/service-worker.js)
- [extension/content/gmail.js](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/content/gmail.js)
- [extension/sidepanel/sidepanel.html](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/sidepanel/sidepanel.html)
- [extension/sidepanel/sidepanel.js](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/sidepanel/sidepanel.js)

Responsibilities:

- authenticate the user with Google OAuth
- search Gmail with a signature-oriented query
- list candidate attachments
- queue files for signing
- host the local UI inside Chrome

### 2. Signing Backend

Planned responsibility:

- accept a selected file reference from the extension
- download the attachment securely or receive an uploaded blob
- verify signer identity
- apply the actual signature workflow
- store audit logs and signed artifacts

### 3. Optional Data Store

Likely future entities:

- users
- signature requests
- documents
- signer events
- audit log entries

## Suggested Request Flow

1. User opens Gmail.
2. The content script exposes an `EZSign` launcher.
3. The side panel opens.
4. The extension uses `chrome.identity` to get a Gmail API token.
5. The background worker calls Gmail `users.messages.list`.
6. Matching messages are expanded and filtered for supported attachments.
7. The user chooses a document.
8. The extension sends that document to a signing backend.
9. The backend returns status updates and, later, a signed artifact.

## Security Boundaries

Keep these boundaries early:

- Chrome extension handles mailbox discovery and local UX.
- Backend handles trust-sensitive signature operations.
- Gmail access starts with read-only scope and expands only when product needs justify it.

## Current File Map

### `extension/manifest.json`

- Manifest V3 configuration
- Gmail host permissions
- side panel registration
- OAuth client placeholder

### `extension/background/service-worker.js`

- central message router
- Gmail API requests
- search result shaping
- local signing queue storage

### `extension/content/gmail.js`

- Gmail page launcher button
- side panel open request

### `extension/sidepanel/*`

- extension UI
- search form
- queue rendering
- result rendering

## Early Technical Decisions

- Use plain JavaScript first to move fast.
- Keep the starter buildless until the workflow is stable.
- Start with `gmail.readonly`.
- Support `pdf`, `doc`, and `docx` attachment metadata discovery first.
- Treat DOM interaction in Gmail as optional sugar, not core logic.
