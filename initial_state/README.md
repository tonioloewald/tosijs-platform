# Initial State

This directory contains seed data for initializing Firestore, Storage, and Auth emulators,
as well as for bootstrapping new tosijs-platform projects.

## Directory Structure

```
initial_state/
  auth/
    users.json          # Firebase Auth users for emulator
  firestore/
    page.json           # Page collection documents
    post.json           # Post collection documents
    module.json         # Module collection documents
    role.json           # Role collection documents
  storage/
    (empty)             # Place files here to seed Storage emulator
```

## Firestore JSON Format

Each JSON file in the `firestore/` directory represents a collection. The filename
corresponds to the collection path. For nested collections, use `|` as a path
separator (e.g., `users|{userId}|posts.json` for `users/{userId}/posts`).

Each document in a collection file should have an `_id` field which becomes
the document ID in Firestore. All other fields are stored as document data.

## Auth Users Format

Users in `auth/users.json` support two provider types:

```json
[
  {
    "uid": "owner-uid",
    "email": "owner@gmail.com",
    "displayName": "Owner User",
    "provider": "google"
  },
  {
    "uid": "password-uid",
    "email": "testuser@example.com",
    "displayName": "Test Password User",
    "provider": "password"
  }
]
```

- **`provider: "google"`** - Creates a Google OAuth user (appears in "Sign in with Google" popup)
- **`provider: "password"`** - Creates an email/password user (password: `password123`)

Note: For Google users, use `@gmail.com` addresses. The `uid` field is informational only;
Firebase generates the actual UID at creation time.

## Emulator vs Production Setup

**Important:** The initial_state data is used differently depending on context:

### Emulator Development (this repository)

The seed data includes test users for development and testing:

| User     | Email                 | Provider | Roles                                    |
|----------|-----------------------|----------|------------------------------------------|
| owner    | owner@gmail.com       | google   | owner, developer, admin, editor, author  |
| admin    | admin@gmail.com       | google   | admin, editor, author                    |
| writer   | writer@gmail.com      | google   | author                                   |
| rando    | rando@gmail.com       | google   | (none)                                   |
| testuser | testuser@example.com  | password | (none)                                   |

These test users allow you to test different permission levels during development.

### New App Creation (create-tosijs-platform-app)

When creating a new project with `create-tosijs-platform-app`, the initial_state
is modified to contain only:

- **One owner role** configured with the admin email provided during setup
- **No test auth users** (the auth/users.json is emptied)

This ensures new projects start with a clean state where only the specified
admin can access owner-level functionality after signing in.

## How Roles Work

Roles use a `contacts` array to define who should have access:

```json
{
  "_id": "owner-role",
  "name": "Owner",
  "contacts": [{ "type": "email", "value": "owner@gmail.com" }],
  "roles": ["owner", "developer", "admin", "editor", "author"],
  "userIds": []
}
```

The `userIds` array is populated **automatically** at runtime:

1. User signs in via Firebase Auth (Google or email/password)
2. Cloud function looks up roles by `userIds` array-contains (fast path)
3. If no match, falls back to searching `contacts` for matching email
4. If found by email, user's Firebase UID is automatically added to `userIds`
5. Subsequent requests use `userIds` for fast permission checks

This allows assigning roles before a user has ever signed in - just add their
email to a role's `contacts` array.

## Usage

### Running with Emulators

The recommended way to run locally with emulators:

```bash
bun run start-emulated
```

This command:
1. Kills any processes on emulator ports
2. Builds the frontend
3. Starts all Firebase emulators
4. Watches `src/` for changes and auto-rebuilds
5. Seeds the emulators with initial_state data

Access the app at http://127.0.0.1:5002 (or http://localhost:5002).
Access the Emulator UI at http://localhost:4000.

### Manual Seeding

If you need to re-seed without restarting emulators:

```bash
# Seed with initial_state data (preserves existing data)
bun run seed

# Clear existing data and re-seed
bun run seed-clear
```

### Accessing the App

When running locally via emulators, use `http://` (not `https://`). The app
automatically detects the protocol and connects to local emulators when
running on `http://`.

To force production services while running locally, set `use-prod` in localStorage:
```javascript
localStorage.setItem('use-prod', 'true')
```

### Admin State Management

Use the `/state` endpoint to push/pull state (requires owner role):

**Pull state from Firestore:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-project.cloudfunctions.net/state/pull?collections=page,post,role,module"
```

**Push state to Firestore:**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"page": [{"_id": "my-page", "title": "Test"}]}' \
  "https://your-project.cloudfunctions.net/state/push"
```
