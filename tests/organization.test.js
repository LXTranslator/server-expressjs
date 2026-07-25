'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
} = require('./helpers/testApp');
const { Account, Project } = require('../src/infrastructure/database/models');

describe('organization lifecycle', () => {
  let app;
  let owner;
  let admin;
  let member;

  beforeAll(async () => {
    app = await setupTestApp();

    owner = await registerAccount(app, { user_id: 'org_owner', email: 'org_owner@example.test' });
    admin = await registerAccount(app, { user_id: 'org_admin', email: 'org_admin@example.test' });
    member = await registerAccount(app, {
      user_id: 'org_member',
      email: 'org_member@example.test',
    });
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  /**
   * Creates an organization with the three test accounts in it.
   *
   * @param {string} userId Organization routing identifier.
   * @returns {Promise<object>} The organization namespace.
   */
  async function createOrganization(userId) {
    const response = await request(app)
      .post('/api/v1/namespaces/organizations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ user_id: userId, email: `${userId}@example.test`, display_name: 'Test Org' })
      .expect(201);

    for (const [account, role] of [
      [admin, 'ADMIN'],
      [member, 'MEMBER'],
    ]) {
      await request(app)
        .post(`/api/v1/namespaces/${userId}/settings/members`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ identifier: account.account.user_id, role })
        .expect(201);
    }

    return response.body.data.namespace;
  }

  describe('availability of an organization identifier', () => {
    it('reports an organization id as taken once it exists', async () => {
      await createOrganization('availability_org');

      const taken = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'availability_org' })
        .expect(200);
      expect(taken.body.data.user_id_available).toBe(false);

      const free = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'unclaimed_org' })
        .expect(200);
      expect(free.body.data.user_id_available).toBe(true);
    });

    it('refuses an organization id that collides with an existing account', async () => {
      const response = await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ user_id: 'org_member', email: 'collide@example.test' })
        .expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  describe('deletion', () => {
    it('refuses deletion by a plain member', async () => {
      await createOrganization('member_guard_org');

      await request(app)
        .delete('/api/v1/namespaces/member_guard_org')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ confirm_user_id: 'member_guard_org' })
        .expect(403);
    });

    it('refuses deletion by an admin, since only an owner may delete', async () => {
      await createOrganization('admin_guard_org');

      await request(app)
        .delete('/api/v1/namespaces/admin_guard_org')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ confirm_user_id: 'admin_guard_org' })
        .expect(403);
    });

    it('refuses deletion by a non member', async () => {
      await createOrganization('outsider_guard_org');
      const outsider = await registerAccount(app, {
        user_id: 'org_outsider',
        email: 'org_outsider@example.test',
      });

      await request(app)
        .delete('/api/v1/namespaces/outsider_guard_org')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ confirm_user_id: 'outsider_guard_org' })
        .expect(404);
    });

    it('refuses deletion when the confirmation does not match', async () => {
      await createOrganization('confirm_org');

      const response = await request(app)
        .delete('/api/v1/namespaces/confirm_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ confirm_user_id: 'wrong_name' })
        .expect(400);

      expect(response.body.error.message).toMatch(/confirmation does not match/i);

      // The organization is still there.
      await request(app)
        .get('/api/v1/namespaces/confirm_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    });

    it('requires a confirmation field at all', async () => {
      await createOrganization('missing_confirm_org');

      await request(app)
        .delete('/api/v1/namespaces/missing_confirm_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({})
        .expect(422);
    });

    it('refuses to delete a personal namespace', async () => {
      const response = await request(app)
        .delete('/api/v1/namespaces/org_owner')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ confirm_user_id: 'org_owner' })
        .expect(400);

      expect(response.body.error.message).toMatch(/personal namespace/i);
    });

    it('deletes the organization and cascades to its projects', async () => {
      const organization = await createOrganization('doomed_org');
      const project = await createProject(app, owner.token, 'doomed_org', {
        name: 'doomed_project',
      });

      expect(await Project.count({ where: { id: project.id } })).toBe(1);

      await request(app)
        .delete('/api/v1/namespaces/doomed_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ confirm_user_id: 'doomed_org' })
        .expect(204);

      // The namespace, its membership rows and its projects are all gone.
      expect(await Account.count({ where: { id: organization.id } })).toBe(0);
      expect(await Project.count({ where: { id: project.id } })).toBe(0);

      await request(app)
        .get('/api/v1/namespaces/doomed_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);
    });

    it('frees the identifier for reuse after deletion', async () => {
      await createOrganization('recycled_org');

      await request(app)
        .delete('/api/v1/namespaces/recycled_org')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ confirm_user_id: 'recycled_org' })
        .expect(204);

      const availability = await request(app)
        .get('/api/v1/auth/availability')
        .query({ user_id: 'recycled_org' })
        .expect(200);

      expect(availability.body.data.user_id_available).toBe(true);
    });
  });
});
