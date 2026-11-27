import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  const n = await prisma.category.count().catch(() => -1);
  return <main className="p-6 text-lg font-bold">남는자리 toolchain ok · categories={n}</main>;
}
