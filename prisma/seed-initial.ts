import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = (
    process.env.SEED_ADMIN_EMAIL ?? 'admin@duka.home'
  ).toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'NewAdmin123!';

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: 'SuperAdmin',
      passwordHash: await bcrypt.hash(password, 12),
      role: Role.ADMIN,
    },
  });

  console.log(`Admin ready: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
