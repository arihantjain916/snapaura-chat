import { PrismaClient } from "@prisma/client";

/**
 * One-off backfill for Conversation.pair_key.
 *
 * Run once (`npx tsx scripts/backfillPairKey.ts`, or ts-node) before making
 * pair_key @unique in schema.prisma. Until that index exists, two concurrent
 * first-messages between the same pair can still create duplicate
 * conversations; the application-level find-or-create narrows the window but
 * cannot close it.
 *
 * Where duplicates already exist, this reports them instead of merging: which
 * row to keep, and what to do with the messages hanging off the other, is a
 * decision worth making deliberately.
 */
const prisma = new PrismaClient();

function pairKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function main() {
  const conversations = await prisma.conversation.findMany();
  const seen = new Map<string, string>();
  const duplicates: Array<{ pairKey: string; ids: string[] }> = [];

  let updated = 0;

  for (const conversation of conversations) {
    const pairKey = pairKeyFor(conversation.sender_id, conversation.receiver_id);
    const existing = seen.get(pairKey);

    if (existing) {
      duplicates.push({ pairKey, ids: [existing, conversation.id] });
      continue;
    }

    seen.set(pairKey, conversation.id);

    if (conversation.pair_key !== pairKey) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { pair_key: pairKey },
      });
      updated += 1;
    }
  }

  console.log(`Scanned ${conversations.length} conversations, updated ${updated}.`);

  if (duplicates.length > 0) {
    console.log(
      `\n${duplicates.length} duplicate pair(s) found. Merge these before adding the unique index:`,
    );
    for (const duplicate of duplicates) {
      console.log(`  ${duplicate.pairKey} -> ${duplicate.ids.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("No duplicates. Safe to mark pair_key @unique and run prisma db push.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
