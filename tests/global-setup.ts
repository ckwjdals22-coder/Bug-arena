import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./env";

/** 테스트 실행 전에 테스트 DB 에 마이그레이션을 적용한다. */
export default function globalSetup() {
  if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
    throw new Error("TEST_DATABASE_URL 은 이름이 _test 로 끝나는 데이터베이스여야 합니다.");
  }
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
