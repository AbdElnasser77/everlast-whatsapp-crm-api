# Everlast CRM — Backend API

Node.js + Express backend for managing WhatsApp customer conversations. Agents receive and reply to WhatsApp messages in real time, with full customer management, media support, and an admin dashboard.

---

## Stack

- **Runtime:** Node.js (CommonJS)
- **Framework:** Express 5
- **Database:** PostgreSQL on Neon (serverless)
- **ORM:** Prisma 5
- **Real-time:** Socket.IO
- **Auth:** JWT via HttpOnly cookies
- **WhatsApp:** Meta Cloud API (webhooks + send messages)
- **Media storage:** Cloudinary
- **API Docs:** Swagger UI at `/api-docs`

---

## Getting Started

```bash
npm install
# fill in config.env with your credentials
npm run dev        # starts on port 8000
npm run seed       # creates the default admin account
```

---

## Project Structure

```
everlast-nodejs-crm-api/
├── server.js
├── app.js
├── config.env
├── config/
├── middleware/
├── modules/
├── utils/
├── prisma/
├── docs/
└── routes/
```

---

## Folders

### `server.js`
Entry point. Loads environment variables, creates the HTTP server, attaches Socket.IO, and starts listening on the configured port.

### `app.js`
Express application setup. Registers all middleware (CORS, cookie parser, JSON body parser, Swagger UI) and mounts every module's router under its `/api/*` path.

---

### `config/`
Application-level configuration files.

| File | Purpose |
|---|---|
| `env.js` | Loads `config.env` into `process.env` via dotenv |
| `prisma.js` | Creates and exports the single shared Prisma client instance |
| `database.js` | Database connection helper |
| `swagger.js` | OpenAPI 3.0 spec — defines all documented endpoints shown at `/api-docs` |

---

### `prisma/`
Everything related to the database schema.

| File | Purpose |
|---|---|
| `schema.prisma` | Single source of truth for all database models, enums, and relations |

**Models:** `User`, `Customer`, `Conversation`, `Message`, `AuditLog`, `WhatsAppNumber`, `CustomerOptOut`

**Enums:** `Role`, `AgentStatus`, `ConversationStatus`, `SenderType`, `MessageType`, `MessageStatus`

After any schema change, run:
```bash
npx prisma migrate dev --name <what-changed>   # creates + applies a migration
npx prisma generate                            # regenerates the Prisma client
```

In production: `npx prisma migrate deploy`.

> **Do not use `npx prisma db push`.** This project moved to Prisma Migrate for
> multi-number support. `db push` cannot express the partial unique index that
> keeps exactly one `WhatsAppNumber.isDefault`, and running it would silently
> drop that index.

## Multiple WhatsApp numbers

The CRM sends and receives on several WhatsApp lines. Numbers are rows in
`WhatsAppNumber`; their **access tokens stay in the environment**, named by the
row's `tokenEnvKey`, so a long-lived Meta token never enters the database or a
backup.

Everything is scoped by the selected number — the inbox, messages, campaigns and
stats — while templates are scoped by **WABA**, so two numbers on the same
WhatsApp Business Account share one template library and numbers on different
accounts are isolated automatically.

Add or update numbers by editing `config.env` and re-running the seed
(idempotent, upserts by `phoneNumberId`):

```bash
npm run seed:numbers
```

```
WHATSAPP_NUMBERS=[{"label":"Clinic","phoneNumberId":"...","wabaId":"...",
                   "displayPhoneNumber":"+971 50 123 4567",
                   "tokenEnvKey":"WHATSAPP_TOKEN_CLINIC","isDefault":true}]
WHATSAPP_TOKEN_CLINIC=EAAG...
WHATSAPP_TOKEN_MARKETING=EAAG...
```

`tokenEnvKey` must match `WHATSAPP_ACCESS_TOKEN` or `WHATSAPP_TOKEN_*` — it is an
allow-list enforced when the token is read, so a row cannot be pointed at
`JWT_SECRET` or any other unrelated secret.

**Requests** carry the selected number in an `X-WhatsApp-Number-Id` header; the
server resolves the credentials itself and echoes the header back so the client
can discard a response that arrives after the user switched. **Inbound** webhooks
route on `metadata.phone_number_id`. **Sockets** join a per-number room at
handshake, so one line's traffic never reaches an agent working another.

A reply always goes out on the line the customer wrote to, taken from the
conversation rather than from the request.

---

### `modules/`
All business logic, organised by feature. Each module is self-contained with a `controller.js` and a `routes.js`.

#### `modules/auth/`
Login and logout. Issues a JWT as an HttpOnly cookie on login. Sets the agent status to `ONLINE` on login and `OFFLINE` on logout.

- `POST /api/auth/login`
- `POST /api/auth/logout`

#### `modules/users/`
Full user management for admins. Agents can manage their own profile and status.

- `GET /api/users` — paginated list with filters (admin only)
- `POST /api/users` — create agent/admin (admin only)
- `GET/PUT/DELETE /api/users/:id` — manage a specific user (admin only)
- `PUT /api/users/:id/password` — reset password (admin only)
- `GET /api/users/me` — own profile
- `PUT /api/users/me/status` — set own status (ONLINE / OFFLINE / ON_BREAK)
- `PUT /api/users/me/password` — change own password

#### `modules/customers/`
WhatsApp contacts. Created automatically when a new number messages for the first time. Can also be created and updated manually.

- `GET /api/customers` — paginated list with search
- `POST /api/customers` — create customer
- `GET/PUT /api/customers/:id` — get or update a customer

Fields: `name`, `phone`, `email`, `tags` (array), `notes`

#### `modules/conversations/`
One conversation per customer. Tracks status, assignment, unread count, and last message.

- `GET /api/conversations` — paginated list, filter by `status` and `assignedAgentId`
- `GET /api/conversations/:id/messages` — messages in a conversation
- `POST /api/conversations/:id/read` — mark as read (resets unread count)
- `PUT /api/conversations/:id/assign` — assign to an agent (or unassign)
- `PUT /api/conversations/:id/status` — change to `OPEN`, `PENDING`, or `RESOLVED`

#### `modules/messages/`
Sending messages and searching.

- `POST /api/messages/send` — send a text or media message to a customer via WhatsApp
- `GET /api/messages/search` — full-text search across messages
- `GET /api/messages/:id/media` — proxy or redirect to media for a received media message

#### `modules/webhooks/`
Receives incoming events from Meta (WhatsApp).

- `GET /api/webhooks/whatsapp/messages` — webhook verification (called once by Meta during setup)
- `POST /api/webhooks/whatsapp/messages` — receives incoming messages and delivery status updates

On each incoming message: finds or creates the customer and conversation, saves the message, triggers a background Cloudinary upload for any media, and emits Socket.IO events to all connected agents.

#### `modules/media/`
File uploads from agents (images, videos, audio, documents).

- `POST /api/media/upload` — accepts a `multipart/form-data` file, uploads to Cloudinary, returns the public URL and detected `messageType`

Max file size: 16MB. Supported types: jpg, png, gif, webp, mp4, 3gp, aac, mp3, ogg, pdf, doc, docx, xls, xlsx.

#### `modules/audit/`
Read-only log of all significant actions (conversation assignments, status changes, user management).

- `GET /api/audit` — paginated audit log (admin only), filter by `action` and `actorId`

#### `modules/stats/`
Admin dashboard data. All endpoints are admin-only.

- `GET /api/stats/overview` — KPI counts: messages today, conversations by status, online agents, unread total
- `GET /api/stats/messages?days=7` — message volume chart, type breakdown, delivery rates, peak hour
- `GET /api/stats/conversations` — pipeline status, avg resolution time, potential leads list, stalled conversations list
- `GET /api/stats/agents` — per-agent productivity: messages sent, response time, assigned conversations
- `GET /api/stats/customers?days=30` — customer growth chart, returning customers, tag distribution, email capture rate

---

### `middleware/`
Express middleware applied to routes.

| File | Purpose |
|---|---|
| `auth.js` | Reads the JWT from the HttpOnly cookie (falls back to `Authorization: Bearer` header for Swagger). Attaches `req.user`. Updates `lastActiveAt` on every request. |
| `roles.js` | `requireRole("ADMIN")` — returns 403 if the logged-in user doesn't have the required role |
| `errorHandler.js` | Global error handler. Returns `{ success: false, message }` with the correct status code. Includes stack trace in development. |
| `webhookSignature.js` | Verifies the `X-Hub-Signature-256` header on incoming webhook requests using HMAC-SHA256 against `req.rawBody` |

---

### `utils/`
Shared helpers used across modules.

| File | Purpose |
|---|---|
| `AppError.js` | Custom error class. Accepts a message and HTTP status code. Used with `next(new AppError("message", 404))` in controllers. |
| `socket.js` | Initialises Socket.IO on the HTTP server and exports `getIO()` so any controller can emit events. Also handles typing indicator events (`typing.start` / `typing.stop`). |
| `whatsappClient.js` | Sends messages via the Meta Cloud API. Supports TEXT, IMAGE, VIDEO, AUDIO, and DOCUMENT by building the correct payload shape for each type. |
| `cloudinary.js` | Configures and exports the Cloudinary SDK instance using credentials from `config.env`. |
| `audit.js` | Fire-and-forget helper for writing to the `AuditLog` table. Never blocks the main request. |
| `seedUsers.js` | `npm run seed`: creates one account per role (admin, marketing, agent) if missing; never overwrites an existing one. |
| `cloudinaryTest.js` | One-time onboarding script used to verify the Cloudinary integration. Safe to delete after setup. |

---

### `docs/`
Frontend integration guides. Each file covers a single feature so it can be given directly to a frontend developer or AI as a focused prompt.

| File | Covers |
|---|---|
| `stats-dashboard.md` | Admin dashboard — all 5 stats endpoints, response shapes, and what UI element each field powers |
| `user-management.md` | User management — agent list, create, edit, delete, reset password, status tracking |
| `media-upload.md` | Media — sending media as an agent, displaying received media, blob URL approach for customer media |
| `frontend-complete-guide.md` | Full reference covering all endpoints, Socket.IO events, and auth flow |

---

### `routes/`
Empty — kept for potential future top-level route files. All current routes live inside `modules/`.

---

## Environment Variables (`config.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default 8000) |
| `NODE_ENV` | `development` or `production` |
| `FRONTEND_URL` | Allowed CORS origin (e.g. `http://localhost:3000`) |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `JWT_SECRET` | Secret key for signing JWTs |
| `WHATSAPP_APP_SECRET` | Used to verify incoming webhook signatures |
| `WHATSAPP_NUMBERS` | JSON array describing each WhatsApp line (see *Multiple WhatsApp numbers*) |
| `WHATSAPP_TOKEN_*` | Per-number Meta access token, named by that number's `tokenEnvKey` |
| `WHATSAPP_ACCESS_TOKEN` | Legacy single-number token; still valid as a `tokenEnvKey` |
| `WHATSAPP_PHONE_NUMBER_ID` | Legacy single-number id — only a bootstrap source for `npm run seed:numbers` |
| `WHATSAPP_VERIFY_TOKEN` | Token used during webhook verification setup |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

---

## Real-time Events (Socket.IO)

Connect to `http://localhost:8000` (not `/api`).

### Server → Frontend
| Event | When |
|---|---|
| `message.created` | New message received from customer or sent by agent |
| `conversation.updated` | Unread count or last message changed |
| `conversation.assigned` | Conversation assigned or unassigned |
| `conversation.status_changed` | Status changed to OPEN / PENDING / RESOLVED |
| `message.status_updated` | Outgoing message delivery status changed |
| `message.media_ready` | Background Cloudinary upload for received media completed |
| `typing.start` | An agent started typing |
| `typing.stop` | An agent stopped typing |

### Frontend → Server
| Event | When |
|---|---|
| `typing.start` | Agent starts typing in a conversation |
| `typing.stop` | Agent stops typing |
