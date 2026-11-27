import "server-only";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { resolveUploadPath, uploadsRoot } from "@/server/storage";

/**
 * 로컬 드라이버로 저장한 이미지 제공(GET /uploads/**).
 * 업로드 폴더 안의 .webp 파일만 내보내고, 그 밖의 모든 경우는 404 다. S3 드라이버에서는 스토리지가 직접 제공한다.
 */

const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  if (env().STORAGE_DRIVER !== "local") return notFound();
  const { path: segments } = await context.params;
  const target = resolveUploadPath(segments);
  if (!target) return notFound();

  try {
    // 심볼릭 링크를 따라간 실제 위치도 업로드 폴더 안이어야 한다.
    const [root, file] = await Promise.all([realpath(uploadsRoot()), realpath(target)]);
    if (!file.startsWith(root + path.sep)) return notFound();
    const data = await readFile(file);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(data.length),
        "X-Content-Type-Options": "nosniff",
        // 키가 무작위이고 내용이 바뀌지 않으므로 오래 캐시한다.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // 없는 파일·폴더 등
    return notFound();
  }
}
