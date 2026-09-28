import { describe, expect, it } from 'vitest';
import { generateCellId } from './cell-id.js';

describe('generateCellId', () => {
  it('generates a cell id with the correct format', () => {
    const cellId = generateCellId(new Date('2026-09-28T12:00:00Z'));
    expect(cellId).toMatch(/^cell_\d{8}T\d{6}Z-[a-f0-9]{8}$/);
  });

  it('generates unique cell ids', () => {
    const cellId1 = generateCellId();
    const cellId2 = generateCellId();
    expect(cellId1).not.toBe(cellId2);
  });

  it('generates cell ids with the cell_ prefix', () => {
    const cellId = generateCellId();
    expect(cellId).toMatch(/^cell_/);
  });

  it('generates cell ids with timestamp component', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    const cellId = generateCellId(now);
    expect(cellId).toContain('20260928T120000Z');
  });

  it('generates cell ids with random suffix', () => {
    const cellId = generateCellId(new Date('2026-09-28T12:00:00Z'));
    // The suffix should be 8 hex characters
    const suffix = cellId.split('-')[1];
    expect(suffix).toMatch(/^[a-f0-9]{8}$/);
  });
});
