"use server";

import "server-only";
import { getSellerContext, requireUserOrThrow } from "@/server/auth/guards";
import { err, runAction, type ActionResult } from "@/server/errors";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { IMAGE_SCOPES, saveImage, type ImageScope } from "@/server/storage";

const isImageScope = (value: unknown): value is ImageScope => IMAGE_SCOPES.includes(value as ImageScope);

/**
 * 이미지 업로드. FormData 의 "file"(이미지)과 "scope"(product | business | review)를 받는다.
 * 로그인한 회원만 올릴 수 있고(시간당 30장), 상품·사업장 이미지는 사업장 구성원만 올릴 수 있다.
 * 돌려준 url 을 상품·프로필·후기 저장 액션에 그대로 넘긴다.
 */
export async function uploadImageAction(formData: FormData): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const user = await requireUserOrThrow();
    const scope = formData.get("scope");
    const file = formData.get("file");
    if (!isImageScope(scope)) throw err.validation("이미지 용도를 확인해 주세요.");
    if (!(file instanceof File)) throw err.validation("이미지 파일을 골라 주세요.");

    let ownerId = user.id;
    if (scope !== "review") {
      const seller = await getSellerContext();
      if (!seller) throw err.forbidden("사업자 등록을 마친 뒤에 올릴 수 있어요.");
      ownerId = seller.business.id;
    }
    await enforceRateLimit(`upload:user:${user.id}`, 30, 3600, "이미지를 너무 많이 올렸어요. 잠시 후 다시 시도해 주세요.");
    const saved = await saveImage(file, { scope, ownerId });
    return { url: saved.url };
  });
}
