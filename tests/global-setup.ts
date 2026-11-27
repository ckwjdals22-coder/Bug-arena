import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./env";

/** 테스트 실행 전에 테스트 DB 에 마이그레이션을 적용한다. */
export default function globalSetup() {
  // 개발·운영 DB 를 지우는 사고를 막기 위해 이름에 _test 가 들어간 데이터베이스만 허용한다.
  if (!/\/[a-z0-9_]*_test[a-z0-9_]*(\?|$)/.test(TEST_DATABASE_URL)) {
    throw new Error("TEST_DATABASE_URL 은 이름에 _test 가 포함된 데이터베이스여야 합니다.");
  }
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
