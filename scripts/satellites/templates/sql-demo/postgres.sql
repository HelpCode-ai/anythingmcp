-- Demo database for sql-to-mcp: a small wholesale business.
-- The AI connects as amcp_reader, which can only SELECT.
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country CHAR(2) NOT NULL,
  credit_limit NUMERIC(12,2) NOT NULL
);
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  on_hand INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL
);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','SHIPPED','INVOICED','CANCELLED'))
);
CREATE TABLE order_lines (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL REFERENCES products(sku),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (order_id, sku)
);

INSERT INTO customers (name, city, country, credit_limit) VALUES
  ('Bauer Holzbau GmbH', 'Freiburg', 'DE', 50000),
  ('Stadtwerke Lörrach', 'Lörrach', 'DE', 120000),
  ('Hotel Schwarzwaldblick', 'Titisee', 'DE', 20000),
  ('Tischlerei Keller AG', 'Basel', 'CH', 35000),
  ('Brico Rossi Srl', 'Milano', 'IT', 40000);
INSERT INTO products VALUES
  ('DR-1001', 'Steel door T30, 875 x 2000 mm', 489.00, 4, 6),
  ('DR-1002', 'Wooden interior door, oak, 860 x 1985 mm', 219.90, 22, 10),
  ('LK-2040', 'Mortise lock, profile cylinder, 55 mm backset', 18.40, 3, 25),
  ('HG-3100', 'Door hinge, stainless, 3D adjustable', 12.75, 140, 60),
  ('CL-5200', 'Overhead door closer, EN 2-5', 96.00, 9, 12);
INSERT INTO orders (order_number, customer_id, order_date, status) VALUES
  ('SO-24017', 1, '2026-09-08', 'SHIPPED'),
  ('SO-24031', 2, '2026-09-15', 'OPEN'),
  ('SO-24044', 3, '2026-09-19', 'OPEN'),
  ('SO-24052', 4, '2026-09-22', 'INVOICED'),
  ('SO-24060', 5, '2026-09-24', 'OPEN');
INSERT INTO order_lines VALUES
  (1, 'DR-1002', 12, 219.90), (1, 'HG-3100', 36, 12.75),
  (2, 'DR-1001', 20, 469.00), (2, 'CL-5200', 20, 92.00), (2, 'LK-2040', 20, 18.40),
  (3, 'DR-1002', 8, 219.90),
  (4, 'HG-3100', 80, 12.75),
  (5, 'DR-1001', 6, 489.00), (5, 'LK-2040', 6, 18.40);

CREATE ROLE amcp_reader LOGIN PASSWORD 'amcp_reader';
GRANT CONNECT ON DATABASE shop TO amcp_reader;
GRANT USAGE ON SCHEMA public TO amcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO amcp_reader;
