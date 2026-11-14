import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getPresetApplicationPromise, oai_settings } from '/scripts/openai.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '/scripts/slash-commands/SlashCommandScope.js';
import { SlashCommandAbortController } from '/scripts/slash-commands/SlashCommandAbortController.js';
import { SlashCommandDebugController } from '/scripts/slash-commands/SlashCommandDebugController.js';
import { bindProfile, findBinding } from './mapping.mjs';

let initialized = false;
let pending = null;
let applying = false;
let activeVertex = null;
const settings = () => extension_settings.presetConnections ??= { bindings: {} };
const profiles = () => extension_settings.connectionManager?.profiles ?? [];
const presetName = () => document.querySelector('#settings_preset_openai')?.selectedOptions[0]?.textContent;
const args = () => ({
    _scope: new SlashCommandScope(),
    _abortController: new SlashCommandAbortController(),
    _debugController: new SlashCommandDebugController(),
    _parserFlags: {}, _hasUnnamedArgument: true, quiet: 'true', await: 'true', timeout: '0',
});

function applyVertex(options) {
    if (!options || oai_settings.chat_completion_source !== 'vertexai') return;
    // The change handler updates both settings and the full/express form visibility.
    $('#vertexai_auth_mode').val(options.authMode).trigger('change');
    if (options.region !== undefined) $('#vertexai_region').val(options.region).trigger('input');
}

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
            activeVertex = settings().vertexOptions?.[profile.id] ?? null;
            try {
                // /profile loads its preset before selecting a secret. Restore
                // auth after that preset, so /secret-id resolves the right store.
                await SlashCommandParser.commands.profile.callback(args(), profile.name);
                applyVertex(activeVertex);
            } finally {
                activeVertex = null;
            }
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
    const authLabel = document.createElement('label');
    authLabel.textContent = 'Vertex AI 认证方式';
    authLabel.htmlFor = 'preset_connection_vertex_auth';
    const auth = document.createElement('select');
    auth.id = authLabel.htmlFor;
    auth.className = 'text_pole';
    auth.add(new Option('跟随预设', ''));
    auth.add(new Option('JSON 服务账号', 'full'));
    auth.add(new Option('快速模式（API Key）', 'express'));
    row.append(label, select, authLabel, auth, save);
    preset.parentElement.after(row);

    const render = () => {
        select.replaceChildren(new Option('不自动切换连接', ''));
        for (const profile of profiles().filter(p => p.mode === 'cc')) {
            select.add(new Option(profile.name, profile.id));
        }
        select.value = settings().bindings[presetName()] ?? '';
        auth.value = settings().vertexOptions?.[select.value]?.authMode ?? '';
        const isVertex = profiles().find(p => p.id === select.value)?.api === 'vertexai';
        auth.hidden = authLabel.hidden = !isVertex;
    };
    select.addEventListener('change', () => {
        auth.value = settings().vertexOptions?.[select.value]?.authMode ?? '';
        const isVertex = profiles().find(p => p.id === select.value)?.api === 'vertexai';
        auth.hidden = authLabel.hidden = !isVertex;
    });
    save.addEventListener('click', async () => {
        try {
            const name = presetName();
            const previous = profiles().find(p => p.id === select.value);
            const oldProfile = previous ? structuredClone(previous) : null;
            let vertex = null;
            let secretId = '';
            if (previous?.api === 'vertexai' && auth.value) {
                if (!['full', 'express'].includes(auth.value)) throw new Error('请选择有效的 Vertex AI 认证方式。');
                vertex = { authMode: auth.value };
                if (oai_settings.chat_completion_source === 'vertexai') vertex.region = oai_settings.vertexai_region;
                const key = auth.value === 'full' ? 'vertexai_service_account_json' : 'api_key_vertexai';
                // Read only the saved selection ID, never the secret value or JSON.
                secretId = await SlashCommandParser.commands['secret-id'].callback({ ...args(), key }, '');
                if (!secretId) throw new Error('此认证方式尚未选好凭据，请先在 API 面板选择对应凭据，再保存关联。');
            }
            const profile = bindProfile(settings().bindings, profiles(), name, select.value);
            if (profile?.api === 'vertexai') {
                settings().vertexOptions ??= {};
                if (vertex) {
                    settings().vertexOptions[profile.id] = vertex;
                    profile['secret-id'] = secretId;
                } else {
                    delete settings().vertexOptions[profile.id];
                }
            }
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
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        applyVertex(activeVertex);
        render();
    });
    for (const event of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED,
        event_types.CONNECTION_PROFILE_DELETED]) eventSource.on(event, render);
    render();
}
