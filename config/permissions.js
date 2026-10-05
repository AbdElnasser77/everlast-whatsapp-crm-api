// Single source of truth for authorization.
//
// Nothing outside this file should branch on req.user.role. Route guards call
// requirePermission(...) from middleware/permissions.js, and the frontend gates
// on the array served by GET /api/users/me and POST /api/auth/login.
//
// Adding a guarded route means adding its permission to ALL_PERMISSIONS first —
// requirePermission() throws at boot on an unknown name, so a typo in a route
// file is a crash rather than a permanent 403 nobody notices.

// Naming scheme: resource:action, lowercase, snake_case for multi-word actions.
//
// Splitting principle, so the vocabulary doesn't sprawl: split a resource into
// two permissions only when (a) the roles' grants actually differ, or (b) it's a
// plausible future attachment point for an approval gate. That's why
// contact:delete and contact:bulk_delete are separate (MARKETING gets one, not
// the other) and why campaign:send is separate from campaign:write (an approval
// gate would attach there) — but template:write covers create/update/delete/
// submit/sync as one, because ADMIN and MARKETING get all five and nobody else
// gets any.
const ALL_PERMISSIONS = [
  // Inbox
  "conversation:read",
  "conversation:write",
  "conversation:assign",
  "message:send",
  "message:delete_own",
  // Contacts
  "contact:read",
  "contact:write",
  "contact:import",
  "contact:delete",
  "contact:bulk_delete",
  // Contact lists
  "list:read",
  "list:write",
  // Segments. Split read/write for the same reason as lists: an agent picking
  // an audience to look at is a different act from authoring the rule a
  // campaign will be sent to. Preview and member listing are reads, so they sit
  // under segment:read rather than earning names of their own.
  "segment:read",
  "segment:write",
  // Templates
  "template:read",
  "template:write",
  // Campaigns
  "campaign:read",
  "campaign:write",
  "campaign:send",
  "campaign:control",
  // Media
  "media:upload",
  "media:read",
  "media:write",
  // Users
  "user:read",
  "user:write",
  // Reporting / ops
  "stats:read",
  "audit:read",
  // The Dok32 clinic-day board (served by n8n). Separate from stats:read
  // because it shows patient names and appointments, which MARKETING's
  // reporting access shouldn't include. ADMIN only, via "*".
  "clinic:read",
  // WhatsApp numbers. `number:read` lists them (every role needs it to render
  // the switcher). `number:use_any` is permission to act as any active number —
  // granted broadly in v1, and the single hook a future per-user number
  // assignment would tighten. `number:write` is CRUD on the numbers themselves.
  "number:read",
  "number:use_any",
  "number:write",
  // Development tools (the message/cost tracker). ADMIN only, via "*"; the
  // /api/dev routes also don't exist in production at all.
  "dev:tools",
];

// ADMIN is the wildcard "*" rather than an enumerated list on purpose: in this
// product ADMIN is *defined* as "everything", and an explicit list is a
// maintenance trap — every permission added later would be silently denied to
// admins until someone remembered to append it. The cost is that no permission
// can ever be admin-forbidden; none is today.
const ROLE_PERMISSIONS = {
  ADMIN: "*",

  MARKETING: [
    // Read only. GET /api/stats/conversations already returns stalled
    // conversations and potential leads with customer data, so denying this
    // while granting stats:read would protect nothing. Note the Inbox nav item
    // and the /chats pages gate on conversation:write, not this — that keeps
    // marketing out of the inbox and stops them 403ing on the auto-fired
    // mark-as-read every time they open a conversation.
    "conversation:read",
    // No contact:bulk_delete — wiping the contact database is irreversible and
    // admin-shaped. Single-contact delete covers hygiene.
    "contact:read", "contact:write", "contact:import", "contact:delete",
    "list:read", "list:write",
    // The segmentation engine is this role's core tool: defining who a campaign
    // goes to is the job. Granting write here is what stops "audience" being an
    // admin-only bottleneck on every send.
    "segment:read", "segment:write",
    "template:read", "template:write",
    "campaign:read", "campaign:write", "campaign:send", "campaign:control",
    "media:read", "media:write",
    "user:read", // agent names for reporting filters; user:write stays ADMIN
    "stats:read", "audit:read", "number:read", "number:use_any",
  ],

  AGENT: [
    "conversation:read", "conversation:write", "conversation:assign",
    "message:send", "message:delete_own",
    // Kept per product decision: an agent on the phone needs to add a walk-in
    // or fix a wrong number. Imports and bulk delete are not granted.
    "contact:read", "contact:write",
    "list:read",
    // Read-only, exactly as with lists: an agent may look at an audience while
    // working a conversation, but authoring the rule a bulk send targets is not
    // theirs to do.
    "segment:read",
    // Load-bearing: this is what lets an agent pick a template to send inside a
    // conversation. Template *administration* is template:write.
    "template:read",
    // No campaign permissions. The server supports an agent drafting a campaign
    // and submitting it for approval (the controller limits anyone with
    // campaign:write but not campaign:send to their own DRAFTs), but the
    // frontend has no submit / approve / reject screens yet — granting
    // campaign:write here would let agents build drafts nobody can approve.
    // Add "campaign:read", "campaign:write" once those screens exist.
    "media:upload", "media:read",
    // An agent must be able to see and act as whichever line a customer wrote
    // to; without these, inbound conversations on a number they aren't "on"
    // would be unanswerable.
    "number:read", "number:use_any",
  ],
};

// Must stay in sync with `enum Role` in prisma/schema.prisma.
const ROLES = Object.keys(ROLE_PERMISSIONS);

// A typo in a grant above would otherwise surface as a permanent, silent 403 on
// one route. Fail at boot instead.
for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
  if (perms === "*") continue;
  for (const p of perms) {
    if (!ALL_PERMISSIONS.includes(p)) {
      throw new Error(
        `config/permissions.js: role ${role} grants unknown permission "${p}"`,
      );
    }
  }
}

// Built once at require time. The per-request hot path is a single Set.has().
const PERMISSION_SETS = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [
    role,
    new Set(perms === "*" ? ALL_PERMISSIONS : perms),
  ]),
);

// Frozen, shared arrays — no per-request allocation, and a controller can't
// mutate another request's permission list.
const EMPTY = Object.freeze([]);
const PERMISSION_LISTS = Object.fromEntries(
  Object.entries(PERMISSION_SETS).map(([role, set]) => [
    role,
    Object.freeze([...set]),
  ]),
);

// Fail closed: an unknown role (a row written out-of-band, or a value added to
// the Prisma enum but not to this file) gets zero permissions rather than
// inheriting someone else's.
const permissionsFor = (role) => PERMISSION_LISTS[role] || EMPTY;

const roleHasPermission = (role, permission) =>
  PERMISSION_SETS[role]?.has(permission) === true;

const isKnownRole = (role) =>
  Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);

module.exports = {
  ALL_PERMISSIONS,
  ROLES,
  permissionsFor,
  roleHasPermission,
  isKnownRole,
};
