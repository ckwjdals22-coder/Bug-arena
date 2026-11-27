/** 테스트 전용 DB 주소. 개발 DB 를 건드리지 않도록 반드시 별도 데이터베이스를 쓴다. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://namneun:namneun@localhost:5432/namneun_test?schema=public";
