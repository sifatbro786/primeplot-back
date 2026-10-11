import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, P, hasPermission, permissionsFor } from '#shared/auth/permissions.js';

describe('RBAC bundles', () => {
  it('admin has every staff permission but no portal access', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(hasPermission('admin', p)).toBe(p !== P.PORTAL_ACCESS);
    }
  });

  it('sales executive cannot manage users, read all leads or reverse receipts', () => {
    expect(hasPermission('sales_executive', P.USERS_MANAGE)).toBe(false);
    expect(hasPermission('sales_executive', P.LEADS_READ_ALL)).toBe(false);
    expect(hasPermission('sales_executive', P.RECEIPTS_REVERSE)).toBe(false);
    expect(hasPermission('sales_executive', P.LEADS_READ_OWN)).toBe(true);
  });

  it('manager is a superset of executive', () => {
    for (const p of permissionsFor('sales_executive'))
      expect(hasPermission('sales_manager', p)).toBe(true);
    expect(hasPermission('sales_manager', P.USERS_MANAGE)).toBe(false);
  });

  it('client only gets the portal and private uploads', () => {
    expect([...permissionsFor('client')].sort()).toEqual(
      [P.MEDIA_UPLOAD_PRIVATE, P.PORTAL_ACCESS].sort(),
    );
  });

  it('unknown role gets nothing', () => {
    expect(permissionsFor('hacker').size).toBe(0);
  });
});
