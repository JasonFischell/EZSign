# Setup Guide

## 1. Local Machine Setup

This workspace is currently empty except for the scaffold I added, and this machine does not currently expose `git`, `node`, or `npm` on PATH.

Install these first:

- Git for Windows
- Node.js LTS for Windows
- Google Chrome

After installing, reopen the terminal and verify:

```powershell
git --version
node --version
npm --version
```

## 2. GitHub Setup

Once Git is available:

```powershell
git init
git branch -M main
git add .
git commit -m "Initial EZSign extension scaffold"
```

Then create a new GitHub repository named `EZSign` and connect it:

```powershell
git remote add origin https://github.com/<your-org-or-user>/EZSign.git
git push -u origin main
```

## 3. Google Cloud Setup

Create a Google Cloud project for the extension:

1. Open Google Cloud Console.
2. Create a new project for EZSign.
3. Enable the Gmail API.
4. Configure the OAuth consent screen.
5. Create an OAuth client using the Chrome Extension application type.
6. Copy the generated client ID.

Update [extension/manifest.json](C:/Users/jason/OneDrive/Documents/Coding%20Projects/EZSign/extension/manifest.json):

```json
"oauth2": {
  "client_id": "YOUR_REAL_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
}
```

## 4. Load The Extension In Chrome

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select the `extension` folder in this repository.
5. Open Gmail in Chrome.
6. Click the floating `EZSign` launcher or the extension toolbar icon.

## 5. MVP Workflow

The current starter supports:

- authenticating with Gmail
- searching for messages with signature-related language
- listing supported attachments
- queueing an attachment for a future signing step
- demo data for UI testing before OAuth is ready

## 6. Recommended Milestones

### Milestone 1: Inbox Discovery

- finalize Gmail search heuristics
- support PDF files first
- add better message detail cards

### Milestone 2: Signing Backend

- create an API that accepts a Gmail attachment selection
- hash the file and create a signing request record
- store signer identity evidence and an audit trail

### Milestone 3: Return Signed Files

- notify the extension when signing is complete
- let the user download or attach the signed document
- optionally draft a Gmail reply with the signed file

## 7. Architecture Choice To Keep

Use the Gmail API for message search and attachment metadata.

Avoid building the core workflow around Gmail DOM scraping. The Gmail UI changes often, while the API is the stable source for message and attachment data. Keep the Gmail content script focused on lightweight entry points and context, not mailbox logic.

## 8. Alternative Path

If you eventually want deeper Gmail-native cards across desktop and mobile, consider a Google Workspace add-on. For this project, a Chrome extension is the better first move because it gives you more freedom for custom signing UX and richer client-side interactions.
