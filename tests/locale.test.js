'use strict';

const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  registerAccount,
  createProject,
  waitForFile,
} = require('./helpers/testApp');
const { assertLangCode, LANG_CODE_PATTERN } = require('../src/modules/files/file.service');

/*
 * Locale codes.
 *
 * The catalogue the interface offers is far wider than the two letter codes the
 * pattern originally allowed: Bavarian is , Low German , Malay in
 * Jawi script . Every one of them is listed here, because a locale
 * the picker offers and the server rejects is a dead end a person only finds
 * after choosing it.
 *
 * The pattern exists to keep a locale code safe in a generated filename, a
 * Content-Disposition header and a ZIP entry name. Widening which names are
 * accepted must not widen which characters are.
 */

/** Every locale the client offers. */
const SUPPORTED_CODES = [
  'af_za', 'ar_sa', 'ast_es', 'az_az', 'ba_ru', 'bar', 'be_by', 'be_latn', 'bg_bg',
  'br_fr', 'brb', 'bs_ba', 'ca_es', 'cv_cu', 'cs_cz', 'cy_gb', 'da_dk', 'de_at', 'de_ch',
  'de_de', 'el_gr', 'en_au', 'en_ca', 'en_gb', 'en_nz', 'en_pt', 'en_ud', 'en_us', 'enp',
  'enws', 'eo_uy', 'es_ar', 'es_cl', 'es_ec', 'es_es', 'es_mx', 'es_uy', 'es_ve', 'esan',
  'et_ee', 'eu_es', 'fa_ir', 'fi_fi', 'fil_ph', 'fo_fo', 'fr_ca', 'fr_ch', 'fr_fr',
  'fra_de', 'fur_it', 'fy_nl', 'ga_ie', 'gd_gb', 'gl_es', 'go_fr', 'got_de', 'hal_ua',
  'haw_us', 'he_il', 'hi_in', 'hn_no', 'hr_hr', 'hu_hu', 'hy_am', 'id_id', 'ig_ng',
  'io_en', 'is_is', 'isv', 'it_it', 'ja_jp', 'jbo_en', 'ka_ge', 'kk_kz', 'kn_in', 'ko_kr',
  'ksh', 'kw_gb', 'ky_kg', 'la_la', 'lb_lu', 'li_li', 'lmo', 'lo_la', 'lol_us', 'lt_lt',
  'lv_lv', 'lzh', 'mk_mk', 'mn_mn', 'ms_my', 'mt_mt', 'nah', 'nds_de', 'nl_be', 'nl_nl',
  'nn_no', 'no_no', 'oc_fr', 'ovd', 'pl_pl', 'pls', 'pt_br', 'pt_pt', 'qcb_es', 'qid',
  'qya_aa', 'ro_ro', 'rpr', 'ru_ru', 'ry_ua', 'sah_sah', 'se_no', 'sk_sk', 'sl_si',
  'so_so', 'sq_al', 'sr_cs', 'sr_sp', 'sv_se', 'sxu', 'szl', 'ta_in', 'th_th', 'tl_ph',
  'tlh_aa', 'tok', 'tr_tr', 'tt_ru', 'tzo_mx', 'uk_ua', 'uz_uz', 'val_es', 'vec_it', 'vro',
  'vi_vn', 'vp_vl', 'yi_de', 'yo_ng', 'zh_cn', 'zh_hk', 'zh_tw', 'zlm_arab'
];

describe('locale codes', () => {
  it('covers the whole catalogue the interface offers', () => {
    const rejected = SUPPORTED_CODES.filter((code) => !LANG_CODE_PATTERN.test(code));
    expect(rejected).toEqual([]);
    expect(SUPPORTED_CODES).toHaveLength(143);
  });

  it('accepts codes with no two letter form', () => {
    // These are the ones a two letter rule silently made unreachable.
    for (const code of ['bar', 'nds_de', 'zlm_arab', 'sah_sah', 'qya_aa', 'tok', 'lzh']) {
      expect(assertLangCode(code)).toBe(code);
    }
  });

  it('normalises case and surrounding space', () => {
    expect(assertLangCode('  PT_BR  ')).toBe('pt_br');
  });

  describe('still refuses anything that is not a locale code', () => {
    it.each([
      ['a path traversal', '../../etc/passwd'],
      ['a path separator', 'en/us'],
      ['a backslash', 'en\\us'],
      ['a null byte', 'en\u0000us'],
      ['a header break', 'en_us\r\nX-Injected: 1'],
      ['a quote, which would break the header', 'en_us"'],
      ['a dot, which would change the extension', 'en_us.json'],
      ['a space', 'en us'],
      ['one letter', 'e'],
      ['nine letters', 'abcdefghi'],
      ['two underscores', 'en_us_extra'],
      ['a trailing underscore', 'en_'],
      ['an empty string', ''],
      ['a hyphen, which is the BCP 47 form and not this one', 'en-us'],
    ])('refuses %s', (_label, code) => {
      expect(() => assertLangCode(code)).toThrow(/not a valid locale code/);
    });
  });
});

describe('translating into a wide locale', () => {
  let app;
  let token;
  let project;

  beforeAll(async () => {
    app = await setupTestApp();
    const registered = await registerAccount(app, {
      user_id: 'locale_user',
      email: 'locale@example.test',
    });
    token = registered.token;
    project = await createProject(app, token, registered.account.user_id);
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  it('carries a three letter locale through the pipeline and the download', async () => {
    const response = await request(app)
      .post(`/api/v1/projects/${project.id}/files`)
      .set('Authorization', `Bearer ${token}`)
      .field('source_lang', 'en_us')
      .field('target_langs', 'bar,nds_de,zlm_arab')
      .attach('file', Buffer.from(JSON.stringify({ hello: 'Hello' })), 'wide_locale.json')
      .expect(202);

    const file = await waitForFile(app, token, response.body.data.file.id);
    expect(file.status).toBe('READY');

    const editor = await request(app)
      .get(`/api/v1/files/${file.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(editor.body.data.available_locales.sort()).toEqual([
      'bar',
      'en_us',
      'nds_de',
      'zlm_arab',
    ]);

    // The code reaches a Content-Disposition header, so the download is the
    // check that matters rather than the database round trip.
    const download = await request(app)
      .get(`/api/v1/files/${file.id}/download`)
      .query({ lang: 'zlm_arab' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(download.headers['content-disposition']).toBe(
      'attachment; filename="zlm_arab.json"',
    );
  });
});
