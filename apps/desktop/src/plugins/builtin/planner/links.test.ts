import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import { hasOnlyPlannerLinks, linkNote, readNoteLinks } from './links';
import { externalKey, type ExternalItem } from './types';

const item: ExternalItem = {
  id: 'event-1',
  provider: 'google',
  calendarId: 'work',
  title: 'Meeting',
  kind: 'event',
  allDay: false,
  occurrence: '2026-09-04T09:00:00Z',
};
describe('Planner note links', () => {
  it('only collapses internal-only frontmatter and leaves user metadata visible', () => {
    expect(hasOnlyPlannerLinks('kuku_planner_links:\n  - key: example')).toBe(true);
    expect(hasOnlyPlannerLinks('title: User title\nkuku_planner_links:\n  - key: example')).toBe(
      false,
    );
    expect(hasOnlyPlannerLinks('invalid: [')).toBe(false);
  });
  it('preserves note body, unknown frontmatter, comments and Unicode', () => {
    const original =
      '---\n# Keep this comment\ntitle: 회의\ncustom:\n  preserved: true\n---\n# Notes\n\nOriginal body.\n';
    const next = linkNote(original, item);
    expect(next).toContain('# Keep this comment');
    expect(next.endsWith('# Notes\n\nOriginal body.\n')).toBe(true);
    expect(parseDocument(next.split('---')[1]).toJS().custom.preserved).toBe(true);
    expect(readNoteLinks(next)).toEqual([expect.objectContaining({ key: externalKey(item) })]);
  });
  it('does not duplicate an existing link, and separates recurring instances and providers', () => {
    const first = linkNote('# Note\n', item);
    expect(linkNote(first, item)).toBe(first);
    const second = linkNote(first, { ...item, occurrence: '2026-09-11T09:00:00Z' });
    expect(readNoteLinks(second)).toHaveLength(2);
    expect(readNoteLinks(linkNote(second, { ...item, provider: 'apple-calendar' }))).toHaveLength(
      3,
    );
  });
  it('rejects invalid YAML and malformed existing link field without replacing data', () => {
    expect(() => linkNote('---\ntitle: [broken\n---\nbody', item)).toThrow();
    expect(() => linkNote('---\nkuku_planner_links: preserved scalar\n---\nbody', item)).toThrow();
    expect(() => linkNote('---\ntitle: missing end\n', item)).toThrow();
  });
  it('preserves unknown entries written by another version', () => {
    const next = linkNote('---\nkuku_planner_links:\n  - future: metadata\n---\nbody', item);
    expect(parseDocument(next.split('---')[1]).toJS().kuku_planner_links[0]).toEqual({
      future: 'metadata',
    });
  });
});
