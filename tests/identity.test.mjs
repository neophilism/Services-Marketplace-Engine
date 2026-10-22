import test from 'node:test';
import assert from 'node:assert/strict';
import {IdentitySessions} from '../packages/contracts/dist/identity.js';

function fixture(overrides = {}) {
  let now = 1_000;
  let sequence = 0;
  let verifierCalls = 0;
  const credentials = new Map([['credential-1', {
    credentialId: 'credential-1',
    subjectId: 'subject-1',
    publicKey: 'public-key',
    signCount: 4,
    revoked: false,
  }]]);
  const service = new IdentitySessions({
    store: {
      getCredential: async id => credentials.get(id) ?? null,
      saveCredential: async credential => credentials.set(credential.credentialId, credential),
    },
    verifyAssertion: async assertion => {
      verifierCalls += 1;
      return assertion;
    },
    createOpaqueId: () => 'opaque-' + (++sequence),
    now: () => now,
    challengeLifetimeMs: 100,
    sessionLifetimeMs: 1_000,
    ...overrides,
  });
  return {
    credentials,
    service,
    advance: milliseconds => { now += milliseconds; },
    verifierCalls: () => verifierCalls,
  };
}

function verified(challenge, overrides = {}) {
  return {
    credentialId: 'credential-1',
    challenge: challenge.challenge,
    origin: 'https://app.example.test',
    relyingPartyId: 'example.test',
    signCount: 5,
    userVerified: true,
    ...overrides,
  };
}

test('verified passkey assertion creates an MFA session and advances the counter', async () => {
  const {credentials, service} = fixture();
  const challenge = service.beginPasskeyAuthentication('https://app.example.test', 'example.test');
  assert.equal(challenge.accepted, true);
  const result = await service.completePasskeyAuthentication(
    challenge.value.challengeId,
    'credential-1',
    verified(challenge.value),
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(service.validateSession(result.value.sessionId), result);
  assert.equal(result.value.authenticationLevel, 'mfa');
  assert.equal(credentials.get('credential-1').signCount, 5);
});

test('challenges are one-time even after a rejected assertion', async () => {
  const {service, verifierCalls} = fixture();
  const challenge = service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
  const mismatch = verified(challenge, {origin: 'https://attacker.example'});
  assert.deepEqual(await service.completePasskeyAuthentication(challenge.challengeId, 'credential-1', mismatch), {
    accepted: false,
    code: 'identity_denied',
  });
  assert.deepEqual(await service.completePasskeyAuthentication(challenge.challengeId, 'credential-1', verified(challenge)), {
    accepted: false,
    code: 'identity_denied',
  });
  assert.equal(verifierCalls(), 1);
});

test('expired challenges and unknown credentials deny before assertion verification', async () => {
  const {service, advance, verifierCalls} = fixture();
  const expired = service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
  advance(101);
  assert.equal((await service.completePasskeyAuthentication(expired.challengeId, 'credential-1', verified(expired))).accepted, false);
  const unknown = service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
  assert.equal((await service.completePasskeyAuthentication(unknown.challengeId, 'unknown', verified(unknown))).accepted, false);
  assert.equal(verifierCalls(), 0);
});

test('origin, RP, user verification and monotonic counter checks fail closed', async t => {
  const cases = [
    ['origin', {origin: 'https://other.example.test'}],
    ['RP', {relyingPartyId: 'other.example.test'}],
    ['user verification', {userVerified: false}],
    ['counter replay', {signCount: 4}],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const {service} = fixture();
      const challenge = service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
      assert.deepEqual(await service.completePasskeyAuthentication(
        challenge.challengeId,
        'credential-1',
        verified(challenge, override),
      ), {accepted: false, code: 'identity_denied'});
    });
  }
});

test('revoked credentials and subjects use the same non-disclosing denial', async () => {
  const revokedCredential = fixture();
  revokedCredential.credentials.set('credential-1', {
    ...revokedCredential.credentials.get('credential-1'),
    revoked: true,
  });
  const first = revokedCredential.service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
  assert.deepEqual(await revokedCredential.service.completePasskeyAuthentication(
    first.challengeId,
    'credential-1',
    verified(first),
  ), {accepted: false, code: 'identity_denied'});

  const revokedSubject = fixture();
  revokedSubject.service.revokeSubject('subject-1');
  const second = revokedSubject.service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
  assert.deepEqual(await revokedSubject.service.completePasskeyAuthentication(
    second.challengeId,
    'credential-1',
    verified(second),
  ), {accepted: false, code: 'identity_denied'});
});

test('session expiry, explicit revocation and subject revocation invalidate sessions', async () => {
  for (const mode of ['expiry', 'session', 'subject']) {
    const {service, advance} = fixture();
    const challenge = service.beginPasskeyAuthentication('https://app.example.test', 'example.test').value;
    const session = (await service.completePasskeyAuthentication(
      challenge.challengeId,
      'credential-1',
      verified(challenge),
    )).value;
    if (mode === 'expiry') advance(1_001);
    if (mode === 'session') service.revokeSession(session.sessionId);
    if (mode === 'subject') service.revokeSubject('subject-1');
    assert.deepEqual(service.validateSession(session.sessionId), {accepted: false, code: 'identity_denied'});
  }
});

test('challenge creation requires HTTPS, an RP ID and distinct opaque values', () => {
  const {service} = fixture();
  assert.equal(service.beginPasskeyAuthentication('http://app.example.test', 'example.test').accepted, false);
  assert.equal(service.beginPasskeyAuthentication('https://app.example.test', '').accepted, false);
  const duplicate = fixture({createOpaqueId: () => 'same'}).service;
  assert.equal(duplicate.beginPasskeyAuthentication('https://app.example.test', 'example.test').accepted, false);
});
