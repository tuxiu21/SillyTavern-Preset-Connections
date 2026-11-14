import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getPresetApplicationPromise } from '/scripts/openai.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '/scripts/slash-commands/SlashCommandScope.js';
import { SlashCommandAbortController } from '/scripts/slash-commands/SlashCommandAbortController.js';
import { SlashCommandDebugController } from '/scripts/slash-commands/SlashCommandDebugController.js';
import { bindProfile, findBinding } from './mapping.mjs';

let initialized = false;
let pending = null;
let applying = false;
const settings = () => extension_settings.presetConnections ??= { bindings: {} };
const profiles = () => extension_settings.connectionManager?.profiles ?? [];
const presetName = () => document.querySelector('#settings_preset_openai')?.selectedOptions[0]?.textContent;
const args = () => ({
    _scope: new SlashCommandScope(),
    _abortController: new SlashCommandAbortController(),
    _debugController: new SlashCommandDebugController(),
    _parserFlags: {}, _hasUnnamedArgument: true, quiet: 'true', await: 'true', timeout: '0',
});

async function drain() {
    if (applying) return;
    applying = true;
    try {
        while (pending !== null) {
            const name = pending;
            pending = null;
            await getPresetApplicationPromise();
            if (pending !== null) continue;
            // An earlier in-flight profile may have changed the selection after
            // the user picked another preset. Restore the latest user choice.
            if (presetName() !== name) {
                await SlashCommandParser.commands.preset.callback(args(), name);
            }
            if (pending !== null) continue;
            const profile = findBinding(settings().bindings, profiles(), name);
            if (!profile) continue;
            if (profile.preset !== name) {
                toastr.warning('对应连接中的预设已被修改，请重新保存对应关系。');
                continue;
            }
            // Reapply even when already selected: a preset can overwrite its model.
            await SlashCommandParser.commands.profile.callback(args(), profile.name);
        }
    } catch (error) {
        console.error('[preset-connections] Connection switch failed', error.name);
        toastr.error('自动切换连接失败，请检查 API 连接面板。');
    } finally {
        applying = false;
        if (pending !== null) setTimeout(() => void drain(), 0);
    }
}

export function init() {
    if (initialized) return;
    const preset = document.querySelector('#settings_preset_openai');
    if (!preset) return;
    initialized = true;
    const row = document.createElement('div');
    row.className = 'flex-container flexFlowRow';
    const label = document.createElement('label');
    label.textContent = '对应连接配置';
    label.htmlFor = 'preset_connection_binding';
    const select = document.createElement('select');
    select.id = label.htmlFor;
    select.className = 'text_pole';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button';
    save.textContent = '保存对应关系';
    row.append(label, select, save);
    preset.parentElement.after(row);

    const render = () => {
        select.replaceChildren(new Option('不自动切换连接', ''));
        for (const profile of profiles().filter(p => p.mode === 'cc')) {
            select.add(new Option(profile.name, profile.id));
        }
        select.value = settings().bindings[presetName()] ?? '';
    };
    save.addEventListener('click', async () => {
        try {
            const name = presetName();
            const previous = profiles().find(p => p.id === select.value);
            const oldProfile = previous ? structuredClone(previous) : null;
            const profile = bindProfile(settings().bindings, profiles(), name, select.value);
            saveSettingsDebounced();
            if (profile) {
                // The built-in profile loader also loads a preset. Keep both directions consistent.
                await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, oldProfile, profile);
            }
            toastr.success('对应关系已保存；下次选择此预设时自动切换连接。');
        } catch (error) {
            toastr.warning(error.message);
        }
    });
    // Only direct user selection starts a switch. Profile loading triggers preset
    // changes itself; ignoring those prevents recursive profile/preset loops.
    preset.addEventListener('change', event => {
        if (!event.isTrusted) return;
        pending = presetName();
        setTimeout(() => void drain(), 0);
    });
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, render);
    for (const event of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED,
        event_types.CONNECTION_PROFILE_DELETED]) eventSource.on(event, render);
    render();
}
