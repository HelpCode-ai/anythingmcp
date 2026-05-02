-- Sample data for the DATABASE-connector smoke test.
-- Designed to exercise the prepared-statement code path: a row is fetched by
-- bound parameter, and a deliberately injection-shaped string is also stored
-- so the test can assert that it round-trips as a literal value.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO users (name, email, active) VALUES
  ('Alice',                 'alice@example.com',         1),
  ('Bob',                   'bob@example.com',           1),
  ('Carol',                 'carol@example.com',         0),
  ('x''; DROP TABLE users;--', 'sqli@example.com', 1);

GRANT SELECT ON smoketest.* TO 'smoke'@'%';
FLUSH PRIVILEGES;
