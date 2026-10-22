import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError, CONTRACT_VERSION, createClient} from '../packages/sdk/dist/index.js';

test('generated client sends the versioned authenticated contract request', async () => {
  let observed;
  const client = createClient({
    baseUrl: 'https://api.example.test/',
    bearerToken: 'token-1',
    fetch: async (input, init) => {
      observed = {input, init};
      return {ok: true, status: 200, json: async () => ({id: 'resource/1', organizationId: 'org 1'})};
    },
  });

  assert.deepEqual(await client.getResource('org 1', 'resource/1'), {
    id: 'resource/1',
    organizationId: 'org 1',
  });
  assert.equal(CONTRACT_VERSION, 1);
  assert.deepEqual(observed, {
    input: 'https://api.example.test/v1/organizations/org%201/resources/resource%2F1',
    init: {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer token-1',
        'x-contract-version': '1',
      },
    },
  });
});

test('client rejects invalid configuration and identifiers before network access', async () => {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    throw new Error('network must not run');
  };
  assert.throws(() => createClient({baseUrl: 'http://api.example.test', bearerToken: 'token', fetch}), /HTTPS/);
  assert.throws(() => createClient({baseUrl: 'https://api.example.test', bearerToken: '', fetch}), /bearerToken/);
  const client = createClient({baseUrl: 'https://api.example.test', bearerToken: 'token', fetch});
  await assert.rejects(client.getResource('', 'resource-1'), /organizationId/);
  await assert.rejects(client.getResource('org-1', ''), /resourceId/);
  assert.equal(requests, 0);
});

test('authorization denial remains generic and does not disclose response fields', async () => {
  const client = createClient({
    baseUrl: 'https://api.example.test',
    bearerToken: 'token',
    fetch: async () => ({
      ok: false,
      status: 403,
      json: async () => ({code: 'authorization_denied', id: 'must-not-escape'}),
    }),
  });

  await assert.rejects(client.getResource('org-1', 'resource-1'), error => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual({status: error.status, code: error.code, message: error.message}, {
      status: 403,
      code: 'authorization_denied',
      message: 'authorization_denied',
    });
    assert.equal('id' in error, false);
    return true;
  });
});

test('client fails closed on undocumented error and success payloads', async t => {
  for (const response of [
    {ok: false, status: 500, json: async () => ({code: 'internal_detail'})},
    {ok: true, status: 200, json: async () => ({id: 'resource-1'})},
  ]) {
    await t.test(String(response.status), async () => {
      const client = createClient({
        baseUrl: 'https://api.example.test',
        bearerToken: 'token',
        fetch: async () => response,
      });
      await assert.rejects(client.getResource('org-1', 'resource-1'), error => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'unexpected_response');
        return true;
      });
    });
  }
});
