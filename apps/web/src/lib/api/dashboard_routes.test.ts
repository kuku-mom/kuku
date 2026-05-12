import { describe, expect, it } from 'vitest';

import { dashboardPathToRoute, dashboardRoutePaths, routeFromDashboardPath } from './dashboard';

describe('dashboard routes', () => {
  it('includes the sync static route', () => {
    expect(dashboardRoutePaths).toContain('sync');
  });

  it('maps /dashboard/sync to the sync route', () => {
    expect(routeFromDashboardPath('/dashboard/sync')).toBe('sync');
    expect(routeFromDashboardPath('/dashboard/sync/')).toBe('sync');
  });

  it('maps Astro path params to dashboard routes', () => {
    expect(dashboardPathToRoute('sync')).toBe('sync');
    expect(dashboardPathToRoute(undefined)).toBe('overview');
    expect(dashboardPathToRoute('unknown')).toBe('overview');
  });
});
