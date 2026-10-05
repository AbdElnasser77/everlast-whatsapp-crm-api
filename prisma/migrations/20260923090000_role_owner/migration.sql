-- OWNER: reaches every business. Kept in its own migration because a Postgres
-- enum value cannot be USED in the same transaction that adds it, and keeping
-- enum changes apart from table changes avoids ever having to reason about that.
ALTER TYPE "Role" ADD VALUE 'OWNER' BEFORE 'ADMIN';
