import { TEST_DATABASE_URL } from "./env";

process.env.DATABASE_URL = TEST_DATABASE_URL;
// NODE_ENV 는 vitest 가 "test" 로 설정한다.
process.env.APP_URL = "http://localhost:3000";
process.env.PAYMENT_PROVIDER = "mock";
process.env.SMS_PROVIDER = "none";
