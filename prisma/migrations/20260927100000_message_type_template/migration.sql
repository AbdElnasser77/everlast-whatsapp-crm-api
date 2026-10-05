-- utils/templateSend.js labels a Meta-approved template send "TEMPLATE", but the
-- enum never had that value, so every such send failed at message.create —
-- every campaign send and every approved template sent from the inbox. Kept in
-- its own migration: Postgres cannot use an enum value in the same transaction
-- that adds it.
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'TEMPLATE';
