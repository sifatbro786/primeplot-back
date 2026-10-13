import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Meta app settings must exist before #config/env.js is first imported.
vi.hoisted(() => {
  process.env.META_APP_SECRET = 'unit-app-secret';
  process.env.META_VERIFY_TOKEN = 'unit-verify-token';
  process.env.SMS_COST_PER_SEGMENT_POISHA = '35';
});

const { analyzeSms, smsCost } = await import('#integrations/sms/segments.js');
const { toBdMsisdn, sendSms, SmsSendError } = await import('#integrations/sms/index.js');
const bulksmsbd = await import('#integrations/sms/drivers/bulksmsbd.js');
const sslwireless = await import('#integrations/sms/drivers/sslwireless.js');
const { decryptSecret, encryptSecret } = await import('#shared/crypto/secrets.js');
const graph = await import('#integrations/meta/graph.js');
const { mapMetaLead, parseMetaTime, labelOf } = await import('#integrations/meta/leadFields.js');
const { renderAutoReply, localeFromPage, checkAutoReply } =
  await import('#modules/leads/autoReplyText.js');
const { clientRefOf } = await import('#modules/sms/sms.service.js');
const { isReconcileDue } = await import('#modules/meta/meta.service.js');
const { zMetaConnect, zMetaForms, zSmsPreview, zSmsTest } =
  await import('#modules/integrations/integration.validation.js');
const { env } = await import('#config/env.js');

afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (status, body) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('SMS segments (GSM-7 / UCS-2)', () => {
  it.each([
    ['a'.repeat(160), 'gsm7', 1],
    ['a'.repeat(161), 'gsm7', 2],
    ['a'.repeat(306), 'gsm7', 2],
    ['a'.repeat(307), 'gsm7', 3],
    ['€'.repeat(80), 'gsm7', 1], // extension chars take 2 septets
    ['€'.repeat(81), 'gsm7', 2],
    ['ক'.repeat(70), 'ucs2', 1],
    ['ক'.repeat(71), 'ucs2', 2],
    ['ক'.repeat(134), 'ucs2', 2],
    ['ক'.repeat(135), 'ucs2', 3],
    ['😀'.repeat(35), 'ucs2', 1], // emoji = 2 UTF-16 units
    ['Hello “world”', 'ucs2', 1], // curly quotes are not GSM
    ['', 'gsm7', 0],
  ])('%#: %s chars → %s, %i segment(s)', (text, encoding, segments) => {
    const a = analyzeSms(text);
    expect(a.encoding).toBe(encoding);
    expect(a.segments).toBe(segments);
  });

  it('never splits an escape pair or a surrogate pair across segments', () => {
    // 152 'a' + '€' (2 septets) = 154 > 153 → € starts segment 2
    expect(analyzeSms(`${'a'.repeat(152)}€${'a'.repeat(10)}`)).toMatchObject({
      segments: 2,
      remaining: 153 - 12,
    });
    expect(analyzeSms(`${'a'.repeat(66)}😀${'a'.repeat(10)}`)).toMatchObject({
      segments: 2,
      remaining: 67 - 12,
    });
  });

  it('cost = segments × per-segment price; null when the price is not configured', () => {
    expect(smsCost('ক'.repeat(100), 35).costPoisha).toBe(70);
    expect(smsCost('hi', null).costPoisha).toBeNull();
  });
});

describe('SMS drivers', () => {
  it('only Bangladesh mobiles are sent', () => {
    expect(toBdMsisdn('+8801712345678')).toBe('8801712345678');
    expect(toBdMsisdn('+971501234567')).toBeNull();
    expect(toBdMsisdn('01712345678')).toBeNull(); // callers pass E.164
  });

  it('log driver (default) sends nothing and succeeds', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = await sendSms(null, { to: '+8801712345678', text: 'hi', clientRef: 'x' });
    expect(r.driver).toBe('log');
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      sendSms(null, { to: '+971501234567', text: 'hi', clientRef: 'x' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DESTINATION', permanent: true });
  });

  const cfg = { apiKey: 'KEY123', senderId: '8809617000000', baseUrl: undefined };

  it('BulkSMSBD: form POST with key in the body; 202 = sent; codes mapped', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, { response_code: 202, success_message: 'SMS Submitted Successfully' }),
    );
    vi.stubGlobal('fetch', fetch);
    await bulksmsbd.send({ msisdn: '8801712345678', text: 'হ্যালো', config: cfg });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://bulksmsbd.net/api/smsapi');
    expect(url).not.toContain('KEY123');
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({
      api_key: 'KEY123',
      senderid: '8809617000000',
      number: '8801712345678',
      message: 'হ্যালো',
    });

    fetch.mockResolvedValueOnce(jsonResponse(200, { response_code: 1007, error_message: '' }));
    await expect(
      bulksmsbd.send({ msisdn: '8801712345678', text: 'x', config: cfg }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      permanent: true,
      providerCode: '1007',
    });
    fetch.mockResolvedValueOnce(jsonResponse(200, { response_code: 1005 }));
    await expect(
      bulksmsbd.send({ msisdn: '8801712345678', text: 'x', config: cfg }),
    ).rejects.toMatchObject({ permanent: false });
    fetch.mockResolvedValueOnce(jsonResponse(503, 'down'));
    await expect(
      bulksmsbd.send({ msisdn: '8801712345678', text: 'x', config: cfg }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DOWN', permanent: false });
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      bulksmsbd.send({ msisdn: '8801712345678', text: 'x', config: cfg }),
    ).rejects.toBeInstanceOf(SmsSendError);
  });

  it('SSL Wireless: JSON v3 with csms_id; SUCCESS → reference id; auth failure is permanent', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        status: 'SUCCESS',
        status_code: 200,
        error_message: '',
        smsinfo: [{ sms_status: 'SUCCESS', msisdn: '8801712345678', reference_id: 'R1' }],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const r = await sslwireless.send({
      msisdn: '8801712345678',
      text: 'hello',
      clientRef: 'abc123',
      config: cfg,
    });
    expect(r.providerMessageId).toBe('R1');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://smsplus.sslwireless.com/api/v3/send-sms');
    expect(JSON.parse(init.body)).toEqual({
      api_token: 'KEY123',
      sid: '8809617000000',
      msisdn: '8801712345678',
      sms: 'hello',
      csms_id: 'abc123',
    });

    fetch.mockResolvedValueOnce(
      jsonResponse(200, { status: 'FAILED', status_code: 4001, error_message: 'Unauthorized' }),
    );
    await expect(
      sslwireless.send({ msisdn: '8801712345678', text: 'x', clientRef: 'b', config: cfg }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', permanent: true });
  });

  it('message reference fits SSL Wireless csms_id (≤ 20 chars)', () => {
    const ref = clientRefOf('ffffffffffffffffffffffff');
    expect(ref.length).toBeLessThanOrEqual(20);
    expect(clientRefOf('0123456789abcdef01234567')).not.toBe(ref);
  });
});

describe('auto-reply text', () => {
  it('fills placeholders, trims a long name, keeps unknown ones', () => {
    expect(
      renderAutoReply('ধন্যবাদ {name}! {company}', { name: '  Rahim   Uddin ', company: 'Acme' }),
    ).toBe('ধন্যবাদ Rahim Uddin! Acme');
    expect(renderAutoReply('{name}', { name: 'x'.repeat(100), company: '' })).toHaveLength(40);
    expect(renderAutoReply('Hi {first}', { name: 'A', company: 'B' })).toBe('Hi {first}');
  });

  it('language comes from the website page', () => {
    expect(localeFromPage('/en/projects/x', null)).toBe('en');
    expect(localeFromPage('/bn', null)).toBe('bn');
    expect(localeFromPage('/projects/x', null)).toBeNull();
    expect(localeFromPage(undefined, 'bn')).toBe('bn');
  });

  it('length check uses the long sample name; the default Bangla text fits', () => {
    const org = { name: 'Acme Properties', nameBn: 'অ্যাকমি প্রপার্টিজ' };
    const def =
      'ধন্যবাদ {name}! {company}-এ আপনার আগ্রহ আমরা পেয়েছি। শিগগিরই আমাদের প্রতিনিধি আপনাকে ফোন করবেন।';
    expect(checkAutoReply(def, { org, locale: 'bn' })).toMatchObject({
      ok: true,
      encoding: 'ucs2',
    });
    expect(checkAutoReply('ক'.repeat(470), { org, locale: 'bn' }).ok).toBe(false);
  });
});

describe('secret encryption (Meta page token)', () => {
  it('round-trips, is randomised, and refuses tampering or another purpose', () => {
    const a = encryptSecret('EAAG-page-token', 'meta-page-token');
    const b = encryptSecret('EAAG-page-token', 'meta-page-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('EAAG');
    expect(decryptSecret(a, 'meta-page-token')).toBe('EAAG-page-token');
    expect(decryptSecret(a, 'other')).toBeNull();
    const parts = a.split('.');
    parts[3] = `${parts[3].slice(0, -2)}AA`;
    expect(decryptSecret(parts.join('.'), 'meta-page-token')).toBeNull();
    expect(decryptSecret('garbage', 'meta-page-token')).toBeNull();
  });
});

describe('Meta webhook + Graph', () => {
  it('verifies X-Hub-Signature-256 over the raw body', () => {
    const raw = Buffer.from('{"object":"page","entry":[]}');
    const sig = `sha256=${createHmac('sha256', 'unit-app-secret').update(raw).digest('hex')}`;
    expect(graph.verifyWebhookSignature(raw, sig, 'unit-app-secret')).toBe(true);
    expect(
      graph.verifyWebhookSignature(
        raw,
        sig.toUpperCase().replace('SHA256', 'sha256'),
        'unit-app-secret',
      ),
    ).toBe(true);
    expect(graph.verifyWebhookSignature(Buffer.from(`${raw} `), sig, 'unit-app-secret')).toBe(
      false,
    );
    expect(graph.verifyWebhookSignature(raw, 'sha1=abc', 'unit-app-secret')).toBe(false);
    expect(graph.verifyWebhookSignature(undefined, sig, 'unit-app-secret')).toBe(false);
  });

  it('extracts leadgen changes and ignores everything else', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: '111',
          time: 1,
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: '444',
                page_id: '111',
                form_id: '555',
                ad_id: '9',
                created_time: 1791900000,
              },
            },
            { field: 'feed', value: { post_id: '1' } },
            { field: 'leadgen', value: { leadgen_id: 'not-a-number', page_id: '111' } },
          ],
        },
      ],
    };
    expect(graph.leadgenChanges(body)).toEqual([
      {
        leadgenId: '444',
        pageId: '111',
        formId: '555',
        adId: '9',
        createdTime: new Date(1791900000 * 1000),
      },
    ]);
    expect(graph.leadgenChanges({ object: 'user', entry: [] })).toEqual([]);
  });

  it('calls Graph with the version, a Bearer token and appsecret_proof (never the token in the URL)', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, { id: '111', name: 'Acme', access_token: 'PAGETOKEN' }),
    );
    vi.stubGlobal('fetch', fetch);
    const page = await graph.resolvePage('111', 'USERTOKEN');
    expect(page).toEqual({ id: '111', name: 'Acme', pageToken: 'PAGETOKEN' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(new RegExp(`^https://graph.facebook.com/${env.META_GRAPH_VERSION}/111\\?`));
    expect(url).not.toContain('USERTOKEN');
    expect(init.headers.Authorization).toBe('Bearer USERTOKEN');
    expect(new URL(url).searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', 'unit-app-secret').update('USERTOKEN').digest('hex'),
    );
  });

  it('classifies Graph errors: token → auth, rate limit → retry, bad id → permanent', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    fetch.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'Session expired', code: 190, error_subcode: 463 } }),
    );
    await expect(graph.getLead('1', 'T')).rejects.toMatchObject({
      isAuth: true,
      retryable: false,
      kind: 'META_TOKEN_INVALID',
    });
    fetch.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'Too many calls', code: 4 } }),
    );
    await expect(graph.getLead('1', 'T')).rejects.toMatchObject({
      retryable: true,
      kind: 'META_RATE_LIMITED',
    });
    fetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: 'Unsupported get request', code: 100, error_subcode: 33 },
      }),
    );
    await expect(graph.getLead('1', 'T')).rejects.toMatchObject({
      retryable: false,
      isAuth: false,
    });
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(graph.getLead('1', 'T')).rejects.toMatchObject({
      retryable: true,
      kind: 'META_UNREACHABLE',
    });
  });

  it('falls back to the core lead fields if Meta rejects one of the extras', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    fetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: '(#100) Tried accessing nonexisting field (adset_name)', code: 100 },
      }),
    );
    fetch.mockResolvedValueOnce(jsonResponse(200, { id: '1', field_data: [] }));
    expect(await graph.getLead('1', 'T')).toEqual({ id: '1', field_data: [] });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('fields')).toBe(
      'id,created_time,form_id,ad_id,field_data',
    );
  });

  it('reads form leads page by page with a time_created filter', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'C1' }, next: 'https://x' },
      }),
    );
    fetch.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ id: '2' }], paging: { cursors: { after: 'C2' } } }),
    );
    const since = new Date('2026-10-12T00:00:00Z');
    const seen = [];
    for await (const batch of graph.formLeadsSince('555', 'T', since))
      seen.push(...batch.map((l) => l.id));
    expect(seen).toEqual(['1', '2']);
    const q = new URL(fetch.mock.calls[1][0]).searchParams;
    expect(q.get('after')).toBe('C1');
    expect(JSON.parse(q.get('filtering'))).toEqual([
      { field: 'time_created', operator: 'GREATER_THAN', value: since.getTime() / 1000 },
    ]);
  });
});

describe('Meta lead → lead fields', () => {
  const raw = {
    id: '444',
    created_time: '2026-10-13T10:00:00+0000',
    form_id: '555',
    platform: 'ig',
    is_organic: false,
    campaign_name: 'Lake View — Oct',
    field_data: [
      { name: 'full_name', values: ['Rahim Uddin'] },
      { name: 'phone_number', values: ['+8801712345678'] },
      { name: 'email', values: ['RAHIM@Example.com'] },
      { name: 'which_size_do_you_prefer?', values: ['1450 sft'] },
      { name: 'city', values: ['Dhaka'] },
    ],
  };

  it('maps the standard questions and turns the rest into message lines', () => {
    expect(mapMetaLead(raw)).toMatchObject({
      name: 'Rahim Uddin',
      phone: '+8801712345678',
      email: 'rahim@example.com',
      message: 'Which size do you prefer?: 1450 sft\nCity: Dhaka',
      source: 'instagram',
      isOrganic: false,
      formId: '555',
      campaign: 'Lake View — Oct',
      createdTime: new Date('2026-10-13T10:00:00Z'),
    });
  });

  it('first + last name, phone from a custom question, bad email dropped', () => {
    const m = mapMetaLead({
      field_data: [
        { name: 'first_name', values: ['Karim'] },
        { name: 'last_name', values: ['Ali'] },
        { name: 'আপনার_মোবাইল_নম্বর', values: ['01812345678'] },
        { name: 'email', values: ['not-an-email'] },
      ],
    });
    expect(m).toMatchObject({
      name: 'Karim Ali',
      phone: '01812345678',
      email: null,
      source: 'facebook',
    });
  });

  it('helpers', () => {
    expect(labelOf('what_is_your_budget?')).toBe('What is your budget?');
    expect(parseMetaTime(1791900000)).toEqual(new Date(1791900000 * 1000));
    expect(parseMetaTime('nope')).toBeNull();
  });
});

describe('nightly reconcile window', () => {
  const at = (s) => new Date(`${s}+06:00`);
  const conn = (last) => ({ status: 'active', lastReconciledAt: last ? at(last) : null });
  it('runs once a night (02–06 Dhaka) or when the last run is over 30 h old', () => {
    expect(isReconcileDue(conn(null), at('2026-10-13T03:00'))).toBe(true);
    expect(isReconcileDue(conn('2026-10-12T03:00'), at('2026-10-13T03:00'))).toBe(true);
    expect(isReconcileDue(conn('2026-10-13T02:10'), at('2026-10-13T03:00'))).toBe(false);
    expect(isReconcileDue(conn('2026-10-12T10:00'), at('2026-10-13T12:00'))).toBe(false); // 26 h, daytime
    expect(isReconcileDue(conn('2026-10-12T03:00'), at('2026-10-13T12:00'))).toBe(true); // 33 h overdue
  });
  it('a broken connection is not reconciled automatically', () => {
    expect(
      isReconcileDue({ status: 'error', lastReconciledAt: null }, at('2026-10-13T03:00')),
    ).toBe(false);
  });
});

describe('integration request schemas', () => {
  it('connect needs a numeric page id and a token-looking string', () => {
    expect(
      zMetaConnect.safeParse({ pageId: '1234567890', accessToken: 'EAAB'.padEnd(40, 'x') }).success,
    ).toBe(true);
    expect(
      zMetaConnect.safeParse({ pageId: 'acme', accessToken: 'EAAB'.padEnd(40, 'x') }).success,
    ).toBe(false);
    expect(zMetaConnect.safeParse({ pageId: '1', accessToken: 'short' }).success).toBe(false);
    expect(
      zMetaConnect.safeParse({ pageId: '1', accessToken: 'x'.repeat(30), extra: 1 }).success,
    ).toBe(false);
  });
  it('form mappings, preview and test SMS', () => {
    expect(zMetaForms.parse({ version: 0, mappings: [{ formId: '555' }] }).mappings[0]).toEqual({
      formId: '555',
      type: 'buyer',
    });
    expect(
      zMetaForms.safeParse({ version: 0, mappings: [{ formId: '555', type: 'tenant' }] }).success,
    ).toBe(false);
    expect(zSmsPreview.safeParse({ text: 'hi', locale: 'bn' }).success).toBe(true);
    expect(zSmsTest.safeParse({ to: '01712345678' }).success).toBe(true);
  });
});
