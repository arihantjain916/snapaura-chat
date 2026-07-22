import { PrismaClient } from "@prisma/client";

/**
 * One-off backfill for Message.is_read.
 *
 * MongoDB is schemaless, so adding `is_read Boolean @default(false)` does not
 * touch documents that already exist: the field is simply absent on them. That
 * matters because a Mongo query for `{ is_read: false }` does *not* match a
 * document where the field is missing, so every message written before this
 * change would be invisible to the unread count — a conversation full of
 * genuinely unread history would show a badge of 0.
 *
 * Existing history is marked **read**, not unread: resurfacing every old
 * message as a fresh notification is the more damaging of the two wrong
 * answers.
 *
 * The filter is `$exists: false`, which Prisma's query API cannot express, so
 * this goes through $runCommandRaw. That also makes it idempotent — messages
 * written by the new code already carry the field and are left alone, so
 * re-running this can never mark a genuinely unread message as read.
 *
 * Run once, as part of the same deploy as `prisma db push`:
 *
 *   pnpm backfill:isread
 */
const prisma = new PrismaClient();

async function main() {
  const result: any = await prisma.$runCommandRaw({
    update: "Message",
    updates: [
      {
        q: { is_read: { $exists: false } },
        u: { $set: { is_read: true } },
        multi: true,
      },
    ],
  });

  if (result?.writeErrors?.length) {
    console.error("Write errors:", result.writeErrors);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Matched ${result?.n ?? 0} message(s) without is_read, updated ${
      result?.nModified ?? 0
    }.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
