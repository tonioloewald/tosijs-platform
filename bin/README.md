# create-tosijs-platform-app

Create a full-stack web app with [tosijs](https://github.com/nicross/tosijs) (front-end) and Google Firebase (back-end).

## Prerequisites

- [Bun](https://bun.sh/) - Install with `curl -fsSL https://bun.sh/install | bash`
- [Firebase CLI](https://firebase.google.com/docs/cli) - Install with `bun install -g firebase-tools`
- A Firebase project (create one at [console.firebase.google.com](https://console.firebase.google.com))

## Quick Start

```bash
npx create-tosijs-platform-app my-awesome-site
```

The CLI will:
1. Check prerequisites (Bun, Firebase CLI, Firebase login)
2. Ask for your Firebase project ID and admin email*
3. Clone the tosijs-platform template
4. Configure Firebase settings automatically
5. Install dependencies
6. Generate TLS certificates for local HTTPS development

*The admin email is the Google account that will be granted owner/admin rights to your site. This email is only stored locally in your project's `setup.js` file and is never transmitted anywhere. It's used to identify which user should get admin privileges when you run `node setup.js` after deploying.

## After Setup

1. **Enable Firebase services** in your project:
   - Authentication (Google sign-in)
   - Firestore Database
   - Cloud Storage

2. **Upgrade to Blaze plan** (required for Cloud Functions)

3. **Deploy**:
   ```bash
   cd my-awesome-site
   bun deploy-functions
   bun deploy-hosting
   ```

4. **Set up admin access**:
   ```bash
   node setup.js
   ```

5. **Start local development**:
   ```bash
   bun start
   ```
   Visit https://localhost:8020

## AI Features (Optional)

To use the `/gen` endpoint for AI completions, set up API keys:

```bash
# For Gemini (Google AI)
firebase functions:secrets:set gemini-api-key

# For ChatGPT (OpenAI)
firebase functions:secrets:set chatgpt-api-key
```

## Links

- [tosijs-platform template](https://github.com/tonioloewald/tosijs-platform)
- [Report issues](https://github.com/tonioloewald/tosijs-platform/issues)

## License

MIT
