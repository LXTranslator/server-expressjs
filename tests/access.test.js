'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  VALID_PASSWORD,
} = require('./helpers/testApp');

describe('access control', () => {
  let app;
  let owner;
  let outsider;
  let ownerProject;

  beforeAll(async () => {
    app = await setupTestApp();

    owner = await registerAccount(app, { user_id: 'owner_user', email: 'owner@example.test' });
    outsider = await registerAccount(app, {
      user_id: 'outsider_user',
      email: 'outsider@example.test',
    });

    ownerProject = await createProject(app, owner.token, 'owner_user', { name: 'private_work' });
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  describe('object level authorization', () => {
    it('hides another account personal namespace', async () => {
      // Reported as missing rather than forbidden, so the response cannot be
      // used to confirm that an account exists.
      await request(app)
        .get('/api/v1/namespaces/owner_user')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });

    it('refuses a project belonging to another namespace', async () => {
      await request(app)
        .get(`/api/v1/projects/${ownerProject.id}`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });

    it('refuses to list another namespace projects', async () => {
      await request(app)
        .get('/api/v1/namespaces/owner_user/projects')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });

    it('refuses to read another project credentials', async () => {
      await request(app)
        .get(`/api/v1/projects/${ownerProject.id}/keys`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });

    it('refuses to upload into another namespace project', async () => {
      await request(app)
        .post(`/api/v1/projects/${ownerProject.id}/files`)
        .set('Authorization', `Bearer ${outsider.token}`)
        .field('target_langs', 'th_th')
        .attach('file', Buffer.from('{"a":"A"}'), 'en_us.json')
        .expect(404);
    });

    it('lets the owner reach their own project', async () => {
      await request(app)
        .get(`/api/v1/projects/${ownerProject.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    });
  });

  describe('organization membership', () => {
    let organization;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/v1/namespaces/organizations')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          user_id: 'acme_corp',
          email: 'acme@example.test',
          display_name: 'Acme Corporation',
        })
        .expect(201);
      organization = response.body.data.namespace;
    });

    it('makes the creator an owner', async () => {
      const response = await request(app)
        .get('/api/v1/namespaces/acme_corp')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(response.body.data.role).toBe('OWNER');
      expect(response.body.data.namespace.type).toBe('ORG');
    });

    it('hides the organization from a non member', async () => {
      await request(app)
        .get('/api/v1/namespaces/acme_corp')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(404);
    });

    it('grants access once a membership exists', async () => {
      await request(app)
        .post('/api/v1/namespaces/acme_corp/settings/members')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ identifier: 'outsider_user', role: 'MEMBER' })
        .expect(201);

      const response = await request(app)
        .get('/api/v1/namespaces/acme_corp')
        .set('Authorization', `Bearer ${outsider.token}`)
        .expect(200);

      expect(response.body.data.role).toBe('MEMBER');
    });

    it('stops a plain member from changing organization settings', async () => {
      await request(app)
        .patch('/api/v1/namespaces/acme_corp/settings')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ display_name: 'Hijacked' })
        .expect(403);
    });

    it('stops a plain member from creating a project', async () => {
      await request(app)
        .post('/api/v1/namespaces/acme_corp/projects')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ name: 'unauthorised' })
        .expect(403);
    });

    it('stops a member from granting a role above their own', async () => {
      const third = await registerAccount(app, {
        user_id: 'third_user',
        email: 'third@example.test',
      });

      // Promote the outsider to ADMIN so they can invite at all.
      const members = await request(app)
        .get('/api/v1/namespaces/acme_corp/settings/members')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const outsiderMembership = members.body.data.members.find(
        (member) => member.member.user_id === 'outsider_user',
      );

      await request(app)
        .patch(`/api/v1/namespaces/acme_corp/settings/members/${outsiderMembership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ role: 'ADMIN' })
        .expect(200);

      // An ADMIN must not be able to mint an OWNER.
      await request(app)
        .post('/api/v1/namespaces/acme_corp/settings/members')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ identifier: 'third_user', role: 'OWNER' })
        .expect(403);

      // The same invitation at an allowed role succeeds.
      await request(app)
        .post('/api/v1/namespaces/acme_corp/settings/members')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ identifier: 'third_user', role: 'MEMBER' })
        .expect(201);

      expect(third.account.user_id).toBe('third_user');
    });

    it('refuses to remove the last owner', async () => {
      const members = await request(app)
        .get('/api/v1/namespaces/acme_corp/settings/members')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const ownerMembership = members.body.data.members.find(
        (member) => member.role === 'OWNER',
      );

      await request(app)
        .delete(`/api/v1/namespaces/acme_corp/settings/members/${ownerMembership.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(403);
    });

    it('refuses organization settings on a personal namespace', async () => {
      await request(app)
        .get('/api/v1/namespaces/owner_user/settings/members')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);
    });
  });

  describe('settings confirmation tokens', () => {
    it('requires the current password before a change', async () => {
      await request(app)
        .post('/api/v1/settings/confirm')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ password: 'WrongPassword1' })
        .expect(401);
    });

    it('spends a confirmation token exactly once', async () => {
      const confirm = await request(app)
        .post('/api/v1/settings/confirm')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ password: VALID_PASSWORD })
        .expect(200);

      const settingsToken = confirm.body.data.token;
      expect(confirm.body.data.expires_in).toBe(600);

      await request(app)
        .patch('/api/v1/settings/identifier')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ token: settingsToken, user_id: 'renamed_owner' })
        .expect(200);

      // Replaying the same token must fail.
      await request(app)
        .patch('/api/v1/settings/identifier')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ token: settingsToken, user_id: 'renamed_again' })
        .expect(401);
    });

    it('refuses a confirmation token issued to a different account', async () => {
      const confirm = await request(app)
        .post('/api/v1/settings/confirm')
        .set('Authorization', `Bearer ${outsider.token}`)
        .send({ password: VALID_PASSWORD })
        .expect(200);

      // The token belongs to the outsider, so the owner's session cannot spend
      // it even though it is otherwise valid.
      await request(app)
        .patch('/api/v1/settings/identifier')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ token: confirm.body.data.token, user_id: 'stolen_name' })
        .expect(401);
    });
  });
});
