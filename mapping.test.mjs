import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindProfile, findBinding } from './mapping.mjs';

test('binding aligns the profile preset without changing model or secret selection', () => {
    const profile = { id: 'a', name: 'connection', mode: 'cc', preset: 'old', model: 'model-a', 'secret-id': 'fake-selection' };
    const bindings = {};
    bindProfile(bindings, [profile], 'target', 'a');
    assert.equal(findBinding(bindings, [profile], 'target'), profile);
    assert.deepEqual(profile, { id: 'a', name: 'connection', mode: 'cc', preset: 'target', model: 'model-a', 'secret-id': 'fake-selection' });
    profile.name = 'renamed';
    assert.equal(findBinding(bindings, [profile], 'target'), profile);
});

test('rejects conflicting or missing connections without partial changes', () => {
    const profile = { id: 'a', mode: 'cc', preset: 'first' };
    const bindings = { first: 'a' };
    assert.throws(() => bindProfile(bindings, [profile], 'second', 'a'));
    assert.throws(() => bindProfile(bindings, [profile], 'second', 'missing'));
    assert.deepEqual(bindings, { first: 'a' });
    assert.equal(profile.preset, 'first');
    assert.equal(findBinding(bindings, [], 'first'), undefined);
});

test('unbinding leaves the stored connection intact', () => {
    const profile = { id: 'a', mode: 'cc', preset: 'first' };
    const bindings = { first: 'a' };
    assert.equal(bindProfile(bindings, [profile], 'first', ''), null);
    assert.deepEqual(bindings, {});
    assert.equal(profile.preset, 'first');
});
