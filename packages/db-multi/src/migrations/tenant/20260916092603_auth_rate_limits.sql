--up
-- Better Auth veritabanı rate limit'i (`rateLimit.storage: "database"`), auth türü başına bir tablo: anahtar IP + yoldur ve auth türünü
-- içermez, bu yüzden `user`, `student` ve `teacher` sayaçları ayrı tutulur. Eşleme `rateLimitTable(authType)` (`@repo/db/auth`).
-- `key` tekildir (Better Auth eşzamanlı ilk isteği çakışmadan ayırt eder); `last_request` epoch milisaniyesidir, süresi geçen satırlar
-- ona göre silinir.
CREATE TABLE rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT rate_limit_key_unique UNIQUE (key)
);

CREATE TABLE student_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT student_rate_limits_key_unique UNIQUE (key)
);

CREATE TABLE teacher_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT teacher_rate_limits_key_unique UNIQUE (key)
);

CREATE INDEX rate_limit_last_request_idx ON rate_limit (last_request);
CREATE INDEX student_rate_limits_last_request_idx ON student_rate_limits (last_request);
CREATE INDEX teacher_rate_limits_last_request_idx ON teacher_rate_limits (last_request);

--down
DROP TABLE teacher_rate_limits, student_rate_limits, rate_limit;
