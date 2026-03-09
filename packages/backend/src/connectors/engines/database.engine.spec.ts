import { DatabaseEngine } from './database.engine';

// Mock pg — use factory functions to avoid hoisting issues
const mockQuery = jest.fn();
const mockEnd = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    end: mockEnd,
  })),
}));

// Mock mssql — return lazy reference
const mockMssqlQuery = jest.fn();
jest.mock('mssql', () => ({
  connect: jest.fn().mockImplementation(() =>
    Promise.resolve({
      request: () => ({ query: mockMssqlQuery }),
      close: jest.fn(),
    }),
  ),
}));

// Mock mongodb
const mockToArray = jest.fn();
const mockLimit = jest.fn().mockReturnValue({ toArray: mockToArray });
const mockSort = jest.fn().mockReturnValue({ limit: mockLimit });
const mockFind = jest.fn().mockReturnValue({ sort: mockSort, limit: mockLimit });
const mockCollection = jest.fn().mockReturnValue({ find: mockFind });
const mockDb = jest.fn().mockReturnValue({ collection: mockCollection });
const mockConnect = jest.fn();
const mockClose = jest.fn();
jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    db: mockDb,
    close: mockClose,
  })),
}));

describe('DatabaseEngine', () => {
  let engine: DatabaseEngine;

  beforeEach(() => {
    engine = new DatabaseEngine();
    jest.clearAllMocks();
    // Re-set default mock chain
    mockFind.mockReturnValue({ sort: mockSort, limit: mockLimit });
    mockSort.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ toArray: mockToArray });
  });

  describe('static response mode', () => {
    it('should return static response without DB execution', async () => {
      const result = await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'static', path: '', staticResponse: 'Example: SELECT * FROM users' },
        {},
      );
      expect(result).toEqual({ text: 'Example: SELECT * FROM users' });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('SQL validation (validateQuery)', () => {
    it('should allow SELECT queries', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users' },
        {},
      );
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users');
    });

    it('should block INSERT queries', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'INSERT INTO users VALUES (1)' },
          {},
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });

    it('should block UPDATE queries', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'UPDATE users SET name = \'x\'' },
          {},
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });

    it('should block DELETE queries', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'DELETE FROM users' },
          {},
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });

    it('should block DROP queries', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'DROP TABLE users' },
          {},
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });
  });

  describe('SQL parameter interpolation (escapeValue)', () => {
    it('should escape string values with single quotes', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users WHERE name = $name' },
        { name: 'John' },
      );
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = 'John'",
      );
    });

    it('should escape single quotes by doubling them', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users WHERE name = $name' },
        { name: "O'Brien" },
      );
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = 'O''Brien'",
      );
    });

    it('should return NULL for null/undefined', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users WHERE name = $name' },
        { name: null },
      );
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE name = NULL',
      );
    });

    it('should return numeric values unquoted', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users WHERE age = $age' },
        { age: 25 },
      );
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE age = 25',
      );
    });

    it('should return TRUE/FALSE for booleans', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users WHERE active = $active' },
        { active: true },
      );
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE active = TRUE',
      );
    });
  });

  describe('row truncation', () => {
    it('should truncate results exceeding MAX_ROWS (1000)', async () => {
      const bigResult = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
      mockQuery.mockResolvedValue({ rows: bigResult });
      const result = (await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM big_table' },
        {},
      )) as any;
      expect(result.truncated).toBe(true);
      expect(result.rows).toHaveLength(1000);
      expect(result.totalRows).toBe(1500);
    });

    it('should not truncate results under MAX_ROWS', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
      const result = (await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'SELECT * FROM users' },
        {},
      )) as any;
      expect(result.truncated).toBeUndefined();
      expect(result.rows).toHaveLength(2);
      expect(result.totalRows).toBe(2);
    });
  });

  describe('read-write mode (readOnly: false)', () => {
    it('should allow INSERT queries when readOnly is false', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1, command: 'INSERT' });
      const result = await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'INSERT INTO users (name) VALUES (\'John\')' },
        {},
        { readOnly: false },
      );
      expect(mockQuery).toHaveBeenCalledWith("INSERT INTO users (name) VALUES ('John')");
      expect(result).toEqual({ rowCount: 1, command: 'INSERT' });
    });

    it('should allow UPDATE queries when readOnly is false', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 3, command: 'UPDATE' });
      const result = await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'UPDATE users SET name = \'x\'' },
        {},
        { readOnly: false },
      );
      expect(mockQuery).toHaveBeenCalled();
      expect(result).toEqual({ rowCount: 3, command: 'UPDATE' });
    });

    it('should allow DELETE queries when readOnly is false', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 2, command: 'DELETE' });
      const result = await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: 'DELETE FROM users WHERE id = 1' },
        {},
        { readOnly: false },
      );
      expect(mockQuery).toHaveBeenCalled();
      expect(result).toEqual({ rowCount: 2, command: 'DELETE' });
    });

    it('should still block write queries when readOnly is true (default)', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'INSERT INTO users VALUES (1)' },
          {},
          { readOnly: true },
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });

    it('should default to read-only when no options provided', async () => {
      await expect(
        engine.execute(
          { baseUrl: 'postgres://host/db', authType: 'NONE' },
          { method: 'query', path: 'INSERT INTO users VALUES (1)' },
          {},
        ),
      ).rejects.toThrow('Only SELECT queries are allowed');
    });
  });

  describe('raw param reference', () => {
    it('should use raw param value as SQL when path is ${param}', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await engine.execute(
        { baseUrl: 'postgres://host/db', authType: 'NONE' },
        { method: 'query', path: '${query}' },
        { query: 'SELECT 1' },
      );
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });
  });
});
