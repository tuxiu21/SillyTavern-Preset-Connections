import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as mapping from './mapping.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

async function harness() {
    class Element {
        constructor() { this.listeners = {}; this.children = []; this.value = ''; }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        append(...items) { this.children.push(...items); }
        after(item) { this.row = item; }
        replaceChildren(...items) { this.children = items; }
        add(item) { this.children.push(item); }
    }
    const preset = new Element();
    preset.parentElement = new Element();
    let current = 'A';
    Object.defineProperty(preset, 'selectedOptions', { get: () => [{ textContent: current }] });
    const profiles = [
        { id: 'a', name: 'Connection A', mode: 'cc', preset: 'A', model: 'model-a' },
        { id: 'b', name: 'Connection B', mode: 'cc', preset: 'B', model: 'model-b' },
    ];
    const settings = { connectionManager: { profiles }, presetConnections: { bindings: { A: 'a', B: 'b' } } };
    const events = new Map();
    const eventTypes = Object.fromEntries(['OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED'].map(x => [x, x]));
    const eventSource = {
        on: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
        emit: async (name, ...args) => { for (const fn of events.get(name) ?? []) await fn(...args); },
    };
    const calls = [];
    const errors = [];
    const live = { chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', vertexai_region: 'default' };
    const authAtSecretSelection = [];
    let application = Promise.resolve();
    let beforeProfile = async () => {};
    const select = (name, trusted) => {
        current = name;
        preset.listeners.change({ isTrusted: trusted });
    };
    const commands = {
        preset: { callback: async (_, name) => { select(name, false); } },
        profile: { callback: async (_, name) => {
            calls.push(name);
            await beforeProfile(name);
            const profile = profiles.find(p => p.name === name);
            live.vertexai_auth_mode = 'express'; // Loaded preset overwrites auth.
            select(profile.preset, false);
            await eventSource.emit(eventTypes.OAI_PRESET_CHANGED_AFTER);
            authAtSecretSelection.push(live.vertexai_auth_mode);
            return name;
        } },
    };
    const context = vm.createContext({
        document: { querySelector: () => preset, createElement: () => new Element() },
        Option: class { constructor(text, value) { this.text = text; this.value = value; } },
        toastr: { warning: message => errors.push(message), error: message => errors.push(message), success() {} },
        structuredClone, setTimeout, console: { error() {} },
        $: selector => ({ val(value) {
            live[selector === '#vertexai_auth_mode' ? 'vertexai_auth_mode' : 'vertexai_region'] = value;
            return { trigger() {} };
        } }),
    });
    const modules = {
        '/script.js': { eventSource, event_types: eventTypes, saveSettingsDebounced() {} },
        '/scripts/extensions.js': { extension_settings: settings },
        '/scripts/openai.js': { getPresetApplicationPromise: () => application, oai_settings: live },
        '/scripts/slash-commands/SlashCommandParser.js': { SlashCommandParser: { commands } },
        './mapping.mjs': mapping,
    };
    for (const name of ['SlashCommandScope', 'SlashCommandAbortController', 'SlashCommandDebugController']) {
        modules[`/scripts/slash-commands/${name}.js`] = { [name]: class {} };
    }
    const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
    const module = new vm.SourceTextModule(source, { context });
    await module.link(specifier => {
        const exports = modules[specifier];
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    module.namespace.init();
    return {
        calls, errors, profiles, settings, select, live, authAtSecretSelection,
        controls: preset.parentElement.row.children,
        commands,
        get current() { return current; },
        setApplication: promise => { application = promise; },
        beforeProfile: fn => { beforeProfile = fn; },
    };
}

test('waits for preset application, then switches once without recursive loading', async () => {
    const h = await harness();
    const application = deferred();
    h.setApplication(application.promise);
    h.select('A', true);
    await tick();
    assert.deepEqual(h.calls, []);
    application.resolve();
    await tick();
    assert.deepEqual(h.calls, ['Connection A']);
    assert.equal(h.current, 'A');
    h.select('A', true);
    await tick();
    assert.deepEqual(h.calls, ['Connection A', 'Connection A']);
});

test('restores JSON auth after preset loading but before native secret selection', async () => {
    const h = await harness();
    h.settings.presetConnections.vertexOptions = { a: { authMode: 'full', region: 'test-region' } };
    h.select('A', true);
    await tick();
    assert.deepEqual(h.authAtSecretSelection, ['full']);
    assert.equal(h.live.vertexai_auth_mode, 'full');
    assert.equal(h.live.vertexai_region, 'test-region');
    h.select('B', true);
    await tick();
    assert.equal(h.live.vertexai_auth_mode, 'express');
    assert.deepEqual(h.authAtSecretSelection, ['full', 'express']);
});

test('saving JSON auth records only the service-account selection ID', async () => {
    const h = await harness();
    h.profiles[0].api = 'vertexai';
    const [, connection, , auth, save] = h.controls;
    connection.value = 'a';
    auth.value = 'full';
    h.commands['secret-id'] = { callback: async (args, value) => {
        assert.equal(args.key, 'vertexai_service_account_json');
        assert.equal(value, '');
        return 'fake-json-selection-id';
    } };
    await save.listeners.click();
    assert.equal(h.profiles[0]['secret-id'], 'fake-json-selection-id');
    assert.equal(h.settings.presetConnections.vertexOptions.a.authMode, 'full');
});

test('missing JSON credential rejects the save without changing the binding', async () => {
    const h = await harness();
    h.profiles[0].api = 'vertexai';
    const [, connection, , auth, save] = h.controls;
    connection.value = 'a';
    auth.value = 'full';
    h.commands['secret-id'] = { callback: async () => '' };
    await save.listeners.click();
    assert.equal(h.settings.presetConnections.vertexOptions, undefined);
    assert.equal(h.profiles[0]['secret-id'], undefined);
    assert.equal(h.errors.length, 1);
});

test('programmatic and unbound selections do not switch connections', async () => {
    const h = await harness();
    h.select('A', false);
    h.select('Unbound', true);
    await tick();
    assert.deepEqual(h.calls, []);
});

test('latest user choice wins while an earlier profile is loading', async () => {
    const h = await harness();
    const gate = deferred();
    h.beforeProfile(async name => { if (name === 'Connection A') await gate.promise; });
    h.select('A', true);
    await tick();
    h.select('B', true);
    gate.resolve();
    await tick();
    assert.deepEqual(h.calls, ['Connection A', 'Connection B']);
    assert.equal(h.current, 'B');
});

test('latest unbound choice is preserved after an in-flight profile finishes', async () => {
    const h = await harness();
    const gate = deferred();
    h.beforeProfile(() => gate.promise);
    h.select('A', true);
    await tick();
    h.select('Unbound', true);
    gate.resolve();
    await tick();
    assert.deepEqual(h.calls, ['Connection A']);
    assert.equal(h.current, 'Unbound');
});

test('missing or inconsistent profiles do not fall back to another connection', async () => {
    const h = await harness();
    h.profiles[0].preset = 'Changed';
    h.select('A', true);
    await tick();
    assert.deepEqual(h.calls, []);
    assert.equal(h.errors.length, 1);
    h.profiles.splice(1, 1);
    h.select('B', true);
    await tick();
    assert.deepEqual(h.calls, []);
});
