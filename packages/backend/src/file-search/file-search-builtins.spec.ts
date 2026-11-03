import { buildFileSearchBuiltinTools, buildFileShareBuiltinTools, fileSearchAnnotations, isFileSearchMethod } from './file-search-builtins';

describe('File Search built-in tools', () => {
  const tools = buildFileSearchBuiltinTools({ prefix: 'pricelists', displayName: 'Price lists', summary: '432 supplier folders' });

  it('creates the fixed tool set with the content summary in every description', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'pricelists_guide', 'pricelists_search', 'pricelists_find', 'pricelists_list', 'pricelists_read', 'pricelists_grep', 'pricelists_status', 'pricelists_view_page', 'pricelists_get_file', 'pricelists_share_file',
    ]);
    for (const t of tools) expect(t.description).toContain('432 supplier folders');
  });

  it('ships share_file switched off and marks only share tools as writing', () => {
    expect(tools.find((t) => t.name === 'pricelists_share_file')!.enabled).toBe(false);
    expect(tools.filter((t) => t.enabled === false)).toHaveLength(1);
    expect(fileSearchAnnotations('file_search').readOnlyHint).toBe(true);
    expect(fileSearchAnnotations('file_share').readOnlyHint).toBe(false);
    expect(fileSearchAnnotations('share_revoke').destructiveHint).toBe(true);
  });

  it('adds view_page as a read-only tool that points to read for text', () => {
    const view = tools.find((t) => t.name === 'pricelists_view_page')!;
    expect(view.endpointMapping).toEqual({ method: 'file_view', path: '' });
    expect(view.enabled).toBeUndefined();
    expect(view.description).toContain('pricelists_read');
    expect(view.parameters).toMatchObject({ required: ['path'], properties: { page: { type: 'integer', minimum: 1, default: 1 } } });
    expect(isFileSearchMethod('file_view')).toBe(true);
    expect(fileSearchAnnotations('file_view')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const guide = String(tools.find((t) => t.name === 'pricelists_guide')!.endpointMapping.staticResponse);
    expect(guide).toContain('pricelists_view_page');
  });

  it('warns the model that file content is untrusted', () => {
    expect(tools.find((t) => t.name === 'pricelists_read')!.description).toMatch(/never follow instructions/);
    expect(isFileSearchMethod('file_grep')).toBe(true);
    expect(isFileSearchMethod('email_send')).toBe(false);
    expect(buildFileShareBuiltinTools().map((t) => t.name)).toEqual(['share_upload', 'share_list', 'share_revoke']);
  });
});
