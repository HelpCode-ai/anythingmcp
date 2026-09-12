import { capToolName, MAX_TOOL_NAME_LENGTH } from './tool-name.util';

describe('capToolName', () => {
  it('leaves a short name alone', () => {
    expect(capToolName('list_invoices')).toBe('list_invoices');
  });

  it('leaves a name of exactly 64 characters alone', () => {
    const name = 'a'.repeat(MAX_TOOL_NAME_LENGTH);
    expect(capToolName(name)).toBe(name);
  });

  it('fits a long name into 64 characters', () => {
    const name =
      'drives_drive_items_driveitem_workbook_worksheets_workbookworksheet_tables_workbooktable_rows_range';
    const capped = capToolName(name);
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(capped).toMatch(/^[a-z0-9_]+$/);
  });

  it('keeps two names that share a 64-character prefix distinct', () => {
    const prefix = 'x'.repeat(70);
    expect(capToolName(`${prefix}_alpha`)).not.toBe(capToolName(`${prefix}_beta`));
  });

  it('is deterministic', () => {
    const name = 'y'.repeat(100);
    expect(capToolName(name)).toBe(capToolName(name));
  });

  it('cuts on a word boundary when one is close', () => {
    const name =
      'groups_group_onenote_sections_onenotesection_pages_onenotepage_onenotepatchcontent';
    const capped = capToolName(name);
    // The readable head ends at an underscore, not mid-word.
    expect(capped).toMatch(/^groups_group_onenote_sections_onenotesection_pages_[a-z0-9]{6}$/);
  });
});
