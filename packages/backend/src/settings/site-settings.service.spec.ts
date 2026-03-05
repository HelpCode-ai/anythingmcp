import { SiteSettingsService } from './site-settings.service';

describe('SiteSettingsService', () => {
  let service: SiteSettingsService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      siteSettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    service = new SiteSettingsService(mockPrisma);
  });

  describe('get', () => {
    it('should return value for existing key', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue({
        key: 'theme',
        value: 'dark',
      });
      const result = await service.get('theme');
      expect(result).toBe('dark');
      expect(mockPrisma.siteSettings.findUnique).toHaveBeenCalledWith({
        where: { key: 'theme' },
      });
    });

    it('should return null when key not found', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue(null);
      const result = await service.get('missing');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should upsert with key and value', async () => {
      mockPrisma.siteSettings.upsert.mockResolvedValue({});
      await service.set('theme', 'light');
      expect(mockPrisma.siteSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'theme' },
        update: { value: 'light' },
        create: { key: 'theme', value: 'light' },
      });
    });
  });

  describe('getJson', () => {
    it('should parse and return valid JSON', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue({
        key: 'config',
        value: '{"host":"smtp.example.com","port":587}',
      });
      const result = await service.getJson('config');
      expect(result).toEqual({ host: 'smtp.example.com', port: 587 });
    });

    it('should return null for invalid JSON string', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue({
        key: 'bad',
        value: 'not-json{',
      });
      const result = await service.getJson('bad');
      expect(result).toBeNull();
    });

    it('should return null when key does not exist', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue(null);
      const result = await service.getJson('missing');
      expect(result).toBeNull();
    });
  });

  describe('setJson', () => {
    it('should stringify value and call set', async () => {
      mockPrisma.siteSettings.upsert.mockResolvedValue({});
      await service.setJson('config', { host: 'smtp.example.com' });
      expect(mockPrisma.siteSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'config' },
        update: { value: '{"host":"smtp.example.com"}' },
        create: { key: 'config', value: '{"host":"smtp.example.com"}' },
      });
    });
  });

  describe('getAll', () => {
    it('should return all settings as key-value record', async () => {
      mockPrisma.siteSettings.findMany.mockResolvedValue([
        { key: 'theme', value: 'dark' },
        { key: 'lang', value: 'en' },
      ]);
      const result = await service.getAll();
      expect(result).toEqual({ theme: 'dark', lang: 'en' });
    });

    it('should return empty record when no settings exist', async () => {
      mockPrisma.siteSettings.findMany.mockResolvedValue([]);
      const result = await service.getAll();
      expect(result).toEqual({});
    });
  });

  describe('delete', () => {
    it('should call deleteMany with key', async () => {
      mockPrisma.siteSettings.deleteMany.mockResolvedValue({ count: 1 });
      await service.delete('theme');
      expect(mockPrisma.siteSettings.deleteMany).toHaveBeenCalledWith({
        where: { key: 'theme' },
      });
    });
  });

  describe('getSmtpConfig', () => {
    it('should return parsed SMTP config', async () => {
      const smtp = {
        host: 'smtp.example.com',
        port: 587,
        user: 'u',
        pass: 'p',
        from: 'noreply@example.com',
        secure: true,
      };
      mockPrisma.siteSettings.findUnique.mockResolvedValue({
        key: 'smtp_config',
        value: JSON.stringify(smtp),
      });
      const result = await service.getSmtpConfig();
      expect(result).toEqual(smtp);
    });

    it('should return null when not configured', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue(null);
      const result = await service.getSmtpConfig();
      expect(result).toBeNull();
    });
  });

  describe('getFooterLinks', () => {
    it('should return parsed footer links', async () => {
      const links = [{ label: 'Docs', url: 'https://docs.example.com' }];
      mockPrisma.siteSettings.findUnique.mockResolvedValue({
        key: 'footer_links',
        value: JSON.stringify(links),
      });
      const result = await service.getFooterLinks();
      expect(result).toEqual(links);
    });

    it('should return empty array when not configured', async () => {
      mockPrisma.siteSettings.findUnique.mockResolvedValue(null);
      const result = await service.getFooterLinks();
      expect(result).toEqual([]);
    });
  });
});
